from dataclasses import replace
from datetime import date
from fractions import Fraction
from statistics import median

import pytest
import real_db_seed
from sqlalchemy import text
from test_family_headways import BUNCHING_GAPS, bunching_rows, edge_rows, seed_rows
from test_family_headways import REQUEST as BASE_REQUEST

from transit_ops.batch.compare import RowDifference, compare_tables
from transit_ops.batch.families.headways import HeadwaysBuilder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window

PROVIDER = "headways_seed"
REQUEST = replace(BASE_REQUEST, provider_id=PROVIDER)
# R28 (2)(b): PostgreSQL counts a gap equal to half the median; exact math excludes it.
R28_BUNCHING_DIFFERENCES = {
    gaps: [
        RowDifference(
            "gold.route_headway_by_shift",
            (PROVIDER, "A", "am_peak"),
            "value",
            "bunched_count",
            1,
            0,
        ),
        RowDifference(
            "gold.route_headway_shift_daily",
            (PROVIDER, "A", date(2026, 11, 2), "am_peak", 0),
            "value",
            "bunched_gap_count",
            1,
            0,
        ),
    ]
    for gaps in ((62, 124, 186), (62, 124, 124, 186))
}


@pytest.mark.parametrize("case", ["regular", "microseconds", "edges", *BUNCHING_GAPS])
def test_headways_match_postgres_on_exported_facts(real_db_engine, seed_provider, tmp_path, case):
    builder = HeadwaysBuilder()
    rows = seed_rows()
    if isinstance(case, tuple):
        rows = bunching_rows(case)
    if case == "edges":
        rows = edge_rows()
    if case == "microseconds":
        from datetime import timedelta

        rows = rows[:2]
        rows[1] = (*rows[1][:4], rows[0][4] + timedelta(microseconds=1), *rows[1][5:])
    try:
        with real_db_engine.begin() as conn:
            seed_provider(conn, PROVIDER, display_name="Headway seed", timezone=REQUEST.timezone)
            params = dict(
                p=PROVIDER, e=98290001, r=98290002, s=98290003, ts=REQUEST.as_of_utc, n=len(rows)
            )
            real_db_seed.feed_endpoints(conn, params)
            real_db_seed.ingestion_runs(conn, params)
            real_db_seed.realtime_snapshot_index(conn, params)
            for index, (route, trip, direction, start, capture, delay, day, key) in enumerate(rows):
                conn.execute(
                    text(
                        "INSERT INTO gold.fact_trip_delay_snapshot "
                        "(provider_id, realtime_snapshot_id, entity_index, route_id, trip_id, "
                        "direction_id, start_date, captured_at_utc, feed_timestamp_utc, "
                        "delay_seconds, "
                        "snapshot_local_date, snapshot_date_key, stop_time_update_count) VALUES "
                        "(:provider_id, :s, :i, :route, :trip, :direction, :start, "
                        ":capture, :capture, "
                        ":delay, :day, :key, 1)"
                    ),
                    dict(
                        provider_id=PROVIDER,
                        s=params["s"],
                        i=index,
                        route=route,
                        trip=trip,
                        direction=direction,
                        start=start,
                        capture=capture,
                        delay=delay,
                        day=day,
                        key=key,
                    ),
                )
            for statement in (
                rollups.UPSERT_ROUTE_HEADWAY_DAILY,
                rollups.UPSERT_ROUTE_HEADWAY_DIRECTION_DAILY,
            ):
                conn.execute(
                    statement,
                    dict(
                        provider_id=PROVIDER,
                        as_of_utc=REQUEST.as_of_utc,
                        built_at_utc=REQUEST.as_of_utc,
                        fact_retention_days=REQUEST.fact_retention_days,
                    ),
                )
            for day in REQUEST.local_dates:
                rollups._write_daily_rollup(
                    conn,
                    provider_id=PROVIDER,
                    rollup_kind="route_headway_shift_daily",
                    upsert=rollups.UPSERT_ROUTE_HEADWAY_SHIFT_DAILY,
                    local_date=day,
                    date_key=int(day.strftime("%Y%m%d")),
                    now=REQUEST.as_of_utc,
                    retention_days=36500,
                )
        with real_db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for need in builder.inputs(REQUEST):
                path = tmp_path / need.relation / f"{need.window}.parquet"
                path.parent.mkdir(parents=True, exist_ok=True)
                window = (
                    REQUEST.as_of_utc.strftime("%Y-%m") if need.window == "all" else need.window
                )
                exported = export_window(
                    conn.connection.driver_connection,
                    WindowSpec(need.relation, PROVIDER, window),
                    path.with_suffix(".csv"),
                    statement_timeout_s=60,
                )
                write_window(
                    exported.csv_path, exported.schema, path, metadata={}, temp_dir=tmp_path
                )
        actual = run_family(
            builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
        )
        with real_db_engine.connect() as conn:
            for relation, table in actual.output.tables.items():
                expected = read_table_rows(
                    conn,
                    relation,
                    table.key,
                    provider_id=PROVIDER,
                    local_dates=REQUEST.local_dates
                    if "provider_local_date" in table.columns
                    else None,
                )
                declared = [
                    difference
                    for difference in R28_BUNCHING_DIFFERENCES.get(case, [])
                    if difference.relation == relation
                ]
                assert compare_tables(expected, table) == declared, relation
                if isinstance(case, tuple):
                    gaps = [Fraction(seconds, 60) for seconds in case]
                    correct_count = sum(gap < median(gaps) / 2 for gap in gaps)
                    column = (
                        "bunched_count"
                        if relation == "gold.route_headway_by_shift"
                        else "bunched_gap_count"
                    )
                    if column in table.columns:
                        assert all(
                            row[table.columns.index(column)] == correct_count for row in table.rows
                        )
    finally:
        with real_db_engine.begin() as conn:
            for relation in (
                *builder.tables,
                "gold.warm_rollup_periods",
                "gold.fact_trip_delay_snapshot",
                "raw.realtime_snapshot_index",
                "raw.ingestion_runs",
                "core.feed_endpoints",
                "core.providers",
            ):
                conn.execute(
                    text(f"DELETE FROM {relation} WHERE provider_id=:provider_id"),
                    dict(provider_id=PROVIDER),
                )
