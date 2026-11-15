from dataclasses import replace
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import duckdb
import pytest
import real_db_seed
from sqlalchemy import text
from test_family_stop_spine_hours import REQUEST as OFFLINE_REQUEST
from test_family_stop_spine_hours import SEED

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.stop_spine_hours import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups
from transit_ops.history.datasets import get_dataset
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window

REQUEST = replace(OFFLINE_REQUEST, provider_id="stop_spine_hours_seed")


def archive_window(need):
    window = (
        REQUEST.as_of_utc.strftime("%Y-%m")
        if need.window == "all"
        else need.window.removeprefix("local:")
    )
    return window[:7] if get_dataset(need.relation).archive_grain == "month" else window


def keep_local_day(source, destination, window):
    # The archive month is UTC; the family input is one provider-local capture day.
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "COPY (SELECT * FROM read_parquet(?) "
            "WHERE timezone(?, period_start_utc)::DATE = ?::DATE) "
            "TO ? (FORMAT PARQUET)",
            [str(source), REQUEST.timezone, window.removeprefix("local:"), str(destination)],
        )


def test_hourly_export_uses_declared_month_bounds():
    from transit_ops.batch.build import InputNeed
    from transit_ops.lake.table_export import window_predicate
    from transit_ops.lake.table_schema import TableSchema

    need = InputNeed("gold.stop_delay_hourly", "local:2026-11-01")
    schema = TableSchema.from_columns(
        [("provider_id", "text", True), ("period_start_utc", "timestamp with time zone", True)],
        ("provider_id", "period_start_utc"),
    )
    _, bounds = window_predicate(
        WindowSpec(need.relation, "stop_spine_hours_seed", archive_window(need)), schema
    )
    assert bounds == (
        datetime.fromisoformat("2026-11-01T00:00:00+00:00"),
        datetime.fromisoformat("2026-12-01T00:00:00+00:00"),
    )


@pytest.mark.parametrize("half_cent", [False, True])
def test_stop_tables_equal_postgres_on_exported_capture_days(
    real_db_engine, seed_provider, tmp_path, half_cent
):
    rows = (
        SEED
        if not half_cent
        else [
            (route, "S", value, "2026-11-01 06:00:00+00")
            for route, sign in [("A", 1), ("a", -1)]
            for value in [sign] + [0] * 199
        ]
    )
    rows = [*rows, ("outside", "S", 300, "2026-11-03 08:45:00+00")]
    with real_db_engine.begin() as conn:
        seed_provider(
            conn, "stop_spine_hours_seed", display_name="Stop seed", timezone=REQUEST.timezone
        )
        params = dict(
            p="stop_spine_hours_seed",
            e=98160001,
            r=98160002,
            s=98160003,
            ts=REQUEST.as_of_utc,
            n=len(rows),
        )
        real_db_seed.feed_endpoints(conn, params)
        real_db_seed.ingestion_runs(conn, params)
        real_db_seed.realtime_snapshot_index(conn, params)
        for i, (route, stop, delay, stamp) in enumerate(rows):
            conn.execute(
                text(
                    "INSERT INTO gold.fact_trip_delay_snapshot (provider_id, "
                    "realtime_snapshot_id, entity_index, snapshot_date_key, "
                    "snapshot_local_date, feed_timestamp_utc, captured_at_utc, route_id, "
                    "delay_stop_id, delay_seconds, stop_time_update_count) VALUES "
                    "(:p,:s,:i,20261020,DATE '2026-10-20',TIMESTAMPTZ '2026-10-20 "
                    "00:00:00+00',:ts,:route,:stop,:delay,1)"
                ),
                {
                    **params,
                    "i": i,
                    "ts": datetime.fromisoformat(stamp),
                    "route": route,
                    "stop": stop,
                    "delay": delay,
                },
            )
    try:
        # Export before the refresh, so prior-hour inputs are independent of its result.
        with real_db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for need in builder.inputs(REQUEST):
                path = tmp_path / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
                path.parent.mkdir(parents=True, exist_ok=True)
                window = archive_window(need)
                exported = export_window(
                    conn.connection.driver_connection,
                    WindowSpec(need.relation, "stop_spine_hours_seed", window),
                    path.with_suffix(".csv"),
                    statement_timeout_s=60,
                )
                archive_path = (
                    path.with_suffix(".month.parquet") if need.window.startswith("local:") else path
                )
                write_window(
                    exported.csv_path, exported.schema, archive_path, metadata={}, temp_dir=tmp_path
                )
                if need.window.startswith("local:"):
                    keep_local_day(archive_path, path, need.window)
        with real_db_engine.begin() as conn:
            for day in REQUEST.local_dates:
                for relation in builder.tables[:2]:
                    name = relation.removeprefix("gold.")
                    rollups._write_daily_rollup(
                        conn,
                        provider_id="stop_spine_hours_seed",
                        rollup_kind=name,
                        upsert=rollups.REBUILDABLE_KINDS[name].upsert,
                        local_date=day,
                        date_key=int(day.strftime("%Y%m%d")),
                        now=REQUEST.as_of_utc,
                        retention_days=36500,
                    )
            params = dict(
                provider_id="stop_spine_hours_seed",
                built_at_utc=REQUEST.as_of_utc,
                open_window_days=REQUEST.open_window_days,
            )
            conn.execute(rollups.CREATE_STOP_DELAY_HOURLY_SOURCE_SUMMARY, params)
            conn.execute(rollups.DELETE_REPORTING_AGGREGATES["stop_delay_hourly"], params)
            conn.execute(rollups.UPSERT_STOP_DELAY_HOURLY, params)
        actual = run_family(
            builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
        )
        with real_db_engine.connect() as conn:
            for relation, table in actual.output.tables.items():
                expected = read_table_rows(
                    conn,
                    relation,
                    table.key,
                    provider_id="stop_spine_hours_seed",
                    local_dates=None if "hourly" in relation else REQUEST.local_dates,
                )
                if "hourly" in relation:
                    # Match replay/load-back's ownership scope without splitting UTC hours.
                    index = expected.columns.index("period_start_utc")
                    expected = replace(
                        expected,
                        rows=tuple(
                            row
                            for row in expected.rows
                            if row[index].astimezone(ZoneInfo(REQUEST.timezone)).date()
                            in REQUEST.local_dates
                        ),
                    )
                assert compare_tables(expected, table) == [], relation
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
                    text(f"DELETE FROM {relation} WHERE provider_id='stop_spine_hours_seed'")
                )


def test_monthly_hourly_input_keeps_only_the_requested_local_day(tmp_path):
    source, destination = tmp_path / "month.parquet", tmp_path / "day.parquet"
    stamps = [
        "2026-11-01 03:59:59.999999+00",
        "2026-11-01 04:00:00+00",
        "2026-11-01 05:30:00.000001+00",
        "2026-11-01 06:30:00.000002+00",
        "2026-11-02 04:59:59.999999+00",
        "2026-11-02 05:00:00+00",
    ]
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute("CREATE TABLE seed(period_start_utc TIMESTAMPTZ)")
        conn.executemany("INSERT INTO seed VALUES (?)", [(stamp,) for stamp in stamps])
        conn.execute("COPY seed TO ? (FORMAT PARQUET)", [str(source)])
    keep_local_day(source, destination, "local:2026-11-01")
    with duckdb.connect() as conn:
        actual = conn.execute(
            "SELECT epoch_us(period_start_utc) FROM read_parquet(?) ORDER BY 1", [str(destination)]
        ).fetchall()
    assert actual == [
        (
            (datetime.fromisoformat(stamp) - datetime(1970, 1, 1, tzinfo=UTC))
            // timedelta(microseconds=1),
        )
        for stamp in stamps[1:-1]
    ]
