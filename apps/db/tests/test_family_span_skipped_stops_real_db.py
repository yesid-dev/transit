from dataclasses import replace
from datetime import datetime, timedelta

import pytest
import real_db_seed
from sqlalchemy import text
from test_family_span_skipped_stops import (
    EDGE_REQUEST,
    EDGE_SEED,
    ISOLATED_REQUEST,
    ISOLATED_SEED,
    OVERNIGHT_SEED,
    REQUEST,
    SEED,
    rounding_rows,
)

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.span_skipped_stops import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window

PROVIDER = "span_skipped_stops_seed"
RELATIONS = (
    *builder.tables,
    "gold.warm_rollup_periods",
    "gold.fact_trip_delay_snapshot",
    "raw.realtime_snapshot_index",
    "raw.ingestion_runs",
    "core.feed_endpoints",
    "core.providers",
)


def seed_facts(real_db_engine, seed_provider, req, rows):
    with real_db_engine.begin() as conn:
        seed_provider(conn, PROVIDER, display_name="Span seed", timezone=req.timezone)
        params = dict(p=PROVIDER, e=98100001, r=98100002, s=98100003, ts=req.as_of_utc, n=len(rows))
        real_db_seed.feed_endpoints(conn, params)
        real_db_seed.ingestion_runs(conn, params)
        real_db_seed.realtime_snapshot_index(conn, params)
        for route, trip, capture, key, service, delay, updates, skipped, _, entity in rows:
            day = datetime.strptime(str(key), "%Y%m%d").date()
            conn.execute(
                text(
                    "INSERT INTO gold.fact_trip_delay_snapshot "
                    "(provider_id,realtime_snapshot_id,entity_index,captured_at_utc,"
                    "feed_timestamp_utc,snapshot_date_key,snapshot_local_date,route_id,trip_id,"
                    "start_date,delay_seconds,stop_time_update_count,skipped_stop_count) "
                    "VALUES (:provider,:s,:i,:capture,:feed,:key,:day,:route,:trip,"
                    ":service,:delay,:n,:k)"
                ),
                dict(
                    provider=PROVIDER,
                    s=params["s"],
                    i=entity,
                    capture=datetime.fromisoformat(capture),
                    feed=datetime.combine(day, datetime.min.time(), req.as_of_utc.tzinfo),
                    key=key,
                    day=day,
                    route=route,
                    trip=trip,
                    service=service,
                    delay=delay,
                    n=updates,
                    k=skipped,
                ),
            )


def write_daily_reference(real_db_engine, monkeypatch, req):
    # Exercise the real append-only driver, with its actual feed-day calendar.
    monkeypatch.setattr(
        rollups,
        "DAILY_BUILD_ORDER",
        (
            "route_service_span_daily",
            "route_skipped_stop_daily",
        ),
    )
    with real_db_engine.connect() as conn:
        feed_days = conn.execute(
            rollups.SELECT_AVAILABLE_PERCENTILE_DAYS,
            dict(
                provider_id=PROVIDER,
                floor_key=20250601,
                today_key=20250901,
            ),
        ).all()
    rollups.build_daily_rollups(
        real_db_engine,
        PROVIDER,
        calendars=rollups.DailyRollupCalendars((), feed_days, ()),
        today_local=req.as_of_utc.date(),
        now=req.as_of_utc,
        retention_days=req.fact_retention_days,
    )


def write_reference(real_db_engine, req):
    with real_db_engine.begin() as conn:
        for index, relation in enumerate(builder.tables):
            run_day = req.local_dates[0] + timedelta(days=1 if index == 0 else 0)
            kind = relation.removeprefix("gold.")
            rollups._write_daily_rollup(
                conn,
                provider_id=PROVIDER,
                rollup_kind=kind,
                upsert=rollups.REBUILDABLE_KINDS[kind].upsert,
                local_date=run_day,
                date_key=int(run_day.strftime("%Y%m%d")),
                now=req.as_of_utc,
                retention_days=36500,
            )


def export_inputs(real_db_engine, req, tmp_path):
    with real_db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        for need in builder.inputs(req):
            path = tmp_path / need.relation / f"{need.window}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            exported = export_window(
                conn.connection.driver_connection,
                WindowSpec(need.relation, PROVIDER, need.window),
                path.with_suffix(".csv"),
                statement_timeout_s=60,
            )
            write_window(exported.csv_path, exported.schema, path, metadata={}, temp_dir=tmp_path)


def cleanup(real_db_engine):
    with real_db_engine.begin() as conn:
        for relation in RELATIONS:
            conn.execute(
                text(f"DELETE FROM {relation} WHERE provider_id = :provider"),
                {"provider": PROVIDER},
            )
    with real_db_engine.connect() as conn:
        for relation in RELATIONS:
            count = conn.execute(
                text(f"SELECT COUNT(*) FROM {relation} WHERE provider_id = :provider"),
                {"provider": PROVIDER},
            ).scalar_one()
            assert count == 0, f"{relation} leaked {count} rows for {PROVIDER}"


@pytest.mark.parametrize(
    "req, rows",
    [
        (REQUEST, SEED),
        (EDGE_REQUEST, EDGE_SEED),
        (ISOLATED_REQUEST, ISOLATED_SEED),
        (replace(ISOLATED_REQUEST, open_window_days=36000), ISOLATED_SEED),
        (ISOLATED_REQUEST, OVERNIGHT_SEED),
        (replace(ISOLATED_REQUEST, open_window_days=36000), OVERNIGHT_SEED),
        pytest.param(REQUEST, None, id="exact-rate-ties"),
    ],
)
def test_span_and_skipped_stops_match_postgres_exported_facts(
    real_db_engine, seed_provider, tmp_path, monkeypatch, req, rows
):
    if rows is None:
        rows = [*SEED, *rounding_rows()]
    req = replace(req, provider_id=PROVIDER)
    try:
        seed_facts(real_db_engine, seed_provider, req, rows)
        if req.local_dates == ISOLATED_REQUEST.local_dates:
            write_daily_reference(real_db_engine, monkeypatch, req)
        else:
            write_reference(real_db_engine, req)
        export_inputs(real_db_engine, req, tmp_path)
        actual = run_family(
            builder, req, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
        )
        if rows == ISOLATED_SEED:
            assert actual.output.tables[builder.tables[0]].rows == ()
        elif rows == OVERNIGHT_SEED:
            span = actual.output.tables[builder.tables[0]]
            first = datetime.fromisoformat("2025-06-03 16:12:00+00:00")
            last = datetime.fromisoformat("2025-06-04 04:30:00+00:00")
            assert span.rows == (
                (PROVIDER, req.local_dates[0], "B10", first, last, 738, 180, 240, 2, req.as_of_utc),
            )
        with real_db_engine.connect() as conn:
            for relation, table in actual.output.tables.items():
                expected = read_table_rows(
                    conn, relation, table.key, provider_id=PROVIDER, local_dates=req.local_dates
                )
                assert compare_tables(expected, table) == [], relation
    finally:
        cleanup(real_db_engine)
