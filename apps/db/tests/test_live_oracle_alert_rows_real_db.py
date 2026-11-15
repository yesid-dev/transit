import hashlib
import json
import os
from contextlib import closing, nullcontext
from dataclasses import replace
from datetime import timedelta
from unittest.mock import patch

import pytest
from google.transit import gtfs_realtime_pb2 as rt
from sqlalchemy import text
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
from transit_ops.live.oracle.window import CycleSpec
from transit_ops.silver.i3 import RawI3AlertSnapshot, load_i3_snapshot_to_silver
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import TABLES
from transit_ops.static.alert_state import seed_alert_state


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
    manifest = case.registry.get_provider(case.window.provider_id)
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


def replay(case, real_db_engine):
    return list(
        replay_window(
            case.window,
            admin_url=real_db_engine.url.render_as_string(hide_password=False),
            environment=os.environ,
            settings=case.settings,
            registry=case.registry,
            bronze=case.bronze,
        )
    )


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
                    tuple(row[c] for c in table.columns) for row in read(local, table.table)
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
