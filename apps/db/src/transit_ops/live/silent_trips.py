"""Count scheduled trips with no recent position, at the publisher's clock."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.live.trip_instances import REMOVED_TRIPS, LiveTripInstances, position_publication
from transit_ops.providers.schedule import service_day_start

REPORT_WINDOW_SECONDS = 90
START_GRACE_SECONDS = 300
UNMEASURED = {
    "scheduled_now": None,
    "non_responding": None,
    "cancelled_now": None,
    "non_responding_by_route": None,
}


@dataclass(frozen=True, slots=True)
class TripSpan:
    trip_id: str
    route_id: str
    first: int
    last: int
    direction_id: int | None = None


def count_silent_trips(
    now: datetime,
    zone: ZoneInfo,
    days: Mapping[date, tuple[TripSpan, ...]],
    *,
    reports: Iterable[tuple[str, date]],
    cancellations: Iterable[tuple[str, date]],
) -> dict[str, object]:
    reported = set(reports)
    cancelled = set(cancellations)
    silent_by_route: Counter[str] = Counter()
    scheduled = cancelled_now = 0
    for day, trips in days.items():
        elapsed = (now - service_day_start(day, zone)).total_seconds()
        for trip in trips:
            if not trip.first <= elapsed < trip.last:
                continue
            key = (trip.trip_id, day)
            if key in cancelled:
                cancelled_now += 1
                continue
            scheduled += 1
            if elapsed >= trip.first + START_GRACE_SECONDS and key not in reported:
                silent_by_route[trip.route_id] += 1
    return {
        "scheduled_now": scheduled,
        "non_responding": silent_by_route.total(),
        "cancelled_now": cancelled_now,
        "non_responding_by_route": [
            {"route_id": line, "count": count} for line, count in sorted(silent_by_route.items())
        ],
    }


def feed_is_fresh(feed: dict[str, Any], now: datetime) -> bool:
    captured = feed["captured_at"]
    if not captured or feed["read_failed"]:
        return False
    age = (now - datetime.fromisoformat(captured)).total_seconds()
    observed = datetime.fromisoformat(feed["source_at"] or captured)
    source_age = (now - observed).total_seconds()
    limit = feed["fresh_for_seconds"]
    return 0 <= age < limit and -5 <= source_age < limit + feed["source_lag_seconds"]


class TripReporting:
    """Retain position evidence for the live window across full capture frames."""

    def __init__(self, source_lag_seconds: int):
        self.window = REPORT_WINDOW_SECONDS + source_lag_seconds
        self.reports: dict[tuple[str, date], datetime] = {}

    def observe(
        self, snapshot: Mapping[str, Any], now: datetime, instances: LiveTripInstances
    ) -> tuple[set[tuple[str, date]], set[tuple[str, date]]] | None:
        feeds = list(snapshot["feeds"].values())
        movement = [
            feed for feed in feeds if feed["family"] in ("vehicle_positions", "trip_updates")
        ]
        positions = [feed for feed in movement if feed["family"] == "vehicle_positions"]
        vehicles = snapshot["vehicle_positions"] or ()
        if not positions or not all(feed_is_fresh(feed, now) for feed in positions):
            return None
        captured = min(datetime.fromisoformat(feed["captured_at"]) for feed in positions)
        self.reports = {
            key: stamp
            for key, stamp in self.reports.items()
            if (now - stamp).total_seconds() < self.window
        }
        for vehicle in vehicles:
            if not vehicle["trip_id"]:
                continue
            stamp = (
                datetime.fromisoformat(vehicle["observed_at"])
                if vehicle["observed_at"]
                else captured
            )
            if -5 <= (now - stamp).total_seconds() < self.window:
                instance, _ = instances.resolve(vehicle, captured)
                if instance is not None:
                    key = (instance.trip_id, instance.service_date)
                    published = position_publication(vehicle, captured)
                    self.reports[key] = max(published, self.reports.get(key, published))
        if not any(vehicle["trip_id"] for vehicle in vehicles) or not all(
            feed_is_fresh(feed, now) for feed in movement
        ):
            return None
        cancelled = {
            (instance.trip_id, instance.service_date)
            for row in snapshot["trip_updates"] or ()
            if row["relationship"] in REMOVED_TRIPS
            if (instance := instances.resolve(row, now, update=True)[0]) is not None
        }
        return set(self.reports), cancelled
