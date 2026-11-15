import hashlib
import json
import os
import re
from contextlib import closing, contextmanager, nullcontext
from dataclasses import replace
from datetime import timedelta
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from google.transit import gtfs_realtime_pb2 as rt
from sqlalchemy import event, text
from test_live_oracle_runner import replay_case as replay_case
from test_live_oracle_seed import case as case
from test_live_oracle_seed import poll_record
from test_local_alert_apply import ALERT, read
from test_local_alert_seed import SETTINGS, bundle

from transit_ops.core.models import I3AlertsFeedConfig, ServiceAlertsFeedConfig
from transit_ops.ingestion.i3 import extract_i3_metadata, extract_service_alerts_metadata
from transit_ops.live.compare import compare_rows, rows_digest
from transit_ops.live.local_file import LocalFile
from transit_ops.live.oracle import PinnedClock, ReplayFailed, oracle_database, replay_window
from transit_ops.live.oracle.rows import read_cycle_rows
from transit_ops.live.oracle.window import CycleSpec
from transit_ops.providers import ProviderRegistry
from transit_ops.silver.i3 import RawI3AlertSnapshot, load_i3_snapshot_to_silver
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import KEYS, SCHEMAS, TABLES
from transit_ops.static.alert_state import seed_alert_state

# Expected evidence is declared independently of the reader and its returned metadata.
FACT_TABLES = ("gold.fact_trip_delay_snapshot", "gold.fact_vehicle_snapshot")
ALERT_TABLES = (
    "silver.i3_alerts",
    "silver.i3_alert_informed_entities",
    "silver.i3_alert_active_periods",
    "raw.alert_feed_observations",
    "raw.alert_language_observations",
)
COMMON = {
    "provider_id": "text",
    "realtime_snapshot_id": "bigint",
    "entity_index": "integer",
    "snapshot_date_key": "integer",
    "snapshot_local_date": "date",
    "feed_timestamp_utc": "timestamp with time zone",
    "captured_at_utc": "timestamp with time zone",
}
EXPECTED_FACTS = {
    FACT_TABLES[0]: COMMON
    | {
        "entity_id": "text",
        "trip_id": "text",
        "route_id": "text",
        "direction_id": "integer",
        "start_date": "date",
        "vehicle_id": "text",
        "trip_schedule_relationship": "integer",
        "delay_seconds": "integer",
        "stop_time_update_count": "integer",
        "delay_stop_id": "text",
        "delay_stop_sequence": "integer",
        "skipped_stop_count": "integer",
        "occupancy_status": "integer",
    },
    FACT_TABLES[1]: COMMON
    | {
        "position_timestamp_utc": "timestamp with time zone",
        "entity_id": "text",
        "vehicle_id": "text",
        "trip_id": "text",
        "route_id": "text",
        "stop_id": "text",
        "current_stop_sequence": "integer",
        "current_status": "integer",
        "occupancy_status": "integer",
        "latitude": "double precision",
        "longitude": "double precision",
        "bearing": "double precision",
        "speed": "double precision",
    },
}


def assert_contract(outcome):
    assert tuple(t.table for t in outcome.facts) == FACT_TABLES
    assert tuple(t.table for t in outcome.alert_state) == ALERT_TABLES
    for table in outcome.facts + outcome.alert_state:
        schema = EXPECTED_FACTS[table.table] if table.table in FACT_TABLES else SCHEMAS[table.table]
        keys = (
            ("provider_id", "realtime_snapshot_id", "entity_index")
            if table.table in FACT_TABLES
            else KEYS[table.table]
        )
        columns = tuple(schema)
        assert table.columns == columns
        assert table.types == tuple(schema.values())
        assert table.key_columns == tuple(columns.index(k) for k in keys)
        assert all(len(row) == len(columns) for row in table.rows)


@pytest.mark.parametrize("drift", ["added", "missing", "type"])
def test_cycle_reader_refuses_catalog_drift_by_table_name(drift):
    catalog = dict(EXPECTED_FACTS[FACT_TABLES[0]])
    if drift == "added":
        catalog["new_fact"] = "integer"
    elif drift == "missing":
        del catalog["delay_seconds"]
    else:
        catalog["delay_seconds"] = "bigint"
    connection = MagicMock()
    connection.execute.return_value.tuples.return_value.all.return_value = list(catalog.items())
    with pytest.raises(ValueError, match="gold.fact_trip_delay_snapshot.*contract"):
        read_cycle_rows(connection, provider_id="catalog_test")


def alert_bytes(endpoint, alerts):
    if endpoint == "i3_alerts":
        return json.dumps(alerts, ensure_ascii=False).encode()
    feed = rt.FeedMessage(header=dict(gtfs_realtime_version="2.0"))
    for alert in alerts:
        entity = feed.entity.add(id=alert["id"])
        message = entity.alert
        for language, value in alert["header"].items():
            message.header_text.translation.add(language=language, text=value)
        for route in alert["routes"]:
            message.informed_entity.add(route_id=route)
        message.active_period.add(start=1735689600)
    return feed.SerializeToString()


@pytest.fixture(params=["i3_alerts", "service_alerts"])
def alerts_case(replay_case, request):
    case = replay_case
    endpoint = request.param
    provider_id = "oracle_" + uuid4().hex
    manifest = case.registry.get_provider(case.window.provider_id)
    manifest.provider.provider_id = provider_id
    manifest_path = case.registry.config_dir / "test.yaml"
    # JSON is valid YAML; reload through the same public manifest interface as production.
    manifest_path.write_text(manifest.model_dump_json(), encoding="utf-8")
    case.registry = ProviderRegistry(case.registry.config_dir, case.settings)
    case.window = replace(
        case.window,
        provider_id=provider_id,
        poll_records=tuple(
            replace(record, feed_day=replace(record.feed_day, provider_id=provider_id))
            for record in case.window.poll_records
        ),
    )
    manifest = case.registry.get_provider(provider_id)
    template = manifest.feeds["trip_updates"]
    feed_type = I3AlertsFeedConfig if endpoint == "i3_alerts" else ServiceAlertsFeedConfig
    manifest.feeds[endpoint] = feed_type.model_validate(
        template.model_dump()
        | {
            "endpoint_key": endpoint,
            "feed_kind": endpoint,
            "source_format": "api_i3_json" if endpoint == "i3_alerts" else "gtfs_rt_service_alerts",
        }
    )
    at = case.window.serving_initialized_at_utc
    # equal-time display/children change, older capture, empty feed, new effective version.
    inputs = [
        ([ALERT, ALERT], 10),
        (
            [ALERT | {"header": {"fr": "Avis é雪", "en": "Edited"}, "routes": ["changed", "new"]}],
            10,
        ),
        ([ALERT | {"header": {"fr": "Older"}}], 9),
        ([], 12),
        ([ALERT | {"header": {"fr": "New"}}], 13),
    ]
    records = list(case.window.poll_records)
    cycles = []
    for index, (alerts, seconds) in enumerate(inputs):
        record = poll_record(case, run_id=1401 + index, endpoint="i3_alerts")
        body = alert_bytes(endpoint, alerts)
        capture = replace(
            record.captures[0],
            captured_at_utc=at + timedelta(seconds=seconds),
            byte_size=len(body),
            sha256=hashlib.sha256(body).hexdigest(),
        )
        (case.bronze("local").root / capture.storage_path).write_bytes(body)
        record = replace(
            record,
            feed_day=replace(record.feed_day, endpoint_key=endpoint),
            captures=(capture,),
            polls=(replace(record.polls[0], run_kind=endpoint),),
        )
        records.append(record)
        refs = (("alert_snapshot", capture.capture_row_id),)
        if index == 0:
            refs = (("realtime_snapshot", 1201),) + refs + (("realtime_snapshot", 1203),)
        cycles.append(CycleSpec(at + timedelta(seconds=400 + index * 30), refs))
    case.window = replace(
        case.window,
        feed_endpoints=dict(case.window.feed_endpoints) | {endpoint: 906},
        poll_records=tuple(records),
        cycles=tuple(cycles),
    )
    return case, endpoint


@contextmanager
def tracked_owner(admin):
    names, outstanding = [], set()

    def checkout(connection, *_):
        outstanding.add(id(connection))

    def checkin(connection, *_):
        outstanding.discard(id(connection))

    @contextmanager
    def owner(*args, **kwargs):
        with oracle_database(*args, **kwargs) as oracle:
            engine = oracle.engine
            event.listen(engine, "checkout", checkout)
            event.listen(engine, "checkin", checkin)
            with engine.connect() as connection:
                name = connection.execute(text("SELECT current_database()")).scalar_one()
                assert re.fullmatch(r".+_oracle_[0-9a-f]{16}", name)
                names.append(name)
            try:
                yield oracle
            finally:
                assert not outstanding, "runner leaked a checked-out connection"

    try:
        with patch("transit_ops.live.oracle.runner.oracle_database", owner):
            yield names
    finally:
        for name in names:
            try:
                with admin.connect() as connection:
                    assert (
                        connection.execute(
                            text("SELECT count(*) FROM pg_database WHERE datname=:n"), {"n": name}
                        ).scalar_one()
                        == 0
                    )
                    assert (
                        connection.execute(
                            text("SELECT count(*) FROM pg_stat_activity WHERE datname=:n"),
                            {"n": name},
                        ).scalar_one()
                        == 0
                    )
            finally:
                # An ownership regression must fail without leaving the test database behind.
                with admin.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
                    quoted = connection.dialect.identifier_preparer.quote(name)
                    connection.exec_driver_sql(f"DROP DATABASE IF EXISTS {quoted} WITH (FORCE)")
        assert not outstanding


def replay(case, real_db_engine):
    def consistent_rows(connection, **kwargs):
        assert tuple(
            connection.exec_driver_sql(
                "SELECT current_setting('transaction_read_only'), "
                "current_setting('transaction_isolation')"
            ).one()
        ) == ("on", "repeatable read")
        return read_cycle_rows(connection, **kwargs)

    with (
        tracked_owner(real_db_engine) as names,
        patch("transit_ops.live.oracle.runner.read_cycle_rows", side_effect=consistent_rows),
    ):
        result = list(
            replay_window(
                case.window,
                admin_url=real_db_engine.url.render_as_string(hide_password=False),
                environment=os.environ,
                settings=case.settings,
                registry=case.registry,
                bronze=case.bronze,
            )
        )
        assert len(names) == 1
        return result


def test_mixed_replay_returns_stable_typed_rows_and_independent_alert_parity(
    real_db_engine,
    alerts_case,
    tmp_path,
):
    case, endpoint = alerts_case
    concurrency = case.settings.SNAPSHOT_PUBLISH_CONCURRENCY
    first, second = replay(case, real_db_engine), replay(case, real_db_engine)
    assert case.settings.SNAPSHOT_PUBLISH_CONCURRENCY == concurrency
    assert [c.public for c in first] == [c.public for c in second]
    assert [c.facts for c in first] == [c.facts for c in second]
    assert [c.alert_state for c in first] == [c.alert_state for c in second]
    seed = bundle().model_copy(update={"provider_id": case.window.provider_id})
    for table in seed.tables.values():
        table.rows.clear()
    extract = extract_i3_metadata if endpoint == "i3_alerts" else extract_service_alerts_metadata
    with closing(
        LocalFile.open(
            tmp_path / "alerts.db", provider_id=case.window.provider_id, settings=SETTINGS
        )
    ) as local:
        seed_alert_state(local, seed)
        for cycle, outcome in zip(case.window.cycles, first, strict=True):
            assert_contract(outcome)
            _, sid = next(ref for ref in cycle.captures if ref[0] == "alert_snapshot")
            _, capture = case.window.capture("alert_snapshot", sid)
            body = (case.bronze("local").root / capture.storage_path).read_bytes()
            payload = extract(body, provider_id=case.window.provider_id).raw_payload_json
            apply_alert_snapshot(
                local,
                RawI3AlertSnapshot(
                    sid,
                    case.window.provider_id,
                    "America/Toronto",
                    capture.captured_at_utc,
                    payload,
                ),
                loaded_at_utc=cycle.generated_utc,
            )
            for table in outcome.alert_state:
                candidate = [
                    tuple(row[c] for c in SCHEMAS[table.table]) for row in read(local, table.table)
                ]
                assert compare_rows(table.table, table.key_columns, table.rows, candidate) == []
                assert rows_digest(table.rows) == rows_digest(candidate)
            for table in outcome.facts:
                assert table.rows
                assert table.columns[:3] == ("provider_id", "realtime_snapshot_id", "entity_index")
                assert table.key_columns == (0, 1, 2)
                assert all(row[0] == case.window.provider_id for row in table.rows)
                assert list(table.rows) == sorted(table.rows, key=lambda row: row[:3])
                assert all(
                    row[table.columns.index("captured_at_utc")].utcoffset() is not None
                    for row in table.rows
                )
                assert rows_digest(table.rows)
    alerts = first[1].alert_state[0]
    values = [dict(zip(alerts.columns, row, strict=True)) for row in alerts.rows]
    assert len(values) == 1
    assert values[0]["i3_alert_snapshot_id"] == 1501
    assert values[0]["message_snapshot_id"] == 1502
    assert values[0]["alert_header_text_en"] == "Edited"
    assert first[2].alert_state[:3] == first[1].alert_state[:3]
    assert first[3].alert_state[0] == first[2].alert_state[0]
    assert any(
        row[alerts.columns.index("valid_to")] is not None for row in first[4].alert_state[0].rows
    )
    # The earlier detached evidence still describes the first message.
    assert first[0].alert_state[0].rows[0][alerts.columns.index("message_snapshot_id")] == 1501


def test_failed_alert_load_rolls_back_capture_and_yields_no_success(real_db_engine, alerts_case):
    case, _ = alerts_case
    clock = PinnedClock(case.window.serving_initialized_at_utc)
    with oracle_database(
        real_db_engine.url.render_as_string(hide_password=False),
        clock=clock,
        environment=os.environ,
    ) as oracle:

        def fail_after_load(connection, **kwargs):
            load_i3_snapshot_to_silver(connection, **kwargs)
            raise RuntimeError("alert write failed")

        with (
            patch(
                "transit_ops.live.oracle.runner.oracle_database", return_value=nullcontext(oracle)
            ),
            patch(
                "transit_ops.live.oracle.runner.load_i3_snapshot_to_silver",
                side_effect=fail_after_load,
            ),
            pytest.raises(ReplayFailed) as error,
        ):
            next(
                replay_window(
                    case.window,
                    admin_url="unused",
                    environment={},
                    settings=case.settings,
                    registry=case.registry,
                    bronze=case.bronze,
                )
            )
        assert str(error.value.__cause__) == "alert write failed"
        assert error.value.generated_utc == case.window.cycles[0].generated_utc
        with oracle.engine.connect() as connection:
            for table in TABLES[:5]:
                assert connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0


def test_public_runner_cleans_up_after_alert_failure(real_db_engine, alerts_case):
    case, _ = alerts_case

    def load(connection, **kwargs):
        load_i3_snapshot_to_silver(connection, **kwargs)
        raise RuntimeError("alert write failed")

    with tracked_owner(real_db_engine) as names:
        with patch("transit_ops.live.oracle.runner.load_i3_snapshot_to_silver", side_effect=load):
            with pytest.raises(ReplayFailed) as error:
                list(
                    replay_window(
                        case.window,
                        admin_url=real_db_engine.url.render_as_string(hide_password=False),
                        environment=os.environ,
                        settings=case.settings,
                        registry=case.registry,
                        bronze=case.bronze,
                    )
                )
            assert str(error.value.__cause__) == "alert write failed"
        assert len(names) == 1


def test_alert_only_replay_keeps_both_empty_typed_fact_tables(real_db_engine, alerts_case):
    case, _ = alerts_case
    case.window = replace(
        case.window, cycles=(replace(case.window.cycles[0], captures=(("alert_snapshot", 1501),)),)
    )
    (outcome,) = replay(case, real_db_engine)
    assert_contract(outcome)
    assert all(table.rows == () for table in outcome.facts)


def test_empty_evidence_has_every_declared_column_type_and_key(alerts_case):
    from types import SimpleNamespace

    case, _ = alerts_case
    schemas = EXPECTED_FACTS | {name: SCHEMAS[name] for name in ALERT_TABLES}
    connection = MagicMock()

    def execute(statement, params):
        result = MagicMock()
        if "pg_attribute" in str(statement):
            result.tuples.return_value.all.return_value = list(schemas[params["table"]].items())
        else:
            result.__iter__.return_value = iter(())
        return result

    connection.execute.side_effect = execute
    facts, alerts = read_cycle_rows(connection, provider_id=case.window.provider_id)
    assert_contract(SimpleNamespace(facts=facts, alert_state=alerts))
    assert all(table.rows == () for table in facts + alerts)


def test_added_columns_in_any_evidence_table_refuse_by_name(real_db_engine, alerts_case):
    case, _ = alerts_case
    with oracle_database(
        real_db_engine.url.render_as_string(hide_password=False),
        clock=PinnedClock(case.window.serving_initialized_at_utc),
        environment=os.environ,
    ) as oracle:
        for table in FACT_TABLES + ALERT_TABLES:
            with oracle.engine.connect() as connection:
                transaction = connection.begin()
                try:
                    connection.exec_driver_sql(
                        f"ALTER TABLE {table} ADD COLUMN contract_probe integer"
                    )
                    with pytest.raises(ValueError, match=table + ".*contract"):
                        read_cycle_rows(connection, provider_id=case.window.provider_id)
                finally:
                    transaction.rollback()


def test_cycle_reader_orders_text_keys_as_binary_under_a_nonbinary_collation(
    real_db_engine, seed_provider, case
):
    keys = ("a_b", "aB", "Ab", "ab")
    binary_order = ["Ab", "aB", "a_b", "ab"]
    provider_id = "oracle_" + uuid4().hex
    at = case.window.serving_initialized_at_utc
    with oracle_database(
        real_db_engine.url.render_as_string(hide_password=False),
        clock=PinnedClock(at),
        environment=os.environ,
    ) as oracle:
        with oracle.engine.begin() as connection:
            collation = connection.execute(
                text("""
                SELECT n.nspname, c.collname FROM pg_collation c
                JOIN pg_namespace n ON n.oid=c.collnamespace
                WHERE c.collname IN ('und-x-icu', 'en-US-x-icu', 'en_US', 'en_US.utf8')
                  AND c.collencoding IN (
                      -1, pg_char_to_encoding(current_setting('server_encoding')))
                ORDER BY CASE c.collname WHEN 'und-x-icu' THEN 0 ELSE 1 END, c.collname
                LIMIT 1
            """)
            ).one_or_none()
            if collation is None:
                pytest.skip(
                    "nonbinary collation unavailable: und-x-icu, en-US-x-icu, en_US, en_US.utf8"
                )
            quote = connection.dialect.identifier_preparer.quote
            qualified = ".".join(quote(part) for part in collation)
            connection.exec_driver_sql(
                "ALTER TABLE raw.alert_language_observations "
                f"ALTER COLUMN alert_logical_id TYPE text COLLATE {qualified}"
            )
            seed_provider(connection, provider_id, display_name="Binary ordering test")
            connection.execute(
                text("""
                INSERT INTO raw.alert_language_observations
                    (provider_id, alert_logical_id, observation_date, has_explicit_fr,
                     has_explicit_en, undetermined, observed_at_utc)
                VALUES (:provider, :key, :day, true, false, false, :at)
            """),
                [dict(provider=provider_id, key=key, day=at.date(), at=at) for key in keys],
            )
            locale_order = list(
                connection.execute(
                    text("""
                SELECT alert_logical_id FROM raw.alert_language_observations
                WHERE provider_id=:provider ORDER BY alert_logical_id
            """),
                    {"provider": provider_id},
                ).scalars()
            )
            assert locale_order != binary_order, f"{qualified} must differ from binary on {keys}"
        with oracle.engine.begin() as connection:
            connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            _, alerts = read_cycle_rows(connection, provider_id=provider_id)
        table = next(t for t in alerts if t.table == "raw.alert_language_observations")
        key_index = tuple(SCHEMAS[table.table]).index("alert_logical_id")
        # Assert the raw tuple order, before either comparator can sort its input.
        assert [row[key_index] for row in table.rows] == binary_order
        assert sorted(locale_order) == binary_order
