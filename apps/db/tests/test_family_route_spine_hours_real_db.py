"""Disposable PostgreSQL twin, including evidence-gated replacement and load-back."""

import json
from dataclasses import replace
from datetime import UTC, datetime, time

import duckdb
import pytest
import test_delay_period_lifecycle_real_db as lifecycle
from sqlalchemy import MetaData, Table, and_, text
from test_family_route_spine_hours import (
    EDGE_REQUEST,
    EDGE_ROWS,
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

PROVIDER = "route_spine_seed"
_CREATED_RELATIONS = (
    *builder.tables,
    "gold.warm_rollup_periods",
    "gold.fact_trip_delay_snapshot",
    "silver.rt_trip_updates",
    "silver.rt_entities",
    "silver.rt_feed_snapshots",
    "raw.realtime_snapshot_index",
    "raw.ingestion_objects",
    "raw.ingestion_runs",
    "core.feed_endpoints",
    "core.providers",
)


@pytest.fixture
def route_database(real_db_engine):
    with real_db_engine.connect() as conn:
        transaction = conn.begin()
        try:
            yield conn
        finally:
            # Returning from a refusal case must never commit the outer transaction.
            # All builders use savepoints on this connection, so this removes every FK child.
            transaction.rollback()
            for relation in _CREATED_RELATIONS:
                remaining = conn.execute(
                    text(f"SELECT COUNT(*) FROM {relation} WHERE provider_id=:provider"),
                    {"provider": PROVIDER},
                ).scalar_one()
                assert remaining == 0, f"leaked route twin rows: {relation}"


def export_postgres(conn, root, request=REQUEST):
    # Project the owning SQL's columns, including working-only Silver evidence.
    with duckdb.connect(config={"TimeZone": "UTC"}) as target:
        create_inputs(target)
        for relation in sorted({need.relation for need in builder.inputs(request)}):
            columns = [row[0] for row in target.execute(f"DESCRIBE {relation}").fetchall()]
            rows = conn.execute(
                text(f"SELECT {', '.join(columns)} FROM {relation} WHERE provider_id=:provider"),
                {"provider": request.provider_id},
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
        export_inputs(target, root, request)


def build_postgres(conn, request=REQUEST):
    engine = lifecycle.TransactionEngine(conn)
    for day in request.local_dates:
        from datetime import UTC, time, timedelta
        from zoneinfo import ZoneInfo

        start = datetime.combine(day, time(), ZoneInfo(request.timezone)).astimezone(UTC)
        end = datetime.combine(
            day + timedelta(days=1), time(), ZoneInfo(request.timezone)
        ).astimezone(UTC)
        delay_periods.build_delay_periods(
            engine,
            provider_id=request.provider_id,
            since_utc=start,
            until_utc=end,
            now=request.as_of_utc,
            wall_clock_utc=request.as_of_utc,
            retention_days=request.fact_retention_days,
            progress=delay_periods.PeriodBuildProgress(),
        )
        delay_hours.refresh_changed_delay_hours(engine, request.provider_id, start, end)
        rollups._write_daily_rollup(
            conn,
            provider_id=request.provider_id,
            rollup_kind="route_delay_spine",
            upsert=rollups.UPSERT_ROUTE_DELAY_SPINE,
            local_date=day,
            date_key=int(day.strftime("%Y%m%d")),
            now=request.as_of_utc,
            retention_days=36500,
        )


@pytest.mark.parametrize("replacement", [False, True, "retention_edge", "invalid_count"])
def test_family_matches_postgres_and_preserves_dirty_state_after_loadback(
    route_database,
    seed_provider,
    tmp_path,
    monkeypatch,
    replacement,
):
    edge = replacement == "retention_edge"
    request, seed = (EDGE_REQUEST, EDGE_ROWS) if edge else (REQUEST, SEED)
    request = replace(request, provider_id=PROVIDER)
    monkeypatch.setattr(lifecycle, "PROVIDER", PROVIDER)
    for module in (delay_periods, delay_hours, rollups):
        monkeypatch.setattr(module, "materialization_time", lambda _: request.as_of_utc)
    with route_database.begin_nested():
        conn = route_database
        seed_provider(conn, PROVIDER, display_name="Route seed", timezone=request.timezone)
        for route, trip, direction, delay, capture in seed:
            sid = lifecycle.add_capture(conn, datetime.fromisoformat(capture), delay, route)
            # Several observations share a capture instant; object identity is independent of it.
            conn.execute(
                text(
                    "UPDATE raw.ingestion_objects AS o "
                    "SET storage_path='route-spine-hours/' || o.ingestion_object_id::text "
                    "FROM raw.realtime_snapshot_index AS s "
                    "WHERE s.realtime_snapshot_id=:sid "
                    "AND o.ingestion_object_id=s.ingestion_object_id"
                ),
                {"sid": sid},
            )
            conn.execute(
                text(
                    "UPDATE gold.fact_trip_delay_snapshot SET trip_id=:trip, "
                    "direction_id=:direction WHERE realtime_snapshot_id=:sid"
                ),
                dict(trip=trip, direction=direction, sid=sid),
            )
        if replacement is True or replacement == "invalid_count":
            build_postgres(conn, request)
            conn.execute(
                text(
                    "UPDATE gold.warm_rollup_periods SET invalidated_at_utc=:stamp "
                    "WHERE provider_id=:provider AND rollup_kind='trip_delay_summary_5m'"
                ),
                {"stamp": request.as_of_utc, "provider": PROVIDER},
            )
        if replacement == "invalid_count":
            conn.execute(
                text(
                    "UPDATE silver.rt_feed_snapshots SET manifest_json=CAST(:manifest AS jsonb) "
                    "WHERE provider_id=:provider"
                ),
                {"manifest": '{"entity_count":1.0000000000000001}', "provider": PROVIDER},
            )
        export_postgres(conn, tmp_path, request)
        if replacement == "invalid_count":
            with pytest.raises(ValueError, match="Retained capture evidence is incomplete"):
                build_postgres(conn, request)
            with pytest.raises(ValueError, match="entity_count"):
                run(tmp_path, request)
            return
        build_postgres(conn, request)
        actual = run(tmp_path, request).output
        check_math(actual, seed)
        for relation, table in actual.tables.items():
            expected = read_table_rows(
                conn,
                relation,
                table.key,
                provider_id=PROVIDER,
                local_dates=request.local_dates if relation.endswith("spine") else None,
            )
            differences = compare_tables(expected, table)
            if edge and not relation.endswith("spine"):
                # R28(2)(b): PG's conservative scheduler omits the retained 05:00 fact.
                assert [(d.kind, d.key) for d in differences] == [
                    ("extra", (PROVIDER, datetime(2026, 10, 22, 5, tzinfo=UTC), "A"))
                ]
                column = table.columns.index("usable_delay_sum_seconds")
                assert sum(row[column] for row in expected.rows) == 300
                assert sum(row[column] for row in table.rows) == 360
            else:
                assert differences == [], relation
        params = dict(
            provider_id=PROVIDER,
            from_utc=datetime.combine(request.local_dates[0], time(), UTC),
            until_utc=request.as_of_utc,
        )
        dirty = conn.execute(delay_hours._DIRTY_HOURS, params).all()
        table = Table("route_delay_hourly", MetaData(), schema="gold", autoload_with=conn)
        hours = actual.tables["gold.route_delay_hourly"]
        # Load actual rows (including exact numeric and timestamp fields) into the PostgreSQL seam.
        conn.execute(
            text("DELETE FROM gold.route_delay_hourly WHERE provider_id=:provider"),
            {"provider": PROVIDER},
        )
        conn.execute(
            table.insert(), [dict(zip(hours.columns, row, strict=True)) for row in hours.rows]
        )
        assert conn.execute(delay_hours._DIRTY_HOURS, params).all() == dirty == []
        for row in hours.rows:
            values = dict(zip(hours.columns, row, strict=True))
            key = and_(*(table.c[name] == values[name] for name in hours.key))
            assert conn.execute(table.select().where(key)).one().built_at_utc == request.as_of_utc
