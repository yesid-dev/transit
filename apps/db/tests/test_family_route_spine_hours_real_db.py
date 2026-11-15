"""Disposable PostgreSQL twin, including evidence-gated replacement and load-back."""

import json
import sys
from datetime import datetime

import duckdb
import pytest
import test_delay_period_lifecycle_real_db as lifecycle
from sqlalchemy import MetaData, Table, and_, text
from test_family_route_spine_hours import (
    REQUEST,
    SEED,
    check_math,
    create_inputs,
    export_inputs,
    run,
)

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.route_spine_hours import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.gold import delay_hours, delay_periods, rollups

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="Linux CI owns real-db proof")


def export_postgres(conn, root):
    # Project the owning SQL's columns, including working-only Silver evidence.
    with duckdb.connect(config={"TimeZone": "UTC"}) as target:
        create_inputs(target)
        for relation in sorted({need.relation for need in builder.inputs(REQUEST)}):
            columns = [row[0] for row in target.execute(f"DESCRIBE {relation}").fetchall()]
            rows = conn.execute(
                text(f"SELECT {', '.join(columns)} FROM {relation} WHERE provider_id='seed'")
            ).all()
            if rows:
                target.executemany(
                    f"INSERT INTO {relation} VALUES ({','.join('?' for _ in columns)})",
                    [
                        tuple(
                            json.dumps(value) if isinstance(value, dict) else value for value in row
                        )
                        for row in rows
                    ],
                )
        export_inputs(target, root)


def build_postgres(conn):
    engine = lifecycle.TransactionEngine(conn)
    for day in REQUEST.local_dates:
        from datetime import UTC, time, timedelta
        from zoneinfo import ZoneInfo

        start = datetime.combine(day, time(), ZoneInfo(REQUEST.timezone)).astimezone(UTC)
        end = datetime.combine(
            day + timedelta(days=1), time(), ZoneInfo(REQUEST.timezone)
        ).astimezone(UTC)
        delay_periods.build_delay_periods(
            engine,
            provider_id="seed",
            since_utc=start,
            until_utc=end,
            now=REQUEST.as_of_utc,
            wall_clock_utc=REQUEST.as_of_utc,
            retention_days=REQUEST.fact_retention_days,
            progress=delay_periods.PeriodBuildProgress(),
        )
        delay_hours.refresh_changed_delay_hours(engine, "seed", start, end)
        rollups._write_daily_rollup(
            conn,
            provider_id="seed",
            rollup_kind="route_delay_spine",
            upsert=rollups.UPSERT_ROUTE_DELAY_SPINE,
            local_date=day,
            date_key=int(day.strftime("%Y%m%d")),
            now=REQUEST.as_of_utc,
            retention_days=36500,
        )


@pytest.mark.parametrize("replacement", [False, True])
def test_family_matches_postgres_and_preserves_dirty_state_after_loadback(
    real_db_engine,
    seed_provider,
    tmp_path,
    monkeypatch,
    replacement,
):
    monkeypatch.setattr(lifecycle, "PROVIDER", "seed")
    for module in (delay_periods, delay_hours, rollups):
        monkeypatch.setattr(module, "materialization_time", lambda _: REQUEST.as_of_utc)
    with real_db_engine.connect() as conn, conn.begin() as transaction:
        seed_provider(conn, "seed", display_name="Route seed", timezone=REQUEST.timezone)
        for route, trip, direction, delay, capture in SEED:
            sid = lifecycle.add_capture(conn, datetime.fromisoformat(capture), delay, route)
            conn.execute(
                text(
                    "UPDATE gold.fact_trip_delay_snapshot SET trip_id=:trip, "
                    "direction_id=:direction WHERE realtime_snapshot_id=:sid"
                ),
                dict(trip=trip, direction=direction, sid=sid),
            )
        if replacement:
            build_postgres(conn)
            conn.execute(
                text(
                    "UPDATE gold.warm_rollup_periods SET invalidated_at_utc=:stamp "
                    "WHERE provider_id='seed' AND rollup_kind='trip_delay_summary_5m'"
                ),
                {"stamp": REQUEST.as_of_utc},
            )
        export_postgres(conn, tmp_path)
        build_postgres(conn)
        actual = run(tmp_path).output
        check_math(actual, SEED)
        for relation, table in actual.tables.items():
            expected = read_table_rows(
                conn,
                relation,
                table.key,
                provider_id="seed",
                local_dates=REQUEST.local_dates if relation.endswith("spine") else None,
            )
            assert compare_tables(expected, table) == [], relation
        params = dict(
            provider_id="seed",
            from_utc=datetime(2026, 11, 1, tzinfo=REQUEST.as_of_utc.tzinfo),
            until_utc=REQUEST.as_of_utc,
        )
        dirty = conn.execute(delay_hours._DIRTY_HOURS, params).all()
        table = Table("route_delay_hourly", MetaData(), schema="gold", autoload_with=conn)
        hours = actual.tables["gold.route_delay_hourly"]
        # Load actual rows (including exact numeric and timestamp fields) into the PostgreSQL seam.
        conn.execute(text("DELETE FROM gold.route_delay_hourly WHERE provider_id='seed'"))
        conn.execute(
            table.insert(), [dict(zip(hours.columns, row, strict=True)) for row in hours.rows]
        )
        assert conn.execute(delay_hours._DIRTY_HOURS, params).all() == dirty == []
        for row in hours.rows:
            values = dict(zip(hours.columns, row, strict=True))
            key = and_(*(table.c[name] == values[name] for name in hours.key))
            assert conn.execute(table.select().where(key)).one().built_at_utc == REQUEST.as_of_utc
        transaction.rollback()
