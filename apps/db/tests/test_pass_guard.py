from dataclasses import replace
from datetime import timedelta

import pytest
from google.transit.gtfs_realtime_pb2 import FeedMessage
from schedule_fakes import fake_schedule, fake_trip
from test_pass_judge import AT, build
from test_pass_summary import observation

from transit_ops.daily_pass import LineMatch, StreamAccumulator


def message(n=5, raw="20260102", route="R"):
    m = FeedMessage()
    m.header.gtfs_realtime_version = "2.0"
    for i in range(n):
        e = m.entity.add(id=str(i))
        e.trip_update.trip.trip_id = str(i)
        e.trip_update.trip.start_date = raw
        if route:
            e.trip_update.trip.route_id = route
    return m


def scheduled(n=3):
    return fake_schedule(
        {1: [fake_trip(str(i), "R", [("s", 0, 0)]) for i in range(n)]},
        {AT.date(): 1, (AT + timedelta(days=1)).date(): 1},
    )


@pytest.mark.parametrize("n,listed,expected", [(5, 3, False), (4, 0, True), (5, 4, True)])
def test_line_under_eighty_percent_with_five_trips_fails_the_guard(n, listed, expected):
    b = replace(build(seconds=60), schedule=scheduled(listed))
    a = StreamAccumulator(b)
    a.add(observation(b, message=message(n)))
    assert a.finish(uses_schedule=True).line_match == {
        (AT.date(), "R"): LineMatch(n, listed, expected)
    }


def test_repeated_trip_observations_count_once_per_date_and_line():
    b = replace(
        build(seconds=60),
        schedule=fake_schedule(
            {1: [fake_trip("0", "R", [("s", 0, 0)])], 2: []},
            {AT.date(): 1, (AT + timedelta(days=1)).date(): 2},
        ),
    )
    a = StreamAccumulator(b)
    for raw in ("20260102", "20260103", "20260102"):
        a.add(observation(b, message=message(1, raw), in_service_day=False))
    d = observation(b, message=message())
    a.add(replace(d, family="vehicle_positions"))
    a.add(replace(d, family="alerts"))
    assert a.finish(uses_schedule=True).line_match == {
        (AT.date(), "R"): LineMatch(1, 1, True),
        ((AT + timedelta(days=1)).date(), "R"): LineMatch(1, 0, True),
    }


def test_unlisted_trip_without_route_has_no_line_guard():
    b = replace(build(seconds=60), schedule=scheduled(1))
    a = StreamAccumulator(b)
    for _ in range(2):
        a.add(observation(b, message=message(3, route="")))
    assert a.finish(uses_schedule=True).line_match == {(AT.date(), "R"): LineMatch(1, 1, True)}
    assert a.unlisted_trip_without_route == 2
    with pytest.raises(AttributeError):
        a.unlisted_trip_without_route = 9


def test_unresolved_trip_date_is_not_the_capture_date():
    b = replace(build(seconds=60), schedule=scheduled())
    a = StreamAccumulator(b)
    for raw in ("", "20260230", "2026-01-02", "20260230"):
        a.add(observation(b, message=message(2, raw)))
    assert a.finish(uses_schedule=True).line_match == {}
    assert a.unresolved_trip_date_ids == 6


def test_missing_schedule_does_not_become_zero_service():
    for available in (False, True):
        b = build(seconds=60)
        if available:
            b = replace(b, schedule=scheduled(0))
        a = StreamAccumulator(b)
        a.add(observation(b, message=message()))
        assert a.finish(uses_schedule=True).line_match == (
            {(AT.date(), "R"): LineMatch(5, 0, False)} if available else {}
        )


def test_accumulator_leaves_normalized_messages_unchanged():
    b = replace(build(seconds=60), schedule=scheduled(1))
    a = StreamAccumulator(b)
    for route in ("", "declared route"):
        d = observation(b, message=message(2, route=route))
        before = d.normalized.message.SerializeToString()
        a.add(d)
        assert d.normalized.message.SerializeToString() == before
    assert a.finish(uses_schedule=True).line_match[(AT.date(), "declared route")] == LineMatch(
        2, 1, True
    )


def test_stale_usable_schedule_uses_the_same_match_guard():
    test_line_under_eighty_percent_with_five_trips_fails_the_guard(5, 3, False)
