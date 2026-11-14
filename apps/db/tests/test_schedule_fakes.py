from dataclasses import replace
from datetime import date

import pytest
from schedule_fakes import FakeTrip, fake_schedule, fake_trip

from transit_ops.providers import schedule as sc

DAY = date(2026, 3, 8)


def test_edition_reads_without_dates_and_dated_reads_agree():
    trip = fake_trip("t", "r", [("a", None, 90060), ("b", 93600, None)], first_stop_sequence=5)
    empty = fake_schedule({17: [trip]}, {})
    dated = fake_schedule({17: [trip]}, {DAY: 17})
    assert empty.trip_in_edition(17, "t") == dated.trip(DAY, "t") == trip.trip
    assert empty.stop_times_in_edition(17, "t") == dated.stop_times(DAY, "t") == trip.stop_times
    assert (trip.trip.first_stop_sequence, trip.trip.first_departure_s) == (5, 90060)
    assert (trip.trip.last_arrival_s, trip.trip.frequency_based) == (93600, False)
    assert dated.service_day_start(DAY).isoformat() == "2026-03-08T04:00:00+00:00"


def test_edition_isolation_missing_values_and_refusals():
    a, b = (fake_trip("t", r, [("a", 10, 20)]) for r in ("r", "other"))
    ctx = fake_schedule({17: [a], 18: [b]}, {DAY: 18})
    assert ctx.trip_in_edition(17, "t").route_id == "r"
    assert ctx.trip(DAY, "t").route_id == "other"
    for method in (ctx.trip_in_edition, ctx.stop_times_in_edition, ctx.stop_in_edition):
        assert method(17, "missing") == (() if method == ctx.stop_times_in_edition else None)
        with pytest.raises(sc.EditionNotAvailable) as error:
            method(99, "t")
        assert error.value.dataset_version_id == 99
    with pytest.raises(sc.InvalidScheduleEdition, match="duplicate_trip_ids"):
        fake_schedule({17: [a, a]}, {})
    for stops in ([], [("a", 1, None)], [("a", None, 1)]):
        with pytest.raises(ValueError, match="missing_required_endpoints"):
            fake_trip("t", "r", stops)


def test_optional_fields_unavailable_dates_and_frozen_inputs():
    base = fake_trip("t", "r", [("a", None, 10), ("b", 20, None)])
    rows = [replace(base.stop_times[0], timepoint=0, shape_dist_traveled=12.5), base.stop_times[1]]
    value = FakeTrip(replace(base.trip, shape_id="shape"), rows)
    stop = sc.ScheduledStop("a", 45.0, -75.0, 1, "parent")
    stops = [stop]
    editions, dates, unavailable = {17: [value]}, {DAY: 17}, {date(2026, 3, 9): "unreadable"}
    ctx = fake_schedule(editions, dates, unavailable=unavailable, stops=stops)
    same = fake_schedule(editions, dates, unavailable=unavailable, stops=stops)
    assert ctx.context_id == same.context_id
    assert ctx.context_id != fake_schedule(editions, {}).context_id
    editions.clear(), dates.clear(), unavailable.clear(), stops.clear(), rows.clear()
    assert ctx.stop_times(DAY, "t") == same.stop_times(DAY, "t")
    assert ctx.stop_times(DAY, "t")[0] == sc.ScheduledStopTime(1, "a", None, 10, 0, 12.5)
    assert ctx.stop(DAY, "a") == ctx.stop_in_edition(17, "a") == stop
    assert ctx.trip(DAY, "t").shape_id == "shape"
    assert ctx.unavailable == {date(2026, 3, 9): "unreadable"}
    with pytest.raises(KeyError):
        ctx.trip(date(2026, 3, 9), "t")
    with pytest.raises(TypeError):
        ctx.days[DAY] = None
    with pytest.raises(ValueError, match="overlap"):
        fake_schedule({17: [value]}, {DAY: 17}, unavailable={DAY: "unreadable"})
