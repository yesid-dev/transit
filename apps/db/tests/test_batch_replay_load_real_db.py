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
def replay(real_db_engine, request):
    url = real_db_engine.url.update_query_dict(getattr(request, "param", {}))
    database = prepare_replay_database(url.render_as_string(hide_password=False), os.environ)
    with database.engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE public.replay_load (value text)")
    try:
        yield database
    finally:
        with database.engine.begin() as conn:
            conn.exec_driver_sql("DROP TABLE public.replay_load")
        database.engine.dispose()


def parquet(tmp_path, query):
    tmp_path.mkdir(parents=True, exist_ok=True)
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
           [NULL, 'NULL', '', 'a,b', 'a"b', 'a\\b', '南']),
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
@pytest.mark.parametrize(
    "replay",
    [
        {},
        {
            "client_encoding": "LATIN1",
            "options": "-c array_nulls=off -c TimeZone=America/Toronto",
        },
    ],
    indirect=True,
)
def test_typed_round_trip_is_exact(replay, real_db_engine, tmp_path, split):
    with replay.engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE public.replay_load")
        conn.exec_driver_sql("""
            CREATE TABLE public.replay_load (
                id int, value text, floating double precision, amount numeric(12,4),
                stamp timestamptz, numbers smallint[], words text[])
        """)
    item = typed_parquet(tmp_path, split)
    assert load_inputs(replay, [item], tmp_path) == [LoadReceipt(item.relation, item.files, 4)]
    with real_db_engine.connect() as conn:
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
            [None, "NULL", "", "a,b", 'a"b', "a\\b", "南"],
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
    "query, name, destination",
    [
        ("SELECT 1 AS unknown", "unknown", "value text"),
        *[
            (f"SELECT {value} AS value", "value", destination)
            for value, destination in [
                ("{'x': 1}", "value text"),
                ("map(['x'], [1])", "value text"),
                ("[NULL,[1,2],NULL]::INTEGER[][]", "value integer[]"),
                ("[NULL,NULL]::INTEGER[][]", "value integer[]"),
                ("[[1,2],NULL,[3,4]]", "value integer[]"),
                ("[NULL::INTEGER[]]", "value integer[]"),
                ("'\\xABCD'::BLOB", "value bytea"),
                ("TIMESTAMP_NS '2026-11-01 07:00:00.123456789'", "value timestamp"),
                ("1.2345::DECIMAL(12,4)", "value numeric(12,2)"),
                ("1.2345::DECIMAL(12,4)", "value numeric(11,4)"),
                ("TIMESTAMPTZ '2026-11-01 07:00:00+00'", "value timestamp"),
                ("TIMESTAMP '2026-11-01 07:00:00'", "value timestamptz"),
                ("[1]::INTEGER[]", "value smallint[]"),
                ("'abc  '", "value varchar(3)"),
                ("TIMESTAMP '2026-11-01 07:00:00.123456'", "value timestamp(3)"),
            ]
        ],
        ("SELECT 'kept' AS value", "added", "value text, added timestamptz DEFAULT now()"),
    ],
)
def test_unknown_columns_are_refused(replay, tmp_path, query, name, destination):
    with replay.engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE public.replay_load")
        conn.exec_driver_sql(f"CREATE TABLE public.replay_load ({destination})")
    item = parquet(tmp_path, query)
    with pytest.raises(InputSchemaRefused, match=name):
        load_inputs(replay, [item], tmp_path)
    with replay.engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT * FROM public.replay_load").all() == []


def test_second_relation_failure_rolls_back_first(replay, tmp_path):
    first = parquet(tmp_path, "SELECT 'kept' AS value")
    second = parquet(tmp_path / "second", "SELECT {'x': 1} AS value")
    second = BatchInput("public.refused", second.files)
    with pytest.raises(InputSchemaRefused, match="value"):
        load_inputs(replay, [first, second], tmp_path)
    with replay.engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT * FROM public.replay_load").all() == []


def test_reused_connection_rechecks_identity(replay, tmp_path):
    item = parquet(tmp_path, "SELECT 'kept' AS value")
    with replay.engine.begin() as conn:
        conn.exec_driver_sql("SET ROLE pg_read_all_data")
    try:
        with pytest.raises(ReplayDatabaseRefused, match="Server database/role"):
            load_inputs(replay, [item], tmp_path)
    finally:
        with replay.engine.begin() as conn:
            conn.exec_driver_sql("RESET ROLE")
            assert conn.exec_driver_sql("SELECT * FROM public.replay_load").all() == []


def test_every_new_replay_pool_connection_checks_identity(replay, monkeypatch):
    with replay.engine.connect() as first:
        assert first.exec_driver_sql("SELECT current_user").scalar_one() == "transit_ci"
        monkeypatch.setenv("PGOPTIONS", "-c role=pg_read_all_data")
        with pytest.raises(ReplayDatabaseRefused, match="Server database/role"):
            with replay.engine.connect():
                pytest.fail("second pooled connection accepted an unapproved role")
