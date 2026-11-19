"""Restart and pilot admission gate: local live engine eligibility from recorded evidence.

``evaluate`` is pure over an explicit ``EvidenceBundle`` and names one outcome per gate:
``pass``; ``fail``; ``unavailable`` (a measurement is absent, never a pass); or
``threshold_unowned`` (no owner has set the threshold yet). The verdict only states
eligibility. The 24-hour live shadow, every deploy, role flip and cutover still need
the owner's separate approval.

Every threshold has an owner outside this module:
- recovery: LS3.5d2 (#1142) reopen refusals, live ruling 12 fallback triggers, and live
  ruling 24.3 for the restart bound (the provider's shortest declared live cadence);
- publication: live ruling 24.1-24.2 (provisional; the owner may override them when he
  approves the live shadow) over the paired shadow's per-cycle classes (#1153, #1154);
- performance: ``every_seconds`` in providers/declaration.py;
- resources: ``operations.resource_plan.plan_resources`` (#901, as rendered by #1121).
"""

from __future__ import annotations

import json
import re
import time
from collections import Counter, deque
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field, replace
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
# Live ruling 24.2 (provisional): an unadjudicated key present in every compared cycle over
# at least this continuous span, and still in the window's last compared cycle, persists.
PERSISTENT_UNADJUDICATED_SECONDS: float | None = 600.0
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

type Outcome = Literal["pass", "fail", "unavailable", "threshold_unowned"]


class EvidenceInvalid(ValueError):
    """Recorded evidence is malformed; it is refused by name, never skipped."""


@dataclass(frozen=True)
class Thresholds:
    max_uncompared_cycle_share: float | None = MAX_UNCOMPARED_CYCLE_SHARE
    persistent_unadjudicated_seconds: float | None = PERSISTENT_UNADJUDICATED_SECONDS


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
    def from_dict(cls, data: Mapping[str, Any]) -> ShadowRecord:
        try:
            status = data["status"]
            if status not in ("compared", "invalid", "refused"):
                raise EvidenceInvalid(f"shadow_status_unknown:{status}")
            counts = data["counts"]
            if not isinstance(counts, dict) or any(
                type(v) is not int or v < 0 for v in counts.values()
            ):
                raise EvidenceInvalid("shadow_counts_invalid")
            return cls(
                _aware(data["cycle"], "shadow_cycle"),
                status,
                data["reason"],
                counts,
                dict(data["identity"]),
                float(data["shadow_seconds"]),
                # #1153 records predate the capture split; their capture time is zero.
                float(data.get("capture_seconds", 0.0)),
                _optional_int(data["rss_bytes"], "rss_bytes"),
                _optional_int(data["process_peak_rss_bytes"], "process_peak_rss_bytes"),
            )
        except (KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, EvidenceInvalid):
                raise
            raise EvidenceInvalid(f"shadow_record_invalid:{type(exc).__name__}:{exc}") from exc


@dataclass(frozen=True)
class CycleRecord:
    """One worker cycle as its log tells it; status 'raised' is a cycle that threw."""

    started_at: datetime | None
    status: str | None
    duration_seconds: float | None
    shadow: ShadowRecord | None

    @property
    def public_failed(self) -> bool:
        return self.status in ("failed", "raised")

    @property
    def at(self) -> datetime | None:
        return self.started_at or (self.shadow.cycle if self.shadow else None)


@dataclass(frozen=True)
class RestartObservation:
    """One kill-and-reopen of the worker file, classified at the reopen boundary."""

    point: str
    reopened: bool
    reopen_seconds: float | None
    wal_present: bool
    refusal: str | None
    committed_rows_lost: int | None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RestartObservation:
        names = {f for f in cls.__dataclass_fields__}
        if set(data) != names:
            raise EvidenceInvalid(f"restart_record_fields:{sorted(set(data) ^ names)}")
        if type(data["reopened"]) is not bool or type(data["wal_present"]) is not bool:
            raise EvidenceInvalid("restart_record_flags_invalid")
        seconds = data["reopen_seconds"]
        if seconds is not None and (
            isinstance(seconds, bool) or not isinstance(seconds, int | float)
        ):
            raise EvidenceInvalid("restart_record_seconds_invalid")
        return cls(
            str(data["point"]),
            data["reopened"],
            None if seconds is None else float(seconds),
            data["wal_present"],
            data["refusal"],
            _optional_int(data["committed_rows_lost"], "committed_rows_lost"),
        )


@dataclass(frozen=True)
class Adjudication:
    """Independent math for one counts key: (a) new engine error, (b) PostgreSQL error."""

    klass: Literal["a", "b"]
    math: str

    @classmethod
    def from_dict(cls, key: str, data: Mapping[str, Any]) -> Adjudication:
        klass, math = data.get("class"), data.get("math")
        if klass not in ("a", "b") or not isinstance(math, str) or not math.strip():
            raise EvidenceInvalid(f"adjudication_invalid:{key}")
        return cls(klass, math)


@dataclass(frozen=True)
class ResourceEvidence:
    """The admitted plan's measured evidence (#901 shape) and the worker it governs."""

    peaks: tuple[ServicePeak, ...]
    disk: DiskPeak
    worker_service: str


@dataclass(frozen=True)
class EvidenceBundle:
    provider_id: str
    window_start: datetime
    window_end: datetime
    cycles: tuple[CycleRecord, ...]
    restarts: tuple[RestartObservation, ...] = ()
    cadence_seconds: int | None = None
    resources: ResourceEvidence | None = None
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
                    "owner": "live ruling 24.2 (provisional)",
                },
                "cadence_seconds": {
                    "value": self.bundle.cadence_seconds,
                    "owner": "providers/declaration.py every_seconds; live ruling 24.3",
                },
                "resources": {"owner": "operations.resource_plan.plan_resources (#901, #1121)"},
            },
        }


def _aware(value: object, name: str) -> datetime:
    if not isinstance(value, str):
        raise EvidenceInvalid(f"{name}_invalid")
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() is None:
        raise EvidenceInvalid(f"{name}_not_timezone_aware")
    return parsed.astimezone(UTC)


def _optional_int(value: object, name: str) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise EvidenceInvalid(f"{name}_invalid")
    return value


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
    schema, lock, adoption and missing-file refusals are not DuckDB failures.
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
) -> RestartObservation:
    """Reopen a killed worker's file through #1142's boundary and measure it.

    ``committed`` is what the dead process had committed; None leaves loss unmeasured.
    """
    from transit_ops.live.recovery import reopen

    wal_present = Path(str(path) + ".wal").exists()
    started = time.perf_counter()
    try:
        local = reopen(path, provider_id=provider_id, settings=settings)
    except Exception as exc:  # noqa: BLE001 - every reopen failure is named below
        return RestartObservation(
            point, False, None, wal_present, reopen_refusal(exc, wal_present=wal_present), None
        )
    seconds = time.perf_counter() - started
    try:
        lost = None if committed is None else lost_rows(committed, committed_rows(local))
    finally:
        local.close()
    return RestartObservation(point, True, seconds, wal_present, None, lost)


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
    categories = [classify_restart(o, bundle.cadence_seconds) for o in bundle.restarts]
    triggers = sorted({c for c in categories if c in RULING_12_TRIGGERS})
    unmeasured = {"measurement_unavailable", "cadence_undeclared"}
    refusals = sorted(
        {c for c in categories if c not in (*RULING_12_TRIGGERS, "recovered", *unmeasured)}
    )
    seconds = [o.reopen_seconds for o in bundle.restarts if o.reopen_seconds is not None]
    details: dict[str, object] = {
        "restarts": [
            {**asdict(o), "category": c} for o, c in zip(bundle.restarts, categories, strict=True)
        ],
        "ruling_12_triggers": triggers,
        "refusals": refusals,
        "max_reopen_seconds": max(seconds) if seconds else None,
        "restart_bound_seconds": bundle.cadence_seconds,
    }
    unavailable = sorted({c for c in categories if c in unmeasured})
    if not bundle.restarts:
        unavailable = ["restart_evidence_unavailable"]
    return _gate(
        "recovery",
        details,
        fails=[f"ruling_12:{t}" for t in triggers] + [f"refused:{r}" for r in refusals],
        unavailable=unavailable,
    )


# Publication equivalence: the paired shadow's classes (#1153, #1154), live ruling 24.


def _difference_class(key: str) -> str:
    return key.rsplit(":", 1)[-1]


def _persistence(compared: Sequence[ShadowRecord], key: str) -> tuple[float, int]:
    """Seconds and compared cycles of the run that ends at the last compared cycle."""
    run = 0
    for record in reversed(compared):
        if key not in record.counts:
            break
        run += 1
    if not run:
        return 0.0, 0
    first, last = compared[-run], compared[-1]
    return (last.cycle - first.cycle).total_seconds(), run


def publication_gate(bundle: EvidenceBundle, thresholds: Thresholds) -> GateResult:
    shadow_side: Counter[str] = Counter()
    public_side: Counter[str] = Counter()
    for cycle in bundle.cycles:
        record = cycle.shadow
        if record is None:
            if cycle.public_failed:
                public_side[f"public_cycle_{cycle.status}"] += 1
            else:
                shadow_side["shadow_evidence_missing"] += 1
        elif record.status != "compared":
            reason = (record.reason or "unnamed")[:200]
            (public_side if reason in PUBLIC_SIDE_REASONS else shadow_side)[reason] += 1
    compared = sorted(
        (c.shadow for c in bundle.cycles if c.shadow and c.shadow.status == "compared"),
        key=lambda r: r.cycle,
    )
    attempted = len(compared) + sum(shadow_side.values())
    share = sum(shadow_side.values()) / attempted if attempted else None

    by_class: Counter[str] = Counter()
    by_key: Counter[str] = Counter()
    cycles_with: Counter[str] = Counter()
    for record in compared:
        for key, count in record.counts.items():
            by_class[_difference_class(key)] += count
            by_key[key] += count
            cycles_with[key] += 1

    fails: list[str] = []
    methodology, transient, persistent = [], [], []
    for key in sorted(by_key):
        adjudication = bundle.adjudications.get(key)
        entry: dict[str, object] = {"key": key, "count": by_key[key], "cycles": cycles_with[key]}
        if adjudication is not None and adjudication.klass == "b":
            methodology.append({**entry, "class": "b", "math": adjudication.math})
            continue
        if adjudication is not None:
            fails.append(f"engine_error:{key}")
            continue
        if _difference_class(key) != "unadjudicated":
            continue
        seconds, run = _persistence(compared, key)
        entry.update(span_seconds=seconds, trailing_cycles=run)
        limit = thresholds.persistent_unadjudicated_seconds
        if run and limit is not None and seconds >= limit:
            persistent.append(entry)
            fails.append(f"persistent_unadjudicated:{key}")
        else:
            transient.append(entry)

    limit = thresholds.max_uncompared_cycle_share
    if share is not None and limit is not None and share > limit:
        fails.insert(0, "uncompared_cycle_share_exceeded")
    unowned = [
        name
        for name, value in (
            ("max_uncompared_cycle_share", thresholds.max_uncompared_cycle_share),
            ("persistent_unadjudicated_seconds", thresholds.persistent_unadjudicated_seconds),
        )
        if value is None
    ]
    contexts = {r.identity.get("context_sha256") for r in compared} - {None}
    details: dict[str, object] = {
        "compared_cycles": len(compared),
        "shadow_attributable": dict(sorted(shadow_side.items())),
        "public_side_failures": dict(sorted(public_side.items())),
        "uncompared_cycle_share": share,
        "differences_by_class": dict(sorted(by_class.items())),
        "persistent_unadjudicated": persistent,
        "transient_unadjudicated": transient,
        "methodology_items": methodology,
        "input_identity": {
            "editions": sorted({str(r.identity.get("edition")) for r in compared}),
            "distinct_context_sha256": len(contexts),
            "cycles_without_context_sha256": sum(
                "context_sha256" not in r.identity for r in compared
            ),
        },
    }
    return _gate(
        "publication",
        details,
        fails=fails,
        unavailable=[] if attempted else ["shadow_cycles_unavailable"],
        unowned=unowned,
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


# Resources: the admitted #901 plan, re-planned with the observed worker peak.


def resources_gate(bundle: EvidenceBundle) -> GateResult:
    records = sorted(
        (c.shadow for c in bundle.cycles if c.shadow is not None), key=lambda r: r.cycle
    )
    peaks = [r.process_peak_rss_bytes for r in records if r.process_peak_rss_bytes is not None]
    observed_peak = max(peaks) if peaks else None
    current = next((r.rss_bytes for r in reversed(records) if r.rss_bytes is not None), None)
    details: dict[str, object] = {
        "observed_peak_rss_bytes": observed_peak,
        "current_rss_bytes": current,
    }
    unavailable = []
    if observed_peak is None:
        unavailable.append("peak_rss_unavailable")
    if current is None:
        unavailable.append("current_rss_unavailable")
    evidence = bundle.resources
    if evidence is None:
        return _gate("resources", details, unavailable=[*unavailable, "resource_plan_unavailable"])
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
    limit = admitted.services[evidence.worker_service].memory_bytes
    details["worker_memory_limit_bytes"] = limit
    details["admitted_headroom"] = asdict(admitted.headroom)
    fails = []
    if observed_peak is not None:
        measured = worker.process_rss_bytes
        rss = observed_peak if measured is None else max(measured, observed_peak)
        observed = tuple(
            replace(p, process_rss_bytes=rss) if p is worker else p for p in evidence.peaks
        )
        try:
            replanned = plan_resources(observed, disk=evidence.disk, concurrent_services=services)
            details["replanned_headroom"] = asdict(replanned.headroom)
        except TenantCapacityExceeded as exc:
            fails.append(f"observed_peak_exceeds_plan:{exc}")
        if observed_peak > limit:
            fails.append("peak_rss_above_worker_memory_limit")
    if current is not None and current > limit:
        fails.append("current_rss_above_worker_memory_limit")
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


def _json(text: str, name: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except ValueError as exc:
        raise EvidenceInvalid(f"{name}_json_invalid") from exc
    if not isinstance(value, dict):
        raise EvidenceInvalid(f"{name}_json_invalid")
    return value


def read_worker_log(
    lines: Iterable[str], *, provider_id: str, start: datetime, end: datetime
) -> tuple[CycleRecord, ...]:
    """Cycles of one provider's worker inside [start, end).

    A cycle is placed by its recorded start, else by its shadow cycle instant. A cycle
    that raised has neither and takes the previous cycle's instant; one with no
    earlier instant cannot be placed and is left out.
    """
    cycles: list[_Cycle] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if match := _START.search(line):
            cycles.append(_Cycle(match.group(1)))
        elif _SHADOW in line:
            record = ShadowRecord.from_dict(_json(line.split(_SHADOW, 1)[1], "paired_shadow"))
            if not cycles or cycles[-1].shadow is not None:
                cycles.append(_Cycle(None))  # Evidence from a cycle whose start was not logged.
            cycles[-1].shadow = record
        elif cycles and (match := _DONE.search(line)):
            data = _json(match.group(1), "cycle_result")
            cycles[-1].provider = cycles[-1].provider or data.get("provider_id")
            cycles[-1].status = data.get("status")
            cycles[-1].started_at = _aware(data.get("started_at_utc"), "cycle_started_at")
        elif cycles and (match := _TIMING.search(line)):
            data = _json(match.group(1), "cycle_timing")
            cycles[-1].started_at = _aware(data.get("cycle_start_utc"), "cycle_start_utc")
            cycles[-1].duration = float(data["cycle_duration_seconds"])
        elif cycles and _RAISED.search(line):
            cycles[-1].status = "raised"
    result: list[CycleRecord] = []
    previous: datetime | None = None
    for cycle in cycles:
        if cycle.provider not in (None, provider_id):
            continue
        placed = CycleRecord(cycle.started_at, cycle.status, cycle.duration, cycle.shadow)
        at = placed.at or previous
        previous = at
        if at is not None and start <= at < end:
            result.append(placed)
    return tuple(result)
