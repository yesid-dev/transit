from dataclasses import replace
from datetime import date, timedelta

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from schedule_fakes import fake_schedule, fake_trip
from test_normalize_capture import capture
from test_normalize_capture import provider as provider

from transit_ops.providers import Fill, normalize_capture
from transit_ops.providers.modes import WORKER_MODES

DAY = date(1969, 12, 31)
TRIP = "√2"
ROUTE = " 路線 A "


def schedule(routes=(ROUTE, ROUTE, None), *, day=DAY, missing=None):
    editions = {
        i: [fake_trip(TRIP, route, [("stop", 0, 0)])] if route else []
        for i, route in enumerate(routes, 1)
    }
    days = {day + timedelta(days=i - 2): i for i in editions}
    unavailable = {missing: "not_kept"} if missing else {}
    days.pop(missing, None)
    return fake_schedule(editions, days, unavailable=unavailable)


@pytest.fixture(params=["trip_updates", "vehicle_positions"])
def raw(request):
    return capture(request.param)


def run(provider, raw, context, *, mode="apply", collect=False):
    return normalize_capture(
        provider, raw, context, modes=dict(WORKER_MODES, N1=mode), collect=collect
    )


def test_route_filled_when_every_candidate_day_agrees(provider, raw):
    context = schedule((ROUTE, ROUTE, None, "conflict outside candidates"))
    result = run(provider, raw, context)
    field = "trip_update.trip.route_id" if raw.family == "trip_updates" else "vehicle.trip.route_id"
    assert result.fills == (Fill(0, None, field, "N1"), Fill(1, None, field, "N1"))
    assert (
        all(e.trip_update.trip.route_id == ROUTE for e in result.message.entity)
        if (raw.family == "trip_updates")
        else all(e.vehicle.trip.route_id == ROUTE for e in result.message.entity)
    )
    (outcome,) = result.outcomes
    assert (outcome.rule, outcome.mode, outcome.seen, outcome.changed, outcome.unresolved) == (
        "N1",
        "apply",
        2,
        2,
        0,
    )
    assert outcome.reasons == {}


@pytest.mark.parametrize(
    "routes,reason",
    [
        ((ROUTE, "B", None), "route_differs_between_days"),
        ((None, None, None), "trip_not_in_schedule"),
    ],
)
def test_route_disagreement_or_absent_trip_remains_unresolved(provider, raw, routes, reason):
    result = run(provider, raw, schedule(routes))
    (outcome,) = result.outcomes
    assert (outcome.seen, outcome.changed, outcome.unresolved, outcome.reasons) == (
        2,
        0,
        2,
        {reason: 2},
    )
    assert result.fills == () and result.message.SerializeToString() == raw.payload


@pytest.mark.parametrize(
    "routes", [(ROUTE, "B", None), (ROUTE, ROUTE, None)], ids=["disagreeing", "unanimous-different"]
)
def test_supplied_route_is_never_overwritten(provider, raw, routes):
    message = pb.FeedMessage.FromString(raw.payload)
    for entity in message.entity:
        trip = entity.trip_update.trip if raw.family == "trip_updates" else entity.vehicle.trip
        trip.route_id = " opaque 路線 "
    raw = replace(raw, payload=message.SerializeToString())
    result = run(provider, raw, schedule(routes))
    assert result.message.SerializeToString() == raw.payload
    assert result.fills == result.outcomes == ()


@pytest.mark.parametrize("missing", ["unavailable", "unrequested", "context"])
def test_rule_counts_schedule_not_kept_when_a_date_has_no_list(provider, raw, missing):
    context = schedule(missing=DAY + timedelta(days=1))
    if missing == "unrequested":
        context = replace(context, unavailable={})
    result = run(provider, raw, None if missing == "context" else context)
    (outcome,) = result.outcomes
    assert (outcome.seen, outcome.changed, outcome.unresolved) == (2, 0, 2)
    assert outcome.reasons == {"schedule_not_kept": 2}
    assert result.fills == ()


@pytest.mark.parametrize(
    "timestamp,day",
    [
        (0, date(1969, 12, 31)),
        (1781928000, date(2026, 6, 19)),  # 04:00 UTC is still yesterday in Winnipeg
        (None, date(2026, 6, 20)),
        (2**64 - 1, None),
    ],
)
def test_route_candidate_days_use_presence_and_provider_local_time(provider, raw, timestamp, day):
    message = pb.FeedMessage.FromString(raw.payload)
    message.header.ClearField("timestamp")
    if timestamp is not None:
        message.header.timestamp = timestamp
    for entity in message.entity:
        trip = entity.trip_update.trip if raw.family == "trip_updates" else entity.vehicle.trip
        trip.start_date = "20000101"
    raw = replace(raw, payload=message.SerializeToString())
    result = run(provider, raw, schedule(day=day or DAY))
    if day is None:
        assert (result.status, result.rejected_reason) == ("rejected", "invalid_feed_timestamp")
        assert result.message is None and result.fills == result.outcomes == ()
    else:
        assert len(result.fills) == 2


def test_count_collect_reports_proposals_without_writes(provider, raw):
    context = schedule()
    counted = run(provider, raw, context, mode="count", collect=True)
    applied = run(provider, raw, context)
    (outcome,) = counted.outcomes
    assert (outcome.mode, outcome.seen, outcome.changed, outcome.unresolved) == ("count", 2, 2, 0)
    assert outcome.changed == applied.outcomes[0].changed
    assert counted.message.SerializeToString() == raw.payload and counted.fills == ()
    mixed = normalize_capture(provider, raw, context, modes=dict(WORKER_MODES, N6="apply"))
    assert mixed.outcomes == mixed.fills == ()
    assert mixed.message.SerializeToString() == raw.payload


@pytest.mark.parametrize(
    "changes", [{"N2": "apply"}, {"N3": "apply", "N5": "apply"}, {"N3": "apply", "N2": "apply"}]
)
def test_apply_requires_dependencies_in_apply(provider, changes):
    with pytest.raises(ValueError, match="requires apply dependencies"):
        normalize_capture(provider, capture(payload=b"\xff"), modes=dict(WORKER_MODES, **changes))


def test_route_rules_preserve_entity_order_and_are_idempotent(provider, raw):
    message = pb.FeedMessage.FromString(raw.payload)
    message.entity.add(id="irrelevant").alert.header_text.translation.add(text="notice")
    message.entity.reverse()
    message.entity.add(id="empty")
    # Unknown protobuf field 100, varint 1, must survive the runner.
    raw = replace(raw, payload=message.SerializeToString() + b"\xa0\x06\x01")
    before = pb.FeedMessage.FromString(raw.payload)
    result = run(provider, raw, schedule())
    assert [f.entity_index for f in result.fills] == [1, 2]
    again = run(provider, replace(raw, payload=result.message.SerializeToString()), schedule())
    assert again.fills == again.outcomes == ()
    assert again.message.SerializeToString() == result.message.SerializeToString()
    restored = pb.FeedMessage()
    restored.CopyFrom(result.message)
    for entity in restored.entity:
        member = "trip_update" if raw.family == "trip_updates" else "vehicle"
        if entity.HasField(member):
            getattr(entity, member).trip.ClearField("route_id")
    assert restored.SerializeToString() == raw.payload == before.SerializeToString()
