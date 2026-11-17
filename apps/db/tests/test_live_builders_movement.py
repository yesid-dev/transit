import json
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from test_live_captures import _parse
from test_live_facts import parsed_vehicle, trip_message, vehicle_message
from test_live_local_file import CAPTURE, POLL
from test_live_running import AT, Holder, inputs
from test_live_running import local as local

from transit_ops.live.builders_movement import build_movement
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.facts import apply_capture
from transit_ops.live.local_file import LocalFileMismatch
from transit_ops.live.recording import Recorder
from transit_ops.live.running import FeedPolicy
from transit_ops.live.trip_updates import latest_local_trip_updates
from transit_ops.snapshots.contract import StopDeparturesFile, TripsFile, VehiclesFile
from transit_ops.snapshots.live_trip_updates import LiveTripUpdates


def build(local, parsed=None, cycle=AT, *, holder=None, **kwargs):
    return build_movement(
        local,
        Holder(parsed) if holder is None else holder,
        inputs(local),
        provider_id="network",
        timezone="America/Toronto",
        cycle=cycle,
        trip_policy=FeedPolicy(True, 60),
        vehicle_policy=FeedPolicy(True, 60),
        **kwargs,
    )


def test_missing_has_three_contract_payloads_and_unknown_serving(local):
    result = build(local)
    assert set(result) == {"vehicles.json", "trips.json", "stop_departures.json"}
    assert json.loads(result["trips.json"])["feed_captured_utc"] is None
    assert json.loads(result["stop_departures.json"])["stops"] == {}


def future_message():
    message = trip_message()
    update = message.entity[0].trip_update
    update.stop_time_update[0].arrival.time = int(AT.timestamp()) + 90
    return message


def test_independent_math_units_next_stop_and_borrowed_lifetime(local):
    parsed = _parse(future_message())
    before = parsed.frames.copy()
    message = vehicle_message()
    for entity in message.entity:
        if entity.HasField("vehicle"):
            entity.vehicle.ClearField("stop_id")
    apply_capture(local, parsed_vehicle(message), provider_timezone="America/Toronto")
    local.connection.execute(
        "INSERT INTO local_serving VALUES ('trip_updates',41,?,?)", [AT - timedelta(seconds=30)] * 2
    )
    calls = []
    holder = LiveTripUpdates(
        "network", policy=ParsePolicy(None, 100), fallback=lambda: calls.append(1) or parsed
    )
    kwargs = dict(
        provider_id="network",
        timezone="America/Toronto",
        cycle=AT,
        trip_policy=FeedPolicy(True, 60),
        vehicle_policy=FeedPolicy(True, 60),
        bounds=(-74, 45, -73, 46),
    )
    first = build_movement(local, holder, inputs(local), **kwargs)
    assert build_movement(local, holder, inputs(local), **kwargs) == first
    vehicle = VehiclesFile.model_validate_json(first["vehicles.json"]).vehicles[0]
    # 10 m/s *3.6 =36; 08:00 EDT=12Z, 12:11:30 prediction is +690s =>12min.
    assert (vehicle.speed_kmh, vehicle.bearing, vehicle.occupancy) == (36, 123, "few_seats")
    assert (vehicle.delay_min, vehicle.status, vehicle.next_stop) == (12, "severe", "站")
    assert (vehicle.next_stop_lat, vehicle.next_stop_lon) == (45.5, -73.5)
    trips = TripsFile.model_validate_json(first["trips.json"])
    assert trips.trips["行程"].stops[0].eta_utc == "2026-06-20T12:11:30Z"
    # Raw capture 42 cannot borrow the serving certificate of older capture 41.
    assert trips.feed_captured_utc is None
    stops = StopDeparturesFile.model_validate_json(first["stop_departures.json"])
    assert stops.stops["站"][0].delay_min == 12
    assert calls == [1] and parsed.frames == before
    assert local.connection.execute("SELECT capture_row_id FROM local_serving").fetchall() == [
        (41,)
    ]


def test_ties_route_cap_and_strict_trip_horizon(local):
    message = future_message()
    base = message.entity[0]
    for trip_id in ("c", "b", "a"):
        entity = message.entity.add(id=trip_id)
        entity.CopyFrom(base)
        entity.id = trip_id
        entity.trip_update.trip.trip_id = trip_id
        entity.trip_update.stop_time_update[0].stop_id = "站"
    # These added trips have explicit stop IDs and no schedule/delay match.
    last = message.entity.add(id="horizon").trip_update
    last.trip.trip_id, last.trip.route_id = "horizon", "other"
    last.stop_time_update.add(stop_id="站").departure.time = int(AT.timestamp()) + 3601
    result = build(local, _parse(message))
    departures = json.loads(result["stop_departures.json"])["stops"]["站"]
    assert [d["trip"] for d in departures] == ["a", "b", "horizon"]
    assert departures[0]["delay_min"] is None
    assert "horizon" not in json.loads(result["trips.json"])["trips"]


def test_exact_horizon_is_excluded_only_from_trip_etas(local):
    cycle = AT.replace(microsecond=0)
    message = future_message()
    message.entity[0].trip_update.stop_time_update[0].arrival.time = int(cycle.timestamp()) + 3600
    parsed = _parse(message)
    parsed = replace(parsed, capture=replace(parsed.capture, captured_at_utc=cycle))
    result = build(local, parsed, cycle)
    assert json.loads(result["trips.json"])["trips"] == {}
    assert json.loads(result["stop_departures.json"])["stops"]["站"]


@pytest.mark.parametrize(
    "relationship,skipped,deleted",
    [(3, False, False), (7, False, False), (0, True, False), (0, False, True)],
)
def test_removed_predictions_stay_excluded(local, relationship, skipped, deleted):
    message = future_message()
    message.entity[0].is_deleted = deleted
    message.entity[0].trip_update.trip.schedule_relationship = relationship
    if skipped:
        message.entity[0].trip_update.stop_time_update[0].schedule_relationship = 1
    result = build(local, _parse(message))
    assert json.loads(result["trips.json"])["trips"] == {}
    assert json.loads(result["stop_departures.json"])["stops"] == {}


def test_empty_success_stale_and_missing_keep_serving_evidence(local):
    empty = _parse(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")))
    assert json.loads(build(local, empty)["trips.json"])["feed_captured_utc"] is None
    local.connection.execute("INSERT INTO local_serving VALUES ('trip_updates',42,?,?)", [AT, AT])
    for cycle in (AT, AT + timedelta(days=1)):
        result = build(local, empty, cycle)
        assert json.loads(result["trips.json"])["feed_captured_utc"] == "2026-06-20T12:10:00Z"
        assert json.loads(result["trips.json"])["trips"] == {}
    stale = build(local, _parse(future_message()), AT + timedelta(seconds=61))
    assert json.loads(stale["trips.json"])["trips"]["行程"]["delay_min"] == 12


@pytest.mark.parametrize("provider,enabled", [("stm", True), ("octranspo", False)])
def test_provider_capabilities_without_name_rules(local, provider, enabled):
    local.connection.execute("UPDATE meta SET provider_id=?", [provider])
    local.connection.execute("UPDATE edition_meta SET provider_id=?", [provider])
    schedule = inputs(local)
    calls = []

    class ForbiddenHolder:
        def latest(self):
            calls.append(1)
            return None

    result = build_movement(
        local,
        ForbiddenHolder(),
        schedule,
        provider_id=provider,
        timezone="UTC",
        cycle=AT,
        trip_policy=FeedPolicy(enabled, 3600),
        vehicle_policy=FeedPolicy(False, 3600),
    )
    assert calls == ([1] if enabled else [])
    assert json.loads(result["vehicles.json"])["vehicles"] == []


def test_refuses_uncommitted_naive_foreign_and_incomplete_context(local):
    with local.transaction(), pytest.raises(LocalFileMismatch, match="committed"):
        build(local)
    with pytest.raises(ValueError, match="aware"):
        build(local, cycle=AT.replace(tzinfo=None))
    one = inputs(local)
    with pytest.raises(ValueError, match="incomplete"):
        build_movement(
            local,
            Holder(None),
            replace(one, current=()),
            provider_id="network",
            timezone="UTC",
            cycle=AT,
            trip_policy=FeedPolicy(True, 60),
            vehicle_policy=FeedPolicy(True, 60),
        )


@pytest.mark.parametrize(
    "day,hours,expected",
    [
        ("20260308", 25, "2026-03-09T05:01:30Z"),
        ("20261101", 49, "2026-11-03T06:01:30Z"),
    ],
)
def test_dst_long_service_independent_eta_and_delay(local, day, hours, expected):
    from datetime import datetime

    eta = datetime.fromisoformat(expected.replace("Z", "+00:00"))
    cycle = eta - timedelta(seconds=30)
    local.connection.execute("UPDATE edition_stop_times SET arrival_time=?", [f"{hours}:00:00"])
    message = trip_message()
    update = message.entity[0].trip_update
    update.trip.start_date = day
    update.stop_time_update[0].arrival.time = int(eta.timestamp())
    parsed = _parse(message)
    parsed = replace(
        parsed, capture=replace(parsed.capture, captured_at_utc=cycle, feed_timestamp_utc=cycle)
    )
    result = build(local, parsed, cycle)
    trip = json.loads(result["trips.json"])["trips"]["行程"]
    # Spring noon16Z-12h +25h=05Z; fall noon17Z-12h +49h=06Z. Both +90s.
    assert trip["delay_min"] == 2
    assert trip["stops"][0]["eta_utc"] == expected


def record_trip(local, message, identity, at, *, committed=True):
    payload = message.SerializeToString()
    digest = sha256(payload).hexdigest()
    entry = replace(
        CAPTURE,
        capture_row_id=identity,
        ingestion_run_id=identity + 1000,
        ingestion_object_id=identity + 2000,
        packed=False,
        stream=None,
        offset=None,
        byte_size=len(payload),
        sha256=digest,
        storage_backend="local",
        storage_path=f"{identity}.pb",
        object_created_at_utc=at,
        started_at_utc=at,
        captured_at_utc=at,
        feed_timestamp_utc=at,
        entity_count=len(message.entity),
    )
    local.record_captures([entry], endpoint_key="trip_updates")
    poll = replace(
        POLL,
        ingestion_run_id=entry.ingestion_run_id,
        capture_row_id=identity,
        status="stored",
        run_status="succeeded",
        started_at_utc=at,
        completed_at_utc=at,
        time_utc=at,
        feed_timestamp_utc=at,
    )
    local.record_polls([poll], endpoint_key="trip_updates")
    parsed = parse_capture(
        payload,
        CaptureRef("network", "trip_updates", identity, at, at, len(payload), digest),
        ParsePolicy(None, 100),
    )
    if committed:
        Recorder(local, provider_id="network").apply(
            "trip_updates",
            identity,
            lambda: apply_capture(local, parsed, provider_timezone="America/Toronto"),
            capture=entry,
        )
    return payload


def local_holder(local, payloads, calls):
    def resolve(entry):
        calls.append(entry.capture_row_id)
        return payloads[entry.capture_row_id]

    def fallback():
        calls.append("fallback")
        return latest_local_trip_updates(
            "network", local=local, policy=ParsePolicy(None, 100), resolve_bytes=resolve
        )

    return LiveTripUpdates("network", policy=ParsePolicy(None, 100), fallback=fallback)


@pytest.mark.parametrize("seconds", [0, 20])
def test_serving_empty_transition_refuses_old_holder_and_accepts_aligned_empty(local, seconds):
    payloads = {42: record_trip(local, future_message(), 42, AT)}
    calls = []
    holder = local_holder(local, payloads, calls)
    assert json.loads(build(local, holder=holder)["trips.json"])["trips"]
    later = AT + timedelta(seconds=seconds)
    empty = pb.FeedMessage(header=dict(gtfs_realtime_version="2.0"))
    payloads[43] = record_trip(local, empty, 43, later)
    before = local.connection.execute("SELECT * FROM local_serving").fetchall()
    with pytest.raises(ValueError, match="local_trip_updates_serving_mismatch"):
        build(local, cycle=later, holder=holder)
    assert calls == ["fallback", 42]
    assert local.connection.execute("SELECT * FROM local_serving").fetchall() == before
    aligned = build(local, cycle=later, holder=local_holder(local, payloads, calls))
    assert calls == ["fallback", 42, "fallback", 43]
    for name, key in (("trips.json", "trips"), ("stop_departures.json", "stops")):
        value = json.loads(aligned[name])
        assert value[key] == {}
        assert value["feed_captured_utc"] == f"2026-06-20T12:10:{seconds:02d}Z"


def test_serving_nonempty_transition_refuses_resolved_missing_holder(local):
    payloads, calls = {}, []
    holder = local_holder(local, payloads, calls)
    assert holder.latest() is None
    payloads[42] = record_trip(local, future_message(), 42, AT)
    before = local.connection.execute("SELECT * FROM local_serving").fetchall()
    with pytest.raises(ValueError, match="local_trip_updates_serving_mismatch"):
        build(local, holder=holder)
    assert calls == ["fallback"]
    assert local.connection.execute("SELECT * FROM local_serving").fetchall() == before
    aligned = json.loads(build(local, holder=local_holder(local, payloads, calls))["trips.json"])
    assert aligned["trips"]
    assert aligned["feed_captured_utc"] == "2026-06-20T12:10:00Z"
    assert calls == ["fallback", "fallback", 42]


def test_newer_raw_fallback_keeps_unknown_provenance_without_promotion(local):
    payloads = {42: record_trip(local, future_message(), 42, AT)}
    later = AT + timedelta(seconds=20)
    payloads[43] = record_trip(local, future_message(), 43, later, committed=False)
    calls = []
    before = local.connection.execute("SELECT * FROM local_serving").fetchall()
    result = build(local, cycle=later, holder=local_holder(local, payloads, calls))
    for name, key in (("trips.json", "trips"), ("stop_departures.json", "stops")):
        value = json.loads(result[name])
        assert value[key]
        assert value["feed_captured_utc"] is None
    assert calls == ["fallback", 43]
    assert local.connection.execute("SELECT * FROM local_serving").fetchall() == before


@pytest.mark.parametrize("offset", [-1, 1])
def test_serving_same_capture_requires_the_same_clock(local, offset):
    payloads = {42: record_trip(local, future_message(), 42, AT)}
    local.connection.execute(
        "UPDATE local_serving SET captured_at_utc=?", [AT + timedelta(seconds=offset)]
    )
    with pytest.raises(ValueError, match="local_trip_updates_serving_mismatch"):
        build(local, cycle=AT + timedelta(seconds=20), holder=local_holder(local, payloads, []))
