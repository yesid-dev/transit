from datetime import UTC, datetime, time, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
import real_db_seed
from sqlalchemy import text
from test_family_repeat_offenders import REQUEST, SEED, SPINES
from test_revision_2_both_engines_real_db import _export_inputs

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.repeat_offenders import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups


@pytest.fixture
def reference_retention_clock(monkeypatch):
    monkeypatch.setattr(rollups, "materialization_time", lambda _: REQUEST.as_of_utc)


def test_reference_retention_uses_build_stamp_after_seed_ages(
    monkeypatch, reference_retention_clock
):
    day = REQUEST.local_dates[0]
    zone = ZoneInfo(REQUEST.timezone)
    bounds = tuple(
        datetime.combine(day + timedelta(days=i), time(), zone).astimezone(UTC) for i in (0, 1)
    )
    future_clock = bounds[0] + timedelta(days=REQUEST.fact_retention_days + 365)
    # Only database results are substituted; execute the owning retention guard.
    conn = SimpleNamespace(
        execute=lambda *args: SimpleNamespace(one=lambda: bounds, scalar_one=lambda: future_clock)
    )
    with monkeypatch.context() as unpinned:
        unpinned.setattr(rollups, "materialization_time", lambda _: future_clock)
        with pytest.raises(ValueError, match="begins before the UTC fact-retention cutoff"):
            rollups._check_retained_capture_day(
                conn, REQUEST.provider_id, day, REQUEST.fact_retention_days
            )
    assert (
        rollups._check_retained_capture_day(
            conn, REQUEST.provider_id, day, REQUEST.fact_retention_days
        )
        == bounds
    )


def test_repeat_tables_equal_postgres_on_exported_inputs(
    real_db_engine, seed_provider, tmp_path, reference_retention_clock
):
    provider = REQUEST.provider_id
    # PG ABS(INTEGER_MIN) aborts, tracked by R29.4; the offline test proves the fix.
    rows = [r for r in SEED if r[3] != -2147483648]
    params = dict(p=provider, e=98120001, r=98120002, s=98120003, ts=REQUEST.as_of_utc, n=len(rows))
    try:
        with real_db_engine.begin() as conn:
            seed_provider(conn, provider, display_name="Repeat seed", timezone=REQUEST.timezone)
            real_db_seed.feed_endpoints(conn, params)
            real_db_seed.ingestion_runs(conn, params)
            real_db_seed.realtime_snapshot_index(conn, params)
            for i, (route, trip, vehicle, delay, stamp) in enumerate(rows):
                conn.execute(
                    text(
                        "INSERT INTO gold.fact_trip_delay_snapshot (provider_id, "
                        "realtime_snapshot_id, entity_index, snapshot_date_key, "
                        "snapshot_local_date, "
                        "feed_timestamp_utc, captured_at_utc, route_id, trip_id, vehicle_id, "
                        "delay_seconds, stop_time_update_count) VALUES (:p,:s,:i,20261020,"
                        "DATE '2026-10-20',:ts,:ts,:route,:trip,:vehicle,:delay,1)"
                    ),
                    {
                        **params,
                        "i": i,
                        "route": route,
                        "trip": trip,
                        "vehicle": vehicle,
                        "delay": delay,
                        "ts": datetime.fromisoformat(stamp),
                    },
                )
            for kind, entity, route, day, severe, total, count in SPINES:
                identity = "route_id" if kind == "route" else "stop_id, route_id"
                ids = ":route" if kind == "route" else ":entity, :route"
                extra = (
                    "hour_of_day_local, direction_id, delay_histogram"
                    if kind == "route"
                    else "observation_count"
                )
                values = "0, 0, ARRAY[:count]::smallint[]" if kind == "route" else ":count"
                conn.execute(
                    text(
                        f"INSERT INTO gold.{kind}_delay_spine (provider_id, {identity}, "
                        f"provider_local_date, severe_delay_count, sum_delay_seconds, {extra}) "
                        f"VALUES (:p,{ids},:day,:severe,:total,{values})"
                    ),
                    dict(
                        p=provider,
                        entity=entity,
                        route=route,
                        day=day,
                        severe=severe,
                        total=total,
                        count=count,
                    ),
                )
        _export_inputs(real_db_engine, builder, REQUEST, tmp_path)
        with real_db_engine.begin() as conn:
            for day in REQUEST.local_dates:
                rollups._write_daily_rollup(
                    conn,
                    provider_id=provider,
                    rollup_kind="repeat_offender_daily_spine",
                    upsert=rollups.UPSERT_REPEAT_OFFENDER_DAILY_SPINE,
                    local_date=day,
                    date_key=int(day.strftime("%Y%m%d")),
                    now=REQUEST.as_of_utc,
                    retention_days=REQUEST.fact_retention_days,
                )
            conn.execute(
                rollups.UPSERT_REPEATED_PROBLEM_ROUTE_STOP,
                dict(provider_id=provider, built_at_utc=REQUEST.as_of_utc),
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
                    provider_id=provider,
                    local_dates=REQUEST.local_dates if "daily" in relation else None,
                )
                assert compare_tables(expected, table) == [], relation
    finally:
        relations = (
            *builder.tables,
            "gold.route_delay_spine",
            "gold.stop_delay_spine",
            "gold.warm_rollup_periods",
            "gold.fact_trip_delay_snapshot",
            "raw.realtime_snapshot_index",
            "raw.ingestion_runs",
            "core.feed_endpoints",
            "core.providers",
        )
        with real_db_engine.begin() as conn:
            for relation in relations:
                conn.execute(text(f"DELETE FROM {relation} WHERE provider_id=:p"), {"p": provider})
        with real_db_engine.connect() as conn:
            for relation in relations:
                remaining = conn.execute(
                    text(f"SELECT COUNT(*) FROM {relation} WHERE provider_id=:p"), {"p": provider}
                ).scalar_one()
                assert remaining == 0, f"leaked repeat twin rows: {relation}"
