import os
from datetime import UTC, datetime

from sqlalchemy import text
from test_rescue_fact_day import fact_source as fact_source

from transit_ops.batch.build import InputNeed
from transit_ops.batch.engine import BatchInput
from transit_ops.batch.input_sources import Source, materialize
from transit_ops.batch.pg_load import load_inputs, prepare_replay_database
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window


def test_month_filtered_to_day_loads_exact_day_export(real_db_engine, fact_source, tmp_path):
    """Use the same PostgreSQL day predicate as the existing replay export fixture."""
    provider = fact_source[0]
    database = prepare_replay_database(
        real_db_engine.url.render_as_string(hide_password=False), os.environ
    )
    relation = "raw.realtime_snapshot_index"
    start = datetime(2026, 11, 1, tzinfo=UTC)
    end = datetime(2026, 11, 2, tzinfo=UTC)
    with database.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO raw.realtime_snapshot_index(provider_id,feed_endpoint_id,"
                "ingestion_run_id,ingestion_object_id,feed_timestamp_utc,"
                "captured_at_utc,entity_count) "
                "SELECT provider_id,feed_endpoint_id,ingestion_run_id,ingestion_object_id,"
                "feed_timestamp_utc,:end,entity_count FROM raw.realtime_snapshot_index "
                "WHERE provider_id=:p LIMIT 1"
            ),
            {"p": provider, "end": end},
        )
    with database.engine.connect() as conn:
        expected = conn.execute(
            text(
                f"SELECT * FROM {relation} WHERE provider_id=:p "
                "AND captured_at_utc>=:start AND captured_at_utc<:end ORDER BY realtime_snapshot_id"
            ),
            {"p": provider, "start": start, "end": end},
        ).fetchall()
    assert expected
    import psycopg

    with psycopg.connect(
        **database.engine.url.translate_connect_args(username="user", database="dbname")
    ) as conn:
        exported = export_window(
            conn,
            WindowSpec(relation, provider, "2026-11"),
            tmp_path / "month.csv",
            statement_timeout_s=60,
        )
    written = write_window(
        exported.csv_path,
        exported.schema,
        tmp_path / "month.parquet",
        metadata={},
        temp_dir=tmp_path,
    )
    source = Source(
        "month",
        {"object_sha256": written.sha256, "object_bytes": written.byte_size},
        (InputNeed(relation, "2026-11-01"),),
    )
    root = tmp_path / "inputs"
    receipts = materialize([source], {"month": written.path}, root, end)
    assert receipts[0]["rows_kept"] == len(expected)
    assert receipts[0]["rows_dropped"] == 1
    with database.engine.begin() as conn:
        conn.exec_driver_sql(f"CREATE TABLE public.replay_month (LIKE {relation})")
    try:
        path = root / relation / "2026-11-01.parquet"
        loaded = load_inputs(database, [BatchInput("public.replay_month", (path,))], tmp_path)
        assert loaded[0].rows == len(expected)
        with database.engine.connect() as conn:
            actual = conn.exec_driver_sql(
                "SELECT * FROM public.replay_month ORDER BY realtime_snapshot_id"
            ).fetchall()
        assert actual == expected
    finally:
        with database.engine.begin() as conn:
            conn.exec_driver_sql("DROP TABLE public.replay_month")
        database.engine.dispose()
