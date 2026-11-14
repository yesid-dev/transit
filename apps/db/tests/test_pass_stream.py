from collections.abc import Mapping, Sequence
from dataclasses import FrozenInstanceError, dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from shutil import copyfile
from typing import assert_type, cast

import pytest
from daily_pass_fakes import fake_build, fake_delivery, fake_stream
from history_reader_fakes import fake_capture, fake_feed_day, fake_poll
from schedule_fakes import fake_schedule
from sqlalchemy import Connection

from transit_ops.capture_coverage.rules import CaptureKey
from transit_ops.daily_pass import (
    PASS_LEAD_SECONDS,
    PASS_TAIL_SECONDS,
    PASS_VERSION,
    CaptureNormalizer,
    Decision,
    Delivery,
    DeliveryOutcome,
    FeedFamily,
    LineMatch,
    PassConsumer,
    ServiceDayBuild,
    StreamSummary,
    WindowLock,
    consumed_set_sha256,
)
from transit_ops.providers import load_providers
from transit_ops.providers.declaration import Provider
from transit_ops.providers.modes import PASS_MODES
from transit_ops.providers.normalize import RawCapture, normalize_capture

AT = datetime(2026, 1, 2, tzinfo=UTC)


def test_build_value_is_frozen(provider: Provider) -> None:
    schedule = fake_schedule({}, {})
    feeds: dict[str, FeedFamily] = {"trip_updates": "trip_updates"}
    build = ServiceDayBuild(provider, AT.date(), AT, AT, AT, AT, feeds, (), schedule, "", "")
    feeds.clear()
    assert build.feeds == {"trip_updates": "trip_updates"}
    with pytest.raises(TypeError):
        build.feeds["trip_updates"] = "alerts"  # type: ignore[index]
    assert build.schedule is schedule and build.provider is provider
    with pytest.raises(FrozenInstanceError):
        build.normalizer = "changed"  # type: ignore[misc]


@pytest.fixture
def provider(tmp_path: Path) -> Provider:
    source = Path(__file__).parent / "fixtures/providers/fixture_city.yaml"
    copyfile(source, tmp_path / source.name)
    return load_providers(tmp_path, env={})["fixture_city"]


@dataclass
class RecordingConsumer:
    name = "memory"
    version = 1
    families: frozenset[FeedFamily] = frozenset({"trip_updates"})
    uses_schedule = uses_coverage = wants_bytes = False
    deliveries: list[Delivery] = field(default_factory=list)
    writes: list[tuple[ServiceDayBuild, StreamSummary, Connection]] = field(default_factory=list)

    def fingerprint_extra(self, build: ServiceDayBuild) -> Mapping[str, str | int]:
        return {"pass": build.pass_fingerprint}

    def decide(self, build: ServiceDayBuild, connection: Connection) -> Decision:
        return Decision("build")

    def locks(self, build: ServiceDayBuild) -> Sequence[WindowLock]:
        return (WindowLock("fixture", build.service_date.isoformat()),)

    def accept(self, delivery: Delivery) -> None:
        self.deliveries.append(delivery)

    def write(
        self, build: ServiceDayBuild, summary: StreamSummary, connection: Connection
    ) -> Mapping[str, object]:
        self.writes.append((build, summary, connection))
        return {"deliveries": len(self.deliveries)}


def test_concrete_consumer_satisfies_protocol() -> None:
    consumer: PassConsumer = RecordingConsumer()
    assert_type(consumer.families, frozenset[FeedFamily])
    assert consumer.name == "memory" and consumer.version == 1


@pytest.mark.parametrize(
    "outcome",
    [
        "decoded",
        "rejected",
        "unreadable",
        "capture_missing",
        "failed_poll",
        "unfinished",
        "skipped_identical",
    ],
)
def test_delivery_predicate_and_frozen_value(outcome: DeliveryOutcome) -> None:
    delivery = Delivery(
        0, "trip_updates", "trip_updates", AT, True, fake_poll(), None, None, outcome, None, None
    )
    assert delivery.has_entities is (outcome == "decoded")
    with pytest.raises(FrozenInstanceError):
        delivery.sequence = 2  # type: ignore[misc]


def test_normalizer_protocol_preserves_real_values(provider: Provider) -> None:
    normalizer: CaptureNormalizer = normalize_capture
    raw = RawCapture("trip_updates", "gtfs-rt", b"", AT, "fixture")
    result = normalizer(provider, raw, modes=PASS_MODES, collect=True)
    capture = fake_capture(payload=None)
    family: FeedFamily = "trip_updates"
    poll, ref = fake_poll(), CaptureKey("realtime_snapshot", 1)
    delivery = Delivery(0, family, family, AT, True, poll, capture, ref, "decoded", result, None)
    assert delivery.normalized is result and delivery.capture is capture
    assert delivery.has_entities and result.message is not None
    assert not result.message.entity


def test_summary_and_lifecycle_values_are_frozen() -> None:
    match = LineMatch(10, 9, True)
    counts, share = {"decoded": 1}, {"alerts": None}
    deliveries, blocks = {"trip_updates": counts}, {"trip_updates": ((AT, AT),)}
    lines = {(AT.date(), "route"): match}
    summary = StreamSummary(
        "incomplete", ("missing",), deliveries, share, frozenset(), "fixture", blocks, lines
    )
    for alias, exposed, expected in (
        (counts, summary.deliveries["trip_updates"], {"decoded": 1}),
        (deliveries, summary.deliveries, {"trip_updates": {"decoded": 1}}),
        (share, summary.accounted_share, {"alerts": None}),
        (blocks, summary.missing_blocks, {"trip_updates": ((AT, AT),)}),
        (lines, summary.line_match, {(AT.date(), "route"): match}),
    ):
        alias.clear()
        assert exposed == expected
        with pytest.raises(TypeError):
            exposed["new"] = 0  # type: ignore[index]
    decision, lock = Decision("build"), WindowLock("dataset", "window")
    assert summary.accounted_share["alerts"] is None
    assert summary.line_match[date(2026, 1, 2), "route"] is match
    assert (decision.reason, lock.revision) == (None, 0)
    assert (PASS_VERSION, PASS_LEAD_SECONDS, PASS_TAIL_SECONDS) == (1, 3600, 129600)
    for value, attribute in (
        (match, "passes"),
        (summary, "completeness"),
        (decision, "action"),
        (lock, "revision"),
    ):
        with pytest.raises(FrozenInstanceError):
            setattr(value, attribute, None)


def test_consumed_digest_preserves_family_and_deduplicates() -> None:
    assert consumed_set_sha256([]) == (
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    )
    rt, alert = CaptureKey("realtime_snapshot", 7), CaptureKey("alert_snapshot", 7)
    expected = "4db5da8d6cf49b35b69b3e5abe7999e73a3a13d7deaafddf763047304a3dd4bc"
    assert consumed_set_sha256([rt, alert]) == expected
    assert consumed_set_sha256([alert, rt, rt]) == expected
    assert consumed_set_sha256([rt]) == (
        "24aa362f26d3677b8f7342f6f7077e8f1424218647ffd745a3ac27385978e32f"
    )


@pytest.mark.parametrize(
    "outcome,status,has,ref",
    [
        ("decoded", "stored", True, True),
        ("rejected", "stored", False, True),
        ("unreadable", "stored", False, True),
        ("capture_missing", "capture_missing", False, True),
        ("failed_poll", "failed", False, False),
        ("unfinished", "unfinished", False, False),
        ("skipped_identical", "skipped_identical", False, False),
    ],
)
def test_delivery_outcomes(outcome, status, has, ref):
    d = fake_delivery("trip_updates", AT, outcome=outcome, payload=b"bytes", row_id=7)
    assert (d.poll.status, d.has_entities) == (status, has)
    assert d.ref == (CaptureKey("realtime_snapshot", 7) if ref else None)
    assert d.poll.capture_row_id == (7 if ref else None)
    if outcome in ("decoded", "rejected"):
        assert d.capture.payload is None and d.payload == b"bytes"
        assert d.normalized.status == ("ok" if has else "rejected")
        assert d.normalized.rejected_reason == (None if has else "undecodable")
    else:
        assert d.capture is d.normalized is d.payload is None
        assert d.poll.entity_count is None
    if outcome == "unfinished":
        assert d.poll.completed_at_utc is None


def test_normalization_identity_and_refusals(provider):
    raw = RawCapture("trip_updates", "gtfs-rt", b"", AT, "fixture")
    normalized = normalize_capture(provider, raw, modes=PASS_MODES, collect=True)
    d = fake_delivery("trip_updates", AT, normalized=normalized)
    assert d.normalized is normalized and d.has_entities
    supplied = fake_delivery("trip_updates", AT, message=normalized.message)
    assert supplied.normalized.message is normalized.message
    assert not d.normalized.message.entity
    assert d.normalized.fills == d.normalized.outcomes == ()
    assert d.normalized.evidence is None
    rejected = replace(normalized, status="rejected", rejected_reason="differential_feed")
    assert (
        fake_delivery("trip_updates", AT, outcome="rejected", normalized=rejected).normalized
        is rejected
    )
    for kwargs in (
        {"outcome": "unknown"},
        {"outcome": "rejected", "normalized": normalized},
        {"normalized": normalized, "message": normalized.message},
    ):
        with pytest.raises(ValueError):
            fake_delivery("trip_updates", AT, **kwargs)


def test_alert_routing_and_nonempty_refusal():
    from transit_ops.providers.alert_record import AlertIdentityInputs, AlertRecord

    identity = AlertIdentityInputs(None, None, None, None, None, None, None, None, None, None, ())
    alert = AlertRecord(
        0, None, {}, {}, {}, None, None, None, None, None, (), (), None, None, identity, {}
    )
    with pytest.raises(ValueError) as error:
        fake_delivery("alerts", AT, alerts=[alert])
    assert str(error.value) == "Alert records are not supported by the P201 shell"
    d = fake_delivery("alerts", AT, row_id=7)
    assert d.ref == CaptureKey("alert_snapshot", 7) and d.normalized.alerts == ()
    assert d.endpoint_key == "service_alerts"


def test_build_uses_owned_schedule_anchors(provider):
    provider = replace(provider, timezone="America/Toronto")
    build = fake_build(provider, date(2026, 3, 8))
    assert build.day_start_utc == datetime(2026, 3, 8, 4, tzinfo=UTC)
    assert build.day_end_utc == datetime(2026, 3, 9, 4, tzinfo=UTC)
    assert build.window_start_utc == datetime(2026, 3, 8, 3, tzinfo=UTC)
    assert build.window_end_utc == datetime(2026, 3, 9, 16, tzinfo=UTC)
    assert build.schedule.days == {} and len(build.schedule.unavailable) == 2
    previous = fake_build(provider, date(2026, 3, 7))
    assert previous.day_start_utc == datetime(2026, 3, 7, 5, tzinfo=UTC)
    assert previous.day_end_utc == build.day_start_utc
    day = fake_feed_day()
    supplied = fake_build(provider, build.service_date, schedule=build.schedule, feed_days=[day])
    assert supplied.schedule is build.schedule and supplied.feed_days == (day,)
    assert supplied.feeds == {
        "trip_updates": "trip_updates",
        "vehicle_positions": "vehicle_positions",
        "service_alerts": "alerts",
    }


def test_fake_stream_order_and_half_open_days(provider):
    schedule = fake_schedule(
        {}, {}, timezone="UTC", unavailable={date(2026, 1, n): "fixture" for n in (2, 3, 4)}
    )
    build = fake_build(provider, AT.date(), schedule=schedule)
    inputs = [
        fake_delivery("trip_updates", AT, row_id=9),
        fake_delivery("trip_updates", AT, outcome="failed_poll"),
        fake_delivery("trip_updates", AT, row_id=2),
        fake_delivery("alerts", AT),
    ]
    result = list(fake_stream(build, inputs))
    assert [d.ref for d in result] == [
        CaptureKey("alert_snapshot", 1),
        CaptureKey("realtime_snapshot", 2),
        CaptureKey("realtime_snapshot", 9),
        None,
    ]
    assert [d.sequence for d in result] == [0, 1, 2, 3]
    assert inputs[0].sequence == 0 and inputs[0].ref.capture_row_id == 9
    times = [
        AT - timedelta(microseconds=1),
        AT,
        build.day_end_utc - timedelta(microseconds=1),
        build.day_end_utc,
    ]
    deliveries = [fake_delivery("trip_updates", t, payload=b"bytes") for t in reversed(times)]
    result = list(fake_stream(build, deliveries))
    assert [d.in_service_day for d in result] == [False, True, True, False]
    assert all(d.payload is None and d.capture.payload is None for d in result)
    next_build = fake_build(provider, date(2026, 1, 3), schedule=schedule)
    assert list(fake_stream(next_build, [deliveries[0]]))[0].in_service_day
    assert all(d.payload == b"bytes" for d in deliveries)


def test_full_consumer_protocol(provider: Provider) -> None:
    build = fake_build(provider, AT.date())
    delivery = fake_delivery("trip_updates", AT)
    summary = StreamSummary("incomplete", (), {}, {}, frozenset(), "fixture", {}, {})
    recorded = RecordingConsumer()
    consumer: PassConsumer = recorded
    connection = cast(Connection, object())
    assert consumer.fingerprint_extra(build) == {"pass": "fake-pass"}
    assert consumer.decide(build, connection) == Decision("build")
    assert consumer.locks(build) == (WindowLock("fixture", "2026-01-02"),)
    consumer.accept(delivery)
    assert consumer.write(build, summary, connection) == {"deliveries": 1}
    assert recorded.deliveries[0] is delivery
    assert recorded.writes[0][0] is build and recorded.writes[0][1] is summary
    assert recorded.writes[0][2] is connection
