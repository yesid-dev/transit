"""Paired shadow worker: one capture stream and one cycle instant feed two candidates.

PostgreSQL is the only admitted public authority. Inverted roles need local ingress
with durable identity floors (LS3.9c) and refuse by name until it exists. The local
candidate borrows the worker-owned LocalFile and runs after the public publication,
sequentially on the owning thread. It writes only through the fenced ShadowTarget,
whose keys can never address public objects, in the private bucket under its own lease
namespace. Its PostgreSQL publication context is captured once per cycle, read-only,
before the public publication records this cycle's tier state (live/context_capture.py).
A shadow exception, overrun or refused admission marks that cycle's shadow evidence by
name; public output, freshness and cadence never depend on it. Differences are counted
evidence for math adjudication (owner ruling 4): PostgreSQL detects them, it never gates
the local candidate.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import sys
import time
from collections import Counter, deque
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol
from uuid import uuid4

from sqlalchemy import Engine, text

from transit_ops.batch.build import TableRows
from transit_ops.batch.compare import RowDifference, compare_tables
from transit_ops.control.leases import LeaseLost, release_lease
from transit_ops.history.probe import peak_rss
from transit_ops.ingestion.common import redact_error_message, utc_now
from transit_ops.live.compare import Difference, compare_publications
from transit_ops.live.context_capture import NAMES as CONTEXT_SOURCES
from transit_ops.live.facts import TRIP_COLUMNS, VEHICLE_COLUMNS
from transit_ops.live.publish import LocalBuildSource, LocalPublisher, ShadowTarget
from transit_ops.live.running import ScheduleInputs, TripHolder, cached_schedule
from transit_ops.static.alert_seed_contract import SCHEMAS

if TYPE_CHECKING:
    from transit_ops.control.objects import ConditionalObjects
    from transit_ops.live.context_capture import Registry
    from transit_ops.live.local_file import LocalFile
    from transit_ops.live.publication_context import PublicationContext
    from transit_ops.live.settings import LaneSettings
    from transit_ops.settings import Settings
    from transit_ops.snapshots.protocols import PayloadSink, SnapshotObjectStore, SnapshotPayload

logger = logging.getLogger(__name__)

type ContextSource = Callable[[datetime], PublicationContext]
type PostgresRows = Callable[[tuple[int, ...], bool], PostgresEvidence]
type PublicPublish = Callable[[PayloadSink, datetime], int]

ALERT_ENDPOINTS = frozenset({"i3_alerts", "service_alerts"})
ALERTS = "silver.i3_alerts"
_FACT_KEY = ("provider_id", "realtime_snapshot_id", "entity_index")
_FACTS = {"fact_trip_delay_snapshot": TRIP_COLUMNS, "fact_vehicle_snapshot": VEHICLE_COLUMNS}
_ALERT_KEY = ("i3_alert_snapshot_id", "alert_index")
_DIFFERENCE_LIMIT = 100_000
_SAMPLES = 20
_WINDOW = 120
# Both trips builders keep departures before cycle + 60 min; PG measures from its now().
_DEPARTURE_HORIZON = timedelta(minutes=60)
_TRIPS = "live/trips.json"


class ShadowRefused(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class CycleShadow(Protocol):
    """What the worker loop routes each cycle to and closes on stop."""

    def run_cycle(self, publish: PublicPublish, *, snapshot_ids: tuple[int, ...]) -> int: ...
    def close(self) -> None: ...


class LocalState(Protocol):
    """The LS3.9a owner: its LocalFile is borrowed, never reopened."""

    local: LocalFile
    unavailable: str | None


def admit_role(settings: LaneSettings) -> bool:
    """Validate the selected role; True only for an admitted PostgreSQL-authoritative shadow."""
    if settings.shadow == "off":
        return False
    if settings.shadow == "local_authoritative":
        if settings.ingress != "local":
            raise ShadowRefused("local_authoritative_requires_local_ingress")
        from transit_ops.live.ingest import validate_local_ingress_settings

        try:
            validate_local_ingress_settings(settings)
        except ValueError as exc:
            raise ShadowRefused(str(exc)) from exc
        for name in ("shadow_budget_seconds", "shadow_rss_limit_mb"):
            if getattr(settings, name) is None:
                raise ShadowRefused(f"shadow_requires_{name}")
        raise ShadowRefused("local_authoritative_cutover_disabled")
    if settings.ingress == "local":
        raise ShadowRefused("postgres_authoritative_forbids_local_ingress")
    if not settings.recording:
        raise ShadowRefused("shadow_requires_recording")
    for name in ("shadow_budget_seconds", "shadow_rss_limit_mb"):
        if getattr(settings, name) is None:
            raise ShadowRefused(f"shadow_requires_{name}")
    return True


def publication_class(difference: Difference) -> str:
    if difference.path == "<bytes>":
        if difference.expected == "<absent>":
            return "extra"
        if difference.actual == "<absent>":
            return "missing"
        return "representation"  # Equal JSON values spelled differently: class (c).
    return "unadjudicated"  # Class (a) or (b) needs independent math, never a gate.


def _row_class(difference: RowDifference) -> str:
    if difference.kind in ("missing", "extra", "columns"):
        return difference.kind
    return "representation" if difference.difference_class == "representation" else "unadjudicated"


def _windows_working_set() -> int:
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t)
            for name in (
                "PeakWorkingSetSize",
                "WorkingSetSize",
                "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage",
                "PagefileUsage",
                "PeakPagefileUsage",
            )
        ]

    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    if not psapi.GetProcessMemoryInfo(
        kernel.GetCurrentProcess(), ctypes.byref(counters), ctypes.sizeof(counters)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(counters.WorkingSetSize)


def current_rss() -> int | None:
    """Resident bytes now, unlike the lifetime peak; None when the platform cannot say."""
    try:
        if sys.platform == "win32":
            return _windows_working_set()
        if sys.platform == "linux":
            for line in Path("/proc/self/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        return None
    return None


def _generation(body: bytes) -> object:
    data = json.loads(body)
    return data.get("publish_generation_id") if isinstance(data, dict) else None


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def without_clock_skew(body: bytes, low: datetime, high: datetime) -> tuple[bytes, int]:
    """Drop trip ETAs that only PostgreSQL's later now() admitted into its window.

    Departures in [cycle + horizon, postgres_now + horizon) are a clock artifact, not
    math. A trip PostgreSQL listed only for such departures disappears with them.
    """
    data = json.loads(body)
    dropped = 0
    trips = data.get("trips") or {}
    for trip_id, trip in list(trips.items()):
        stops = trip.get("stops") or []
        kept = [s for s in stops if not low <= datetime.fromisoformat(s["eta_utc"]) < high]
        dropped += len(stops) - len(kept)
        trip["stops"] = kept
        if stops and not kept and trip.get("status") == "unknown" and trip["delay_min"] is None:
            del trips[trip_id]
    return _canonical(data), dropped


def _pair_publications(
    public: Mapping[str, bytes],
    shadow: Mapping[str, bytes],
    *,
    cycle: datetime,
    postgres_now: datetime,
    counts: Counter[str],
) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """Keep only same-generation files; attribute the PostgreSQL now() window by name."""
    left: dict[str, bytes] = {}
    right: dict[str, bytes] = {}
    for key in sorted(public.keys() | shadow.keys()):
        if key not in public or key not in shadow:
            # A restarted owner has not yet seen what the other side reused.
            counts["publication:unobserved"] += 1
        elif _generation(public[key]) != _generation(shadow[key]):
            # Built at different cycles (skip, refusal, overrun or restart): never paired.
            counts[f"publication:{key}:unpaired"] += 1
        elif key == _TRIPS and postgres_now > cycle:
            expected, dropped = without_clock_skew(
                public[key], cycle + _DEPARTURE_HORIZON, postgres_now + _DEPARTURE_HORIZON
            )
            if dropped:
                counts[f"publication:{key}:clock_skew"] += dropped
                left[key], right[key] = expected, _canonical(json.loads(shadow[key]))
            else:
                left[key], right[key] = public[key], shadow[key]
        else:
            left[key], right[key] = public[key], shadow[key]
    return left, right


class PublicTee:
    """Every public write reaches the authority first; the tee only remembers its bytes."""

    def __init__(self, public: PayloadSink) -> None:
        self.public = public
        self.written: dict[str, bytes] = {}

    def put_json(self, rel_key: str, payload: SnapshotPayload, *, tier: str) -> str:
        from transit_ops.snapshots.serialization import snapshot_json_bytes

        key = self.public.put_json(rel_key, payload, tier=tier)
        self.written[rel_key] = snapshot_json_bytes(payload)
        return key

    def get_json(self, rel_key: str) -> object:
        read = getattr(self.public, "get_json", None)
        return read(rel_key) if callable(read) else None


class _ShadowStore:
    def __init__(self, store: SnapshotObjectStore) -> None:
        self.store = store
        self.written: dict[str, bytes] = {}

    def get_json(self, rel_key: str) -> object:
        return self.store.get_json(rel_key)

    def full_key(self, rel_key: str) -> str:
        return self.store.full_key(rel_key)

    def put_bytes(self, rel_key: str, body: bytes, *, tier: str) -> str:
        key = self.store.put_bytes(rel_key, body, tier=tier)
        self.written[rel_key] = body
        return key


@dataclass(frozen=True)
class ShadowEvidence:
    cycle: datetime
    status: Literal["compared", "invalid", "refused"]
    reason: str | None
    identity: Mapping[str, object]
    counts: Mapping[str, int]
    samples: tuple[str, ...]
    shadow_seconds: float
    p95_seconds: float | None
    rss_bytes: int | None
    process_peak_rss_bytes: int | None
    # Part of shadow_seconds spent before the public publish: the delay it cost the cycle.
    capture_seconds: float = 0.0

    def display_dict(self) -> dict[str, object]:
        return {
            "cycle": self.cycle.isoformat(),
            "role": "postgres_authoritative",
            "status": self.status,
            "reason": self.reason,
            "identity": dict(self.identity),
            "counts": dict(self.counts),
            "difference_total": sum(self.counts.values()),
            "samples": list(self.samples),
            "shadow_seconds": round(self.shadow_seconds, 3),
            "capture_seconds": round(self.capture_seconds, 3),
            "p95_seconds": None if self.p95_seconds is None else round(self.p95_seconds, 3),
            "rss_bytes": self.rss_bytes,
            "process_peak_rss_bytes": self.process_peak_rss_bytes,
        }


class _Invalid(Exception):
    pass


@dataclass(frozen=True)
class PostgresEvidence:
    """The authority's rows plus its now(), read once per cycle after publication.

    That now() bounds the publication transaction's own now() from above.
    """

    now: datetime
    tables: Mapping[str, TableRows]


def _ordered(
    table: str, columns: tuple[str, ...], key: tuple[str, ...], rows: Iterable[tuple[Any, ...]]
) -> TableRows:
    indexes = [columns.index(name) for name in key]
    ordered = sorted(rows, key=lambda row: tuple(row[i] for i in indexes))
    return TableRows(table, columns, key, tuple(ordered))


def local_rows(
    local: LocalFile, provider_id: str, snapshot_ids: tuple[int, ...], *, alerts: bool = True
) -> dict[str, TableRows]:
    """This cycle's local facts and open alert versions, with aware UTC stamps."""
    from transit_ops.live.builders_status import _rows

    result = {}
    with local.transaction() as conn:
        for table, spec in _FACTS.items():
            names = tuple(name for name, _ in spec)
            rows = (
                conn.execute(
                    f"SELECT {', '.join(names)} FROM {table} WHERE provider_id=? "
                    "AND list_contains(?, realtime_snapshot_id)",
                    [provider_id, list(snapshot_ids)],
                ).fetchall()
                if snapshot_ids
                else []
            )
            result[table] = _ordered(
                table,
                names,
                _FACT_KEY,
                [
                    tuple(v.replace(tzinfo=UTC) if isinstance(v, datetime) else v for v in row)
                    for row in rows
                ],
            )
        if alerts:
            columns = tuple(SCHEMAS[ALERTS])
            open_rows = [r for r in _rows(local, ALERTS, provider_id) if r["valid_to"] is None]
            result[ALERTS] = _ordered(
                ALERTS, columns, _ALERT_KEY, [tuple(r[c] for c in columns) for r in open_rows]
            )
    return result


def postgres_rows(engine: Engine, provider_id: str) -> PostgresRows:
    """Read the authority's committed rows for the same captures, read-only."""

    def read(snapshot_ids: tuple[int, ...], alerts: bool) -> PostgresEvidence:
        result = {}
        with engine.connect() as conn, conn.begin():
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
            now = conn.execute(text("SELECT now()")).scalar_one()
            for table, spec in _FACTS.items():
                names = tuple(name for name, _ in spec)
                rows = conn.execute(
                    text(
                        f"SELECT {', '.join(names)} FROM gold.{table} "
                        "WHERE provider_id = :provider_id "
                        "AND realtime_snapshot_id = ANY(CAST(:ids AS bigint[]))"
                    ),
                    {"provider_id": provider_id, "ids": list(snapshot_ids)},
                )
                result[table] = _ordered(table, names, _FACT_KEY, [tuple(r) for r in rows])
            if alerts:
                schema = SCHEMAS[ALERTS]
                projection = ", ".join(
                    f"{c}::text" if kind == "jsonb" else c for c, kind in schema.items()
                )
                rows = conn.execute(
                    text(
                        f"SELECT {projection} FROM {ALERTS} "
                        "WHERE provider_id = :provider_id AND valid_to IS NULL"
                    ),
                    {"provider_id": provider_id},
                )
                result[ALERTS] = _ordered(
                    ALERTS, tuple(schema), _ALERT_KEY, [tuple(r) for r in rows]
                )
        return PostgresEvidence(now, result)

    return read


def _p95(durations: deque[float]) -> float | None:
    if not durations:
        return None
    ordered = sorted(durations)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


@dataclass
class PairedShadow:
    """Run one cycle: public publication first, then the bounded local comparison."""

    provider_id: str
    settings: LaneSettings
    publish_settings: Settings
    state: LocalState
    context_source: ContextSource
    postgres_rows: PostgresRows
    trips: TripHolder
    public: PayloadSink
    store: SnapshotObjectStore
    objects: ConditionalObjects
    clock: Callable[[], datetime] = utc_now
    perf: Callable[[], float] = time.perf_counter
    rss: Callable[[], int | None] = current_rss
    peak: Callable[[], tuple[int | None, str | None]] = peak_rss
    evidence: ShadowEvidence | None = None
    _public_bytes: dict[str, bytes] = field(default_factory=dict)
    _shadow_bytes: dict[str, bytes] = field(default_factory=dict)
    _durations: deque[float] = field(default_factory=lambda: deque(maxlen=_WINDOW))
    _publisher: LocalPublisher | None = None
    _overran: bool = False
    _rss_bytes: int | None = None

    def __post_init__(self) -> None:
        admit_role(self.settings)
        self._store = _ShadowStore(self.store)
        self._target = ShadowTarget(self.provider_id, self._store)
        # Live 20: candidates publish sequentially, keeping uploads off other threads.
        self._sequential = self.publish_settings.model_copy(
            update={"SNAPSHOT_PUBLISH_CONCURRENCY": 1}
        )

    def run_cycle(self, publish: PublicPublish, *, snapshot_ids: tuple[int, ...]) -> int:
        """Return the public failure count; the shadow never raises into the cycle."""
        cycle = self.clock()
        self._rss_bytes = None  # A failed probe never reports a previous cycle's RSS.
        try:
            refusal = self._admission()
        except Exception as exc:  # noqa: BLE001 - admission probes never reach public work
            refusal = f"shadow_admission_refused:{type(exc).__name__}"
        context: PublicationContext | Exception | None = None
        capture_seconds = 0.0
        if refusal is None:
            # PostgreSQL's builders read tier state before this cycle's publish records it.
            began = self.perf()
            try:
                context = self.context_source(cycle)
            except Exception as exc:  # noqa: BLE001 - reported as this cycle's shadow evidence
                context = exc
            capture_seconds = self.perf() - began
        tee = PublicTee(self.public)
        failures = publish(tee, cycle)
        if not failures:
            # The comparison target is the latest public state, even when refused.
            self._public_bytes.update(tee.written)
        started = self.perf()
        identity: dict[str, object] = {
            "cycle": cycle.isoformat(),
            "realtime_snapshot_ids": sorted(snapshot_ids),
            "public_keys_written": sorted(tee.written),
        }
        counts: Counter[str] = Counter()
        samples: list[str] = []
        status: Literal["compared", "invalid", "refused"] = "refused"
        reason = refusal
        if refusal is None:
            status, reason = "compared", None
            try:
                self._compare(
                    cycle, context, failures, tee.written, snapshot_ids, identity, counts, samples
                )
            except _Invalid as exc:
                status, reason = "invalid", str(exc)
            except Exception as exc:  # noqa: BLE001 - shadow failures never reach public work
                status, reason = (
                    "invalid",
                    f"{type(exc).__name__}: {redact_error_message(str(exc))}",
                )
        seconds = self.perf() - started + capture_seconds
        if refusal is None:
            self._durations.append(seconds)
            budget = self.settings.shadow_budget_seconds
            if status == "compared" and budget is not None and seconds > budget:
                status, reason, self._overran = "invalid", "shadow_overrun", True
        if status != "compared":
            counts.clear()
            samples.clear()
        self.evidence = ShadowEvidence(
            cycle,
            status,
            reason,
            identity,
            dict(counts),
            tuple(samples),
            seconds,
            _p95(self._durations),
            self._rss_bytes,
            self._peak(),
            capture_seconds,
        )
        line = "paired_shadow " + json.dumps(self.evidence.display_dict(), sort_keys=True)
        (logger.info if status == "compared" else logger.warning)("%s", line)
        return failures

    def _peak(self) -> int | None:
        try:
            return self.peak()[0]
        except Exception:  # noqa: BLE001 - telemetry only
            return None

    def close(self) -> None:
        """Graceful stop: release the shadow lease so a restart need not wait for expiry."""
        publisher, self._publisher = self._publisher, None
        if publisher is None or publisher.lease is None:
            return
        try:
            release_lease(self.objects, publisher.lease, clock=self.clock)
        except Exception:  # noqa: BLE001 - expiry still fences a lease we failed to release
            logger.exception("paired shadow lease release failed (expires by TTL)")

    def _admission(self) -> str | None:
        if self.state.unavailable is not None:
            return f"shadow_admission_refused:{self.state.unavailable}"
        if self._overran:
            # One-cycle backoff: a slow shadow can never take every cycle's slack.
            self._overran = False
            return "shadow_admission_refused:previous_overrun"
        # Current RSS, so admission returns once a spike subsides; the peak is telemetry.
        self._rss_bytes = rss = self.rss()
        if rss is None:
            return "shadow_admission_refused:rss_unavailable"
        limit = self.settings.shadow_rss_limit_mb
        if limit is None or rss >= limit * 2**20:
            return "shadow_admission_refused:rss_limit"
        return None

    def _compare(
        self,
        cycle: datetime,
        context: PublicationContext | Exception | None,
        failures: int,
        written: Mapping[str, bytes],
        snapshot_ids: tuple[int, ...],
        identity: dict[str, object],
        counts: Counter[str],
        samples: list[str],
    ) -> None:
        if failures:
            raise _Invalid("public_publication_failed")
        if not written:
            raise _Invalid("public_publication_absent")
        if isinstance(context, Exception):
            raise context
        assert context is not None
        for name in CONTEXT_SOURCES:
            context.rows(name)  # A missing source refuses by name before any build.
        # Input identity: the captured PostgreSQL facts this cycle compared against.
        identity["context_sha256"] = hashlib.sha256(
            json.dumps(
                {name: getattr(context, name).body.decode() for name in CONTEXT_SOURCES},
                sort_keys=True,
            ).encode()
        ).hexdigest()
        selected = cached_schedule(self.state.local)
        identity["edition"] = selected.edition.dataset_version_id
        inputs = ScheduleInputs(
            selected, frozenset({selected.edition.dataset_version_id}), (selected,)
        )
        shadow = self._publish_local(
            cycle, LocalBuildSource(self.state.local, self.trips, inputs, context)
        )
        self._shadow_bytes.update(shadow)
        identity["shadow_keys_written"] = sorted(shadow)
        for name, body in (("public", self._public_bytes), ("shadow", self._shadow_bytes)):
            manifest = body.get("manifest.json")
            identity[f"{name}_manifest_sha256"] = (
                hashlib.sha256(manifest).hexdigest() if manifest is not None else None
            )

        endpoints = {row["endpoint_key"] for row in context.rows("endpoints")}
        alerts = bool(endpoints & ALERT_ENDPOINTS)
        theirs = self.postgres_rows(snapshot_ids, alerts)
        identity["postgres_now"] = theirs.now.isoformat()
        expected, actual = _pair_publications(
            self._public_bytes,
            self._shadow_bytes,
            cycle=cycle,
            postgres_now=theirs.now,
            counts=counts,
        )
        differences = compare_publications(
            expected, actual, project_clock=True, limit=_DIFFERENCE_LIMIT
        )
        if len(differences) >= _DIFFERENCE_LIMIT:
            counts["publication:truncated"] += 1
        for difference in differences:
            kind = publication_class(difference)
            counts[f"publication:{difference.key}:{kind}"] += 1
            if len(samples) < _SAMPLES:
                samples.append(f"{difference.key} {difference.path} [{kind}]")

        mine = local_rows(self.state.local, self.provider_id, snapshot_ids, alerts=alerts)
        for relation, rows in mine.items():
            surface = "alerts" if relation == ALERTS else "facts"
            for row in compare_tables(theirs.tables[relation], rows):
                kind = _row_class(row)
                counts[f"{surface}:{relation}:{kind}"] += 1
                if len(samples) < _SAMPLES:
                    samples.append(f"{relation} {row.key!r} {row.column} [{kind}]")

    def _publish_local(self, cycle: datetime, source: LocalBuildSource) -> dict[str, bytes]:
        if self._publisher is None:
            # A fresh holder per owner: an expired or released lease is never adopted.
            holder = f"paired-shadow:{self.provider_id}:{uuid4()}"
            self._publisher = LocalPublisher(
                self._target, self.objects, holder=holder, clock=self.clock
            )
        self._store.written = {}
        try:
            self._publisher.publish(
                source, provider_id=self.provider_id, cycle=cycle, settings=self._sequential
            )
        except LeaseLost:
            self._publisher = None
            raise
        prefix = self._target.key("manifest.json").removesuffix("manifest.json")
        return {key.removeprefix(prefix): body for key, body in self._store.written.items()}


class _NoTripFeed:
    """A provider that declares no trip_updates feed has no trip capture to hold."""

    def latest(self) -> None:
        return None


# Private-bucket prefixes for shadow objects and, separately, its lease namespace.
SHADOW_PREFIXES = ("shadow", "shadow/control/v1")


def _private_store(settings: Settings) -> SnapshotObjectStore:
    from transit_ops.control.objects import bronze_store

    return bronze_store(settings, SHADOW_PREFIXES[0])


def _private_objects(settings: Settings) -> ConditionalObjects:
    from transit_ops.control.objects import SnapshotConditionalObjects, bronze_store

    # Its own lease namespace: the shadow can never fence a public local publisher.
    return SnapshotConditionalObjects(bronze_store(settings, SHADOW_PREFIXES[1]))


def validate_shadow_config(settings: Settings) -> None:
    """Every static shadow check, run before a worker start is recorded.

    A shadow-only misconfiguration must exit by name before observe_start, never
    crash-loop the worker that carries the provider's public publication.
    """
    from transit_ops.s3 import validated_s3_target
    from transit_ops.snapshots.storage import LocalSnapshotStorage

    if settings.SNAPSHOT_STORAGE_BACKEND == "local":
        if not settings.SNAPSHOT_LOCAL_ROOT:
            raise ShadowRefused("shadow_requires_public_publication")
    elif not settings.SNAPSHOT_R2_BUCKET:
        raise ShadowRefused("shadow_requires_public_publication")
    else:
        try:
            validated_s3_target(settings, bucket_setting="SNAPSHOT_R2_BUCKET")
        except ValueError as exc:
            raise ShadowRefused("shadow_public_storage_invalid") from exc
    try:
        if settings.BRONZE_STORAGE_BACKEND == "local":
            for prefix in SHADOW_PREFIXES:
                LocalSnapshotStorage(settings.BRONZE_LOCAL_ROOT, prefix)
        else:
            validated_s3_target(settings, bucket_setting="BRONZE_S3_BUCKET")
    except ValueError as exc:
        raise ShadowRefused("shadow_private_storage_invalid") from exc
    if not (settings.SNAPSHOT_PUBLIC_BASE_URL or "").strip():
        raise ShadowRefused("shadow_requires_public_base_url")


@dataclass
class UnavailableShadow:
    """A shadow that could not be built at runtime: the worker publishes as today.

    Each cycle publishes through the default path (no tee, no explicit cycle) and
    records named refused evidence, so the failure is visible but never stops the
    provider's public ingestion.
    """

    reason: str
    clock: Callable[[], datetime] = utc_now
    evidence: ShadowEvidence | None = None

    def run_cycle(self, publish: PublicPublish, *, snapshot_ids: tuple[int, ...]) -> int:
        # Today's path: publish() with no tee and no explicit cycle.
        failures = publish(None, None)  # type: ignore[arg-type]
        cycle = self.clock()
        self.evidence = ShadowEvidence(
            cycle,
            "refused",
            self.reason,
            {"cycle": cycle.isoformat(), "realtime_snapshot_ids": sorted(snapshot_ids)},
            {},
            (),
            0.0,
            None,
            None,
            None,
        )
        logger.warning(
            "%s", "paired_shadow " + json.dumps(self.evidence.display_dict(), sort_keys=True)
        )
        return failures

    def close(self) -> None:
        return None


def worker_shadow(
    provider_id: str,
    *,
    settings: Settings,
    registry: Registry,
    engine: Engine,
    state: LocalState,
    trips: TripHolder | None,
) -> PairedShadow | UnavailableShadow:
    """Build the admitted PostgreSQL-authoritative shadow for the worker loop.

    Static configuration was refused by name before the worker started. Anything
    that still fails here (client construction, the live scope) invalidates the
    shadow by name while the worker keeps publishing.
    """
    try:
        return _paired_shadow(
            provider_id,
            settings=settings,
            registry=registry,
            engine=engine,
            state=state,
            trips=trips,
        )
    except Exception as exc:  # noqa: BLE001 - a shadow failure never stops public work
        reason = exc.reason if isinstance(exc, ShadowRefused) else type(exc).__name__
        logger.error("paired shadow unavailable: %s", reason)
        return UnavailableShadow(f"shadow_unavailable:{reason}")


def _paired_shadow(
    provider_id: str,
    *,
    settings: Settings,
    registry: Registry,
    engine: Engine,
    state: LocalState,
    trips: TripHolder | None,
) -> PairedShadow:
    from transit_ops.live.context_capture import postgres_context
    from transit_ops.snapshots.live_scope import worker_live_storage

    validate_shadow_config(settings)
    public = worker_live_storage(provider_id, settings)
    if public is None:
        raise ShadowRefused("shadow_public_storage_unavailable")
    return PairedShadow(
        provider_id=provider_id,
        settings=settings.LIGHTER_STORAGE.live,
        publish_settings=settings,
        state=state,
        context_source=postgres_context(
            engine,
            provider_id=provider_id,
            registry=registry,
            public_base_url=settings.SNAPSHOT_PUBLIC_BASE_URL,
        ),
        postgres_rows=postgres_rows(engine, provider_id),
        trips=_NoTripFeed() if trips is None else trips,
        public=public,
        store=_private_store(settings),
        objects=_private_objects(settings),
    )
