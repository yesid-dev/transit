import hashlib
import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import yaml
from sqlalchemy import create_engine, event, text
from test_static_silver import (
    _minimal_compliant_members,
    _write_members_zip,
)

from transit_ops.cli import _seed_feed_endpoints, _seed_provider
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.oracle.database import OracleDatabase, PinnedClock, oracle_database
from transit_ops.live.oracle.seed import SeedRefused, admit_polls, seed_static
from transit_ops.live.oracle.window import EditionInput, ReplayWindow
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings


def registry(config, settings):
    feeds = {}
    for key, source in (
        ("static_schedule", "gtfs_schedule_zip"),
        ("trip_updates", "gtfs_rt_trip_updates"),
        ("vehicle_positions", "gtfs_rt_vehicle_positions"),
    ):
        feeds[key] = dict(
            endpoint_key=key,
            feed_kind=key,
            source_format=source,
            source_url=f"https://fixture.test/{key}",
            auth={"auth_type": "none"},
            refresh_interval_seconds=60,
        )
    config.mkdir()
    manifest = dict(
        provider=dict(
            provider_id="oracle_seed", display_name="Oracle seed", timezone="America/Toronto"
        ),
        feeds=feeds,
        realtime={"lines_without_live_data": [{"gap_id": "gap", "route_ids": ["1"]}]},
    )
    (config / "test.yaml").write_text(yaml.safe_dump(manifest), encoding="utf-8")
    return ProviderRegistry(config, settings)


@pytest.fixture
def case(tmp_path):
    path = tmp_path / "schedule.zip"
    members = _minimal_compliant_members()
    members["stops.txt"] = members["stops.txt"].replace("node-1,,", "node-1,Generic node,")
    _write_members_zip(path, members)
    payload = path.read_bytes()
    at = datetime(2026, 3, 24, 12, 0, 0, 123456, tzinfo=UTC)
    edition = EditionInput(
        901,
        902,
        903,
        "local",
        path.name,
        hashlib.sha256(payload).hexdigest(),
        len(payload),
        None,
        at,
        at,
        at + timedelta(seconds=1),
        at + timedelta(seconds=2),
    )
    endpoints = {"static_schedule": 901, "trip_updates": 904, "vehicle_positions": 905}
    window = ReplayWindow("oracle_seed", endpoints, (), edition, at + timedelta(seconds=3), ())
    settings = Settings(_env_file=None)
    return SimpleNamespace(
        window=window,
        settings=settings,
        registry=registry(tmp_path / "providers", settings),
        bronze=lambda backend: LocalBronzeStorage(backend, tmp_path),
    )


@pytest.fixture
def oracle(real_db_engine, case):
    clock = PinnedClock(case.window.serving_initialized_at_utc)
    with oracle_database(
        real_db_engine.url.render_as_string(hide_password=False),
        clock=clock,
        environment=os.environ,
    ) as engine:
        yield engine
    with pytest.raises(SeedRefused, match="owned oracle"):
        seed(engine, case)


def seed(engine, case):
    seed_static(
        engine, case.window, settings=case.settings, registry=case.registry, bronze=case.bronze
    )


def test_seeded_endpoints_equal_what_seed_core_writes_except_the_id(oracle, case):
    manifest = case.registry.get_provider(case.window.provider_id)
    with oracle.engine.connect() as connection:
        transaction = connection.begin()
        _seed_provider(connection, manifest)
        _seed_feed_endpoints(connection, manifest, case.settings)
        expected = (
            connection.execute(text("SELECT * FROM core.feed_endpoints ORDER BY endpoint_key"))
            .mappings()
            .all()
        )
        expected = [{k: v for k, v in row.items() if k != "feed_endpoint_id"} for row in expected]
        transaction.rollback()
    seed(oracle, case)
    with oracle.engine.connect() as connection:
        rows = (
            connection.execute(text("SELECT * FROM core.feed_endpoints ORDER BY endpoint_key"))
            .mappings()
            .all()
        )
        assert [
            {k: v for k, v in row.items() if k != "feed_endpoint_id"} for row in rows
        ] == expected
        assert {
            row["endpoint_key"]: row["feed_endpoint_id"] for row in rows
        } == case.window.feed_endpoints
        assert connection.execute(
            text("SELECT lines_without_live_data FROM core.providers")
        ).scalar_one() == [{"gap_id": "gap", "route_ids": ["1"], "route_types": []}]


def assert_raw_edition(connection, edition):
    run = connection.execute(text("SELECT * FROM raw.ingestion_runs")).mappings().one()
    assert (run["ingestion_run_id"], run["feed_endpoint_id"], run["status"]) == (
        902,
        901,
        "succeeded",
    )
    for field in ("requested_at_utc", "started_at_utc", "completed_at_utc"):
        assert run[field] == getattr(edition, field)
    obj = connection.execute(text("SELECT * FROM raw.ingestion_objects")).mappings().one()
    assert (obj["ingestion_object_id"], obj["ingestion_run_id"], obj["source_url"]) == (
        903,
        902,
        None,
    )
    assert obj["checksum_sha256"] == edition.checksum_sha256
    assert obj["byte_size"] == edition.byte_size
    assert obj["created_at_utc"] == edition.object_created_at_utc


@pytest.mark.parametrize("provider_strict,settings_strict", [(False, True), (None, False)])
def test_seed_static_loads_the_edition_and_its_source_version_is_set(
    oracle, case, provider_strict, settings_strict
):
    case.registry.get_provider(case.window.provider_id).provider.strict_gtfs = provider_strict
    case.settings.STRICT_GTFS = settings_strict
    members = _minimal_compliant_members()
    members["stops.txt"] = members["stops.txt"].replace("node-1,,", "node-1,Generic node,")
    members["agency.txt"] = "agency_name,agency_url\nFixture,https://fixture.test\n"
    path = case.bronze("local").root / "schedule.zip"
    _write_members_zip(path, members)
    payload = path.read_bytes()
    case.window = replace(
        case.window,
        edition=replace(
            case.window.edition,
            checksum_sha256=hashlib.sha256(payload).hexdigest(),
            byte_size=len(payload),
        ),
    )
    seed(oracle, case)
    edition = case.window.edition
    with oracle.engine.connect() as connection:
        version = connection.execute(
            text("""
            SELECT source_version, source_ingestion_run_id, source_ingestion_object_id
            FROM core.dataset_versions WHERE is_current
        """)
        ).one()
        assert tuple(version) == (edition.storage_path, 902, 903)
        assert connection.execute(
            text("SELECT trip_id FROM gold.trip_service_span")
        ).scalars().all() == ["trip-1"]
        assert connection.execute(text("SELECT route_id FROM gold.dim_route")).scalars().all() == [
            "1"
        ]
        assert_raw_edition(connection, edition)
        states = connection.execute(
            text("""
            SELECT endpoint_key, initialized_at_utc, realtime_snapshot_id, captured_at_utc
            FROM gold.realtime_serving_state ORDER BY endpoint_key
        """)
        ).all()
        assert [tuple(row) for row in states] == [
            (key, case.window.serving_initialized_at_utc, None, None)
            for key in ("trip_updates", "vehicle_positions")
        ]


def test_unknown_endpoint_is_refused(oracle, case):
    case.window = replace(case.window, feed_endpoints={"unknown": 999})
    with pytest.raises(SeedRefused, match="unknown"):
        seed(oracle, case)


@pytest.mark.parametrize("kind", ["engine", "inactive"])
def test_unowned_engine_is_refused_before_connect(case, kind):
    engine = create_engine("sqlite://")
    target = engine if kind == "engine" else OracleDatabase()

    @event.listens_for(engine, "connect")
    def connected(*args):
        pytest.fail("seed_static connected to an unowned engine")

    try:
        with pytest.raises(SeedRefused, match="owned oracle"):
            seed(target, case)
    finally:
        engine.dispose()


def test_sequences_move_past_seeded_ids(oracle, case):
    seed(oracle, case)
    for table, column, maximum in (
        ("core.feed_endpoints", "feed_endpoint_id", 905),
        ("raw.ingestion_runs", "ingestion_run_id", 902),
        ("raw.ingestion_objects", "ingestion_object_id", 903),
    ):
        with oracle.engine.begin() as connection:
            next_id = connection.execute(
                text("SELECT nextval(pg_get_serial_sequence(:table, :column))"),
                {"table": table, "column": column},
            ).scalar_one()
            assert next_id > maximum


def poll_record(case, *, endpoint="trip_updates", status="succeeded", run_id=1101):
    from transit_ops.history.poll_record import CaptureEntry, FeedDayKey, PollEntry, PollRecord

    at = case.window.serving_initialized_at_utc + timedelta(seconds=run_id - 1096)
    family = "alert_snapshot" if endpoint == "i3_alerts" else "realtime_snapshot"
    payload = '{"apiVersion":"v1","alerts":[{"text":"Métro interrompu"}]}'.encode()
    path = case.bronze("local").root / f"{run_id}.json"
    path.write_bytes(payload)
    capture = CaptureEntry(
        family,
        run_id + 100,
        run_id,
        run_id + 200,
        False,
        None,
        None,
        len(payload),
        hashlib.sha256(payload).hexdigest(),
        "local",
        path.name,
        "api_i3_json" if family == "alert_snapshot" else "gtfs_rt_trip_updates",
        None,
        at,
        at,
        at,
        at,
        "header",
        None,
        200,
        None,
        None,
    )
    poll = PollEntry(
        run_id,
        endpoint,
        "stored" if status == "succeeded" else "failed",
        status,
        at,
        at,
        at,
        at,
        200,
        None if status == "succeeded" else "unavailable",
        at,
        "header",
        None,
        family,
        capture.capture_row_id if status == "succeeded" else None,
        None,
        None,
    )
    return PollRecord(
        FeedDayKey(case.window.provider_id, endpoint, family, at.date()),
        (poll,),
        (capture,) if status == "succeeded" else (),
        (),
        60,
        None,
    )


def rows(oracle, query):
    with oracle.engine.connect() as connection:
        return connection.execute(text(query)).mappings().all()


def admit(oracle, case, *records):
    window = replace(case.window, poll_records=records)
    return admit_polls(
        oracle.engine, window, until_utc=records[-1].polls[0].started_at_utc, bronze=case.bronze
    )


def test_admit_polls_inserts_in_time_order_with_production_ids(oracle, case):
    seed(oracle, case)
    early, late = poll_record(case), poll_record(case, run_id=1102)
    assert admit(oracle, case, late, early) == 3
    assert admit(oracle, case, late, early) == 0
    runs = rows(oracle, "SELECT * FROM raw.ingestion_runs ORDER BY ingestion_run_id")
    assert [r["ingestion_run_id"] for r in runs] == [902, 1101]
    assert runs[1]["status"] == "succeeded"
    for field in ("requested_at_utc", "started_at_utc", "completed_at_utc", "feed_timestamp_utc"):
        assert runs[1][field] == getattr(early.polls[0], field)
    assert runs[1]["entity_count"] is None
    capture = rows(oracle, "SELECT * FROM raw.realtime_snapshot_index")[0]
    assert (capture["realtime_snapshot_id"], capture["ingestion_object_id"]) == (1201, 1301)
    assert capture["captured_at_utc"] == early.captures[0].captured_at_utc
    obj = rows(oracle, "SELECT * FROM raw.ingestion_objects WHERE ingestion_object_id=1301")[0]
    assert obj["checksum_sha256"] == early.captures[0].sha256
    assert obj["created_at_utc"] == early.captures[0].object_created_at_utc
    assert obj["source_url"] is None
    assert admit(oracle, case, early, late) == 3
    for table, column, maximum in (
        ("ingestion_runs", "ingestion_run_id", 1102),
        ("ingestion_objects", "ingestion_object_id", 1302),
        ("realtime_snapshot_index", "realtime_snapshot_id", 1202),
    ):
        result = rows(oracle, f"SELECT nextval(pg_get_serial_sequence('raw.{table}','{column}')) n")
        assert result[0]["n"] > maximum


def test_a_poll_without_run_status_is_refused(case):
    record = poll_record(case, status=None)
    target = SimpleNamespace(engine=create_engine("sqlite://"))
    try:
        with pytest.raises(SeedRefused, match="1101.*run_status"):
            admit(target, case, record)
    finally:
        target.engine.dispose()


def test_alert_capture_stores_the_extracted_payload(oracle, case):
    from transit_ops.ingestion.i3 import extract_i3_metadata

    seed(oracle, case)
    with oracle.engine.begin() as connection:
        connection.execute(
            text("""
            INSERT INTO core.feed_endpoints
                (feed_endpoint_id,provider_id,endpoint_key,feed_kind,source_format,
                 source_url,auth_type,refresh_interval_seconds)
            SELECT 906,provider_id,'i3_alerts','i3_alerts','api_i3_json',
                   source_url,auth_type,refresh_interval_seconds
            FROM core.feed_endpoints WHERE feed_endpoint_id=904
        """)
        )
    case.window = replace(
        case.window, feed_endpoints=dict(case.window.feed_endpoints, i3_alerts=906)
    )
    record = poll_record(case, endpoint="i3_alerts")
    payload = (case.bronze("local").root / record.captures[0].storage_path).read_bytes()
    expected = extract_i3_metadata(payload, provider_id=case.window.provider_id).raw_payload_json
    assert admit(oracle, case, record) == 3
    row = rows(oracle, "SELECT * FROM raw.i3_alert_snapshots")[0]
    assert (row["i3_alert_snapshot_id"], row["ingestion_object_id"]) == (1201, 1301)
    assert row["raw_payload_json"] == expected
    result = rows(
        oracle,
        """
        SELECT nextval(pg_get_serial_sequence('raw.i3_alert_snapshots','i3_alert_snapshot_id')) n
    """,
    )
    assert result[0]["n"] > 1201


def test_a_failed_poll_has_a_run_and_no_capture(oracle, case):
    seed(oracle, case)
    assert admit(oracle, case, poll_record(case, status="failed")) == 1
    row = rows(oracle, "SELECT * FROM raw.ingestion_runs WHERE ingestion_run_id=1101")[0]
    assert (row["status"], row["error_message"]) == ("failed", "unavailable")
    assert rows(oracle, "SELECT ingestion_object_id FROM raw.ingestion_objects") == [
        {"ingestion_object_id": 903}
    ]
    assert rows(oracle, "SELECT * FROM raw.realtime_snapshot_index") == []
