import gc
import weakref
from dataclasses import replace

import pytest
from daily_pass_fakes import fake_delivery
from schedule_fakes import fake_schedule
from test_pass_judge import AT, build
from test_pass_stream import RecordingConsumer

from transit_ops.capture_coverage.rules import CaptureKey
from transit_ops.daily_pass import StreamAccumulator, deliver_stream


def observation(b, **kwargs):
    d = fake_delivery("trip_updates", AT, **kwargs)
    return replace(d, poll=replace(d.poll, provider_id=b.provider.id))


def test_summary_preserves_all_seven_delivery_outcomes():
    b = build(seconds=60)
    a = StreamAccumulator(b)
    outcomes = (
        "decoded",
        "rejected",
        "unreadable",
        "capture_missing",
        "failed_poll",
        "unfinished",
        "skipped_identical",
    )
    for outcome in outcomes:
        a.add(observation(b, outcome=outcome))
    s = a.finish(uses_schedule=False)
    assert s.deliveries == {"trip_updates": dict.fromkeys(outcomes, 1)}
    assert s.accounted_share == {"trip_updates": 1.0}
    assert s.missing_blocks == {"trip_updates": ()}
    assert s.incomplete_reasons == ("unreadable_captures",)


def test_only_decoded_capture_keys_are_consumed_across_the_read_window():
    b = build(seconds=60)
    alert = replace(b.provider.feeds[0], endpoint_key="service_alerts", family="alerts")
    b = replace(
        b,
        provider=replace(b.provider, feeds=(*b.provider.feeds, alert)),
        feeds={"trip_updates": "trip_updates", "service_alerts": "alerts"},
        feed_days=(*b.feed_days, *(replace(r, endpoint_key="service_alerts") for r in b.feed_days)),
    )
    a = StreamAccumulator(b)
    a.add(observation(b, row_id=7, in_service_day=False))
    d = fake_delivery("alerts", AT, row_id=7, in_service_day=False)
    a.add(replace(d, poll=replace(d.poll, provider_id=b.provider.id)))
    a.add(observation(b, outcome="rejected", row_id=8))
    a.add(observation(b, outcome="unreadable", row_id=9))
    s = a.finish(uses_schedule=False)
    assert s.consumed == frozenset(
        {CaptureKey("realtime_snapshot", 7), CaptureKey("alert_snapshot", 7)}
    )
    assert (
        s.consumed_set_sha256 == "4db5da8d6cf49b35b69b3e5abe7999e73a3a13d7deaafddf763047304a3dd4bc"
    )


@pytest.mark.parametrize("pending,unreadable", [(False, True), (True, False), (True, True)])
def test_pending_change_and_unreadable_captures_are_incomplete(pending, unreadable):
    b = build(seconds=60)
    b = replace(
        b,
        feed_days=tuple(
            replace(r, form="archive_copy", content_version="v1", pending_change=pending)
            for r in b.feed_days
        ),
    )
    a = StreamAccumulator(b)
    a.add(observation(b, outcome="unreadable" if unreadable else "decoded"))
    s = a.finish(uses_schedule=False)
    assert s.incomplete_reasons == tuple(
        r for yes, r in ((pending, "pending_change"), (unreadable, "unreadable_captures")) if yes
    )
    b = replace(
        b,
        feed_days=(
            replace(b.feed_days[0], pending_change=True),
            *(replace(r, pending_change=False) for r in b.feed_days[1:]),
        ),
    )
    a = StreamAccumulator(b)
    a.add(observation(b))
    assert a.finish(uses_schedule=False).completeness == "complete"


def test_schedule_zip_unreadable_only_limits_schedule_consumers():
    b = replace(
        build(seconds=60),
        schedule=fake_schedule({}, {}, unavailable={AT.date(): "schedule_zip_unreadable"}),
    )
    a = StreamAccumulator(b)
    a.add(observation(b, outcome="unreadable"))
    assert a.finish(uses_schedule=True).incomplete_reasons == (
        "schedule_zip_unreadable",
        "unreadable_captures",
    )
    assert a.finish(uses_schedule=False).incomplete_reasons == ("unreadable_captures",)


def test_record_completeness_does_not_assert_capability_or_absence():
    b = build(seconds=60)
    a = StreamAccumulator(b)
    for outcome in ("failed_poll", "rejected", "skipped_identical"):
        a.add(observation(b, outcome=outcome))
    s = a.finish(uses_schedule=False)
    assert s.completeness == "complete" and s.accounted_share == {"trip_updates": 1.0}
    assert s.consumed == frozenset() and s.line_match == {}


def test_undeclared_family_is_not_applicable_not_a_zero_count():
    b = build(seconds=60)
    a = StreamAccumulator(b)
    s = a.finish(uses_schedule=False)
    assert s.deliveries == {"trip_updates": {}}
    assert s.accounted_share == {"trip_updates": 0.0}
    assert s.incomplete_reasons == ("under_accounted:trip_updates",)
    b = replace(b, feed_days=tuple(replace(r, declared_interval_seconds=None) for r in b.feed_days))
    s = StreamAccumulator(b).finish(uses_schedule=False)
    assert s.accounted_share == {"trip_updates": None}
    assert s.incomplete_reasons == ("accounting_interval_missing:trip_updates",)
    with pytest.raises(ValueError, match="refused"):
        StreamAccumulator(replace(b, feed_days=())).finish(uses_schedule=False)


def test_summary_is_deterministic_and_releases_normalized_captures():
    b = build(seconds=60)
    results = []
    for outcomes in (("decoded", "failed_poll"), ("failed_poll", "decoded")):
        a = StreamAccumulator(b)
        for outcome in outcomes:
            d = observation(b, outcome=outcome)
            refs = [weakref.ref(d)] + ([weakref.ref(d.normalized)] if d.normalized else [])
            a.add(d)
            del d
            gc.collect()
            assert all(r() is None for r in refs)
        s = a.finish(uses_schedule=False)
        assert a.finish(uses_schedule=False) == s
        results.append(s)
        with pytest.raises(ValueError, match="finished"):
            a.add(observation(b))
    assert results[0] == results[1]


def test_deliver_stream_observations_make_one_summary_for_two_consumers():
    from test_pass_guard import message

    b = build(seconds=60)
    d = observation(b, message=message(0))
    capture = replace(
        d.capture, provider_id=b.provider.id, payload=d.normalized.message.SerializeToString()
    )
    consumers = [RecordingConsumer(), RecordingConsumer()]
    a = StreamAccumulator(b)
    for _item in deliver_stream(
        b,
        polls=[d.poll],
        captures=[capture],
        consumers=consumers,
        on_consumer_error=lambda c, e: pytest.fail(str(e)),
    ):
        a.add(_item)
    assert consumers[0].deliveries[0].normalized is consumers[1].deliveries[0].normalized
    assert a.finish(uses_schedule=False).deliveries == {"trip_updates": {"decoded": 1}}
    assert a.finish(uses_schedule=False).completeness == "complete"


def test_unsupported_adapter_is_not_an_empty_complete_summary():
    b = build(seconds=60)
    feed = replace(b.provider.feeds[0], format="unsupported")
    b = replace(b, provider=replace(b.provider, feeds=(feed,)))
    d = observation(b)
    capture = replace(d.capture, provider_id=b.provider.id, payload=b"opaque")
    with pytest.raises(ValueError, match="Declared feed adapter is not implemented"):
        for _item in deliver_stream(
            b,
            polls=[d.poll],
            captures=[capture],
            consumers=[RecordingConsumer()],
            on_consumer_error=lambda c, e: None,
        ):
            pytest.fail("Unsupported adapter yielded an observation")
