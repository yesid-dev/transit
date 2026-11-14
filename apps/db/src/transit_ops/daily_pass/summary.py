"""One byte-free stream summary; no acquisition or normalization."""

from collections import Counter, defaultdict
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta

from transit_ops.capture_coverage.rules import CaptureKey
from transit_ops.daily_pass.interface import (
    Delivery,
    LineMatch,
    ServiceDayBuild,
    StreamSummary,
    consumed_set_sha256,
)
from transit_ops.daily_pass.judge import account_feed, judge_buildability
from transit_ops.gold.match_guard import line_passes_match_guard
from transit_ops.history.reader import Poll


class StreamAccumulator:
    def __init__(self, build: ServiceDayBuild) -> None:
        self._build = build
        self._counts: dict[str, Counter[str]] = {e: Counter() for e in sorted(build.feeds)}
        self._polls: dict[str, list[Poll]] = defaultdict(list)
        self._consumed: set[CaptureKey] = set()
        self._base: StreamSummary | None = None
        self._trips: dict[tuple[date, str], set[str]] = defaultdict(set)
        self._unlisted: set[tuple[date, str]] = set()
        self._unresolved: set[tuple[str, str]] = set()

    @property
    def unlisted_trip_without_route(self) -> int:
        return len(self._unlisted)

    @property
    def unresolved_trip_date_ids(self) -> int:
        return len(self._unresolved)

    def add(self, delivery: Delivery) -> None:
        if self._base is not None:
            raise ValueError("Summary is already finished")
        self._counts[delivery.endpoint_key][delivery.outcome] += 1
        self._polls[delivery.endpoint_key].append(replace(delivery.poll))
        if delivery.outcome == "decoded" and delivery.ref is not None:
            self._consumed.add(delivery.ref)
        if delivery.outcome == "decoded" and delivery.family == "trip_updates":
            self._observe_trips(delivery)

    def _observe_trips(self, delivery: Delivery) -> None:
        normalized = delivery.normalized
        if normalized is None or normalized.message is None:
            return
        for entity in normalized.message.entity:
            if not entity.HasField("trip_update"):
                continue
            trip = entity.trip_update.trip
            identity, raw = trip.trip_id, trip.start_date
            if not identity:
                continue
            try:
                if len(raw) != 8 or not raw.isascii() or not raw.isdigit():
                    raise ValueError("Invalid GTFS date")
                day = date(int(raw[:4]), int(raw[4:6]), int(raw[6:]))
            except ValueError:
                self._unresolved.add((identity, raw))
                continue
            if day not in self._build.schedule.days:
                continue
            listed = self._build.schedule.trip(day, identity)
            route = trip.route_id or (listed.route_id if listed is not None else "")
            if route:
                self._trips[day, route].add(identity)
            else:
                self._unlisted.add((day, identity))

    def finish(self, *, uses_schedule: bool) -> StreamSummary:
        if self._base is None:
            self._finish()
        assert self._base is not None
        if uses_schedule and "schedule_zip_unreadable" in self._build.schedule.unavailable.values():
            reasons = tuple(sorted({*self._base.incomplete_reasons, "schedule_zip_unreadable"}))
            return replace(self._base, completeness="incomplete", incomplete_reasons=reasons)
        return self._base

    def _finish(self) -> None:
        b = self._build
        verdict = judge_buildability(b)
        if verdict.state != "buildable":
            raise ValueError(f"{verdict.state}:{verdict.reason}:{verdict.detail}")
        accounting = {e: account_feed(b, e, self._polls[e]) for e in sorted(b.feeds)}
        reasons = {r.reason for r in accounting.values() if r.reason is not None}
        if any(c["unreadable"] for c in self._counts.values()):
            reasons.add("unreadable_captures")
        if any(
            r.pending_change
            and b.window_start_utc < datetime.combine(r.utc_date, time(), UTC) + timedelta(days=1)
            and datetime.combine(r.utc_date, time(), UTC) < b.window_end_utc
            for r in b.feed_days
        ):
            reasons.add("pending_change")
        matches = {}
        for key, ids in sorted(self._trips.items()):
            listed = len(ids & b.schedule.days[key[0]].trip_ids)
            matches[key] = LineMatch(len(ids), listed, line_passes_match_guard(len(ids), listed))
        self._base = StreamSummary(
            "incomplete" if reasons else "complete",
            tuple(sorted(reasons)),
            {e: dict(sorted(c.items())) for e, c in self._counts.items()},
            {e: r.accounted_share for e, r in accounting.items()},
            frozenset(self._consumed),
            consumed_set_sha256(self._consumed),
            {e: r.missing_blocks for e, r in accounting.items()},
            matches,
        )
