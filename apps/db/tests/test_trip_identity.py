"""Trip identity across clock changes, for feeds that send start_time but no start_date."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from transit_ops.gold.vehicle_instance_rule import TripInstance, VehicleDescriptor
from transit_ops.gtfs.trip_identity import feed_start_seconds, resolve_trip_instance
from transit_ops.providers.schedule import service_day_start

OTTAWA = ZoneInfo("America/Toronto")
FALL_BACK = date(2026, 11, 1)  # 25 hours: 02:00 EDT becomes 01:00 EST
SPRING_FORWARD = date(2027, 3, 14)  # 23 hours: 02:00 EST becomes 03:00 EDT
PLAIN_SUNDAY = date(2026, 11, 8)


def _instance(day: date, first: int, minutes: int = 40) -> TripInstance:
    anchor = service_day_start(day, OTTAWA)
    start = anchor + timedelta(seconds=first)
    return TripInstance("trip", day, start, start + timedelta(minutes=minutes), first)


def _clock(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _resolve(instance: TripInstance, start_time: str) -> TripInstance | None:
    # The vehicle reports ten minutes into the trip, with start_time but no start_date.
    captured = instance.start_utc + timedelta(minutes=10)
    accepted, _ = resolve_trip_instance(
        captured,
        (instance,),
        VehicleDescriptor(None, start_time),
        advance_notice=False,
        timezone=OTTAWA,
    )
    return accepted


@pytest.mark.parametrize(
    ("day", "offset"),
    [(FALL_BACK, 3600), (SPRING_FORWARD, -3600), (PLAIN_SUNDAY, 0)],
)
def test_a_start_time_counted_from_midnight_matches_on_its_day(day: date, offset: int) -> None:
    # 10:00 by GTFS service time (noon minus twelve hours). Counted from local
    # midnight, the same departure is 11:00 on the fall-back day and 09:00 on the
    # spring-forward day.
    trip = _instance(day, 10 * 3600)
    assert trip.start_utc.astimezone(OTTAWA).hour == 10
    assert feed_start_seconds(trip, OTTAWA) == {10 * 3600, 10 * 3600 + offset}
    assert _resolve(trip, "10:00:00") == trip
    assert _resolve(trip, _clock(10 * 3600 + offset)) == trip
    midnight = datetime.combine(day, datetime.min.time(), OTTAWA)
    elapsed = int((trip.start_utc - midnight).total_seconds())
    assert elapsed == 10 * 3600 + offset


def test_an_hour_off_start_time_still_misses_on_an_ordinary_day() -> None:
    trip = _instance(PLAIN_SUNDAY, 10 * 3600)
    assert _resolve(trip, "11:00:00") is None
    assert _resolve(trip, "09:00:00") is None


def test_without_a_timezone_only_the_gtfs_time_matches() -> None:
    trip = _instance(FALL_BACK, 10 * 3600)
    assert feed_start_seconds(trip, None) == {10 * 3600}
    accepted, _ = resolve_trip_instance(
        trip.start_utc + timedelta(minutes=10),
        (trip,),
        VehicleDescriptor(None, "11:00:00"),
        advance_notice=False,
    )
    assert accepted is None


def test_early_morning_trips_on_the_fall_back_day_match_too() -> None:
    # 00:30 service time is 01:30 EDT, before the clock goes back; counted from
    # midnight it is still one hour more, 01:30.
    trip = _instance(FALL_BACK, 30 * 60, minutes=50)
    assert _resolve(trip, "01:30:00") == trip
    assert _resolve(trip, "00:30:00") == trip
