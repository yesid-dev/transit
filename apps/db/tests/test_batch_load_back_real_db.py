from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, date, datetime, time
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine, event, text
from test_family_occupancy_crowding import REQUEST as OCCUPANCY_REQUEST
from test_family_occupancy_crowding import SEED, write_inputs
from test_family_occupancy_crowding_real_db import seed_facts

from transit_ops.batch.build import FamilyOutput, TableRows
from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families import registry
from transit_ops.batch.families.occupancy_crowding import builder
from transit_ops.batch.load_back import load_back
from transit_ops.batch.manifest import BuildManifest
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import delay_days
from transit_ops.gold.rollups import WarmRollupStageReceipt

PROVIDER = "load_back_seed"
REQUEST = replace(OCCUPANCY_REQUEST, provider_id=PROVIDER)
RELATIONS = (
    *builder.tables,
    "gold.route_delay_spine",
    "gold.warm_rollup_periods",
    "gold.fact_vehicle_snapshot",
    "gold.fact_trip_delay_snapshot",
    "raw.realtime_snapshot_index",
    "raw.ingestion_runs",
    "core.feed_endpoints",
    "core.providers",
)


@contextmanager
def provider_rows(engine):
    try:
        yield engine
    finally:
        with engine.begin() as conn:
            for relation in RELATIONS:
                conn.execute(
                    text(f"DELETE FROM {relation} WHERE provider_id = :provider"),
                    {"provider": PROVIDER},
                )
        with engine.connect() as conn:
            for relation in RELATIONS:
                count = conn.execute(
                    text(f"SELECT COUNT(*) FROM {relation} WHERE provider_id = :provider"),
                    {"provider": PROVIDER},
                ).scalar_one()
                assert count == 0, f"{relation} leaked {count} rows for {PROVIDER}"


@pytest.fixture
def load_back_database(real_db_engine):
    with provider_rows(real_db_engine) as engine:
        yield engine


class NoDatabaseAccess:
    def begin(self):
        pytest.fail("load_back reached a write transaction before refusing the request")


@pytest.mark.parametrize("provider_id", [PROVIDER, "occupancy_crowding_seed"])
def test_seed_helper_uses_callers_provider(monkeypatch, provider_id):
    from transit_ops.gold import rollups

    request = replace(REQUEST, provider_id=provider_id)
    conn, seed_provider, write_rollup = Mock(), Mock(), Mock()
    monkeypatch.setattr(rollups, "_write_daily_rollup", write_rollup)
    seed_facts(conn, seed_provider, request, SEED, None, provider_id=provider_id)
    assert seed_provider.call_args.args[1] == request.provider_id
    assert {call.args[1]["p"] for call in conn.execute.call_args_list} == {request.provider_id}
    assert {call.kwargs["provider_id"] for call in write_rollup.call_args_list} == {
        request.provider_id
    }


def test_failed_setup_cleans_provider_rows_and_preserves_other_providers():
    # Exercise the teardown SQL offline; PostgreSQL FKs are covered by real-db CI.
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as conn:
            for schema in ("core", "raw", "gold"):
                conn.exec_driver_sql(f"ATTACH DATABASE ':memory:' AS {schema}")
            for relation in RELATIONS:
                conn.exec_driver_sql(f"CREATE TABLE {relation} (provider_id TEXT)")
        with pytest.raises(RuntimeError, match="failed setup"):
            with provider_rows(engine) as database:
                with database.begin() as conn:
                    for relation in RELATIONS:
                        conn.execute(
                            text(f"INSERT INTO {relation} (provider_id) VALUES (:provider)"),
                            [{"provider": PROVIDER}, {"provider": "other"}],
                        )
                raise RuntimeError("failed setup")
        with engine.connect() as conn:
            for relation in RELATIONS:
                assert conn.execute(
                    text(f"SELECT provider_id FROM {relation}")
                ).scalars().all() == ["other"], relation
    finally:
        engine.dispose()


def test_retention_edge_refused_before_database_access():
    manifest = BuildManifest(
        provider_id=PROVIDER,
        local_dates=(date(2026, 10, 22),),
        as_of_utc=datetime(2026, 11, 5, tzinfo=UTC),
        fact_retention_days=14,
        open_window_days=10,
        timezone="Etc/UTC",
        family_id="occupancy_crowding",
        code_commit="a" * 40,
        inputs=(),
    )
    with pytest.raises(ValueError, match="retention_edge_day 2026-10-22"):
        load_back(
            NoDatabaseAccess(),
            PROVIDER,
            manifest.local_dates,
            FamilyOutput({}, {}),
            manifest=manifest,
        )


def test_five_minute_output_refused_before_database_access():
    manifest = BuildManifest(
        **vars(REQUEST), family_id="route_spine_hours", code_commit="a" * 40, inputs=()
    )
    relation = "gold.trip_delay_summary_5m"
    rows = TableRows(relation, ("provider_id",), ("provider_id",), ())
    with pytest.raises(ValueError, match="trip_delay_summary_5m.*unsupported"):
        load_back(
            NoDatabaseAccess(),
            PROVIDER,
            manifest.local_dates,
            FamilyOutput({relation: rows}, {}),
            manifest=manifest,
        )


def test_receipt_engine_defaults():
    assert (
        WarmRollupStageReceipt(PROVIDER, "test", "test", "test", 0, 0).display_dict()["engine"]
        == "postgres"
    )


def test_load_back_rows_and_idempotence(load_back_database, seed_provider, tmp_path):
    write_inputs(tmp_path, REQUEST, provider_id=PROVIDER)
    result = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    with load_back_database.begin() as conn:
        seed_provider(conn, PROVIDER, display_name="Load back seed", timezone=REQUEST.timezone)
    for _ in range(2):
        receipts = load_back(
            load_back_database,
            PROVIDER,
            REQUEST.local_dates,
            result.output,
            manifest=result.manifest,
        )
        assert all(
            r.display_dict()["engine"] == "duckdb"
            and r.display_dict()["build_id"] == result.manifest.build_id
            for r in receipts
        )
        with load_back_database.connect() as conn:
            assert set(
                conn.execute(
                    text(
                        "SELECT rollup_kind,period_start_utc FROM gold.warm_rollup_periods "
                        "WHERE provider_id=:provider AND rollup_kind != 'delay_day_coordination'"
                    ),
                    {"provider": PROVIDER},
                ).all()
            ) == {
                (relation.removeprefix("gold."), datetime.combine(day, time(), UTC))
                for relation in builder.tables
                for day in REQUEST.local_dates
            }
            for relation, rows in result.output.tables.items():
                assert (
                    compare_tables(
                        rows,
                        read_table_rows(
                            conn,
                            relation,
                            rows.key,
                            provider_id=PROVIDER,
                            local_dates=REQUEST.local_dates,
                        ),
                    )
                    == []
                )
    with pytest.raises(ValueError, match="not owned"):
        load_back(
            load_back_database,
            PROVIDER,
            REQUEST.local_dates,
            result.output,
            manifest=replace(result.manifest, family_id="headways"),
        )
    with pytest.raises(ValueError, match="provider"):
        load_back(
            load_back_database,
            "other",
            REQUEST.local_dates,
            FamilyOutput({}, {}),
            manifest=result.manifest,
        )


@pytest.fixture
def built_seed(load_back_database, seed_provider, tmp_path):
    write_inputs(tmp_path, REQUEST, provider_id=PROVIDER)
    result = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    with load_back_database.begin() as conn:
        seed_facts(conn, seed_provider, REQUEST, SEED, None, provider_id=PROVIDER)
    return result


def correct_facts(conn):
    conn.execute(
        text(
            "UPDATE gold.fact_trip_delay_snapshot SET delay_seconds=240 WHERE provider_id=:provider"
        ),
        {"provider": PROVIDER},
    )
    delay_days.invalidate_delay_days(conn, PROVIDER, [98110003])


@pytest.mark.parametrize("first_build", [False, True])
def test_correction_after_build_refuses_stale_load(load_back_database, built_seed, first_build):
    with load_back_database.begin() as conn:
        if first_build:
            for relation in (*builder.tables, "gold.warm_rollup_periods"):
                conn.execute(
                    text(f"DELETE FROM {relation} WHERE provider_id=:provider"),
                    {"provider": PROVIDER},
                )
        correct_facts(conn)
        before = conn.execute(
            text(
                "SELECT to_jsonb(r) FROM gold.warm_rollup_periods r "
                "WHERE provider_id=:provider ORDER BY rollup_kind,period_start_utc"
            ),
            {"provider": PROVIDER},
        ).all()
    with pytest.raises(ValueError, match="stale.*load.back"):
        load_back(
            load_back_database,
            PROVIDER,
            REQUEST.local_dates,
            built_seed.output,
            manifest=built_seed.manifest,
        )
    with load_back_database.connect() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT to_jsonb(r) FROM gold.warm_rollup_periods r "
                    "WHERE provider_id=:provider ORDER BY rollup_kind,period_start_utc"
                ),
                {"provider": PROVIDER},
            ).all()
            == before
        )


def test_concurrent_invalidation_wins_over_stale_load(load_back_database, built_seed):
    reached_lock = Event()

    def observe(conn, cursor, statement, params, context, many):
        if "pg_advisory_xact_lock" in statement:
            reached_lock.set()

    with load_back_database.connect() as correction, ThreadPoolExecutor(1) as pool:
        correction.begin()
        correct_facts(correction)
        event.listen(load_back_database, "before_cursor_execute", observe)
        try:
            future = pool.submit(
                load_back,
                load_back_database,
                PROVIDER,
                REQUEST.local_dates,
                built_seed.output,
                manifest=built_seed.manifest,
            )
            try:
                assert reached_lock.wait(5)
                with pytest.raises(TimeoutError):
                    future.result(timeout=0.2)
            finally:
                correction.commit()
            with pytest.raises(ValueError, match="stale.*load.back"):
                future.result(timeout=10)
        finally:
            event.remove(load_back_database, "before_cursor_execute", observe)
    with load_back_database.connect() as conn:
        assert (
            delay_days.delay_day_state(
                conn, PROVIDER, "route_delay_by_crowding_daily", REQUEST.local_dates[0]
            )
            == "dirty"
        )


def test_owned_histogram_arrays_round_trip(load_back_database, seed_provider, monkeypatch):
    relation = "gold.route_delay_spine"
    key = ("provider_id", "route_id", "provider_local_date", "hour_of_day_local", "direction_id")
    manifest = BuildManifest(
        **vars(REQUEST), family_id="route_spine_hours", code_commit="a" * 40, inputs=()
    )
    monkeypatch.setattr(registry, "resolve_builder", lambda _: SimpleNamespace(inputs=lambda _: ()))
    with load_back_database.begin() as conn:
        seed_provider(conn, PROVIDER, display_name="Histogram load back", timezone=REQUEST.timezone)
        for route, histogram in (("A", "{1,0,2}"), ("B", "{}"), ("C", None)):
            conn.execute(
                text(
                    "INSERT INTO gold.route_delay_spine "
                    "(provider_id,route_id,provider_local_date,hour_of_day_local,"
                    "direction_id,delay_histogram,built_at_utc) "
                    "VALUES (:provider,:route,:day,1,0,CAST(:histogram AS smallint[]),:stamp)"
                ),
                dict(
                    provider=PROVIDER,
                    route=route,
                    day=REQUEST.local_dates[0],
                    histogram=histogram,
                    stamp=REQUEST.as_of_utc,
                ),
            )
        rows = read_table_rows(
            conn, relation, key, provider_id=PROVIDER, local_dates=REQUEST.local_dates
        )
    load_back(
        load_back_database,
        PROVIDER,
        REQUEST.local_dates,
        FamilyOutput({relation: rows}, {}),
        manifest=manifest,
    )
    with load_back_database.connect() as conn:
        assert (
            compare_tables(
                rows,
                read_table_rows(
                    conn, relation, key, provider_id=PROVIDER, local_dates=REQUEST.local_dates
                ),
            )
            == []
        )
