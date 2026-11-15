import re
from datetime import datetime
from types import SimpleNamespace

import duckdb
import pytest
import real_db_seed
import revision_2_seed as seed
from sqlalchemy import text
from test_family_cancellations_service_states import (
    assert_math,
    build,
    request,
    retention_case,
    seed_data,
)

from transit_ops.batch.build import InputNeed
from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.cancellations_service_states import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.gold import rollups
from transit_ops.lake.edition_identity import registered_keys
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window

PROVIDER = "cancellations_service_states_seed"
RELATIONS = (
    *builder.tables,
    "gold.warm_rollup_periods",
    "gold.fact_trip_delay_snapshot",
    "silver.trips",
    "silver.routes",
    "silver.calendar",
    "silver.calendar_dates",
    "core.dataset_versions",
    "raw.realtime_snapshot_index",
    "raw.ingestion_runs",
    "core.feed_endpoints",
    "core.providers",
)


def seed_inputs(conn, seed_provider, req, data):
    seed_provider(conn, PROVIDER, display_name="Service states seed", timezone=req.timezone)
    params = dict(p=PROVIDER, e=98280001, r=98280002, s=98280003, ts=req.as_of_utc, n=100)
    real_db_seed.feed_endpoints(conn, params)
    real_db_seed.ingestion_runs(conn, params)
    real_db_seed.realtime_snapshot_index(conn, params)
    for row in data["core.dataset_versions"][1]:
        real_db_seed.dataset_versions(
            conn,
            dict(params, d=row[0], h=f"{row[0]:064x}", current=row[3]),
            is_current=":current",
            loaded_at_utc=":ts",
        )
    trips = data["silver.trips"][1]
    for edition, route in sorted({(r[0], r[2]) for r in trips}):
        conn.execute(
            text(
                "INSERT INTO silver.routes "
                "(dataset_version_id, provider_id, route_id, route_type) "
                "VALUES (:d,:provider,:route,3)"
            ),
            dict(d=edition, route=route, provider=PROVIDER),
        )
    for relation, (ddl, rows) in data.items():
        if relation.startswith("core."):
            continue
        columns = [part.strip().split()[0] for part in ddl.split(",")]
        for index, row in enumerate(rows):
            values = dict(zip(columns, row, strict=True))
            if relation.startswith("gold."):
                day = datetime.strptime(str(values["snapshot_date_key"]), "%Y%m%d").date()
                values.update(
                    realtime_snapshot_id=params["s"],
                    entity_index=index,
                    snapshot_local_date=day,
                    stop_time_update_count=1,
                    feed_timestamp_utc=datetime.combine(
                        day, datetime.min.time(), req.as_of_utc.tzinfo
                    ),
                )
            conn.execute(
                text(
                    f"INSERT INTO {relation} ({', '.join(values)}) "
                    f"VALUES ({', '.join(':' + c for c in values)})"
                ),
                values,
            )


def export_inputs(engine, req, root):
    for need in builder.inputs(req):
        path = root / need.relation / (need.window.replace(":", "=") + ".parquet")
        path.parent.mkdir(parents=True, exist_ok=True)
        window = need.window
        edition_id = int(window.split(":")[1]) if window.startswith("edition:") else None
        if window == "all":
            window = req.as_of_utc.strftime("%Y-%m")
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            if edition_id is not None:
                window = registered_keys(conn.connection.driver_connection, PROVIDER)[edition_id]
            exported = export_window(
                conn.connection.driver_connection,
                WindowSpec(need.relation, PROVIDER, window),
                path.with_suffix(".csv"),
                statement_timeout_s=60,
            )
        write_window(exported.csv_path, exported.schema, path, metadata={}, temp_dir=root)


@pytest.mark.parametrize("at_cutoff", [False, True])
def test_family_matches_postgres_with_calendar_and_lagged_capture(
    real_db_engine, seed_provider, tmp_path, at_cutoff
):
    req = request(provider_id=PROVIDER)
    data = seed_data(req, PROVIDER)
    if at_cutoff:
        req, data = retention_case(PROVIDER)
    try:
        with real_db_engine.begin() as conn:
            seed_inputs(conn, seed_provider, req, data)
        with real_db_engine.begin() as conn:
            for day in req.local_dates:
                for relation in builder.tables:
                    name = relation.removeprefix("gold.")
                    rollups._write_daily_rollup(
                        conn,
                        provider_id=PROVIDER,
                        rollup_kind=name,
                        upsert=rollups.REBUILDABLE_KINDS[name].upsert,
                        local_date=day,
                        date_key=int(day.strftime("%Y%m%d")),
                        now=req.as_of_utc,
                        retention_days=36500,
                    )
        export_inputs(real_db_engine, req, tmp_path)
        actual = build(tmp_path, req)
        assert_math(actual, data, PROVIDER)
        with real_db_engine.connect() as conn:
            for relation, table in actual.tables.items():
                expected = read_table_rows(
                    conn, relation, table.key, provider_id=PROVIDER, local_dates=req.local_dates
                )
                assert compare_tables(expected, table) == [], relation
    finally:
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


def test_seed_editions_have_exportable_checksums(real_db_engine, tmp_path, monkeypatch):
    from test_revision_2_both_engines_real_db import _export_inputs, _seed_request

    monkeypatch.setattr(seed, "PROVIDERS", {kind: f"{PROVIDER}_{kind}" for kind in seed.PROVIDERS})
    try:
        with real_db_engine.begin() as conn:
            for provider in seed.PROVIDERS.values():
                seed._seed_provider(conn, provider, alerts=False)
        with real_db_engine.connect() as conn:
            editions = conn.execute(
                text(
                    "SELECT provider_id, dataset_version_id, "
                    "COALESCE(checksum_sha256, content_hash) FROM core.dataset_versions "
                    "WHERE provider_id = ANY(:providers)"
                ),
                {"providers": list(seed.PROVIDERS.values())},
            ).all()
        assert {(p, edition) for p, edition, _ in editions} == {
            (p, seed._base(p) + 20) for p in seed.PROVIDERS.values()
        }
        for provider, edition, checksum in editions:
            assert re.fullmatch(r"[0-9a-f]{64}", checksum), (provider, edition, checksum)
            need = InputNeed("silver.calendar", f"edition:{edition}")
            calendar = SimpleNamespace(inputs=lambda _, need=need: (need,))
            root = tmp_path / provider
            _export_inputs(real_db_engine, calendar, _seed_request(provider), root)
            path = root / "silver.calendar" / f"edition={edition}.parquet"
            with duckdb.connect() as conn:
                rows = conn.execute(
                    "SELECT dataset_version_id, provider_id, service_id, start_date, end_date "
                    "FROM read_parquet(?)",
                    [str(path)],
                ).fetchall()
            assert rows == [(edition, provider, "ETE", *seed.SEASON)]
    finally:
        seed.delete_rows(real_db_engine)
        with real_db_engine.connect() as conn:
            relations = conn.execute(text(seed._TABLES_SQL)).scalars().all()
            for relation in relations:
                for provider in seed.PROVIDERS.values():
                    count = conn.execute(
                        text(f"SELECT COUNT(*) FROM {relation} WHERE provider_id = :provider"),
                        {"provider": provider},
                    ).scalar_one()
                    assert count == 0, f"{relation} leaked {count} rows for {provider}"
