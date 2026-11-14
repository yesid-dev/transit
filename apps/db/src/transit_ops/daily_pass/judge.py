"""Pure service-day planning and recorded-attempt time accounting."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from fractions import Fraction
from typing import Literal

from transit_ops.daily_pass.interface import ServiceDayBuild
from transit_ops.history.reader import FeedDay, Poll

TOLERATED_SPACING_INTERVALS = 4
MAX_MISSING_BLOCK_SECONDS = 600
MAX_MISSING_BLOCK_INTERVALS = 6
COMPLETE_MIN_ACCOUNTED_SHARE = 0.90


@dataclass(frozen=True)
class Buildability:
    state: Literal["buildable", "pending", "refused"]
    reason: str | None
    detail: str | None


@dataclass(frozen=True)
class FeedAccounting:
    accounted_share: float | None
    missing_blocks: tuple[tuple[datetime, datetime], ...]
    complete: bool
    reason: str | None


def planning_start_utc(window_start_utc: datetime) -> datetime:
    if window_start_utc.utcoffset() is None:
        raise ValueError("Window requires aware bounds")
    return datetime.combine(window_start_utc.astimezone(UTC).date(), time(), UTC) - timedelta(
        days=1
    )


def _plan(build: ServiceDayBuild) -> dict[tuple[str, date], FeedDay]:
    start, end = build.window_start_utc, build.window_end_utc
    if start.utcoffset() is None or end.utcoffset() is None or start >= end:
        raise ValueError("Window requires aware increasing bounds")
    declared = {
        f.endpoint_key: f.family
        for f in build.provider.feeds
        if f.family in ("trip_updates", "vehicle_positions", "alerts")
    }
    if not build.feeds or dict(build.feeds) != declared:
        raise ValueError("Build requires declared realtime endpoints")
    rows: dict[tuple[str, date], FeedDay] = {}
    for row in build.feed_days:
        key = row.endpoint_key, row.utc_date
        if row.provider_id != build.provider.id or row.endpoint_key not in build.feeds:
            raise ValueError("Feed day does not match build")
        if key in rows:
            raise ValueError("Duplicate feed day")
        rows[key] = row
    return rows


def _dates(start: datetime, end: datetime) -> tuple[date, ...]:
    first = planning_start_utc(start) + timedelta(days=1)
    last = (end - timedelta(microseconds=1)).astimezone(UTC).date()
    return tuple((first + timedelta(days=i)).date() for i in range((last - first.date()).days + 1))


def _interval(build: ServiceDayBuild, row: FeedDay) -> int | None:
    current = next(
        f.every_seconds for f in build.provider.feeds if f.endpoint_key == row.endpoint_key
    )
    sealed = row.declared_interval_seconds
    if sealed is None and row.reason != "no_polls":
        return None
    return max(current, sealed or current)


def judge_buildability(build: ServiceDayBuild) -> Buildability:
    rows = _plan(build)
    first = planning_start_utc(build.window_start_utc) + timedelta(days=1)
    dates = _dates(build.window_start_utc, build.window_end_utc)
    relevant = [rows.get((e, d)) for e in sorted(build.feeds) for d in dates]
    if any(r is not None and r.reason == "still_open" for r in relevant):
        return Buildability("pending", "still_open", None)
    if any(r is None for r in relevant):
        return Buildability("refused", "captures_not_available", "plan_evidence_missing")
    if any(r is not None and r.reason == "pruned_before_archive" for r in relevant):
        return Buildability("refused", "captures_not_available", "pruned_before_archive")
    if all(r is not None and r.reason == "never_collected" for r in relevant):
        return Buildability("refused", "captures_not_available", "never_collected")
    for endpoint in sorted(build.feeds):
        previous = rows.get((endpoint, (first - timedelta(days=1)).date()))
        if previous is None:
            return Buildability("refused", "captures_not_available", "edge_evidence_missing")
        if previous.reason == "pruned_before_archive":
            row = rows[endpoint, first.date()]
            interval = _interval(build, row)
            poll = row.first_time_utc
            if (
                interval is None
                or poll is None
                or not first <= poll <= first + timedelta(seconds=3 * interval)
            ):
                return Buildability("refused", "captures_not_available", previous.reason)
        elif previous.reason not in (None, "no_polls", "never_collected"):
            return Buildability("refused", "captures_not_available", previous.reason)
    return Buildability("buildable", None, None)


def account_feed(
    build: ServiceDayBuild, endpoint_key: str, polls: Iterable[Poll]
) -> FeedAccounting:
    rows = _plan(build)
    if endpoint_key not in build.feeds:
        raise ValueError("Undeclared endpoint")
    start, end = build.window_start_utc, build.window_end_utc
    expected = set(_dates(start, end))
    days = [r for r in rows.values() if r.endpoint_key == endpoint_key and r.utc_date in expected]
    if {r.utc_date for r in days} != expected or any(
        r.reason not in (None, "no_polls") for r in days
    ):
        return FeedAccounting(None, (), False, f"captures_not_available:{endpoint_key}")
    nullable = {row.utc_date: _interval(build, row) for row in days}
    if any(i is None for i in nullable.values()):
        return FeedAccounting(None, (), False, f"accounting_interval_missing:{endpoint_key}")
    intervals = {d: i for d, i in nullable.items() if i is not None}
    times = set()
    for poll in polls:
        if poll.provider_id != build.provider.id or poll.endpoint_key not in build.feeds:
            raise ValueError("Poll does not match build")
        if poll.time_utc.utcoffset() is None:
            raise ValueError("Poll requires aware time")
        if poll.endpoint_key == endpoint_key and start <= poll.time_utc < end:
            times.add(poll.time_utc)
    points = sorted({start, end, *times})
    blocks = []
    block_ok = True
    for a, b in zip(points, points[1:], strict=False):
        # Both limits increase with cadence: the strictest touched day governs the whole gap.
        interval = min(intervals[d] for d in _dates(a, b))
        if not times or b - a > timedelta(seconds=TOLERATED_SPACING_INTERVALS * interval):
            blocks.append((a, b))
            block_ok &= b - a <= timedelta(
                seconds=max(MAX_MISSING_BLOCK_SECONDS, MAX_MISSING_BLOCK_INTERVALS * interval)
            )
    accounted = end - start - sum((b - a for a, b in blocks), timedelta())
    threshold = Fraction(str(COMPLETE_MIN_ACCOUNTED_SHARE))
    complete = accounted * threshold.denominator >= (end - start) * threshold.numerator and block_ok
    return FeedAccounting(
        accounted / (end - start),
        tuple(blocks),
        complete,
        None if complete else f"under_accounted:{endpoint_key}",
    )
