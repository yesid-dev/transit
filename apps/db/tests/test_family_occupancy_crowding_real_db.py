from datetime import datetime

import real_db_seed
from sqlalchemy import text
from test_family_occupancy_crowding import REQUEST, SEED, STAMP

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.occupancy_crowding import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window


def seed_facts(conn, seed_provider):
    seed_provider(conn, "seed", display_name="Occupancy seed")
    params = dict(p="seed", e=98110001, r=98110002, s=98110003, ts=STAMP, n=len(SEED))
    real_db_seed.feed_endpoints(conn, params)
    real_db_seed.ingestion_runs(conn, params)
    real_db_seed.realtime_snapshot_index(conn, params)
    for index, (route, stop, occupancy, delay, capture, key) in enumerate(SEED):
        values = dict(
            p="seed",
            s=params["s"],
            i=index,
            route=route,
            stop=stop,
            occupancy=occupancy,
            delay=delay,
            ts=datetime.fromisoformat(capture),
            key=key,
            day=datetime.strptime(str(key), "%Y%m%d").date(),
        )
        for name in ("vehicle", "trip_delay"):
            extra = "stop_id" if name == "vehicle" else "delay_seconds, stop_time_update_count"
            bind = ":stop" if name == "vehicle" else ":delay, 1"
            conn.execute(
                text(
                    f"INSERT INTO gold.fact_{name}_snapshot "
                    "(provider_id, realtime_snapshot_id, entity_index, snapshot_date_key, "
                    "snapshot_local_date, feed_timestamp_utc, captured_at_utc, route_id, "
                    f"occupancy_status, {extra}) "
                    f"VALUES (:p,:s,:i,:key,:day,:ts,:ts,:route,:occupancy,{bind})"
                ),
                values,
            )
    for day in REQUEST.local_dates:
        for relation in builder.tables:
            name = relation.removeprefix("gold.")
            rollups._write_daily_rollup(
                conn,
                provider_id="seed",
                rollup_kind=name,
                upsert=rollups.REBUILDABLE_KINDS[name].upsert,
                local_date=day,
                date_key=int(day.strftime("%Y%m%d")),
                now=STAMP,
                retention_days=36500,
            )


def test_family_matches_postgres_on_exported_fallback_inputs(
    real_db_engine, seed_provider, tmp_path
):
    with real_db_engine.begin() as conn:
        seed_facts(conn, seed_provider)
    try:
        # The exporter owns a read-only transaction on an idle autocommit connection.
        with real_db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for need in builder.inputs(REQUEST):
                path = tmp_path / need.relation / f"{need.window}.parquet"
                path.parent.mkdir(parents=True, exist_ok=True)
                window = STAMP.strftime("%Y-%m") if need.window == "all" else need.window
                exported = export_window(
                    conn.connection.driver_connection,
                    WindowSpec(need.relation, "seed", window),
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
            for relation, rows in actual.output.tables.items():
                expected = read_table_rows(
                    conn, relation, rows.key, provider_id="seed", local_dates=REQUEST.local_dates
                )
                assert compare_tables(expected, rows) == [], relation
    finally:
        with real_db_engine.begin() as conn:
            for relation in (
                *builder.tables,
                "gold.warm_rollup_periods",
                "gold.fact_vehicle_snapshot",
                "gold.fact_trip_delay_snapshot",
                "raw.realtime_snapshot_index",
                "raw.ingestion_runs",
                "core.feed_endpoints",
                "core.providers",
            ):
                conn.execute(text(f"DELETE FROM {relation} WHERE provider_id='seed'"))
