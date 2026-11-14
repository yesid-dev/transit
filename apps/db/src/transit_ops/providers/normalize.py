"""Dormant capture normalization; worker mode remains decode-only."""

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

from google.protobuf.message import DecodeError  # type: ignore[import-untyped]
from google.transit.gtfs_realtime_pb2 import FeedMessage

from transit_ops.providers.declaration import Provider
from transit_ops.providers.formats import decode_gtfs_rt
from transit_ops.providers.modes import RULE_ORDER, WORKER_MODES, RuleMode, normalizer_fingerprint
from transit_ops.providers.rules.route import candidate_dates, propose
from transit_ops.providers.schedule import ScheduleContext as ScheduleIdentity

__all__ = [
    "Fill",
    "NormalizedCapture",
    "RawCapture",
    "RuleOutcome",
    "ScheduleIdentity",
    "normalize_capture",
]


@dataclass(frozen=True)
class RawCapture:
    family: str
    format: str
    payload: bytes
    captured_at_utc: datetime
    label: str


@dataclass(frozen=True)
class Fill:
    entity_index: int
    stop_time_update_index: int | None
    field: str
    rule: str


@dataclass(frozen=True)
class RuleOutcome:
    rule: str
    mode: RuleMode
    seen: int
    changed: int
    unresolved: int
    reasons: Mapping[str, int]


@dataclass(frozen=True)
class NormalizedCapture:
    status: Literal["ok", "rejected"]
    rejected_reason: str | None
    message: FeedMessage | None
    alerts: tuple[()]
    fills: tuple[Fill, ...]
    outcomes: tuple[RuleOutcome, ...]
    evidence: None
    schedule_context_id: str | None
    normalizer: str


def normalize_capture(
    provider: Provider,
    capture: RawCapture,
    schedule: ScheduleIdentity | None = None,
    *,
    modes: Mapping[str, RuleMode],
    collect: bool = False,
) -> NormalizedCapture:
    fingerprint = normalizer_fingerprint(modes)
    if set(modes) != set(WORKER_MODES):
        raise ValueError("All normalizer rule modes are required")
    feed = provider.feed(capture.family)
    if feed is None or feed.format != capture.format:
        raise ValueError("Capture does not match a declared feed")
    if capture.format != "gtfs-rt" or capture.family not in ("trip_updates", "vehicle_positions"):
        raise ValueError("Declared feed adapter is not implemented")
    context_id = (
        schedule.context_id
        if schedule is not None and (collect or any(v == "apply" for v in modes.values()))
        else None
    )
    try:
        message = decode_gtfs_rt(capture.payload)
    except DecodeError:
        return NormalizedCapture(
            "rejected", "undecodable", None, (), (), (), None, context_id, fingerprint
        )
    fills: list[Fill] = []
    outcomes: list[RuleOutcome] = []
    if collect or modes["N1"] == "apply":
        try:
            dates = candidate_dates(message, capture.captured_at_utc, provider.timezone)
        except (ValueError, OverflowError, OSError):
            return NormalizedCapture(
                "rejected",
                "invalid_feed_timestamp",
                None,
                (),
                (),
                (),
                None,
                context_id,
                fingerprint,
            )
        fills, outcomes = _run_rules(message, capture.family, schedule, dates, modes, collect)
    return NormalizedCapture(
        "ok", None, message, (), tuple(fills), tuple(outcomes), None, context_id, fingerprint
    )


def _run_rules(
    message: FeedMessage,
    family: str,
    schedule: ScheduleIdentity | None,
    dates: tuple[date, ...],
    modes: Mapping[str, RuleMode],
    collect: bool,
) -> tuple[list[Fill], list[RuleOutcome]]:
    fills: list[Fill] = []
    outcomes: list[RuleOutcome] = []
    member = "trip_update" if family == "trip_updates" else "vehicle"
    field = f"{member}.trip.route_id"
    for rule in RULE_ORDER:
        if rule != "N1" or (modes[rule] != "apply" and not collect):
            continue
        seen = changed = unresolved = 0
        reasons: Counter[str] = Counter()
        for index, entity in enumerate(message.entity):
            if not entity.HasField(member):
                continue
            trip = getattr(entity, member).trip
            proposal = propose(trip, field, schedule, dates)
            seen += proposal.seen
            changed += len(proposal.writes)
            unresolved += proposal.unresolved
            reasons.update(dict(proposal.reasons))
            if modes[rule] == "apply":
                for write in proposal.writes:
                    trip.route_id = write.value
                    fills.append(Fill(index, write.stop_time_update_index, write.field, rule))
        if seen:
            outcomes.append(
                RuleOutcome(rule, modes[rule], seen, changed, unresolved, dict(reasons))
            )
    return fills, outcomes
