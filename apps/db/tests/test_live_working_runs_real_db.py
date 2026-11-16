from datetime import timedelta

from sqlalchemy import text
from test_history_reader_real_db import PROVIDER, START, seed
from test_history_reader_real_db import conn as conn

from transit_ops.history.working_captures import read_working_runs


def test_identity_page_reads_midnight_and_separate_namespaces(conn):
    seed(conn, at=START, run_id=101, capture_id=101)
    seed(conn, "vehicle_positions", at=START + timedelta(days=1), run_id=102, capture_id=102)
    records = read_working_runs(conn, provider_id=PROVIDER, run_ids=[102])
    assert len(records) == 1
    assert records[0].feed_day.endpoint_key == "vehicle_positions"
    assert records[0].feed_day.utc_date == (START + timedelta(days=1)).date()
    assert [c.capture_row_id for c in records[0].captures] == [102]
    assert read_working_runs(conn, provider_id="other_provider", run_ids=[101, 102]) == ()


def test_failed_poll_and_failed_silver_use_exact_tag_not_latest_capture(conn):
    endpoint = seed(conn, at=START, run_id=101, capture_id=101)
    seed(conn, at=START + timedelta(minutes=1), run_id=102, capture_id=102)
    run_id = conn.execute(
        text(
            "INSERT INTO raw.ingestion_runs(provider_id, feed_endpoint_id, run_kind, status, "
            "requested_at_utc, started_at_utc, completed_at_utc, error_message) VALUES "
            "(:p, :e, 'silver_load', 'failed', :at, :at, :at, '[capture_row_id=101] failed') "
            "RETURNING ingestion_run_id"
        ),
        dict(p=PROVIDER, e=endpoint, at=START + timedelta(days=1)),
    ).scalar_one()
    records = read_working_runs(conn, provider_id=PROVIDER, run_ids=[run_id])
    failure = next(p for record in records for p in record.processing)
    assert failure.capture_row_id == 101
    assert failure.attribution == "recorded"
    assert [c.capture_row_id for record in records for c in record.captures] == [101]
