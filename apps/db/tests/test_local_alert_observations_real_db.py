from dataclasses import replace
from datetime import datetime, timedelta

import pytest
from sqlalchemy import text
from test_local_alert_observations import AT, duck, feed_rows, language_rows, snapshot

from transit_ops.silver.i3 import load_i3_snapshot_to_silver
from transit_ops.static.alert_observations import record_alert_observations

# Reuse the local file fixture; PostgreSQL comes from the disposable target guard.
duck = duck


@pytest.mark.parametrize("case", ["empty", "older", "language", "timezone", "unknown"])
def test_observation_rows_and_admission_equal_old_loader(real_db_engine, seed_provider, duck, case):
    provider = "local_alert_observations_test"
    with real_db_engine.connect() as pg, pg.begin() as transaction:
        seed_provider(pg, provider, display_name="Disposable alert observation parity")
        endpoint = pg.execute(
            text(
                "INSERT INTO core.feed_endpoints "
                "(provider_id, endpoint_key, feed_kind, source_format) "
                "VALUES (:p, 'i3_alerts', 'i3_alerts', 'api_i3_json') RETURNING feed_endpoint_id"
            ),
            {"p": provider},
        ).scalar_one()
        for capture in captures(case):
            run = pg.execute(
                text(
                    "INSERT INTO raw.ingestion_runs "
                    "(provider_id, feed_endpoint_id, run_kind, status) "
                    "VALUES (:p, :e, 'i3_alerts', 'succeeded') RETURNING ingestion_run_id"
                ),
                {"p": provider, "e": endpoint},
            ).scalar_one()
            sid = pg.execute(
                text(
                    "INSERT INTO raw.i3_alert_snapshots (provider_id, feed_endpoint_id, "
                    "ingestion_run_id, captured_at_utc, raw_payload_json) "
                    "VALUES (:p, :e, :r, :at, '{}') RETURNING i3_alert_snapshot_id"
                ),
                {"p": provider, "e": endpoint, "r": run, "at": capture.captured_at_utc},
            ).scalar_one()
            capture = replace(capture, provider_id=provider, i3_alert_snapshot_id=sid)
            result = load_i3_snapshot_to_silver(pg, snapshot=capture, loaded_at_utc=AT)
            assert record_alert_observations(duck, capture) == (not result.skipped_older_capture)
            for table, local_rows in (
                ("alert_feed_observations", feed_rows(duck)),
                ("alert_language_observations", language_rows(duck)),
            ):
                expected = pg.execute(
                    text(f"SELECT * FROM raw.{table} WHERE provider_id=:p ORDER BY 1, 2, 3"),
                    {"p": provider},
                ).fetchall()
                assert local_rows == [tuple(row) for row in expected]
        transaction.rollback()


def captures(case):
    first = snapshot([{"id": "a", "header": {"fr": "Avis é"}}])
    if case == "empty":
        return [first, snapshot([], AT + timedelta(seconds=1))]
    if case == "older":
        return [
            first,
            snapshot([{"id": "old"}], AT - timedelta(days=1)),
            snapshot([], AT - timedelta(seconds=1)),
        ]
    if case == "language":
        return [
            first,
            snapshot([{"id": "a"}], AT - timedelta(seconds=1)),
            snapshot([{"id": "a", "header": {"en": "Notice"}}]),
            snapshot([], AT + timedelta(seconds=1)),
        ]
    if case == "timezone":
        return [
            snapshot([{"id": "a"}], datetime.fromisoformat(at))
            for at in (
                "2026-03-08T04:59:59+00:00",
                "2026-03-08T07:00:00+00:00",
                "2026-11-01T05:30:00+00:00",
                "2026-11-01T06:30:00+00:00",
            )
        ]
    return [
        snapshot({"messages": [None, {"id": "a", "header": {"es": "Aviso"}}]}),
        snapshot([{"id": "a", "header": None}, {"id": "a", "header": ""}]),
    ]
