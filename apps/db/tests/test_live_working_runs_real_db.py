from contextlib import closing
from datetime import timedelta

from history_fixtures import _working_capture
from sqlalchemy import text
from test_history_reader_real_db import PROVIDER, START, seed
from test_history_reader_real_db import conn as conn
from test_live_local_file import SETTINGS

from transit_ops.history.working_captures import read_working_runs
from transit_ops.live.local_file import LocalFile
from transit_ops.live.recording import Recorder


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


def test_source_page_bounds_history_but_reads_current_and_pending_runs(conn, tmp_path):
    seed(conn, at=START, run_id=101, capture_id=101)
    seed(conn, at=START, run_id=102, capture_id=102)
    seed(conn, at=START, run_id=103, status="running", with_capture=False)
    with closing(
        LocalFile.open(tmp_path / "page.db", provider_id=PROVIDER, settings=SETTINGS)
    ) as local:
        recorder = Recorder(local, provider_id=PROVIDER)
        records, ids, upper = recorder._source_page(conn, 0, 0, 0, 1, ())
        assert ids == [101]
        assert upper == 103
        assert {p.ingestion_run_id for r in records for p in r.polls} == {101, 102}
        records, ids, _ = recorder._source_page(conn, 0, 102, upper, 1, ())
        assert ids == [103]  # pending identities must be enumerated, not skipped
        assert {p.ingestion_run_id for r in records for p in r.polls} == {102}
        conn.execute(
            text(
                "UPDATE raw.ingestion_runs SET status='failed', completed_at_utc=:at "
                "WHERE provider_id=:p AND ingestion_run_id=103"
            ),
            dict(p=PROVIDER, at=START),
        )
        records, ids, _ = recorder._source_page(conn, 0, 103, upper, 1, (102,))
        assert ids == []  # current receipts never advance the historical cursor
        assert {p.ingestion_run_id for r in records for p in r.polls} == {102, 103}


def read_page(recorder, conn):
    initial, after, upper = recorder.local.connection.execute(
        "SELECT initial_run_id, after_run_id, sweep_last_run_id FROM recording_cursor"
    ).fetchone()
    records, ids, upper = recorder._source_page(
        conn, initial, after, upper, 2, recorder._due_runs(2)
    )
    recorder._commit_page(records, ids, initial, upper)
    return records, ids


def test_lower_terminal_receipt_discharge_is_durable_across_keyset_reopen(conn, tmp_path):
    endpoint = seed(conn, "vehicle_positions", run_id=100, status="running", with_capture=False)
    seed(conn, run_id=101, capture_id=101)
    for identity in (102, 103):
        seed(conn, run_id=identity, status="failed", with_capture=False)
    path = tmp_path / "coverage.db"
    with closing(LocalFile.open(path, provider_id=PROVIDER, settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id=PROVIDER)
        recorder.initialize(initial_run_id=0, seed_sha256="seed")
        assert read_page(recorder, conn)[1] == [100, 101]
        assert read_page(recorder, conn)[1] == [102, 103]
        assert not recorder.sweep_complete
        assert recorder.completed_upper is None
    params = dict(
        p=PROVIDER,
        e=endpoint,
        r=100,
        s=102,
        o=100,
        end=START + timedelta(seconds=4),
        stamp=START,
        checksum="a" * 64,
        n=2,
        path="capture/100",
    )
    conn.execute(
        text(
            "UPDATE raw.ingestion_runs SET status='succeeded', completed_at_utc=:end, "
            "feed_timestamp_utc=:stamp, entity_count=2, http_status_code=200 "
            "WHERE provider_id=:p AND ingestion_run_id=100"
        ),
        params,
    )
    _working_capture(conn, params, "vehicle_positions")
    with closing(LocalFile.open(path, provider_id=PROVIDER, settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id=PROVIDER)
        recorder.initialize(initial_run_id=0, seed_sha256="seed")
        records, ids = read_page(recorder, conn)
        assert ids == []  # 100 is behind history and outside the 103/102 tail
        assert any(
            c.ingestion_run_id == 100 and c.capture_row_id == 102
            for r in records
            for c in r.captures
        )
        assert recorder.sweep_complete
        assert recorder.completed_upper == 103
        assert local.connection.execute(
            "SELECT covered_through FROM recording_cursor"
        ).fetchone() == (103,)
