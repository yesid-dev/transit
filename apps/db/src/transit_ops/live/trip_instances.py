"""Adapt the loaded service-day schedules to the shared instance resolver."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from transit_ops.gold.vehicle_instance_rule import TripInstance, VehicleDescriptor
from transit_ops.gtfs.trip_identity import reported_service_date, resolve_trip_instance
from transit_ops.providers.schedule import service_day_start

if TYPE_CHECKING:
    from transit_ops.live.silent_trips import TripSpan

REMOVED_TRIPS = frozenset({3, 7})


def position_publication(row: Mapping[str, Any], captured: datetime) -> datetime:
    observed = row.get("observed_at")
    return min(datetime.fromisoformat(observed), captured) if observed else captured


class LiveTripInstances:
    def __init__(self, days: Mapping[date, Mapping[str, TripSpan]], zone: ZoneInfo):
        self.days = days
        self.anchors = {day: service_day_start(day, zone) for day in days}
        self._candidates: dict[str, tuple[TripInstance, ...]] = {}

    def resolve(
        self, row: Mapping[str, Any], captured: datetime, *, update: bool = False
    ) -> tuple[TripInstance | None, bool]:
        if not (trip_id := row.get("trip_id")):
            return None, False
        if trip_id not in self._candidates:
            self._candidates[trip_id] = tuple(
                TripInstance(
                    trip_id,
                    day,
                    self.anchors[day] + timedelta(seconds=span.first),
                    self.anchors[day] + timedelta(seconds=span.last),
                    span.first,
                )
                for day, trips in self.days.items()
                if (span := trips.get(trip_id)) is not None
            )
        if not self._candidates[trip_id]:
            return None, False

        prediction = None
        if update:
            stamp = row.get("_published_at")
            published = datetime.fromtimestamp(stamp, UTC) if stamp is not None else captured
            published_second = published.timestamp()
            next_stamp = min(
                (
                    value
                    for stop in row.get("stops", ())
                    if stop["relationship"] not in (1, 2)
                    for value in (stop["arrival"], stop["departure"])
                    if value is not None and value >= published_second
                ),
                default=None,
            )
            if next_stamp is not None:
                try:
                    prediction = datetime.fromtimestamp(next_stamp, UTC)
                except (ValueError, OverflowError, OSError):
                    pass
        else:
            published = position_publication(row, captured)

        date_hint = row.get("start_date")
        return resolve_trip_instance(
            published,
            self._candidates[trip_id],
            VehicleDescriptor(
                reported_service_date(date_hint) if date_hint else None, row.get("start_time") or ""
            ),
            advance_notice=update,
            removed=update and row["relationship"] in REMOVED_TRIPS,
            next_prediction=prediction,
        )
