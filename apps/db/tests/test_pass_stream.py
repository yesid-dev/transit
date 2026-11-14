from collections.abc import Mapping, Sequence
from dataclasses import FrozenInstanceError, dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from shutil import copyfile
from typing import assert_type

import pytest
from history_reader_fakes import fake_capture, fake_poll
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
