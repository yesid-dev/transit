from dataclasses import replace
from datetime import date, timedelta

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from schedule_fakes import fake_schedule, fake_trip
from test_normalize_capture import capture
from test_normalize_capture import provider as provider
from test_rule_route import DAY, ROUTE, TRIP, schedule

from transit_ops.providers import RuleOutcome, normalize_capture
from transit_ops.providers.modes import WORKER_MODES


@pytest.fixture(params=["trip_updates", "vehicle_positions"])
def raw(request):
    return capture(request.param)


def supplied(raw, route, trip_id=TRIP):
    message = pb.FeedMessage.FromString(raw.payload)
    for entity in message.entity:
        trip = entity.trip_update.trip if raw.family == "trip_updates" else entity.vehicle.trip
        trip.route_id, trip.trip_id = route, trip_id
    return replace(raw, payload=message.SerializeToString() + b"\xa0\x06\x01")


@pytest.mark.parametrize("mode,collect", [("apply", False), ("count", True)])
@pytest.mark.parametrize(
    "route,trip_id,reasons",
    [
        (ROUTE, TRIP, {}),
        ("unknown", "absent", {"unknown_route": 2}),
        ("known other", TRIP, {"trip_route_mismatch": 2}),
        (ROUTE, "", {}),
        (" opaque 路線 ", TRIP, {"unknown_route": 2, "trip_route_mismatch": 2}),
    ],
)
def test_unknown_route_is_counted_only(provider, raw, mode, collect, route, trip_id, reasons):
    context = fake_schedule(
        {
            1: [
                fake_trip(TRIP, ROUTE, [("s", 0, 0)]),
                fake_trip("other", "known other", [("s", 0, 0)]),
            ]
        },
        {DAY: 1},
    )
    raw = supplied(raw, route, trip_id)
    result = normalize_capture(
        provider, raw, context, modes=dict(WORKER_MODES, N9=mode), collect=collect
    )
    assert result.outcomes == (RuleOutcome("N9", mode, 2, 0, 2 if reasons else 0, reasons),)
    assert result.status == "ok" and result.message.SerializeToString() == raw.payload
    assert result.fills == result.alerts == () and result.evidence is None


def test_n9_uses_sent_routes_not_n1_fills(provider, raw):
    context = schedule((ROUTE, None, None))
    message = pb.FeedMessage.FromString(raw.payload)
    member = "trip_update" if raw.family == "trip_updates" else "vehicle"
    getattr(message.entity[1], member).trip.route_id = "supplied"
    raw = replace(raw, payload=message.SerializeToString())
    result = normalize_capture(
        provider, raw, context, modes=dict(WORKER_MODES, N1="apply", N9="apply")
    )
    assert result.outcomes == (
        RuleOutcome("N1", "apply", 1, 1, 0, {}),
        RuleOutcome("N9", "apply", 1, 0, 1, {"unknown_route": 1}),
    )
    assert [f.entity_index for f in result.fills] == [0]
    assert getattr(result.message.entity[0], member).trip.route_id == ROUTE
    assert getattr(result.message.entity[1], member).trip.route_id == "supplied"


@pytest.mark.parametrize("missing", ["context", "unrequested", "unavailable"])
def test_n9_missing_day_is_unknown_evidence(provider, raw, missing):
    context = fake_schedule(
        {}, {}, unavailable={DAY: "not_kept"} if missing == "unavailable" else {}
    )
    raw = supplied(raw, "unknown")
    result = normalize_capture(
        provider,
        raw,
        None if missing == "context" else context,
        modes=dict(WORKER_MODES, N9="apply"),
    )
    assert result.outcomes == (RuleOutcome("N9", "apply", 2, 0, 2, {"schedule_not_kept": 2}),)
    assert result.fills == () and result.message.SerializeToString() == raw.payload


@pytest.mark.parametrize(
    "timestamp,day", [(0, DAY), (1781928000, date(2026, 6, 19)), (None, date(2026, 6, 20))]
)
def test_n9_uses_only_the_observation_day(provider, raw, timestamp, day):
    context = schedule((ROUTE, None, ROUTE), day=day)
    message = pb.FeedMessage.FromString(supplied(raw, ROUTE).payload)
    message.header.ClearField("timestamp")
    if timestamp is not None:
        message.header.timestamp = timestamp
    raw = replace(raw, payload=message.SerializeToString())
    result = normalize_capture(provider, raw, context, modes=dict(WORKER_MODES, N9="apply"))
    assert result.outcomes == (RuleOutcome("N9", "apply", 2, 0, 2, {"unknown_route": 2}),)
    assert result.message.SerializeToString() == raw.payload and result.fills == ()
    # A missing neighbour is irrelevant to N9 when the observation day is usable.
    context = schedule(missing=day + timedelta(days=1), day=day)
    result = normalize_capture(provider, raw, context, modes=dict(WORKER_MODES, N9="apply"))
    assert result.outcomes == (RuleOutcome("N9", "apply", 2, 0, 0, {}),)


def test_uncollected_count_mode_does_not_diagnose_supplied_routes(provider, raw):
    raw = supplied(raw, "unknown")
    result = normalize_capture(provider, raw, modes=dict(WORKER_MODES, N1="apply"))
    assert result.outcomes == result.fills == ()
    assert result.message.SerializeToString() == raw.payload
