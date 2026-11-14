import os
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

import duckdb
import psycopg
import pytest
from sqlalchemy import create_engine
from test_rescue_fact_day import fact_source as fact_source

from transit_ops.batch.engine import BatchInput
from transit_ops.batch.pg_load import (
    InputSchemaRefused,
    LoadReceipt,
    ReplayDatabaseRefused,
    load_inputs,
    prepare_replay_database,
)
from transit_ops.history import datasets
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window


def test_unprepared_engine_is_refused_without_connecting(tmp_path, monkeypatch):
    engine = create_engine("postgresql+psycopg://transit_ci@localhost/transit_ci")
    monkeypatch.setattr(engine, "connect", lambda: pytest.fail("unprepared connection opened"))
    with pytest.raises(ReplayDatabaseRefused, match="prepare_replay_database"):
        load_inputs(engine, [], tmp_path)


@pytest.fixture
def replay(real_db_engine):
    database = prepare_replay_database(
        real_db_engine.url.render_as_string(hide_password=False), os.environ
    )
    with database.engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE public.replay_load (value text)")
    try:
        yield database
    finally:
        with database.engine.begin() as conn:
            conn.exec_driver_sql("DROP TABLE public.replay_load")
        database.engine.dispose()


def parquet(tmp_path, query):
    path = tmp_path / "input.parquet"
    with duckdb.connect() as conn:
        conn.execute("COPY (" + query + ") TO ? (FORMAT parquet)", [str(path)])
    return BatchInput("public.replay_load", (path,))


def typed_parquet(tmp_path, split):
    item = parquet(
        tmp_path,
        """
        SELECT * FROM (VALUES
          (1, NULL, 0.30000000000000004::DOUBLE, 12.3400::DECIMAL(12,4),
           TIMESTAMPTZ '2026-11-01 07:00:00.123456+00', [1, NULL, -2]::SMALLINT[],
           ['NULL', '', 'a,b', 'a"b', 'a\\b']),
          (2, '', NULL, NULL, NULL, []::SMALLINT[], NULL),
          (3, 'é', NULL, NULL, NULL, NULL, []::VARCHAR[]),
          (4, 'Z', NULL, NULL, NULL, NULL, NULL)
        ) AS t(id, value, floating, amount, stamp, numbers, words)
    """,
    )
    if split:
        paths = tuple(tmp_path / f"part-{part}.parquet" for part in (0, 1))
        with duckdb.connect() as conn:
            for part, path in enumerate(paths):
                conn.execute(
                    "COPY (SELECT * FROM read_parquet(?) WHERE id % 2 = ?) TO ? (FORMAT parquet)",
                    [str(item.files[0]), part, str(path)],
                )
        item = BatchInput(item.relation, paths)
    return item


@pytest.mark.parametrize("split", [False, True])
def test_typed_round_trip_is_exact(replay, tmp_path, split):
    with replay.engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE public.replay_load")
        conn.exec_driver_sql("""
            CREATE TABLE public.replay_load (
                id int, value text, floating double precision, amount numeric(12,4),
                stamp timestamptz, numbers smallint[], words text[])
        """)
    item = typed_parquet(tmp_path, split)
    assert load_inputs(replay, [item], tmp_path) == [LoadReceipt(item.relation, item.files, 4)]
    with replay.engine.connect() as conn:
        rows = [
            tuple(row)
            for row in conn.exec_driver_sql("SELECT * FROM public.replay_load ORDER BY id")
        ]
    assert rows == [
        (
            1,
            None,
            0.1 + 0.2,
            Decimal("12.3400"),
            datetime(2026, 11, 1, 7, 0, 0, 123456, UTC),
            [1, None, -2],
            ["NULL", "", "a,b", 'a"b', "a\\b"],
        ),
        (2, "", None, None, None, [], None),
        (3, "é", None, None, None, None, []),
        (4, "Z", None, None, None, None, None),
    ]
    assert rows[0][3].as_tuple().exponent == -4


def test_canonical_csv_survives_parquet_and_load(replay, fact_source, tmp_path, monkeypatch):
    provider, start, _end = fact_source
    relation = "gold.fact_vehicle_snapshot"
    with replay.engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE public.replay_load")
        conn.exec_driver_sql(f"CREATE TABLE public.replay_load (LIKE {relation} INCLUDING ALL)")
    with psycopg.connect(
        **replay.engine.url.translate_connect_args(username="user", database="dbname"),
        autocommit=True,
    ) as conn:
        spec = WindowSpec(relation, provider, start.date().isoformat())
        exported = export_window(conn, spec, tmp_path / "before.csv", statement_timeout_s=60)
        written = write_window(
            exported.csv_path,
            exported.schema,
            tmp_path / "fact.parquet",
            metadata={},
            temp_dir=tmp_path,
        )
        item = BatchInput("public.replay_load", (written.path,))
        assert load_inputs(replay, [item], tmp_path)[0].rows == exported.rows
        original = datasets.get_dataset(relation)
        monkeypatch.setattr(
            datasets,
            "HISTORY_DATASETS",
            {
                **datasets.HISTORY_DATASETS,
                relation: replace(original, source=replace(original.source, table=item.relation)),
            },
        )
        after = export_window(conn, spec, tmp_path / "after.csv", statement_timeout_s=60)
        assert after.csv_path.read_bytes() == exported.csv_path.read_bytes()
        assert conn.execute(f"SELECT * FROM {item.relation} ORDER BY entity_index").fetchall() == (
            conn.execute(
                f"SELECT * FROM {relation} WHERE provider_id=%s AND captured_at_utc >= %s "
                "AND captured_at_utc < %s + interval '1 day' ORDER BY entity_index",
                (provider, start, start),
            ).fetchall()
        )


@pytest.mark.parametrize(
    "query, name",
    [
        ("SELECT 1 AS unknown", "unknown"),
        ("SELECT {'x': 1} AS value", "value"),
        ("SELECT map(['x'], [1]) AS value", "value"),
    ],
)
def test_unknown_columns_are_refused(replay, tmp_path, query, name):
    item = parquet(tmp_path, query)
    with pytest.raises(InputSchemaRefused, match=name):
        load_inputs(replay, [item], tmp_path)
    with replay.engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT * FROM public.replay_load").all() == []


def test_every_new_replay_pool_connection_checks_identity(replay, monkeypatch):
    with replay.engine.connect() as first:
        assert first.exec_driver_sql("SELECT current_user").scalar_one() == "transit_ci"
        monkeypatch.setenv("PGOPTIONS", "-c role=pg_read_all_data")
        with pytest.raises(ReplayDatabaseRefused, match="Server database/role"):
            with replay.engine.connect():
                pytest.fail("second pooled connection accepted an unapproved role")
