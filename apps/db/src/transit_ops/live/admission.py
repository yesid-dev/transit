"""Restart and pilot admission gate: local live engine eligibility from recorded evidence.

``evaluate`` is pure over an explicit ``EvidenceBundle`` and names one outcome per gate:
``pass``; ``fail``; ``unavailable`` (a measurement is absent, never a pass); or
``threshold_unowned`` (no owner has set the threshold yet). The gate fails closed (live
ruling 25). The verdict only states eligibility. The 24-hour live shadow, every deploy,
role flip and cutover still need the owner's separate approval.

Every threshold has an owner outside this module:
- recovery: LS3.5d2 (#1142) reopen refusals, live ruling 12 fallback triggers, live ruling
  24.3 for the restart bound (the provider's shortest declared live cadence) and 25.4 for
  binding restart records to a provider and the window;
- publication: live rulings 24.1-24.2 (provisional; the owner may override them when he
  approves the live shadow) and 25.1-25.4, over the paired shadow's per-cycle classes
  (#1153, #1154) and the worker's declared tick (realtime_schedule.worker_tick_seconds);
- performance: ``every_seconds`` in providers/declaration.py;
- resources: ``operations.resource_plan.plan_resources`` (#901, as rendered by #1121).
"""

from __future__ import annotations

import itertools
import json
import math
import re
import time
from collections import Counter, deque
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from transit_ops.operations.resource_plan import (
    DiskPeak,
    ResourceEvidenceMissing,
    ServicePeak,
    TenantCapacityExceeded,
    plan_resources,
)

if TYPE_CHECKING:
    from transit_ops.core.models import ProviderManifest
    from transit_ops.live.local_file import LocalFile
    from transit_ops.live.settings import LaneSettings

# Live ruling 24.1 (storage orchestrator 10, 2026-11-19; provisional): the largest share of
# a provider's window that may be shadow-attributable invalid or refused cycles.
MAX_UNCOMPARED_CYCLE_SHARE: float | None = 0.05
# Live ruling 24.2 (provisional): a judged key present in every compared cycle over at least
# this continuous span, and still in the window's last compared cycle, persists.
PERSISTENT_UNADJUDICATED_SECONDS: float | None = 600.0
# Live ruling 25.1: the two named non-differences; every other class is judged.
EXEMPT_CLASSES = frozenset({"representation", "clock_skew"})
# Live rulings 24.2, 25.1 and 25a: the persistence-tested classes. Others are unowned.
JUDGED_CLASSES = frozenset({"unadjudicated", "missing", "extra", "unpaired", "unobserved"})
# Live ruling 25a: a structural schema difference fails on first occurrence, no span.
SCHEMA_CLASS = "columns"
# Live ruling 25.1: the comparison hit its difference limit; the cycle is uncompared.
TRUNCATED = "truncated"
# Live ruling 24.3: the restart bound is the shortest declared cadence of the live feeds
# (trip_updates, vehicle_positions, alerts), i.e. every feed but schedule and geometry.
STATIC_FEED_KINDS = frozenset({"static_schedule", "gis_static"})
# Live ruling 12: the SQLite fallback is considered only for these three, by name.
RULING_12_TRIGGERS = ("lost_committed_row", "failed_wal_replay", "missed_restart_gate")
# Shadow reasons that are the public side failing, excluded from the share (ruling 24.1).
PUBLIC_SIDE_REASONS = frozenset({"public_publication_failed", "public_publication_absent"})
APPROVAL = (
    "eligibility only: the 24-hour live shadow, any deploy, role flip and cutover "
    "need the owner's separate approval"
)
ADJUDICATION_SCOPE = (
    "an adjudication covers every difference of its exact counts key inside its UTC "
    "validity interval, so a class (b) ruling there can also hide a class (a) error"
)

type Outcome = Literal["pass", "fail", "unavailable", "threshold_unowned"]


class EvidenceInvalid(ValueError):
    """Recorded evidence is malformed; it is refused by name, never skipped."""


@dataclass(frozen=True)
class Thresholds:
    max_uncompared_cycle_share: float | None = MAX_UNCOMPARED_CYCLE_SHARE
    persistent_unadjudicated_seconds: float | None = PERSISTENT_UNADJUDICATED_SECONDS


def _mapping(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvidenceInvalid(f"{name}_invalid")
    return value


def _aware(value: object, name: str) -> datetime:
    if not isinstance(value, str):
        raise EvidenceInvalid(f"{name}_invalid")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise EvidenceInvalid(f"{name}_invalid") from exc
    if parsed.utcoffset() is None:
        raise EvidenceInvalid(f"{name}_not_timezone_aware")
    return parsed.astimezone(UTC)


def _optional_int(value: object, name: str) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise EvidenceInvalid(f"{name}_invalid")
    return value


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
        raise EvidenceInvalid(f"{name}_invalid")
    return float(value)


def _exact(data: Mapping[str, Any], names: Iterable[str], name: str) -> None:
    expected = set(names)
    if set(data) != expected:
        raise EvidenceInvalid(f"{name}_fields:{sorted(set(data) ^ expected)}")


@dataclass(frozen=True)
class ShadowRecord:
    """One ``paired_shadow`` evidence line (ShadowEvidence.display_dict)."""

    cycle: datetime
    status: str
    reason: str | None
    counts: Mapping[str, int]
    identity: Mapping[str, object]
    shadow_seconds: float
    capture_seconds: float
    rss_bytes: int | None
    process_peak_rss_bytes: int | None

    @classmethod
    def from_dict(cls, value: object) -> ShadowRecord:
        data = _mapping(value, "shadow_record")
        try:
            status = data["status"]
            if status not in ("compared", "invalid", "refused"):
                raise EvidenceInvalid(f"shadow_status_unknown:{status}")
            if data["reason"] is not None and not isinstance(data["reason"], str):
                raise EvidenceInvalid("shadow_reason_invalid")
            counts = _mapping(data["counts"], "shadow_counts")
            if any(type(v) is not int or v < 0 for v in counts.values()):
                raise EvidenceInvalid("shadow_counts_invalid")
            return cls(
                _aware(data["cycle"], "shadow_cycle"),
                status,
                data["reason"],
                dict(counts),
                dict(_mapping(data["identity"], "shadow_identity")),
                _number(data["shadow_seconds"], "shadow_seconds"),
                # #1153 records predate the capture split; their capture time is zero.
                _number(data.get("capture_seconds", 0.0), "capture_seconds"),
                _optional_int(data["rss_bytes"], "rss_bytes"),
                _optional_int(data["process_peak_rss_bytes"], "process_peak_rss_bytes"),
            )
        except KeyError as exc:
            raise EvidenceInvalid(f"shadow_record_missing:{exc}") from exc


@dataclass(frozen=True)
class CycleRecord:
    """One worker cycle as its log tells it; status 'raised' is a cycle that threw.

    ``attempted_endpoints`` is successful plus failed endpoints; 0 means nothing was due.
    """

    started_at: datetime | None
    status: str | None
    duration_seconds: float | None
    shadow: ShadowRecord | None
    attempted_endpoints: int | None = None
    requested_poll_seconds: float | None = None

    @property
    def public_failed(self) -> bool:
        return self.status in ("failed", "raised")

    @property
    def at(self) -> datetime | None:
        return self.started_at or (self.shadow.cycle if self.shadow else None)


@dataclass(frozen=True)
class RestartObservation:
    """One kill-and-reopen of a provider's worker file, classified at the reopen boundary."""

    provider_id: str
    observed_at: datetime
    point: str
    reopened: bool
    reopen_seconds: float | None
    wal_present: bool
    refusal: str | None
    committed_rows_lost: int | None

    @classmethod
    def from_dict(cls, value: object) -> RestartObservation:
        data = _mapping(value, "restart_record")
        _exact(data, cls.__dataclass_fields__, "restart_record")
        if type(data["reopened"]) is not bool or type(data["wal_present"]) is not bool:
            raise EvidenceInvalid("restart_record_flags_invalid")
        for name in ("provider_id", "point"):
            if not isinstance(data[name], str) or not data[name]:
                raise EvidenceInvalid(f"restart_record_{name}_invalid")
        if data["refusal"] is not None and not isinstance(data["refusal"], str):
            raise EvidenceInvalid("restart_record_refusal_invalid")
        seconds = data["reopen_seconds"]
        return cls(
            data["provider_id"],
            _aware(data["observed_at"], "restart_record_observed_at"),
            data["point"],
            data["reopened"],
            None if seconds is None else _number(seconds, "restart_record_reopen_seconds"),
            data["wal_present"],
            data["refusal"],
            _optional_int(data["committed_rows_lost"], "restart_record_committed_rows_lost"),
        )

    def display_dict(self) -> dict[str, object]:
        return {
            "provider_id": self.provider_id,
            "observed_at": self.observed_at.isoformat(),
            "point": self.point,
            "reopened": self.reopened,
            "reopen_seconds": self.reopen_seconds,
            "wal_present": self.wal_present,
            "refusal": self.refusal,
            "committed_rows_lost": self.committed_rows_lost,
        }


@dataclass(frozen=True)
class Adjudication:
    """Independent math for one exact counts key over [valid_from, valid_until).

    (a) new engine error; (b) PostgreSQL error. Outside its interval the key's
    differences are judged as unadjudicated again (live ruling 25.4).
    """

    klass: Literal["a", "b"]
    math: str
    valid_from: datetime
    valid_until: datetime

    @classmethod
    def from_dict(cls, key: str, value: object) -> Adjudication:
        data = _mapping(value, f"adjudication:{key}")
        _exact(data, ("class", "math", "valid_from", "valid_until"), f"adjudication:{key}")
        klass, note = data["class"], data["math"]
        if klass not in ("a", "b") or not isinstance(note, str) or not note.strip():
            raise EvidenceInvalid(f"adjudication_invalid:{key}")
        start = _aware(data["valid_from"], f"adjudication_valid_from:{key}")
        end = _aware(data["valid_until"], f"adjudication_valid_until:{key}")
        if start >= end:
            raise EvidenceInvalid(f"adjudication_interval_empty:{key}")
        return cls(klass, note, start, end)

    def covers(self, at: datetime) -> bool:
        return self.valid_from <= at < self.valid_until


@dataclass(frozen=True)
class ResourceEvidence:
    """The admitted plan's measured evidence (#901 shape) and the worker it governs."""

    peaks: tuple[ServicePeak, ...]
    disk: DiskPeak
    worker_service: str


@dataclass(frozen=True)
class WindowCpu:
    """The worker's peak CPU cores, measured over an interval that must cover the window."""

    service: str
    cpu_cores: float
    start: datetime
    end: datetime
    measurement_sha: str

    @classmethod
    def from_dict(cls, value: object) -> WindowCpu:
        data = _mapping(value, "window_cpu")
        _exact(data, ("service", "cpu_cores", "start", "end", "measurement_sha"), "window_cpu")
        sha = data["measurement_sha"]
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise EvidenceInvalid("window_cpu_measurement_sha_invalid")
        if not isinstance(data["service"], str):
            raise EvidenceInvalid("window_cpu_service_invalid")
        return cls(
            data["service"],
            _number(data["cpu_cores"], "window_cpu_cores"),
            _aware(data["start"], "window_cpu_start"),
            _aware(data["end"], "window_cpu_end"),
            sha,
        )


@dataclass(frozen=True)
class EvidenceBundle:
    provider_id: str
    window_start: datetime
    window_end: datetime
    cycles: tuple[CycleRecord, ...]
    restarts: tuple[RestartObservation, ...] = ()
    cadence_seconds: int | None = None
    tick_seconds: int | None = None
    resources: ResourceEvidence | None = None
    window_cpu: WindowCpu | None = None
    adjudications: Mapping[str, Adjudication] = field(default_factory=dict)


@dataclass(frozen=True)
class GateResult:
    gate: str
    outcome: Outcome
    reasons: tuple[str, ...]
    details: Mapping[str, object]


@dataclass(frozen=True)
class Verdict:
    bundle: EvidenceBundle
    thresholds: Thresholds
    gates: tuple[GateResult, ...]

    @property
    def eligible(self) -> bool:
        return all(gate.outcome == "pass" for gate in self.gates)

    def display_dict(self) -> dict[str, object]:
        gates = {gate.gate: gate for gate in self.gates}
        return {
            "provider_id": self.bundle.provider_id,
            "window": {
                "start": self.bundle.window_start.isoformat(),
                "end": self.bundle.window_end.isoformat(),
            },
            "outcome": "eligible" if self.eligible else "not_eligible",
            "approval": APPROVAL,
            "gates": {
                name: {"outcome": g.outcome, "reasons": list(g.reasons), "details": g.details}
                for name, g in gates.items()
            },
            "ruling_12_triggers": gates["recovery"].details.get("ruling_12_triggers", []),
            "methodology_items": gates["publication"].details.get("methodology_items", []),
            "thresholds": {
                "max_uncompared_cycle_share": {
                    "value": self.thresholds.max_uncompared_cycle_share,
                    "owner": "live ruling 24.1 (provisional)",
                },
                "persistent_unadjudicated_seconds": {
                    "value": self.thresholds.persistent_unadjudicated_seconds,
                    "owner": "live rulings 24.2 (provisional) and 25.1",
                },
                "exempt_classes": {
                    "value": sorted(EXEMPT_CLASSES),
                    "owner": "live ruling 25.1",
                },
                "cadence_seconds": {
                    "value": self.bundle.cadence_seconds,
                    "owner": "providers/declaration.py every_seconds; live ruling 24.3",
                },
                "tick_seconds": {
                    "value": self.bundle.tick_seconds,
                    "owner": "realtime_schedule.worker_tick_seconds; live ruling 25.2",
                },
                "resources": {"owner": "operations.resource_plan.plan_resources (#901, #1121)"},
            },
        }


def _gate(
    gate: str,
    details: Mapping[str, object],
    *,
    fails: Sequence[str] = (),
    unavailable: Sequence[str] = (),
    unowned: Sequence[str] = (),
) -> GateResult:
    if fails:
        return GateResult(gate, "fail", tuple(fails), details)
    if unavailable:
        return GateResult(gate, "unavailable", tuple(unavailable), details)
    if unowned:
        return GateResult(gate, "threshold_unowned", tuple(unowned), details)
    return GateResult(gate, "pass", (), details)


def _p95(values: Iterable[float]) -> float | None:
    from transit_ops.live.shadow import _p95 as shadow_p95  # The shadow's own nearest rank.

    return shadow_p95(deque(values))


def declared_cadence(manifest: ProviderManifest) -> int | None:
    """The provider's shortest declared live cadence (live ruling 24.3).

    The worker's own manifest: a declaration's ``every_seconds`` arrives as
    ``refresh_interval_seconds`` through providers/compat.py.
    """
    cadences = [
        int(feed.refresh_interval_seconds)
        for feed in manifest.feeds.values()
        if feed.is_enabled and feed.feed_kind not in STATIC_FEED_KINDS
    ]
    return min(cadences) if cadences else None


# Recovery: #1142's reopen categories and live ruling 12.


def reopen_refusal(error: BaseException, *, wal_present: bool) -> str:
    """Name a reopen failure. Only a DuckDB failure with a WAL present is failed WAL replay.

    #1142: an unreadable file alone does not establish that WAL replay failed, and
    schema, lock, adoption and missing-file refusals are not DuckDB failures. LocalFile
    wraps every ``duckdb.Error`` as LocalFileUnreadable, so any other exception is not one.
    """
    from transit_ops.live.local_file import (
        LocalFileLocked,
        LocalFileMismatch,
        LocalFileUnreadable,
    )
    from transit_ops.live.recovery import RecoveryRefused

    message = str(error)
    if isinstance(error, LocalFileUnreadable):
        return "failed_wal_replay" if wal_present else "local_file_unreadable_without_wal"
    if isinstance(error, LocalFileLocked):
        return "local_file_locked"
    if isinstance(error, LocalFileMismatch):
        return message if message.startswith("recovery_") else "schema_mismatch"
    if isinstance(error, FileNotFoundError):
        if message.startswith("recovery_database_missing_with_wal"):
            return "database_missing_with_wal"
        return "database_missing"
    if isinstance(error, RecoveryRefused):
        return message
    return f"reopen_error:{type(error).__name__}"


def committed_rows(local: LocalFile) -> dict[str, list[str]]:
    """Every row of every table in the worker file, canonical and ordered."""
    from transit_ops.live.compare import canonical_row

    tables = local.connection.execute(
        "SELECT table_name FROM duckdb_tables() WHERE schema_name='main' "
        "AND database_name=current_database() AND NOT temporary ORDER BY table_name"
    ).fetchall()
    return {
        name: [
            canonical_row(
                tuple(v.replace(tzinfo=UTC) if isinstance(v, datetime) else v for v in row)
            )
            for row in local.connection.execute(f'SELECT * FROM "{name}" ORDER BY ALL').fetchall()
        ]
        for (name,) in tables
    }


def lost_rows(expected: Mapping[str, Sequence[str]], actual: Mapping[str, Sequence[str]]) -> int:
    return sum(
        sum((Counter(rows) - Counter(actual.get(table, ()))).values())
        for table, rows in expected.items()
    )


def observe_restart(
    path: Path,
    *,
    provider_id: str,
    settings: LaneSettings,
    committed: Mapping[str, Sequence[str]] | None,
    point: str,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> RestartObservation:
    """Reopen a killed worker's file through #1142's boundary and measure it.

    ``committed`` is what the dead process had committed; None leaves loss unmeasured.
    """
    from transit_ops.live.recovery import reopen

    observed_at = clock()
    wal_present = Path(str(path) + ".wal").exists()
    started = time.perf_counter()
    try:
        local = reopen(path, provider_id=provider_id, settings=settings)
    except Exception as exc:  # noqa: BLE001 - every reopen failure is named below
        refusal = reopen_refusal(exc, wal_present=wal_present)
        return RestartObservation(
            provider_id, observed_at, point, False, None, wal_present, refusal, None
        )
    seconds = time.perf_counter() - started
    try:
        lost = None if committed is None else lost_rows(committed, committed_rows(local))
    finally:
        local.close()
    return RestartObservation(
        provider_id, observed_at, point, True, seconds, wal_present, None, lost
    )


def classify_restart(observation: RestartObservation, cadence_seconds: int | None) -> str:
    if not observation.reopened:
        return observation.refusal or "reopen_unclassified"
    if observation.committed_rows_lost is None or observation.reopen_seconds is None:
        return "measurement_unavailable"
    if observation.committed_rows_lost:
        return "lost_committed_row"
    if cadence_seconds is None:
        return "cadence_undeclared"
    if observation.reopen_seconds > cadence_seconds:
        return "missed_restart_gate"
    return "recovered"


def recovery_gate(bundle: EvidenceBundle) -> GateResult:
    """Live ruling 25.4: this provider's records inside the window; every one must pass."""
    ignored: Counter[str] = Counter()
    restarts = []
    for observation in bundle.restarts:
        if observation.provider_id != bundle.provider_id:
            ignored["other_provider"] += 1
        elif not bundle.window_start <= observation.observed_at < bundle.window_end:
            ignored["outside_window"] += 1
        else:
            restarts.append(observation)
    categories = [classify_restart(o, bundle.cadence_seconds) for o in restarts]
    triggers = sorted({c for c in categories if c in RULING_12_TRIGGERS})
    unmeasured = {"measurement_unavailable", "cadence_undeclared"}
    refusals = sorted(
        {c for c in categories if c not in (*RULING_12_TRIGGERS, "recovered", *unmeasured)}
    )
    seconds = [o.reopen_seconds for o in restarts if o.reopen_seconds is not None]
    details: dict[str, object] = {
        "restarts": [
            {**o.display_dict(), "category": c} for o, c in zip(restarts, categories, strict=True)
        ],
        "ignored_restarts": dict(sorted(ignored.items())),
        "ruling_12_triggers": triggers,
        "refusals": refusals,
        "max_reopen_seconds": max(seconds) if seconds else None,
        "restart_bound_seconds": bundle.cadence_seconds,
    }
    unavailable = sorted({c for c in categories if c in unmeasured})
    if not restarts:
        unavailable = ["restart_evidence_unavailable"]
    return _gate(
        "recovery",
        details,
        fails=[f"ruling_12:{t}" for t in triggers] + [f"refused:{r}" for r in refusals],
        unavailable=unavailable,
    )


# Publication equivalence: the paired shadow's classes (#1153, #1154), rulings 24 and 25.


def _difference_class(key: str) -> str:
    return key.rsplit(":", 1)[-1]


def _coverage(bundle: EvidenceBundle) -> tuple[int, dict[str, object], list[str]]:
    """Expected ticks in [start, end) with no cycle line (live ruling 25.2)."""
    tick = bundle.tick_seconds
    instants = sorted(c.at for c in bundle.cycles if c.at is not None)
    edges = [bundle.window_start, *instants, bundle.window_end]
    details: dict[str, object] = {
        "tick_seconds": tick,
        "observed_cycles": len(bundle.cycles),
        "first_cycle": instants[0].isoformat() if instants else None,
        "last_cycle": instants[-1].isoformat() if instants else None,
        "max_gap_seconds": max((b - a).total_seconds() for a, b in itertools.pairwise(edges)),
    }
    if tick is None:
        return 0, details, ["worker_tick_undeclared"]
    logged = {c.requested_poll_seconds for c in bundle.cycles} - {None, float(tick)}
    if logged:
        details["logged_tick_seconds"] = sorted(t for t in logged if t is not None)
        return 0, details, ["worker_tick_mismatch"]
    expected = math.ceil(bundle.window_end.timestamp() / tick) - math.ceil(
        bundle.window_start.timestamp() / tick
    )
    details["expected_cycles"] = expected
    return max(0, expected - len(bundle.cycles)), details, []


def _trailing_run(effective: Sequence[tuple[datetime, set[str]]], key: str) -> tuple[float, int]:
    """Seconds and compared cycles of the run that ends at the last compared cycle."""
    run = 0
    for _, keys in reversed(effective):
        if key not in keys:
            break
        run += 1
    if not run:
        return 0.0, 0
    return (effective[-1][0] - effective[-run][0]).total_seconds(), run


def publication_gate(bundle: EvidenceBundle, thresholds: Thresholds) -> GateResult:
    shadow_side: Counter[str] = Counter()
    public_side: Counter[str] = Counter()
    no_publication_due = 0
    compared: list[ShadowRecord] = []
    for cycle in bundle.cycles:
        record = cycle.shadow
        if record is None:
            if cycle.attempted_endpoints == 0:
                no_publication_due += 1  # Live ruling 25.3: nothing due, no shadow to run.
            elif cycle.public_failed:
                public_side[f"public_cycle_{cycle.status}"] += 1
            else:
                shadow_side["shadow_evidence_missing"] += 1
        elif record.status != "compared":
            reason = (record.reason or "unnamed")[:200]
            public = (
                reason in PUBLIC_SIDE_REASONS
                or cycle.public_failed
                or record.identity.get("public_keys_written") == []
            )
            (public_side if public else shadow_side)[reason] += 1
        elif any(_difference_class(key) == TRUNCATED for key in record.counts):
            shadow_side["comparison_truncated"] += 1  # Live ruling 25.1.
        else:
            compared.append(record)
    compared.sort(key=lambda r: r.cycle)
    missing, coverage, coverage_unavailable = _coverage(bundle)
    if missing:
        shadow_side["shadow_evidence_missing"] += missing
    attempted = len(compared) + sum(shadow_side.values())
    share = sum(shadow_side.values()) / attempted if attempted else None

    by_class: Counter[str] = Counter()
    judged: Counter[str] = Counter()
    judged_cycles: Counter[str] = Counter()
    ruled: dict[str, dict[str, Any]] = {}
    effective: list[tuple[datetime, set[str]]] = []
    for record in compared:
        keys = set()
        for key, count in record.counts.items():
            klass = _difference_class(key)
            by_class[klass] += count
            adjudication = bundle.adjudications.get(key)
            if adjudication is not None and adjudication.covers(record.cycle):
                item = ruled.setdefault(key, {"count": 0, "cycles": 0, "ruling": adjudication})
                item["count"] += count
                item["cycles"] += 1
            elif klass not in EXEMPT_CLASSES:
                keys.add(key)
                judged[key] += count
                judged_cycles[key] += 1
        effective.append((record.cycle, keys))

    fails: list[str] = []
    unowned: set[str] = set()
    methodology, transient, persistent = [], [], []
    for key, item in sorted(ruled.items()):
        ruling: Adjudication = item["ruling"]
        if ruling.klass == "a":
            fails.append(f"engine_error:{key}")
            continue
        methodology.append(
            {
                "key": key,
                "count": item["count"],
                "cycles": item["cycles"],
                "class": "b",
                "math": ruling.math,
                "valid_from": ruling.valid_from.isoformat(),
                "valid_until": ruling.valid_until.isoformat(),
            }
        )
    limit = thresholds.persistent_unadjudicated_seconds
    for key in sorted(judged):
        klass = _difference_class(key)
        if klass == SCHEMA_CLASS:
            fails.append(f"schema_columns:{key.rsplit(':', 1)[0]}")
            continue
        seconds, run = _trailing_run(effective, key)
        entry = {
            "key": key,
            "class": klass,
            "count": judged[key],
            "cycles": judged_cycles[key],
            "span_seconds": seconds,
            "trailing_cycles": run,
        }
        if run and limit is not None and seconds >= limit:
            persistent.append(entry)
            fails.append(f"persistent_{klass}:{key}")
            continue
        transient.append(entry)
        if klass not in JUDGED_CLASSES:
            unowned.add(f"unowned_class:{klass}")  # Live ruling 25.1: never a pass.

    max_share = thresholds.max_uncompared_cycle_share
    if share is not None and max_share is not None and share > max_share:
        fails.insert(0, "uncompared_cycle_share_exceeded")
    for name, value in (
        ("max_uncompared_cycle_share", max_share),
        ("persistent_unadjudicated_seconds", limit),
    ):
        if value is None:
            unowned.add(name)
    contexts = {r.identity.get("context_sha256") for r in compared} - {None}
    details: dict[str, object] = {
        "coverage": coverage,
        "compared_cycles": len(compared),
        "no_publication_due": no_publication_due,
        "shadow_attributable": dict(sorted(shadow_side.items())),
        "public_side_failures": dict(sorted(public_side.items())),
        "uncompared_cycle_share": share,
        "differences_by_class": dict(sorted(by_class.items())),
        "persistent": persistent,
        "transient": transient,
        "methodology_items": methodology,
        "adjudication_scope": ADJUDICATION_SCOPE,
        "input_identity": {
            "editions": sorted({str(r.identity.get("edition")) for r in compared}),
            "distinct_context_sha256": len(contexts),
            "cycles_without_context_sha256": sum(
                "context_sha256" not in r.identity for r in compared
            ),
        },
    }
    if not bundle.cycles:
        return _gate("publication", details, unavailable=["no_cycles_observed"])
    unavailable = [*coverage_unavailable]
    if not attempted:
        unavailable.append("shadow_cycles_unavailable")
    return _gate(
        "publication", details, fails=fails, unavailable=unavailable, unowned=sorted(unowned)
    )


# Performance: shadow and capture p95 against the provider's declared cadence.


def performance_gate(bundle: EvidenceBundle) -> GateResult:
    ran = [c.shadow for c in bundle.cycles if c.shadow and c.shadow.status != "refused"]
    paired = [
        (c.duration_seconds, c.shadow.shadow_seconds)
        for c in bundle.cycles
        if c.shadow is not None and c.duration_seconds is not None
    ]
    with_shadow = _p95(d for d, _ in paired)
    without_shadow = _p95(max(0.0, d - s) for d, s in paired)
    cadence = bundle.cadence_seconds
    details: dict[str, object] = {
        "cadence_seconds": cadence,
        "shadow_p95_seconds": _p95(r.shadow_seconds for r in ran),
        "capture_p95_seconds": _p95(r.capture_seconds for r in ran),
        "public_cycle_p95_seconds_with_shadow": with_shadow,
        "public_cycle_p95_seconds_without_shadow": without_shadow,
        "measured_cycles": len(paired),
    }
    unavailable = []
    if cadence is None:
        unavailable.append("cadence_undeclared")
    if not ran:
        unavailable.append("shadow_seconds_unavailable")
    if with_shadow is None or without_shadow is None:
        unavailable.append("public_cycle_timing_unavailable")
    fails = []
    if cadence is not None and with_shadow is not None and without_shadow is not None:
        if without_shadow > cadence:
            fails.append("public_cycle_over_cadence")
        elif with_shadow > cadence:
            fails.append("shadow_delays_public_cycle")
    return _gate("performance", details, fails=fails, unavailable=unavailable)


# Resources: the admitted #901 plan, re-planned with what the window observed.


def _replan(
    evidence: ResourceEvidence, worker: ServicePeak, observed: ServicePeak
) -> TenantCapacityExceeded | None:
    peaks = tuple(observed if p is worker else p for p in evidence.peaks)
    try:
        plan_resources(peaks, disk=evidence.disk, concurrent_services=[p.service for p in peaks])
    except TenantCapacityExceeded as exc:
        return exc
    return None


def resources_gate(bundle: EvidenceBundle) -> GateResult:
    records = sorted(
        (c.shadow for c in bundle.cycles if c.shadow is not None), key=lambda r: r.cycle
    )
    peaks = [r.process_peak_rss_bytes for r in records if r.process_peak_rss_bytes is not None]
    observed_peak = max(peaks) if peaks else None
    current = next((r.rss_bytes for r in reversed(records) if r.rss_bytes is not None), None)
    cpu = bundle.window_cpu
    details: dict[str, object] = {
        "observed_peak_rss_bytes": observed_peak,
        "current_rss_bytes": current,
        "window_cpu_cores": None if cpu is None else cpu.cpu_cores,
    }
    unavailable = []
    if observed_peak is None:
        unavailable.append("peak_rss_unavailable")
    if current is None:
        unavailable.append("current_rss_unavailable")
    evidence = bundle.resources
    if evidence is None:
        return _gate("resources", details, unavailable=[*unavailable, "resource_plan_unavailable"])
    window_cpu = None
    if cpu is None:
        unavailable.append("window_cpu_unavailable")  # Live ruling 25.4.
    elif cpu.service != evidence.worker_service:
        unavailable.append("window_cpu_other_service")
    elif cpu.start > bundle.window_start or cpu.end < bundle.window_end:
        unavailable.append("window_cpu_outside_window")
    else:
        window_cpu = cpu.cpu_cores
    services = [p.service for p in evidence.peaks]
    worker = next((p for p in evidence.peaks if p.service == evidence.worker_service), None)
    if worker is None or not worker.worker:
        return _gate("resources", details, unavailable=[*unavailable, "worker_service_unmeasured"])
    try:
        admitted = plan_resources(evidence.peaks, disk=evidence.disk, concurrent_services=services)
    except ResourceEvidenceMissing as exc:
        return _gate(
            "resources", details, unavailable=[*unavailable, f"resource_plan_evidence:{exc}"]
        )
    except TenantCapacityExceeded as exc:
        return _gate("resources", details, fails=[f"admitted_plan_refused:{exc}"])
    limit = admitted.services[evidence.worker_service]
    details["worker_memory_limit_bytes"] = limit.memory_bytes
    details["worker_cpu_limit"] = limit.cpus
    fails = []
    if observed_peak is not None:
        measured = worker.process_rss_bytes
        rss = observed_peak if measured is None else max(measured, observed_peak)
        if refused := _replan(evidence, worker, replace(worker, process_rss_bytes=rss)):
            fails.append(f"observed_peak_exceeds_plan:{refused}")
        if observed_peak > limit.memory_bytes:
            fails.append("peak_rss_above_worker_memory_limit")
    if current is not None and current > limit.memory_bytes:
        fails.append("current_rss_above_worker_memory_limit")
    if window_cpu is not None:
        cores = max(float(worker.cpu_cores or 0), window_cpu)
        if refused := _replan(evidence, worker, replace(worker, cpu_cores=cores)):
            fails.append(f"observed_cpu_exceeds_plan:{refused}")
        if window_cpu > limit.cpus:
            fails.append("window_cpu_above_worker_limit")
    return _gate("resources", details, fails=fails, unavailable=unavailable)


def evaluate(bundle: EvidenceBundle, thresholds: Thresholds | None = None) -> Verdict:
    thresholds = thresholds or Thresholds()
    return Verdict(
        bundle,
        thresholds,
        (
            recovery_gate(bundle),
            publication_gate(bundle, thresholds),
            performance_gate(bundle),
            resources_gate(bundle),
        ),
    )


# Reading the worker's own log lines (transit_ops.logging format).

_START = re.compile(r"\] Starting realtime worker cycle \d+ for provider '([^']*)'\.$")
_DONE = re.compile(
    r"\] Realtime worker cycle \d+ completed (?:successfully|with status \w+): (\{.*\})$"
)
_TIMING = re.compile(r"\] Realtime worker cycle \d+ timing: (\{.*\})$")
_RAISED = re.compile(r"\] Realtime worker cycle \d+ for provider '[^']*' raised an unexpected")
_SHADOW = "] paired_shadow "


@dataclass
class _Cycle:
    provider: str | None
    started_at: datetime | None = None
    status: str | None = None
    duration: float | None = None
    shadow: ShadowRecord | None = None
    attempted: int | None = None
    tick: float | None = None


def _json(text: str, name: str) -> Mapping[str, Any]:
    try:
        value = json.loads(text)
    except ValueError as exc:
        raise EvidenceInvalid(f"{name}_json_invalid") from exc
    return _mapping(value, name)


def _done(cycle: _Cycle, data: Mapping[str, Any]) -> None:
    provider = data["provider_id"]
    if not isinstance(provider, str) or not isinstance(data["status"], str):
        raise EvidenceInvalid("cycle_result_invalid")
    cycle.provider = cycle.provider or provider
    cycle.status = data["status"]
    cycle.started_at = _aware(data["started_at_utc"], "cycle_result_started_at")
    counts = [
        _optional_int(data[k], "cycle_result_endpoint_count")
        for k in ("successful_endpoint_count", "failed_endpoint_count")
    ]
    if None in counts:
        raise EvidenceInvalid("cycle_result_endpoint_count_invalid")
    cycle.attempted = sum(c for c in counts if c is not None)


def _timing(cycle: _Cycle, data: Mapping[str, Any]) -> None:
    cycle.started_at = _aware(data["cycle_start_utc"], "cycle_timing_start")
    cycle.duration = _number(data.get("cycle_duration_seconds"), "cycle_timing_duration")
    tick = data.get("requested_poll_seconds")
    cycle.tick = None if tick is None else _number(tick, "cycle_timing_poll_seconds")


def read_worker_log(
    lines: Iterable[str], *, provider_id: str, start: datetime, end: datetime
) -> tuple[CycleRecord, ...]:
    """Cycles of one provider's worker inside [start, end).

    A cycle is placed by its recorded start, else by its shadow cycle instant. A cycle
    that raised has neither and takes the previous cycle's instant; one with no
    earlier instant cannot be placed and is left out. A malformed line refuses the log.
    """
    cycles: list[_Cycle] = []
    for number, raw in enumerate(lines, 1):
        line = raw.rstrip("\r\n")
        try:
            if match := _START.search(line):
                cycles.append(_Cycle(match.group(1)))
            elif _SHADOW in line:
                record = ShadowRecord.from_dict(_json(line.split(_SHADOW, 1)[1], "paired_shadow"))
                if not cycles or cycles[-1].shadow is not None:
                    cycles.append(_Cycle(None))  # Evidence whose cycle start was not logged.
                cycles[-1].shadow = record
            elif cycles and (match := _DONE.search(line)):
                _done(cycles[-1], _json(match.group(1), "cycle_result"))
            elif cycles and (match := _TIMING.search(line)):
                _timing(cycles[-1], _json(match.group(1), "cycle_timing"))
            elif cycles and _RAISED.search(line):
                cycles[-1].status = "raised"
        except EvidenceInvalid as exc:
            raise EvidenceInvalid(f"{exc}:line {number}") from exc
        except KeyError as exc:
            raise EvidenceInvalid(f"log_field_missing:{exc}:line {number}") from exc
    result: list[CycleRecord] = []
    previous: datetime | None = None
    for cycle in cycles:
        if cycle.provider not in (None, provider_id):
            continue
        placed = CycleRecord(
            cycle.started_at,
            cycle.status,
            cycle.duration,
            cycle.shadow,
            cycle.attempted,
            cycle.tick,
        )
        at = placed.at or previous
        previous = at
        if at is not None and start <= at < end:
            result.append(placed)
    return tuple(result)
