import sqlite3
from collections import Counter
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
                ("T", 2, "previous", stop_time - 60, stop_time - 30),
                ("T", 3, "stop", stop_time, stop_time + 30),
                ("T", 4, "next", stop_time + 120, stop_time + 150),
                ("T", 5, "terminus", stop_time + 300, None),
                ("T", 6, "loop", stop_time + 420, stop_time + 440),
                ("T", 7, "loop", stop_time + 540, stop_time + 560),
            ],
        )
    return {day: DaySchedule(path, {"T": TripSpan("T", "A", first, stop_time + 540, 0)})}


@pytest.mark.parametrize(
    ("vehicle", "stops", "expected"),
    [
        (position(), [call(sequence=4, stop="next", arrival=EXPECTED + 145)], 25),
        (
            position(),
            [
                call(sequence=4, stop="next", arrival=EXPECTED + 145),
                call(arrival=EXPECTED + 10),
            ],
            10,
        ),
        (position(), [call(sequence=2, stop="previous", arrival=EXPECTED + 5)], None),
        (
            position(sequence=None, stop="loop"),
            [call(sequence=7, stop="loop", arrival=EXPECTED + 560)],
            None,
        ),
        (
            position(),
            [
                call(sequence=4, stop="next", status=1),
                call(sequence=5, stop="terminus", arrival=EXPECTED + 350),
            ],
            50,
        ),
        (
            position(sequence=None),
            [call(sequence=4, stop="next", arrival=EXPECTED + 145)],
            25,
        ),
        (
            position(stop="next"),
            [call(sequence=4, stop="next", arrival=EXPECTED + 145)],
            None,
        ),
        (
            position(),
            [
                call(sequence=5, stop="terminus", arrival=EXPECTED + 100),
                call(sequence=4, stop="next", arrival=EXPECTED + 145),
            ],
            25,
        ),
        (
            position(),
            [
                call(sequence=4, stop="next", arrival=EXPECTED - 80),
                call(sequence=5, stop="terminus", arrival=EXPECTED + 350),
            ],
            50,
        ),
    ],
    ids=[
        "reported call dropped",
        "reported call preferred",
        "never use preceding call",
        "unqualified loop stop",
        "skip and advance",
        "resolve stop id from schedule",
        "conflicting stop and sequence",
        "advance by sequence",
        "skip expired predictions",
    ],
)
def test_vehicle_uses_first_usable_call_at_or_after_reported_stop(
    tmp_path, vehicle, stops, expected
):
    vehicles, _ = reconcile_delays(
        [vehicle], [report(*stops)], schedule(tmp_path), ZONE, NOW, update_window=90
    )
    assert vehicles[0]["delay"] == expected


def test_coverage_counts_identified_vehicles_and_why_delays_are_missing(tmp_path):
    coverage = Counter()
    day = schedule(tmp_path)
    reconcile_delays(
        [
            position(),
            position(sequence=None, stop="loop"),
            position(trip="absent"),
            position(trip=None),
        ],
        [report(call(sequence=4, stop="next", status=1))],
        day,
        ZONE,
        NOW,
        update_window=90,
        coverage=coverage,
    )
    reconcile_delays([position()], [], day, ZONE, NOW, update_window=90, coverage=coverage)
    assert coverage == {"skipped": 1, "ambiguous": 1, "no_schedule": 1, "no_update": 1}


def test_dated_trip_matches_when_both_feeds_disagree_with_scheduled_direction(tmp_path):
    vehicle = {**position(), "direction_id": 1}
    update = {**report(call(arrival=EXPECTED + 15)), "direction_id": 1}
    positions, trips = reconcile_delays(
        [vehicle], [update], schedule(tmp_path), ZONE, NOW, update_window=90
    )
    assert positions[0]["delay"] == trips[0]["stops"][0]["arrival_delay"] == 15


def test_unchanged_prediction_in_fresh_feed_remains_usable(tmp_path):
    positions, trips = reconcile_delays(
        [position()],
        [report(call(arrival=EXPECTED + 20), age=1200)],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
    )
    assert positions[0]["delay"] == trips[0]["stops"][0]["arrival_delay"] == 20


@pytest.mark.parametrize(
    ("following", "expected", "reason"),
    [
        ([call(sequence=4, stop="next", arrival=EXPECTED + 145)], 25, "delay"),
        ([call(sequence=4, stop="next", arrival=EXPECTED - 480)], None, "expired"),
        ([], None, "expired"),
    ],
)
def test_expired_reported_call_cannot_supply_a_delay(tmp_path, following, expected, reason):
    coverage = Counter()
    old = call(arrival=int(NOW.timestamp()) - 600, delay=5)
    positions, trips = reconcile_delays(
        [position()],
        [report(old, *following, delay=25)],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
        coverage=coverage,
    )
    assert positions[0]["delay"] == expected
    assert trips[0]["stops"][0]["arrival"] == old["arrival"]
    assert trips[0]["stops"][0]["arrival_delay"] is None
    assert coverage == {reason: 1}


def test_call_at_tolerance_uses_latest_arrival_or_departure(tmp_path):
    stop = call(
        arrival=int(NOW.timestamp()) - 600,
        departure=int(NOW.timestamp()) - 90,
        delay=12,
    )
    positions, trips = reconcile_delays(
        [position()], [report(stop)], schedule(tmp_path), ZONE, NOW, update_window=90
    )
    assert positions[0]["delay"] == trips[0]["stops"][0]["arrival_delay"] == 12


def test_stale_trip_feed_clears_vehicle_and_stop_delay(tmp_path):
    positions, trips = reconcile_delays(
        [position()],
        [report(call(arrival=EXPECTED, delay=15), delay=15)],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=0,
    )
    assert positions[0]["delay"] is None
    assert trips[0]["delay"] is None
    assert trips[0]["stops"][0]["arrival_delay"] is None


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
        [report(call(arrival=EXPECTED, delay=10)), report(call(arrival=EXPECTED, delay=10))],
        [report(call(arrival=EXPECTED, delay=10, status=1))],
        [report(call(arrival=EXPECTED, delay=10, stop="other"))],
        [report(call(arrival=EXPECTED, delay=10, stop="loop", sequence=None))],
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


@pytest.mark.parametrize("hint", ["20261124", "20261125"])
def test_midnight_position_and_update_use_running_service_day(tmp_path, hint):
    now = datetime(2026, 11, 25, 5, 30, tzinfo=UTC)
    predicted = int(datetime(2026, 11, 25, 5, 35, tzinfo=UTC).timestamp()) + 45
    vehicle = {**position(day=hint), "start_time": "24:10:00", "observed_at": now.isoformat()}
    update = report(call(arrival=predicted), day=hint)
    positions, trips = reconcile_delays(
        [vehicle],
        [update],
        schedule(tmp_path, first=87000, stop_time=88500),
        ZONE,
        now,
        update_window=90,
    )
    assert positions[0]["delay"] == trips[0]["stops"][0]["arrival_delay"] == 45


@pytest.mark.parametrize(
    ("previous_day", "now_utc", "scheduled_utc", "hint"),
    [
        (date(2026, 3, 7), "2026-03-08T07:10:00+00:00", "2026-03-08T07:20:00+00:00", "20260308"),
        (date(2026, 10, 31), "2026-11-01T06:10:00+00:00", "2026-11-01T06:20:00+00:00", "20261101"),
    ],
)
def test_calendar_date_hint_does_not_lose_overnight_trip_on_clock_change(
    tmp_path, previous_day, now_utc, scheduled_utc, hint
):
    now = datetime.fromisoformat(now_utc)
    predicted = int(datetime.fromisoformat(scheduled_utc).timestamp()) + 25
    vehicle = {**position(day=hint), "start_time": "25:50:00", "observed_at": now_utc}
    positions, updates = reconcile_delays(
        [vehicle],
        [report(call(arrival=predicted), day=hint)],
        schedule(tmp_path, previous_day, 93000, 94800),
        ZONE,
        now,
        update_window=90,
    )
    assert positions[0]["delay"] == updates[0]["delay"] == 25


@pytest.mark.parametrize(
    ("day", "first", "stop_time", "absolute"),
    [
        (DAY, 93000, 93300, "2026-11-25T06:55:00+00:00"),
        (date(2026, 11, 25), 21600, 21900, "2026-11-25T11:05:00+00:00"),
    ],
)
def test_midnight_advance_notice_uses_scheduled_service_day(
    tmp_path, day, first, stop_time, absolute
):
    now = datetime(2026, 11, 25, 5, 30, tzinfo=UTC)
    predicted = int(datetime.fromisoformat(absolute).timestamp()) + 75
    update = report(call(arrival=predicted), day="20261125")
    _, trips = reconcile_delays(
        None, [update], schedule(tmp_path, day, first, stop_time), ZONE, now, update_window=90
    )
    assert trips[0]["stops"][0]["arrival_delay"] == 75


@pytest.mark.parametrize(
    ("arrival", "delay"),
    [(EXPECTED + 86400, None), (EXPECTED, -86400), (EXPECTED, 86400)],
)
def test_delays_beyond_cleaner_sanity_bound_are_never_published(tmp_path, arrival, delay):
    positions, trips = reconcile_delays(
        [position()],
        [report(call(arrival=arrival), delay=delay)],
        schedule(tmp_path),
        ZONE,
        NOW,
        update_window=90,
    )
    assert (
        positions[0]["delay"] is trips[0]["delay"] is trips[0]["stops"][0]["arrival_delay"] is None
    )
