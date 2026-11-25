"""Count scheduled trips with no recent position, at the publisher's clock."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from heapq import nsmallest
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.live.trip_instances import REMOVED_TRIPS, LiveTripInstances, position_publication
from transit_ops.providers.schedule import service_day_start

REPORT_WINDOW_SECONDS = 90
START_GRACE_SECONDS = 300
SILENT_TRIP_LIMIT = 100
UNMEASURED = {
    "scheduled_now": None,
    "non_responding": None,
    "cancelled_now": None,
    "non_responding_by_route": None,
    "silent_trips": None,
}


@dataclass(frozen=True, slots=True)
class TripSpan:
    trip_id: str
    route_id: str
    first: int
    last: int
    direction_id: int | None = None
    headsign: str | None = None


def count_silent_trips(
    now: datetime,
    zone: ZoneInfo,
    days: Mapping[date, tuple[TripSpan, ...]],
    *,
    reports: Iterable[tuple[str, date]],
    cancellations: Iterable[tuple[str, date]],
    history: Mapping[tuple[str, date], datetime] | None = None,
) -> dict[str, object]:
    reported = set(reports)
    cancelled = set(cancellations)
    silent_by_route: Counter[str] = Counter()
    silent = []
    scheduled = cancelled_now = 0
    for day, trips in days.items():
        anchor = service_day_start(day, zone)
        elapsed = (now - anchor).total_seconds()
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
                departure = anchor + timedelta(seconds=trip.first)
                observed = history.get(key) if history is not None else None
                silent.append((observed or departure, day, trip, departure, observed))
    longest = nsmallest(
        SILENT_TRIP_LIMIT, silent, key=lambda item: (item[0], item[1], item[2].trip_id)
    )
    return {
        "scheduled_now": scheduled,
        "non_responding": silent_by_route.total(),
        "cancelled_now": cancelled_now,
        "non_responding_by_route": [
            {"route_id": line, "count": count} for line, count in sorted(silent_by_route.items())
        ],
        "silent_trips": [
            {
                "trip_id": trip.trip_id,
                "route_id": trip.route_id,
                "direction_id": trip.direction_id,
                "departure": {
                    "service_seconds": trip.first,
                    "local_time": departure.astimezone(zone).strftime("%H:%M"),
                },
                "silent_since": observed.astimezone(UTC).isoformat() if observed else None,
                "silent_for_seconds": int((now - since).total_seconds()),
            }
            for since, _, trip, departure, observed in longest
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
        self.last_positions: dict[tuple[str, date], datetime] = {}

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
        if instances.days:
            self.last_positions = {
                key: stamp for key, stamp in self.last_positions.items() if key[1] in instances.days
            }
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
            age = (now - stamp).total_seconds()
            if age < -5:
                continue
            instance, _ = instances.resolve(vehicle, captured)
            if instance is None:
                continue
            key = (instance.trip_id, instance.service_date)
            if age < self.window:
                published = position_publication(vehicle, captured)
                self.reports[key] = max(published, self.reports.get(key, published))
            if vehicle["observed_at"]:
                self.last_positions[key] = max(stamp, self.last_positions.get(key, stamp))
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
