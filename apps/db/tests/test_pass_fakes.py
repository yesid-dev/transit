from datetime import date
from pathlib import Path

import pytest
from daily_pass_fakes import fake_build, fake_delivery, fake_summary

from transit_ops.daily_pass import LineMatch
from transit_ops.providers import load_providers


@pytest.fixture
def build(tmp_path):
    source = Path(__file__).parent / "fixtures/providers/fixture_city.yaml"
    (tmp_path / source.name).write_bytes(source.read_bytes())
    provider = load_providers(tmp_path, env={})["fixture_city"]
    return fake_build(provider, date(2026, 1, 2))


def test_fake_summary_counts_attempts_without_claiming_accounting(build):
    deliveries = [fake_delivery("trip_updates", build.day_start_utc, row_id=7)]
    deliveries += [fake_delivery("alerts", build.day_start_utc, row_id=7)]
    deliveries += [fake_delivery("trip_updates", build.day_start_utc, outcome="rejected")]
    summary = fake_summary(build, deliveries, completeness="incomplete")
    assert summary.completeness == "incomplete"
    assert summary.deliveries["trip_updates"] == {"decoded": 1, "rejected": 1}
    assert summary.deliveries["service_alerts"] == {"decoded": 1}
    assert summary.consumed == {("realtime_snapshot", 7), ("alert_snapshot", 7)}
    assert summary.consumed_set_sha256 == (
        "4db5da8d6cf49b35b69b3e5abe7999e73a3a13d7deaafddf763047304a3dd4bc"
    )
    assert summary.accounted_share == dict.fromkeys(build.feeds)
    assert summary.missing_blocks == dict.fromkeys(build.feeds, ())
    assert summary.line_match == {} and summary.incomplete_reasons == ()
    assert fake_summary(build, []).completeness == "complete"
    with pytest.raises(ValueError, match="completeness"):
        fake_summary(build, [], completeness="unknown")


def test_fake_summary_preserves_explicit_line_matches_and_empty_decoded_captures(build):
    matches = {(build.service_date, "line"): LineMatch(5, 3, False)}
    summary = fake_summary(build, [], line_match=matches)
    matches.clear()
    assert summary.line_match == {(build.service_date, "line"): LineMatch(5, 3, False)}
    with pytest.raises(TypeError):
        summary.line_match[build.service_date, "other"] = LineMatch(0, 0, True)


class Consumer:
    name, version = "fixture", 1
    families = frozenset({"trip_updates"})
    uses_schedule = uses_coverage = wants_bytes = False

    def __init__(self, action="build", failure=None):
        self.action, self.failure = action, failure
        self.accepted, self.writes = [], []
        self.result = {"written": True}

    def fingerprint_extra(self, build):
        return {}

    def locks(self, build):
        raise AssertionError("No ledger locking")

    def decide(self, build, connection):
        from transit_ops.daily_pass import Decision

        self.connection = connection
        if self.failure == "decide":
            connection.exec_driver_sql("INSERT INTO events VALUES ('partial')")
            raise RuntimeError("decide")
        return Decision(self.action)

    def accept(self, delivery):
        self.accepted.append(delivery)
        if self.failure == "accept":
            self.connection.exec_driver_sql("INSERT INTO events VALUES ('partial')")
            raise RuntimeError("accept")

    def write(self, build, summary, connection):
        self.writes.append((build, summary, connection))
        connection.exec_driver_sql("INSERT INTO events VALUES ('written')")
        if self.failure == "write":
            raise RuntimeError("write")
        return self.result


@pytest.fixture
def connection():
    from sqlalchemy import create_engine

    engine = create_engine("sqlite://")
    with engine.connect() as conn:
        conn.exec_driver_sql("CREATE TABLE events (value TEXT)")
        conn.commit()
        yield conn
    engine.dispose()


@pytest.mark.parametrize("action", ["skip", "refuse"])
def test_drive_consumer_applies_decide_before_reading_deliveries(build, connection, action):
    from daily_pass_fakes import drive_consumer

    def poison():
        raise AssertionError("Input consumed")
        yield

    consumer = Consumer(action)
    assert drive_consumer(consumer, build, poison(), connection) == {}
    assert consumer.accepted == consumer.writes == []
    assert not connection.in_transaction()


def test_drive_consumer_commits_one_successful_write(build, connection):
    from daily_pass_fakes import drive_consumer

    consumer = Consumer()
    assert drive_consumer(consumer, build, [], connection) is consumer.result
    assert not connection.in_transaction()
    assert connection.exec_driver_sql("SELECT value FROM events").scalars().all() == ["written"]
    assert len(consumer.writes) == 1


@pytest.mark.parametrize("failure", ["decide", "accept", "write"])
def test_drive_consumer_rolls_back_accept_or_write_failure(build, connection, failure):
    from daily_pass_fakes import drive_consumer

    delivery = fake_delivery("trip_updates", build.day_start_utc)
    with pytest.raises(RuntimeError, match=failure):
        drive_consumer(Consumer(failure=failure), build, [delivery], connection)
    assert not connection.in_transaction()
    assert connection.exec_driver_sql("SELECT value FROM events").all() == []


@pytest.mark.parametrize("failure", [None, "accept", "write"])
@pytest.mark.parametrize("prior", ["untouched", "select", "dml"])
def test_drive_consumer_does_not_commit_the_callers_transaction(build, connection, failure, prior):
    from daily_pass_fakes import drive_consumer

    outer = connection.begin()
    if prior == "select":
        connection.exec_driver_sql("SELECT 1")
    elif prior == "dml":
        connection.exec_driver_sql("INSERT INTO events VALUES ('outer')")
    consumer = Consumer(failure=failure)
    deliveries = [fake_delivery("trip_updates", build.day_start_utc)]
    if failure:
        with pytest.raises(RuntimeError, match=failure):
            drive_consumer(consumer, build, deliveries, connection)
    else:
        drive_consumer(consumer, build, deliveries, connection)
    assert outer.is_active
    expected = (["outer"] if prior == "dml" else []) + ([] if failure else ["written"])
    assert connection.exec_driver_sql("SELECT value FROM events").scalars().all() == expected
    outer.rollback()
    assert connection.exec_driver_sql("SELECT value FROM events").all() == []


def test_drive_consumer_filters_families_and_preserves_global_sequences(build, connection):
    from daily_pass_fakes import drive_consumer
    from google.transit.gtfs_realtime_pb2 import FeedMessage

    message = FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    before = message.SerializeToString()
    at = build.day_start_utc
    deliveries = [
        fake_delivery("trip_updates", at, row_id=9, payload=b"later", message=message),
        fake_delivery("vehicle_positions", at, row_id=7, payload=b"vp"),
        fake_delivery("trip_updates", at, row_id=8, payload=b"earlier", message=message),
        fake_delivery("alerts", at, row_id=8, payload=b"alert"),
    ]
    # Endpoint ordering puts alerts first and vehicles last; TU keeps global gaps.
    consumer = Consumer()
    consumer.families = frozenset({"alerts", "vehicle_positions"})
    drive_consumer(consumer, build, iter(deliveries), connection)
    assert [d.sequence for d in consumer.accepted] == [0, 3]
    assert all(d.in_service_day for d in consumer.accepted)
    assert consumer.writes[0][1].deliveries["trip_updates"] == {"decoded": 2}
    assert message.SerializeToString() == before
    connection.commit()
    supplied = fake_summary(build, [], completeness="incomplete")
    other = Consumer()
    drive_consumer(other, build, deliveries, connection, summary=supplied)
    assert other.writes == [(build, supplied, connection)]
    assert other.writes[0][0] is build and other.writes[0][1] is supplied
    assert message.SerializeToString() == before


@pytest.mark.parametrize("wants_bytes", [False, True])
def test_drive_consumer_exposes_bytes_only_during_opted_in_accept(build, connection, wants_bytes):
    from daily_pass_fakes import drive_consumer, fake_stream

    deliveries = [
        fake_delivery("vehicle_positions", build.day_start_utc, row_id=8, payload=b"vp"),
        fake_delivery("alerts", build.day_start_utc, row_id=8, payload=b"alert"),
    ]
    consumer = Consumer()
    consumer.families = frozenset({"alerts", "vehicle_positions"})
    consumer.wants_bytes = wants_bytes
    drive_consumer(consumer, build, deliveries, connection)
    assert [d.payload for d in consumer.accepted] == (
        [b"alert", b"vp"] if wants_bytes else [None, None]
    )
    assert all(d.capture.payload is None for d in consumer.accepted)
    observations = list(fake_stream(build, deliveries))
    assert all(d.payload is None and d.capture.payload is None for d in observations)
