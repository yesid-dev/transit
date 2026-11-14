from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
import real_db_seed as seed
from sqlalchemy import text
from test_orchestration import _i3_ingestion_result, _realtime_ingestion_result

from transit_ops import capture_load, orchestration
from transit_ops.failed_load_tag import parse_failed_load_capture_row_id
from transit_ops.settings import Settings

AT = datetime(2026, 6, 20, 12, tzinfo=UTC)
ENDPOINTS = ("trip_updates", "vehicle_positions", "i3_alerts", "service_alerts")
HOSTILE = (
    "[capture_row_id=999] hostile\n[capture_row_id=3] https://example.test?api_key=private-secret"
)


@pytest.fixture
def worker(real_db_engine, seed_provider, monkeypatch):
    with real_db_engine.connect() as conn, conn.begin():
        seed_provider(conn, "sd14_test", display_name="SD14")
        for index, endpoint in enumerate(ENDPOINTS):
            params = {
                "p": "sd14_test",
                "e": 944100 + index,
                "k": endpoint,
                "r": 944200 + index,
                "s": 944042 + index,
                "ts": AT,
                "n": 1,
            }
            seed.feed_endpoints(conn, params, endpoint_key=":k", feed_kind=":k")
            seed.ingestion_runs(conn, params, run_kind=":k")
            if index < 2:
                seed.realtime_snapshot_index(conn, params)
                newer = params | {"s": 944052 + index, "r": 944300 + index}
                seed.ingestion_runs(conn, newer, run_kind=":k")
                seed.realtime_snapshot_index(conn, newer)
            else:
                conn.execute(
                    text(
                        "INSERT INTO raw.i3_alert_snapshots "
                        "(i3_alert_snapshot_id, provider_id, feed_endpoint_id, ingestion_run_id, "
                        "captured_at_utc, raw_payload_json) VALUES (:s,:p,:e,:r,:ts,'[]')"
                    ),
                    params,
                )
        engine = SimpleNamespace(begin=lambda: nullcontext(conn))
        monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **k: None)
        monkeypatch.setattr(orchestration, "_best_effort_publish_live", lambda *a, **k: 0)
        monkeypatch.setattr(orchestration, "utc_now", lambda: AT)
        monkeypatch.setattr(capture_load, "utc_now", lambda: AT)

        def cycle(endpoint, fault=None):
            index = ENDPOINTS.index(endpoint)
            receipt = (
                _realtime_ingestion_result(endpoint, 944042 + index, "sd14_test")
                if index < 2
                else replace(
                    _i3_ingestion_result(),
                    provider_id="sd14_test",
                    endpoint_key=endpoint,
                    i3_alert_snapshot_id=944042 + index,
                )
            )
            if fault in {"provider_id", "endpoint_key"}:
                receipt = replace(receipt, **{fault: "[capture_row_id=999] hostile"})
            monkeypatch.setattr(
                capture_load, "_capture_realtime_feed", lambda *a, **k: (receipt, HOSTILE.encode())
            )
            for name in ("_capture_i3_alerts", "_capture_service_alerts"):
                monkeypatch.setattr(orchestration, name, lambda *a, **k: receipt)

            def fail(*args, **kwargs):
                raise RuntimeError(HOSTILE)

            monkeypatch.setattr(capture_load, "_load_realtime_to_silver", fail)
            monkeypatch.setattr(orchestration, "load_i3_to_silver", fail)
            registry = SimpleNamespace(
                get_provider=lambda p: SimpleNamespace(
                    feeds={endpoint: SimpleNamespace(refresh_interval_seconds=30)}
                )
            )
            result = orchestration.run_realtime_cycle(
                "sd14_test",
                settings=Settings(_env_file=None),
                registry=registry,
                engine=engine,
                bronze_storage_resolver=lambda b: object(),
            )
            row = (
                conn.execute(
                    text(
                        "SELECT error_message, run_kind, feed_endpoint_id "
                        "FROM raw.ingestion_runs WHERE provider_id='sd14_test' "
                        "AND run_kind='silver_load' "
                        "ORDER BY ingestion_run_id DESC LIMIT 1"
                    )
                )
                .mappings()
                .one()
            )
            return result.endpoint_results[0], row

        yield cycle, conn
        conn.rollback()


@pytest.mark.parametrize("endpoint", ENDPOINTS[:2])
def test_failed_silver_load_row_names_its_capture(worker, endpoint):
    result, row = worker[0](endpoint)
    identity = 944042 + ENDPOINTS.index(endpoint)
    assert row["error_message"] == f"[capture_row_id={identity}] {result.error_message}"
    assert row["run_kind"] == "silver_load"
    assert row["feed_endpoint_id"] == 944100 + ENDPOINTS.index(endpoint)
    assert parse_failed_load_capture_row_id(row["error_message"]) == identity


@pytest.mark.parametrize("endpoint", ENDPOINTS[2:])
def test_alert_feed_tag_names_the_alert_snapshot_id(worker, endpoint):
    test_failed_silver_load_row_names_its_capture(worker, endpoint)


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("fault", ["provider_id", "endpoint_key"])
def test_no_tag_on_a_capture_identity_failure(worker, endpoint, fault):
    result, row = worker[0](endpoint, fault)
    assert row["error_message"] == result.error_message
    assert row["error_message"].startswith("load-")
    assert parse_failed_load_capture_row_id(row["error_message"]) is None


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_payload_or_error_tag_cannot_forge_persisted_capture_id(worker, endpoint):
    result, row = worker[0](endpoint)
    assert parse_failed_load_capture_row_id(row["error_message"]) == 944042 + ENDPOINTS.index(
        endpoint
    )
    assert "[capture_row_id=999] hostile\n[capture_row_id=3]" in row["error_message"]
    assert "private-secret" not in row["error_message"]
    assert "private-secret" not in result.error_message


def _silver_rows(engine, provider):
    with engine.connect() as conn:
        tables = (
            conn.execute(
                text(
                    "SELECT tablename FROM pg_tables "
                    "WHERE schemaname='silver' AND (tablename LIKE 'rt_%' OR tablename LIKE 'i3_%')"
                )
            )
            .scalars()
            .all()
        )
        return {
            t: conn.execute(
                text(
                    f"SELECT to_jsonb(t) FROM silver.{t} t "
                    "WHERE to_jsonb(t)->>'provider_id'=:p OR "
                    "(to_jsonb(t)->>'i3_alert_snapshot_id')::bigint IN "
                    "(SELECT i3_alert_snapshot_id FROM silver.i3_alerts WHERE provider_id=:p) "
                    "ORDER BY to_jsonb(t)::text"
                ),
                {"p": provider},
            )
            .scalars()
            .all()
            for t in tables
        }


def test_failure_tag_keeps_silver_rows_and_live_bytes(real_db_engine, tmp_path, monkeypatch):
    import revision_2_seed as data
    from test_revision_2_projection import _pin, _publish

    settings = data.settings_for(tmp_path)
    data.delete_rows(real_db_engine)
    try:
        data.seed_history(real_db_engine, settings, tmp_path)
        data.seed_live(real_db_engine, settings, tmp_path, data.HISTORY_CLOCK)
        _pin(monkeypatch, data.HISTORY_CLOCK)
        with data.pinned_engine(real_db_engine, data.HISTORY_CLOCK) as engine:
            for provider in data.PROVIDERS.values():
                before = _silver_rows(engine, provider)
                assert before["rt_trip_updates"] and before["rt_vehicle_positions"]
                with engine.begin() as conn:
                    endpoint = conn.execute(
                        text(
                            "SELECT feed_endpoint_id FROM core.feed_endpoints "
                            "WHERE provider_id=:p AND endpoint_key='trip_updates'"
                        ),
                        {"p": provider},
                    ).scalar_one()
                    run = conn.execute(
                        text(
                            "INSERT INTO raw.ingestion_runs (provider_id, "
                            "feed_endpoint_id,run_kind,status,started_at_utc,"
                            "completed_at_utc,error_message) "
                            "VALUES (:p,:e,'silver_load','failed',:ts,:ts,"
                            "'load-realtime-silver failed: down') "
                            "RETURNING ingestion_run_id"
                        ),
                        {"p": provider, "e": endpoint, "ts": data.HISTORY_CLOCK},
                    ).scalar_one()
                _, legacy = _publish(engine, settings, provider, "live")
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            "UPDATE raw.ingestion_runs SET error_message="
                            "'[capture_row_id=42] load-realtime-silver failed: down' "
                            "WHERE ingestion_run_id=:r"
                        ),
                        {"r": run},
                    )
                _, tagged = _publish(engine, settings, provider, "live")
                assert tagged == legacy
                assert set(legacy) == {
                    "live/trips.json",
                    "live/stop_departures.json",
                    "live/vehicles.json",
                    "live/alerts.json",
                    "live/network.json",
                    "status/data_health.json",
                    "manifest.json",
                }
                assert _silver_rows(engine, provider) == before
    finally:
        data.delete_rows(real_db_engine)
