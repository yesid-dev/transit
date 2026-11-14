import csv
import os
import subprocess
from datetime import UTC, date, datetime

import pytest
import revision_2_seed as seed
from sqlalchemy import MetaData, Table, text
from test_revision_2_projection import _pin, _publish

from transit_ops import settings as settings_module
from transit_ops.batch.build import BuildRequest, FamilyBuilder
from transit_ops.batch.compare import compare_bodies, compare_tables
from transit_ops.batch.families.registry import FAMILIES, resolve_builder
from transit_ops.batch.pg_load import pinned_replay_engine, prepare_replay_database
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import key_matches, run_family
from transit_ops.gold import delay_hours, rollups
from transit_ops.history.datasets import TableSource, get_dataset
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window
from transit_ops.snapshots.builders.historic import (
    line_history,
    network_history,
    network_trend,
    provenance,
    stop_history,
)


def test_reader_supports_consecutive_windows():
    from sqlalchemy import create_engine

    with create_engine("sqlite://").connect() as conn:
        conn.exec_driver_sql("ATTACH DATABASE ':memory:' AS information_schema")
        conn.exec_driver_sql(
            "CREATE TABLE information_schema.columns "
            "(table_schema, table_name, column_name, data_type, "
            "numeric_precision, ordinal_position)"
        )
        for index, name in enumerate(("provider_id", "provider_local_date", "id")):
            conn.exec_driver_sql(
                "INSERT INTO information_schema.columns VALUES "
                "('main', 'probe', ?, 'text', NULL, ?)",
                (name, index),
            )
        conn.exec_driver_sql("CREATE TABLE probe (provider_id, provider_local_date, id)")
        conn.exec_driver_sql(
            "INSERT INTO probe VALUES ('seed', '2025-06-03', 2), "
            "('seed', '2025-06-03', 1), ('other', '2025-06-03', 3)"
        )
        assert [
            r[2]
            for r in read_table_rows(
                conn, "main.probe", ("id",), provider_id="seed", local_dates=None
            ).rows
        ] == [1, 2]
        assert (
            read_table_rows(conn, "main.probe", ("id",), provider_id="seed", local_dates=()).rows
            == ()
        )


def test_reader_preserves_postgres_text_and_sorts_keys(real_db_engine):
    with real_db_engine.connect() as conn, conn.begin():
        conn.exec_driver_sql("""
            CREATE TEMP TABLE batch_rows_probe (
                provider_id text, provider_local_date date, id integer,
                amount numeric, items numeric[], payload jsonb, span interval, clock timetz)
        """)
        conn.exec_driver_sql("""
            INSERT INTO batch_rows_probe VALUES
            ('seed', '2025-06-03', 2, 1.500, '{1.50,NULL}', '{"a": 1.00}',
             '1 month 2 days', '12:00:00+03'),
            ('seed', '2025-06-03', 1, NULL, NULL, NULL, NULL, NULL),
            ('other', '2025-06-03', 3, NULL, NULL, NULL, NULL, NULL)
        """)
        schema = conn.exec_driver_sql("SELECT pg_my_temp_schema()::regnamespace::text").scalar_one()
        relation = f"{schema}.batch_rows_probe"
        rows = read_table_rows(
            conn, relation, ("id",), provider_id="seed", local_dates=(date(2025, 6, 3),)
        )
        expected = conn.exec_driver_sql("""
            SELECT provider_id, provider_local_date, id, amount::text, items::text,
                   payload::text, span::text, clock::text
            FROM batch_rows_probe WHERE provider_id='seed' ORDER BY id
        """).all()
        assert rows.rows == tuple(tuple(row) for row in expected)
        assert rows.rows[1][3:6] == ("1.500", "{1.50,NULL}", '{"a": 1.00}')
        assert (
            read_table_rows(conn, relation, ("id",), provider_id="seed", local_dates=()).rows == ()
        )
        with pytest.raises(ValueError, match="missing"):
            read_table_rows(conn, relation, ("missing",), provider_id="seed", local_dates=None)


@pytest.fixture
def seeded(real_db_engine, tmp_path, monkeypatch):
    database = prepare_replay_database(
        real_db_engine.url.render_as_string(hide_password=False), os.environ
    )
    settings = seed.settings_for(tmp_path)
    monkeypatch.setattr(
        seed, "pinned_engine", lambda _engine, stamp: pinned_replay_engine(database, stamp)
    )
    monkeypatch.setattr(rollups, "PERCENTILE_LOOKBACK_DAYS", seed.RETENTION_DAYS - 1)
    for module in (
        settings_module,
        line_history,
        network_history,
        network_trend,
        provenance,
        stop_history,
    ):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    seed.delete_rows(database.engine)
    try:
        seed.seed_history(database.engine, settings, tmp_path)
        with pinned_replay_engine(database, seed.HISTORY_CLOCK) as engine:
            _pin(monkeypatch, seed.HISTORY_CLOCK)
            seed.seed_live(engine, settings, tmp_path, seed.HISTORY_CLOCK)
            yield engine, settings, tmp_path
    finally:
        seed.delete_rows(database.engine)
        database.engine.dispose()


def _bodies(engine, settings, provider):
    bodies = {}
    for tier in ("static", "historic", "live"):
        result, files = _publish(engine, settings, provider, tier)
        assert result.gate_report is not None and result.gate_report["errors"] == 0
        assert not bodies.keys() & files.keys()
        bodies.update(files)
    return bodies


def test_postgres_path_repeats_byte_for_byte(seeded):
    engine, settings, _root = seeded
    for provider in seed.PROVIDERS.values():
        first = _bodies(engine, settings, provider)
        assert first
        assert compare_bodies(first, _bodies(engine, settings, provider)) == []


def test_window_filter_keeps_null_empty_and_multiline_text(tmp_path):
    path = tmp_path / "window.csv"
    selected = '2025-06-03,\n2025-06-03,""\n2025-06-03,"été\nquoted ""text"""\n'
    path.write_bytes(("day,value\n" + selected + "2025-06-04,other\n").encode())
    result = filter_window(path, "day", "local:2025-06-03")
    assert result.read_bytes() == ("day,value\n" + selected).encode()


def filter_window(csv_path, column, window):
    filtered = csv_path.with_suffix(".filtered.csv")
    with (
        csv_path.open(newline="", encoding="utf8") as stream,
        filtered.open("w", newline="", encoding="utf8") as output,
    ):
        lines = []

        def capture():
            for line in stream:
                lines.append(line)
                yield line

        # Parsing selects records; original text retains NULL/empty and quoting.
        reader = csv.reader(capture())
        index = next(reader).index(column)
        output.write("".join(lines))
        lines.clear()
        for row in reader:
            value = row[index]
            if window.startswith("local:") and " " in value:
                value = datetime.fromisoformat(value).astimezone(seed.TZ).date().isoformat()
            if value[:10] == window.removeprefix("local:"):
                output.write("".join(lines))
            lines.clear()
    return filtered


def _export_inputs(engine, builder, request, root):
    for need in builder.inputs(request):
        destination = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
        destination.parent.mkdir(parents=True, exist_ok=True)
        dataset = get_dataset(need.relation)
        source = dataset.source
        assert isinstance(source, TableSource), need
        window = need.window.removeprefix("local:")
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            driver = conn.connection.driver_connection
            if window.startswith("edition:"):
                window = conn.execute(
                    text(
                        "SELECT COALESCE(checksum_sha256, content_hash) "
                        "FROM core.dataset_versions WHERE dataset_version_id=:id"
                    ),
                    {"id": int(window.split(":")[1])},
                ).scalar_one()
            if dataset.archive_grain == "month":
                window = request.as_of_utc.strftime("%Y-%m") if window == "all" else window[:7]
            exported = export_window(
                driver,
                WindowSpec(need.relation, request.provider_id, window),
                destination.with_suffix(".csv"),
                statement_timeout_s=60,
            )
        csv_path = exported.csv_path
        if source.window_column is not None and not need.window.startswith("edition:"):
            csv_path = filter_window(csv_path, source.window_column, need.window)
        write_window(csv_path, exported.schema, destination, metadata={}, temp_dir=root)


def _dirty_after_load(conn, tables, provider):
    params = dict(
        provider_id=provider,
        from_utc=datetime(2025, 6, 1, tzinfo=UTC),
        until_utc=seed.HISTORY_CLOCK,
    )
    expected = conn.execute(delay_hours._DIRTY_HOURS, params).all()
    with conn.begin_nested() as transaction:
        for rows in tables.values():
            schema, name = rows.relation.split(".")
            table = Table(name, MetaData(), schema=schema, autoload_with=conn)
            conn.execute(table.delete().where(table.c.provider_id == provider))
            if rows.rows:
                conn.execute(
                    table.insert(), [dict(zip(rows.columns, row, strict=True)) for row in rows.rows]
                )
        assert conn.execute(delay_hours._DIRTY_HOURS, params).all() == expected
        transaction.rollback()


def test_every_implemented_family_matches_postgres_on_the_seed(seeded, record_property):
    engine, settings, root = seeded
    builders = {name: resolve_builder(name) for name in FAMILIES}
    compared = []
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    for name, builder in builders.items():
        if builder is None:
            continue
        assert isinstance(builder, FamilyBuilder), name
        for provider in seed.PROVIDERS.values():
            request = BuildRequest(
                provider, seed.DAYS, seed.HISTORY_CLOCK, seed.RETENTION_DAYS, 36000, str(seed.TZ)
            )
            inputs = root / name / provider
            _export_inputs(engine, builder, request, inputs)
            expected = _bodies(engine, settings, provider)
            result = run_family(
                builder, request, inputs_root=inputs, workdir=root, code_commit=commit
            )
            with engine.connect() as conn:
                for relation, actual in result.output.tables.items():
                    dates = request.local_dates if "provider_local_date" in actual.columns else None
                    reference = read_table_rows(
                        conn, relation, actual.key, provider_id=provider, local_dates=dates
                    )
                    assert compare_tables(reference, actual) == [], (name, relation)
                if "gold.route_delay_hourly" in result.output.tables:
                    _dirty_after_load(conn, result.output.tables, provider)
            assert (
                compare_bodies(
                    {k: v for k, v in expected.items() if key_matches(k, builder.published_keys)},
                    result.output.bodies,
                )
                == []
            ), name
        compared.append(name)
    expected_names = [name for name, builder in builders.items() if builder is not None]
    record_property("compared_family_count", len(compared))
    record_property("compared_families", ",".join(compared) or "(none)")
    print(f"Compared {len(compared)} families: {compared}")
    assert compared == expected_names, f"Compared {len(compared)} families: {compared}"
