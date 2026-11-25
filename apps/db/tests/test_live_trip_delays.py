import sqlite3
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from transit_ops.live.silent_trips import TripSpan
from transit_ops.live.trip_delays import reconcile_delays
from transit_ops.live.trip_schedule import DaySchedule

ZONE = ZoneInfo("America/Toronto")
NOW = datetime(2026, 11, 25, 6, 14, tzinfo=UTC)
DAY = date(2026, 11, 24)
EXPECTED = int(datetime(2026, 11, 25, 6, 15, tzinfo=UTC).timestamp())


def position(trip="T", sequence=3, stop="stop", *, day="20261124"):
    return {
        "trip_id": trip,
        "stop_sequence": sequence,
        "stop_id": stop,
        "start_date": day,
        "start_time": "25:10:00",
        "direction_id": 0,
    }


def call(*, arrival=None, departure=None, status=0, stop="stop", sequence=3, delay=None):
    return {
        "sequence": sequence,
        "stop_id": stop,
        "relationship": status,
        "arrival": arrival,
        "departure": departure,
        "arrival_delay": delay,
        "departure_delay": None,
    }


def report(*stops, trip="T", status=0, age=0, delay=None, day="20261124"):
    return {
        "trip_id": trip,
        "route_id": "A",
        "direction_id": 0,
        "start_date": day,
        "start_time": None,
        "relationship": status,
        "observed_at": int(NOW.timestamp()) - age,
        "delay": delay,
        "stops": list(stops),
    }


def schedule(tmp_path, day=DAY, first=90600, stop_time=90900):
    path = tmp_path / f"{day}.sqlite"
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(
            "CREATE TABLE stops (trip TEXT, seq INTEGER, stop TEXT,"
            " arrival INTEGER, departure INTEGER)"
        )
        conn.executemany(
            "INSERT INTO stops VALUES (?, ?, ?, ?, ?)",
            [
                ("T", 3, "stop", stop_time, stop_time + 30),
                ("T", 5, "terminus", stop_time + 300, None),
                ("T", 6, "loop", stop_time + 420, stop_time + 440),
                ("T", 7, "loop", stop_time + 540, stop_time + 560),
            ],
        )
    return {day: DaySchedule(path, {"T": TripSpan("T", "A", first, stop_time + 540, 0)})}


@pytest.mark.parametrize("difference", [-61, -60, 0, 300, 301])
def test_midnight_matches_absolute_arrival_and_retains_second_boundaries(tmp_path, difference):
    positions, trips = reconcile_delays(
        [position()],
        [report(call(arrival=EXPECTED + difference))],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
    )
    assert positions[0]["delay"] == difference
    assert trips[0]["stops"][0]["arrival_delay"] == difference


def test_departure_is_used_without_arrival_or_position_stop_identity(tmp_path):
    positions, trips = reconcile_delays(
        [position(sequence=None, stop=None)],
        [report(call(departure=EXPECTED + 22, stop=None))],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
    )
    assert positions[0]["delay"] == -8
    assert trips[0]["stops"][0]["stop_id"] == "stop"
    assert trips[0]["stops"][0]["departure_delay"] == -8


def test_feed_delays_take_precedence(tmp_path):
    positions, trips = reconcile_delays(
        [position()],
        [report(call(arrival=EXPECTED + 300, delay=0), delay=15)],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
    )
    assert positions[0]["delay"] == 0
    assert trips[0]["delay"] == 15


@pytest.mark.parametrize(
    "updates",
    [
        [report(call(arrival=EXPECTED, delay=10), status=1)],
        [report(call(arrival=EXPECTED, delay=10), trip="unscheduled")],
        [report(call(arrival=EXPECTED, delay=10), age=90)],
        [report(call(arrival=EXPECTED, delay=10)), report(call(arrival=EXPECTED, delay=10))],
        [report(call(arrival=EXPECTED, delay=10, status=1))],
        [report(call(arrival=EXPECTED, delay=10, stop="other"))],
        [report(call(arrival=EXPECTED, delay=10, stop="loop", sequence=None))],
        [report(call(arrival=EXPECTED, delay=10), day="20261125")],
    ],
)
def test_does_not_label_unmatched_ambiguous_or_stale_predictions(tmp_path, updates):
    positions, trips = reconcile_delays(
        [position()],
        updates,
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
    )
    assert positions[0]["delay"] is None
    assert all(trip["stops"][0]["arrival_delay"] is None for trip in trips)


@pytest.mark.parametrize(
    ("day", "utc_arrival", "scheduled"),
    [
        (date(2026, 3, 8), datetime(2026, 3, 8, 6, 15, tzinfo=UTC), 8100),
        (date(2026, 11, 1), datetime(2026, 11, 1, 5, 15, tzinfo=UTC), 900),
        (date(2026, 11, 1), datetime(2026, 11, 1, 6, 15, tzinfo=UTC), 4500),
    ],
)
def test_elapsed_schedule_handles_clock_changes(tmp_path, day, utc_arrival, scheduled):
    instant = utc_arrival - timedelta(seconds=50)
    vehicle = {**position(day=day.strftime("%Y%m%d")), "start_time": None}
    update = {
        **report(call(arrival=int(utc_arrival.timestamp()) + 42), day=day.strftime("%Y%m%d")),
        "observed_at": int(instant.timestamp()),
    }
    positions, _ = reconcile_delays(
        [vehicle],
        [update],
        schedule(tmp_path, day, scheduled - 60, scheduled),
        ZONE,
        instant,
        update_window=90,
    )
    assert positions[0]["delay"] == 42
