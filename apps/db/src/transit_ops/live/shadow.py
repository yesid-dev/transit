"""Paired shadow worker: one capture stream and one cycle instant feed two candidates.

PostgreSQL is the only admitted public authority. Inverted roles need local ingress
with durable identity floors (LS3.9c) and refuse by name until it exists. The local
candidate borrows the worker-owned LocalFile and runs after the public publication,
sequentially on the owning thread. It writes only through the fenced ShadowTarget,
whose keys can never address public objects. A shadow exception, overrun or refused
admission marks that cycle's shadow evidence by name; public output, freshness and
cadence never depend on it. Differences are counted evidence for math adjudication
(owner ruling 4): PostgreSQL detects them, it never gates the local candidate.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import time
from collections import Counter, deque
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol
from uuid import uuid4

from sqlalchemy import Engine, text

from transit_ops.batch.build import TableRows
from transit_ops.batch.compare import RowDifference, compare_tables
from transit_ops.control.leases import LeaseLost, release_lease
from transit_ops.history.probe import peak_rss
from transit_ops.ingestion.common import redact_error_message, utc_now
from transit_ops.live.compare import Difference, compare_publications
from transit_ops.live.facts import TRIP_COLUMNS, VEHICLE_COLUMNS
from transit_ops.live.publish import LocalBuildSource, LocalPublisher, ShadowTarget
from transit_ops.live.running import ScheduleInputs, TripHolder, cached_schedule
from transit_ops.static.alert_seed_contract import SCHEMAS

if TYPE_CHECKING:
    from transit_ops.control.objects import ConditionalObjects
    from transit_ops.live.local_file import LocalFile
    from transit_ops.live.publication_context import PublicationContext
    from transit_ops.live.settings import LaneSettings
    from transit_ops.settings import Settings
    from transit_ops.snapshots.protocols import PayloadSink, SnapshotObjectStore, SnapshotPayload

logger = logging.getLogger(__name__)

type ContextSource = Callable[[datetime], PublicationContext]
type PostgresRows = Callable[[tuple[int, ...], bool], Mapping[str, TableRows]]
type PublicPublish = Callable[[PayloadSink, datetime], int]

ALERT_ENDPOINTS = frozenset({"i3_alerts", "service_alerts"})
ALERTS = "silver.i3_alerts"
_FACT_KEY = ("provider_id", "realtime_snapshot_id", "entity_index")
_FACTS = {"fact_trip_delay_snapshot": TRIP_COLUMNS, "fact_vehicle_snapshot": VEHICLE_COLUMNS}
_ALERT_KEY = ("i3_alert_snapshot_id", "alert_index")
_DIFFERENCE_LIMIT = 100_000
_SAMPLES = 20
_WINDOW = 120


class ShadowRefused(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class LocalState(Protocol):
    """The LS3.9a owner: its LocalFile is borrowed, never reopened."""

    local: LocalFile
    unavailable: str | None


def admit_role(settings: LaneSettings, *, context_source: ContextSource | None = None) -> bool:
    """Validate the selected role; True only for an admitted PostgreSQL-authoritative shadow."""
    if settings.shadow == "off":
        return False
    if settings.shadow != "postgres_authoritative":
        raise ShadowRefused("local_ingress_unavailable")
    if not settings.recording:
        raise ShadowRefused("shadow_requires_recording")
    for name in ("shadow_budget_seconds", "shadow_rss_limit_mb"):
        if getattr(settings, name) is None:
            raise ShadowRefused(f"shadow_requires_{name}")
    if context_source is None:
        # Nothing yet captures a PostgreSQL PublicationContext (feed freshness policy
        # has no stored owner); a guessed context would fabricate local freshness.
        raise ShadowRefused("publication_context_capture_unavailable")
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
    rss_peak_bytes: int | None

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
            "p95_seconds": None if self.p95_seconds is None else round(self.p95_seconds, 3),
            "rss_peak_bytes": self.rss_peak_bytes,
        }


class _Invalid(Exception):
    pass


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

    def read(snapshot_ids: tuple[int, ...], alerts: bool) -> dict[str, TableRows]:
        result = {}
        with engine.connect() as conn, conn.begin():
            conn.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
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
        return result

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
    rss: Callable[[], tuple[int | None, str | None]] = peak_rss
    evidence: ShadowEvidence | None = None
    _public_bytes: dict[str, bytes] = field(default_factory=dict)
    _shadow_bytes: dict[str, bytes] = field(default_factory=dict)
    _durations: deque[float] = field(default_factory=lambda: deque(maxlen=_WINDOW))
    _publisher: LocalPublisher | None = None
    _overran: bool = False

    def __post_init__(self) -> None:
        admit_role(self.settings, context_source=self.context_source)
        self._store = _ShadowStore(self.store)
        self._target = ShadowTarget(self.provider_id, self._store)
        # Live 20: candidates publish sequentially, keeping uploads off other threads.
        self._sequential = self.publish_settings.model_copy(
            update={"SNAPSHOT_PUBLISH_CONCURRENCY": 1}
        )

    def run_cycle(self, publish: PublicPublish, *, snapshot_ids: tuple[int, ...]) -> int:
        """Return the public failure count; the shadow never raises into the cycle."""
        cycle = self.clock()
        tee = PublicTee(self.public)
        failures = publish(tee, cycle)
        if not failures:
            # The comparison target is the latest public state, even when refused.
            self._public_bytes.update(tee.written)
        started = self.perf()
        refusal = self._admission()
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
                self._compare(cycle, failures, tee.written, snapshot_ids, identity, counts, samples)
            except _Invalid as exc:
                status, reason = "invalid", str(exc)
            except Exception as exc:  # noqa: BLE001 - shadow failures never reach public work
                status, reason = (
                    "invalid",
                    f"{type(exc).__name__}: {redact_error_message(str(exc))}",
                )
        seconds = self.perf() - started
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
            self.rss()[0],
        )
        line = "paired_shadow " + json.dumps(self.evidence.display_dict(), sort_keys=True)
        (logger.info if status == "compared" else logger.warning)("%s", line)
        return failures

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
        peak, _ = self.rss()
        if peak is None:
            return "shadow_admission_refused:rss_unavailable"
        limit = self.settings.shadow_rss_limit_mb
        if limit is None or peak >= limit * 2**20:
            return "shadow_admission_refused:rss_limit"
        return None

    def _compare(
        self,
        cycle: datetime,
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
        context = self.context_source(cycle)
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

        common = sorted(self._public_bytes.keys() & self._shadow_bytes.keys())
        # A restarted owner has not yet seen keys the other side reused: not a difference.
        unobserved = len(self._public_bytes.keys() ^ self._shadow_bytes.keys())
        if unobserved:
            counts["publication:unobserved"] += unobserved
        for difference in compare_publications(
            {key: self._public_bytes[key] for key in common},
            {key: self._shadow_bytes[key] for key in common},
            project_clock=True,
            limit=_DIFFERENCE_LIMIT,
        ):
            kind = publication_class(difference)
            counts[f"publication:{difference.key}:{kind}"] += 1
            if len(samples) < _SAMPLES:
                samples.append(f"{difference.key} {difference.path} [{kind}]")

        endpoints = {row["endpoint_key"] for row in context.rows("endpoints")}
        alerts = bool(endpoints & ALERT_ENDPOINTS)
        mine = local_rows(self.state.local, self.provider_id, snapshot_ids, alerts=alerts)
        theirs = self.postgres_rows(snapshot_ids, alerts)
        for relation, actual in mine.items():
            surface = "alerts" if relation == ALERTS else "facts"
            for row in compare_tables(theirs[relation], actual):
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
