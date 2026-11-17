from contextlib import closing
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from test_live_captures import _parse
from test_live_facts import parsed_vehicle, seed_fact_edition, trip_message
from test_live_local_file import SETTINGS

from transit_ops.live.facts import apply_capture
from transit_ops.live.local_file import LocalFile
from transit_ops.live.running import (
    FeedPolicy,
    ScheduleInputs,
    cached_schedule,
    project_running,
    running_trips,
    service_anchor,
)

AT = datetime(2026, 6, 20, 12, 10, 0, 123456, tzinfo=UTC)
POLICY = FeedPolicy(True, 60)


class Holder:
    def __init__(self, parsed):
        self.parsed = parsed

    def latest(self):
        return self.parsed


@pytest.fixture
def local(tmp_path):
    with closing(
        LocalFile.open(tmp_path / "running.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        local.connection.execute("INSERT INTO edition_routes VALUES ('路线',3)")
        local.connection.execute("INSERT INTO edition_stops VALUES ('站',45.5,-73.5)")
        local.connection.execute(
            "INSERT INTO edition_trip_service_span VALUES ('行程','路线','S',0,360000)"
        )
        local.connection.execute("INSERT INTO edition_calendar_dates VALUES ('S','2026-06-20',1)")
        yield local


def inputs(local):
    selected = cached_schedule(local)
    return ScheduleInputs(selected, frozenset({7}), (selected,))


def project(local, parsed=None, cycle=AT):
    return project_running(
        local,
        Holder(parsed),
        inputs(local),
        provider_id="network",
        timezone="America/Toronto",
        cycle=cycle,
        trip_policy=POLICY,
        vehicle_policy=POLICY,
    )


def with_frame(schedule, name, rows):
    return replace(
        schedule, frames={**schedule.frames, name: replace(schedule.frames[name], rows=tuple(rows))}
    )


def test_missing_empty_stale_and_unsupported(local):
    before = local.connection.execute("SHOW TABLES").fetchall()
    result = project(local)
    assert result.trip_evidence.state == result.vehicle_evidence.state == "missing"
    assert result.trip_evidence.observed_count is None
    assert local.connection.execute("SHOW TABLES").fetchall() == before
    empty = _parse(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")))
    result = project(local, empty)
    assert result.trip_evidence.state == "observed-empty"
    assert result.trip_evidence.observed_count == 0
    assert project(local, empty, AT + timedelta(seconds=61)).trip_evidence.state == "stale"
    result = project_running(
        local,
        Holder(empty),
        inputs(local),
        provider_id="network",
        timezone="UTC",
        cycle=AT,
        trip_policy=FeedPolicy(False, 60),
        vehicle_policy=POLICY,
    )
    assert result.trip_evidence.state == "unsupported"


def test_scalar_and_all_current_are_distinct(local):
    one = inputs(local)
    second = replace(one.selected, edition=replace(one.selected.edition, dataset_version_id=8))
    second = with_frame(second, "edition_trip_service_span", [("other", "路线", "S", 0, 360000)])
    both = replace(one, current_ids=frozenset({7, 8}), current=(one.selected, second))
    assert running_trips(both, provider_id="network", timezone="UTC", cycle=AT) == (
        ("路线", "other"),
        ("路线", "行程"),
    )
    with pytest.raises(ValueError, match="incomplete all-current"):
        running_trips(
            replace(both, current=(one.selected,)), provider_id="network", timezone="UTC", cycle=AT
        )
    other = replace(second, edition=replace(second.edition, provider_id="other"))
    with pytest.raises(ValueError, match="provider"):
        running_trips(
            replace(both, current=(one.selected, other)),
            provider_id="network",
            timezone="UTC",
            cycle=AT,
        )
    assert (
        running_trips(
            replace(both, excluded_routes=frozenset({"路线"})),
            provider_id="network",
            timezone="UTC",
            cycle=AT,
        )
        == ()
    )


@pytest.mark.parametrize("hours", [25, 49, 100])
def test_service_over_48_hours_inclusive_boundaries(local, hours):
    one = inputs(local)
    selected = with_frame(
        one.selected,
        "edition_trip_service_span",
        [("行程", "路线", "S", hours * 3600, hours * 3600 + 60)],
    )
    one = replace(one, selected=selected, current=(selected,))
    start = datetime(2026, 6, 20, 4, tzinfo=UTC) + timedelta(hours=hours)
    for offset, expected in [
        (-1, ()),
        (0, (("路线", "行程"),)),
        (60, (("路线", "行程"),)),
        (61, ()),
    ]:
        assert (
            running_trips(
                one,
                provider_id="network",
                timezone="America/Toronto",
                cycle=start + timedelta(seconds=offset),
            )
            == expected
        )


def test_like_for_like_delay_counts_and_borrowed_frames(local):
    parsed = _parse(trip_message())
    before = parsed.frames.copy()
    row = project(local, parsed).delays[0]
    # Arrival 12:03Z - 08:00 EDT = 180 seconds; skipped child still counts as an observation.
    assert (
        row["avg_delay_seconds"],
        row["max_delay_seconds"],
        row["stop_time_observation_count"],
    ) == (Decimal("180.00"), 180, 2)
    assert type(row["stop_time_observation_count"]) is int
    assert parsed.frames == before
    local.connection.execute(
        "UPDATE edition_stop_times SET arrival_time=NULL,departure_time='08:00:00'"
    )
    assert project(local, parsed).delays == ()


@pytest.mark.parametrize("relationship", [1, 2])
def test_skipped_and_no_data_cannot_supply_delay_or_departure(local, relationship):
    message = trip_message()
    stop = message.entity[0].trip_update.stop_time_update[0]
    stop.schedule_relationship = relationship
    stop.arrival.time = int((AT + timedelta(seconds=90)).timestamp())
    result = project(local, _parse(message))
    assert result.delays == result.departures == ()


def test_cancelled_and_ambiguous_stop(local):
    message = trip_message()
    trip = message.entity[0].trip_update
    trip.trip.schedule_relationship = 3
    trip.stop_time_update[0].arrival.time = int((AT + timedelta(seconds=90)).timestamp())
    result = project(local, _parse(message))
    assert result.delays == result.departures == ()
    trip.trip.schedule_relationship = 0
    trip.stop_time_update[0].ClearField("stop_sequence")
    trip.stop_time_update[0].stop_id = "站"
    local.connection.execute(
        "INSERT INTO edition_stop_times VALUES ('行程',5,'08:00:00',NULL,'站')"
    )
    assert project(local, _parse(message)).delays == ()


def test_vehicle_empty_replaces_history_and_stale_retains_rows(local):
    apply_capture(local, parsed_vehicle(), provider_timezone="UTC")
    result = project(local)
    assert len(result.vehicles) == 3  # null coordinates excluded; valid observations retained.
    assert result.vehicle_evidence.state == "fresh"
    result = project(local, cycle=AT + timedelta(seconds=61))
    assert result.vehicle_evidence.state == "stale"
    assert len(result.vehicles) == 3
    empty = parsed_vehicle(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")))
    empty = replace(empty, capture=replace(empty.capture, capture_row_id=43))
    apply_capture(local, empty, provider_timezone="UTC")
    result = project(local)
    assert result.vehicles == ()
    assert result.vehicle_evidence.state == "observed-empty"


def test_eta_entity_ties_and_provider_dimensions(local):
    message = trip_message()
    message.entity[0].trip_update.stop_time_update[0].arrival.time = int(
        (AT + timedelta(seconds=90)).timestamp()
    )
    message.entity.add().CopyFrom(message.entity[0])
    message.entity[1].id = "second"
    apply_capture(local, parsed_vehicle(), provider_timezone="UTC")
    result = project(local, _parse(message))
    assert [r["entity_index"] for r in result.departures] == [0, 1]
    assert [r["departure_rank"] for r in result.departures] == [1, 2]
    assert result.vehicles[0]["next_stop_lat"] == 45.5
    assert result.vehicles[0]["next_stop_lon"] == -73.5


def test_naive_clock_future_and_wrong_provider_refuse(local):
    with pytest.raises(ValueError, match="aware"):
        project(local, cycle=AT.replace(tzinfo=None))
    parsed = _parse(trip_message())
    with pytest.raises(ValueError, match="identity"):
        project(local, replace(parsed, capture=replace(parsed.capture, provider_id="other")))
    with pytest.raises(ValueError, match="after cycle"):
        project(
            local,
            replace(
                parsed, capture=replace(parsed.capture, captured_at_utc=AT + timedelta(seconds=1))
            ),
        )


@pytest.mark.parametrize(
    "day,expected",
    [
        (date(2026, 3, 8), datetime(2026, 3, 8, 4, tzinfo=UTC)),
        (date(2026, 11, 1), datetime(2026, 11, 1, 5, tzinfo=UTC)),
    ],
)
def test_service_anchor_is_elapsed_twelve_hours_before_local_noon(day, expected):
    # Toronto noon is 16Z in spring and 17Z in autumn on these transition days.
    assert service_anchor(day, "America/Toronto") == expected


def test_vehicle_receives_current_delay_and_unknown_is_null(local):
    apply_capture(local, parsed_vehicle(), provider_timezone="UTC")
    result = project(local, _parse(trip_message()))
    assert result.vehicles[0]["trip_avg_delay_seconds"] == Decimal("180.00")
    assert project(local).vehicles[0]["trip_avg_delay_seconds"] is None


def test_delay_average_is_independent_integer_math(local):
    message = trip_message()
    message.entity.add().CopyFrom(message.entity[0])
    message.entity[1].id = "second"
    message.entity[1].trip_update.stop_time_update[0].arrival.time -= 60
    row = project(local, _parse(message)).delays[0]
    # (180 + 120)/2 = 150, four total children including two skipped.
    assert row["avg_delay_seconds"] == Decimal("150.00")
    assert row["max_delay_seconds"] == 180
    assert row["stop_time_observation_count"] == 4


def test_weekly_calendar_exception_and_provider_gold_route(local):
    local.connection.execute("DELETE FROM edition_calendar_dates")
    local.connection.execute(
        "INSERT INTO edition_calendar VALUES "
        "('S','2026-06-20','2026-06-20',false,false,false,false,false,true,false)"
    )
    assert project(local).running == (("路线", "行程"),)
    local.connection.execute("INSERT INTO edition_calendar_dates VALUES ('S','2026-06-20',2)")
    assert project(local).running == ()
    local.connection.execute("DELETE FROM edition_calendar_dates")
    local.connection.execute("DELETE FROM edition_routes")
    assert project(local).running == ()


def test_real_sd04_holder_borrowing_once_and_next_stop_fallback(local):
    from test_live_facts import vehicle_message

    from transit_ops.live.captures import ParsePolicy
    from transit_ops.snapshots.live_trip_updates import LiveTripUpdates

    message = trip_message()
    message.entity[0].trip_update.stop_time_update[0].arrival.time = int(AT.timestamp()) + 90
    parsed = _parse(message)
    calls = []

    def fallback():
        calls.append(True)
        return parsed

    holder = LiveTripUpdates("network", policy=ParsePolicy(None, 100), fallback=fallback)
    vehicles = vehicle_message()
    for entity in vehicles.entity:
        if entity.HasField("vehicle"):
            entity.vehicle.ClearField("stop_id")
    apply_capture(local, parsed_vehicle(vehicles), provider_timezone="UTC")
    before = parsed.frames.copy()
    for _ in range(2):
        result = project_running(
            local,
            holder,
            inputs(local),
            provider_id="network",
            timezone="America/Toronto",
            cycle=AT,
            trip_policy=POLICY,
            vehicle_policy=POLICY,
        )
        assert result.vehicles[0]["next_stop"] == "站"
        assert result.vehicles[0]["next_stop_lat"] == 45.5
    assert calls == [True]
    assert parsed.frames == before


def test_freshness_boundary_and_exact_fractional_age(local):
    empty = _parse(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")))
    result = project(local, empty, AT + timedelta(seconds=60))
    assert result.trip_evidence.state == "observed-empty"
    result = project(local, empty, AT + timedelta(seconds=60, microseconds=1))
    assert result.trip_evidence.state == "stale"
    assert result.trip_evidence.age_seconds == Decimal("60.000001")


def parse_at(message, endpoint, at):
    from hashlib import sha256

    from test_live_captures import POLICY as parse_policy

    from transit_ops.live.captures import CaptureRef, parse_capture

    payload = message.SerializeToString()
    capture = CaptureRef("network", endpoint, 42, at, at, len(payload), sha256(payload).hexdigest())
    return parse_capture(payload, capture, parse_policy)


def vehicle_without_stop(local, captured_at=AT):
    from test_live_facts import vehicle_message

    message = vehicle_message()
    for entity in message.entity:
        if entity.HasField("vehicle"):
            entity.vehicle.ClearField("stop_id")
    apply_capture(
        local,
        parse_at(message, "vehicle_positions", captured_at),
        provider_timezone="America/Toronto",
    )


def test_vehicle_fallback_uses_capture_clock_without_relaxing_departures(local):
    vehicle_without_stop(local)
    message = trip_message()
    trip = message.entity[0].trip_update
    trip.stop_time_update[0].arrival.time = int(AT.timestamp()) + 10
    trip.stop_time_update[0].stop_id = "站"
    later = trip.stop_time_update.add(stop_sequence=5, stop_id="later")
    later.arrival.time = int(AT.timestamp()) + 40
    result = project(local, _parse(message), AT + timedelta(seconds=30))
    assert result.trip_evidence.state == result.vehicle_evidence.state == "fresh"
    assert result.vehicles[0]["next_stop"] == "站"
    assert result.vehicles[0]["next_stop_lat"] == 45.5
    assert [r["stop_id"] for r in result.departures] == ["later"]


@pytest.mark.parametrize("relationship", [3, 7])
def test_removed_trip_children_cannot_seed_any_movement(local, relationship):
    vehicle_without_stop(local)
    message = trip_message()
    trip = message.entity[0].trip_update
    trip.trip.schedule_relationship = relationship
    trip.stop_time_update[0].arrival.time = int(AT.timestamp()) + 90
    parsed = _parse(message)
    assert parsed.frames["rt_trip_updates"].column("schedule_relationship") == [relationship]
    result = project(local, parsed)
    assert result.departures == result.delays == ()
    assert result.vehicles[0]["next_stop"] is None
    assert result.vehicles[0]["trip_avg_delay_seconds"] is None


def long_service_case(local, captured_at=None):
    # June 20 noon EDT is 16Z; anchor=04Z; +49h=June 22 05Z, plus 90s delay.
    at = datetime(2026, 6, 22, 5, tzinfo=UTC)
    local.connection.execute("UPDATE edition_stop_times SET arrival_time='49:00:00'")
    local.connection.execute(
        "UPDATE edition_trip_service_span SET first_seconds=176400,last_seconds=176460"
    )
    message = trip_message()
    message.entity[0].trip_update.stop_time_update[0].arrival.time = int(at.timestamp()) + 90
    message.header.timestamp = int(at.timestamp())
    captured_at = at if captured_at is None else captured_at
    return captured_at, parse_at(message, "trip_updates", captured_at)


def test_fresh_49_hour_delay_and_vehicle_are_current(local):
    at, parsed = long_service_case(local)
    vehicle_without_stop(local, at)
    result = project(local, parsed, at)
    assert result.trip_evidence.state == result.vehicle_evidence.state == "fresh"
    assert result.running == (("路线", "行程"),)
    assert result.departures[0]["predicted_departure_utc"] == datetime(
        2026, 6, 22, 5, 1, 30, tzinfo=UTC
    )
    assert result.delays[0]["avg_delay_seconds"] == Decimal("90.00")
    assert result.vehicles[0]["trip_avg_delay_seconds"] == Decimal("90.00")


def test_expired_short_service_cannot_certify_current_delay(local):
    at, parsed = long_service_case(local)
    local.connection.execute("UPDATE edition_stop_times SET arrival_time='08:00:00'")
    local.connection.execute(
        "UPDATE edition_trip_service_span SET first_seconds=28800,last_seconds=28860"
    )
    # A fresh capture carrying an old short-service event cannot certify current delay.
    message = trip_message()
    message.entity[0].trip_update.stop_time_update[0].arrival.time = int(
        datetime(2026, 6, 20, 12, 1, 30, tzinfo=UTC).timestamp()
    )
    parsed = parse_at(message, "trip_updates", at)
    vehicle_without_stop(local, at)
    result = project(local, parsed, at)
    assert result.trip_evidence.state == "fresh"
    assert result.running == result.departures == result.delays == ()
    assert result.vehicles[0]["trip_avg_delay_seconds"] is None


@pytest.mark.parametrize(
    "capture_kind",
    [
        "missing",
        "empty",
        "disabled",
        "removed",
        "skipped",
        "no-data",
        "no-children",
        "entity-deleted",
    ],
)
def test_no_applicable_trip_never_reads_static_stop_times(local, capture_kind):
    one = inputs(local)
    selected = replace(
        one.selected,
        frames={k: v for k, v in one.selected.frames.items() if k != "edition_stop_times"},
    )
    one = replace(one, selected=selected, current=(selected,))
    message = trip_message()
    if capture_kind == "removed":
        message.entity[0].trip_update.trip.schedule_relationship = 7
    if capture_kind == "skipped":
        message.entity[0].trip_update.stop_time_update[0].schedule_relationship = 1
    if capture_kind == "no-data":
        message.entity[0].trip_update.stop_time_update[0].schedule_relationship = 2
    if capture_kind == "no-children":
        message.entity[0].trip_update.ClearField("stop_time_update")
    if capture_kind == "entity-deleted":
        message.entity[0].is_deleted = True
    if capture_kind == "empty":
        message = pb.FeedMessage(header=dict(gtfs_realtime_version="2.0"))
    parsed = None if capture_kind == "missing" else _parse(message)
    result = project_running(
        local,
        Holder(parsed),
        one,
        provider_id="network",
        timezone="UTC",
        cycle=AT,
        trip_policy=FeedPolicy(capture_kind != "disabled", 60),
        vehicle_policy=POLICY,
    )
    assert result.delays == result.departures == ()


def test_schedule_matching_does_one_pass_without_copying_irrelevant_rows(local, monkeypatch):
    from transit_ops.live import running

    class CountedRows(tuple):
        scans = 0

        def __iter__(self):
            self.scans += 1
            return super().__iter__()

    one = inputs(local)
    selected = with_frame(
        one.selected,
        "edition_stop_times",
        [
            ("irrelevant", 1, "00:00:00", None, "unused"),
            ("行程", 3, "08:00:00", None, "站"),
        ],
    )
    frame = selected.frames["edition_stop_times"]
    counted = CountedRows(frame.rows)
    selected = replace(
        selected, frames={**selected.frames, frame.table: replace(frame, rows=counted)}
    )
    one = replace(one, selected=selected, current=(selected,))
    original = running._rows

    def rows(frame):
        assert frame.table != "edition_stop_times", "Do not copy the full edition into dictionaries"
        return original(frame)

    monkeypatch.setattr(running, "_rows", rows)
    message = trip_message()
    for i in range(2):
        entity = message.entity.add()
        entity.CopyFrom(message.entity[0])
        entity.id = str(i)
    result = project_running(
        local,
        Holder(_parse(message)),
        one,
        provider_id="network",
        timezone="America/Toronto",
        cycle=AT,
        trip_policy=POLICY,
        vehicle_policy=POLICY,
    )
    assert result.delays[0]["avg_delay_seconds"] == Decimal("180.00")
    assert result.delays[0]["stop_time_observation_count"] == 6
    assert counted.scans == 1


@pytest.mark.parametrize("match_kind", ["duplicate-sequence", "ambiguous-id", "sequence"])
def test_stop_index_refuses_ambiguity_but_sequence_disambiguates(local, match_kind):
    local.connection.execute(
        "INSERT INTO edition_stop_times VALUES ('行程',5,'08:00:00',NULL,'站')"
    )
    if match_kind == "duplicate-sequence":
        local.connection.execute("UPDATE edition_stop_times SET stop_sequence=3")
    message = trip_message()
    if match_kind == "ambiguous-id":
        stop = message.entity[0].trip_update.stop_time_update[0]
        stop.ClearField("stop_sequence")
        stop.stop_id = "站"
    result = project(local, _parse(message))
    if match_kind == "sequence":
        assert result.delays[0]["avg_delay_seconds"] == Decimal("180.00")
    else:
        assert result.delays == ()


@pytest.mark.parametrize(
    "offset,available", [(-3601, False), (-3600, True), (3600, True), (3601, False)]
)
def test_elapsed_service_delay_window_preserves_one_hour_bounds(local, offset, available):
    cycle = datetime(2026, 6, 22, 5, tzinfo=UTC) + timedelta(seconds=offset)
    _, parsed = long_service_case(local, captured_at=cycle)
    result = project(local, parsed, cycle)
    assert bool(result.delays) is available
