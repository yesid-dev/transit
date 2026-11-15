import os
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
import real_db_seed
from sqlalchemy import text
from test_family_percentiles_histograms import DAY, REQUEST, SEED, assert_math

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.percentiles_histograms import builder
from transit_ops.batch.pg_load import pinned_replay_engine, prepare_replay_database
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window

PROVIDER = "percentiles_histograms_seed"
RELATIONS = (
    *builder.tables,
    "gold.warm_rollup_periods",
    "gold.fact_trip_delay_snapshot",
    "raw.realtime_snapshot_index",
    "raw.ingestion_runs",
    "core.feed_endpoints",
    "core.providers",
)


def seed_facts(conn, seed_provider, request, rows):
    seed_provider(conn, PROVIDER, display_name="Percentile seed", timezone=request.timezone)
    params = dict(p=PROVIDER, e=98270001, r=98270002, s=98270003, ts=request.as_of_utc, n=len(rows))
    real_db_seed.feed_endpoints(conn, params)
    real_db_seed.ingestion_runs(conn, params)
    real_db_seed.realtime_snapshot_index(conn, params)
    for index, (route, stop, delay, capture) in enumerate(rows):
        conn.execute(
            text(
                "INSERT INTO gold.fact_trip_delay_snapshot "
                "(provider_id, realtime_snapshot_id, entity_index, snapshot_date_key, "
                "snapshot_local_date, feed_timestamp_utc, captured_at_utc, route_id, "
                "delay_stop_id, delay_seconds, stop_time_update_count) "
                "VALUES (:p,:s,:i,20261031,'2026-10-31','2026-10-31T12:00:00Z',"
                ":capture,:route,:stop,:delay,1)"
            ),
            dict(
                params,
                i=index,
                capture=datetime.fromisoformat(capture),
                route=route,
                stop=stop,
                delay=delay,
            ),
        )


def export_inputs(engine, root, request):
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        for need in builder.inputs(request):
            path = root / need.relation / f"{need.window}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            window = request.as_of_utc.strftime("%Y-%m") if need.window == "all" else need.window
            exported = export_window(
                conn.connection.driver_connection,
                WindowSpec(need.relation, PROVIDER, window),
                path.with_suffix(".csv"),
                statement_timeout_s=60,
            )
            write_window(exported.csv_path, exported.schema, path, metadata={}, temp_dir=root)


def build_postgres(engine, request):
    # Exercise the PostgreSQL day-calendar driver, not only its aggregate SQL.
    for entity, source in zip(
        ("route", "stop"),
        (rollups.UPSERT_ROUTE_DELAY_PERCENTILE_DAILY, rollups.UPSERT_STOP_DELAY_PERCENTILE_DAILY),
        strict=True,
    ):
        rollups._build_percentile_days(
            engine,
            provider_id=PROVIDER,
            rollup_kind=f"{entity}_percentile_daily",
            upsert=source,
            today_key=int((request.local_dates[-1] + timedelta(days=1)).strftime("%Y%m%d")),
            floor_key=int(request.local_dates[0].strftime("%Y%m%d")),
            now=request.as_of_utc,
            select_missing=rollups.SELECT_MISSING_CAPTURE_DAYS,
            retained_since_utc=request.as_of_utc - timedelta(days=request.fact_retention_days),
            retention_days=request.fact_retention_days,
        )


@pytest.mark.parametrize("at_cutoff", [False, True])
def test_percentiles_match_postgres_and_plain_math(
    real_db_engine, seed_provider, tmp_path, at_cutoff
):
    request, rows = REQUEST, SEED
    if at_cutoff:
        request = replace(
            REQUEST,
            local_dates=(DAY,),
            timezone="Etc/UTC",
            as_of_utc=datetime(2026, 11, 15, tzinfo=UTC),
        )
        rows = [("cutoff", "cutoff", 1, "2026-11-01T00:00:00+00:00")]
    request = replace(request, provider_id=PROVIDER)
    db = prepare_replay_database(
        real_db_engine.url.render_as_string(hide_password=False), os.environ
    )
    try:
        with pinned_replay_engine(db, request.as_of_utc) as engine:
            with engine.begin() as conn:
                seed_facts(conn, seed_provider, request, rows)
            build_postgres(engine, request)
            export_inputs(engine, tmp_path, request)
            actual = run_family(
                builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
            ).output
            assert_math(actual, request, rows)
            with engine.connect() as conn:
                for relation, table in actual.tables.items():
                    expected = read_table_rows(
                        conn,
                        relation,
                        table.key,
                        provider_id=PROVIDER,
                        local_dates=request.local_dates,
                    )
                    assert compare_tables(expected, table) == [], relation
    finally:
        try:
            with db.engine.begin() as conn:
                for relation in RELATIONS:
                    conn.execute(
                        text(f"DELETE FROM {relation} WHERE provider_id = :provider"),
                        {"provider": PROVIDER},
                    )
            with db.engine.connect() as conn:
                for relation in RELATIONS:
                    count = conn.execute(
                        text(f"SELECT COUNT(*) FROM {relation} WHERE provider_id = :provider"),
                        {"provider": PROVIDER},
                    ).scalar_one()
                    assert count == 0, f"{relation} leaked {count} rows for {PROVIDER}"
        finally:
            db.engine.dispose()
