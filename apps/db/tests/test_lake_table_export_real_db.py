import csv
import json
from dataclasses import replace
from functools import partial
from uuid import uuid4

import psycopg
import pytest
from test_rescue_fact_day import fact_source as fact_source
from test_rescue_fact_day import rescue

from transit_ops.history import datasets
from transit_ops.lake.table_export import (
    ExportRefused,
    SchemaDrift,
    WindowSpec,
    export_window,
    recheck_window,
)


@pytest.fixture
def source(real_db_engine):
    with psycopg.connect(
        **real_db_engine.url.translate_connect_args(username="user", database="dbname"),
        autocommit=True,
    ) as connection:
        yield connection


export = partial(export_window, statement_timeout_s=60)
recheck = partial(recheck_window, statement_timeout_s=60)


@pytest.mark.parametrize("table", list(rescue.SCHEMAS))
def test_fact_day_export_is_byte_identical_to_the_rescue_export(
    source, fact_source, tmp_path, table
):
    provider, start, end = fact_source
    source.execute(
        f"UPDATE gold.{table} SET entity_index=10-entity_index, "
        "trip_id=CASE WHEN entity_index=2 THEN '南' ELSE trip_id END WHERE provider_id=%s",
        (provider,),
    )
    spec = WindowSpec("gold." + table, provider, start.date().isoformat())
    result = export(source, spec, tmp_path / "export.csv")
    with source.transaction():
        source.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        source.execute("SET LOCAL TimeZone='UTC'")
        source.execute("SET LOCAL DateStyle='ISO, YMD'")
        source.execute("SET LOCAL IntervalStyle='iso_8601'")
        source.execute("SET LOCAL extra_float_digits=1")
        source.execute("SET LOCAL bytea_output='hex'")
        source.execute("SET LOCAL client_encoding='UTF8'")
        expected = rescue.copy_fact_table(
            source,
            table=table,
            provider_id=provider,
            start_utc=start,
            end_utc=end,
            destination=tmp_path / "rescue.csv",
        )
    assert result.csv_path.read_bytes() == (tmp_path / "rescue.csv").read_bytes()
    assert result.content_sha256 == expected["csv_sha256"]
    assert result.content_bytes == expected["csv_bytes"]
    assert result.rows == expected["copy_rows"]
    with result.csv_path.open(newline="", encoding="utf8") as stream:
        assert [row["entity_index"] for row in csv.DictReader(stream)] == ["7", "8", "9"]
    assert recheck(source, spec) == (result.content_sha256, result.content_bytes, 3)
    source.execute(f"UPDATE gold.{table} SET trip_id='changed' WHERE provider_id=%s", (provider,))
    assert recheck(source, spec)[0] != result.content_sha256
    with pytest.raises(FileExistsError):
        export(source, spec, result.csv_path)


@pytest.fixture
def owned(source, monkeypatch):
    table = "public.export_" + uuid4().hex
    original = datasets.get_dataset("gold.network_vehicle_day")
    declared = replace(original, dataset_id=table, source=replace(original.source, table=table))
    monkeypatch.setattr(
        datasets, "HISTORY_DATASETS", {**datasets.HISTORY_DATASETS, table: declared}
    )
    registered = (
        source.execute("SELECT 1 FROM core.providers WHERE provider_id='p'").fetchone() is None
    )
    source.execute(
        f"CREATE TABLE {table} (provider_id text, revision int, service_date date, "
        "value text NOT NULL, PRIMARY KEY(provider_id,revision,service_date))"
    )
    try:
        if registered:
            source.execute(
                "INSERT INTO core.providers(provider_id,provider_key,display_name,timezone) "
                "VALUES ('p','p','fixture','UTC')"
            )
        source.execute(f"INSERT INTO {table} VALUES ('p',2,'2026-11-01','old')")
        yield WindowSpec(table, "p", "2026-11", 2)
    finally:
        source.execute(f"DROP TABLE {table}")
        if registered:
            source.execute("DELETE FROM core.providers WHERE provider_id='p'")


def test_month_window_of_a_rollup_contains_exactly_its_month(source, owned, tmp_path):
    source.execute(
        f"INSERT INTO {owned.dataset_id} VALUES "
        "('p',2,'2026-10-31','before'),('p',2,'2026-12-01','after')"
    )
    result = export(source, owned, tmp_path / "month.csv")
    with result.csv_path.open(newline="", encoding="utf8") as stream:
        assert [row["service_date"] for row in csv.DictReader(stream)] == ["2026-11-01"]


def test_whole_table_export_of_a_shared_table(source, tmp_path):
    result = export(
        source, WindowSpec("gold.report_labels", "_shared", "2026-11"), tmp_path / "all.csv"
    )
    assert result.rows == source.execute("SELECT count(*) FROM gold.report_labels").fetchone()[0]


@pytest.mark.parametrize("active", [True, False])
def test_export_refuses_a_writable_transaction_and_writes_nothing(source, owned, tmp_path, active):
    source.autocommit = False
    if active:
        source.execute("SELECT 1")
    try:
        with pytest.raises(ExportRefused, match="not_read_only"):
            export(source, owned, tmp_path / "refused.csv")
        assert not list(tmp_path.iterdir())
    finally:
        source.rollback()
        source.autocommit = True


@pytest.mark.parametrize("change", ["value TYPE varchar(1000)", "value DROP NOT NULL"])
def test_recheck_refuses_same_byte_schema_drift(source, owned, tmp_path, change):
    result = export(source, owned, tmp_path / "old.csv")
    source.execute(f"ALTER TABLE {owned.dataset_id} ALTER COLUMN {change}")
    assert recheck(source, owned)[0] == result.content_sha256
    with pytest.raises(SchemaDrift):
        recheck(source, owned, expected_schema=result.schema)


def test_changed_primary_key_is_refused(source, owned, tmp_path):
    source.execute(
        f"ALTER TABLE {owned.dataset_id} DROP CONSTRAINT "
        f"{owned.dataset_id.split('.')[1]}_pkey, ADD PRIMARY KEY(provider_id,service_date,revision)"
    )
    with pytest.raises(SchemaDrift):
        export(source, owned, tmp_path / "key.csv")
    with pytest.raises(SchemaDrift):
        recheck(source, owned)


def test_lock_failure_cleans_files_and_allows_retry(source, owned, tmp_path, real_db_engine):
    arguments = real_db_engine.url.translate_connect_args(username="user", database="dbname")
    with psycopg.connect(**arguments) as blocker, blocker.transaction():
        blocker.execute(f"LOCK TABLE {owned.dataset_id} IN ACCESS EXCLUSIVE MODE")
        with pytest.raises(psycopg.errors.LockNotAvailable):
            export(source, owned, tmp_path / "retry.csv")
        assert not list(tmp_path.iterdir())
    assert export(source, owned, tmp_path / "retry.csv").rows == 1


def test_binary_order_matches_old_copy_and_has_no_postgres_sort(source, monkeypatch, tmp_path):
    from psycopg import sql

    from transit_ops.lake.parquet_codec import write_window
    from transit_ops.lake.table_export import _copy, _snapshot, order_by

    table = "public.export_" + uuid4().hex
    original = datasets.get_dataset("gold.report_labels")
    declared = replace(original, dataset_id=table, source=replace(original.source, table=table))
    monkeypatch.setattr(
        datasets, "HISTORY_DATASETS", {**datasets.HISTORY_DATASETS, table: declared}
    )
    collation = source.execute(
        "SELECT collname FROM pg_collation WHERE collname IN "
        "('en-US-x-icu', 'en_US.utf8', 'en_US') LIMIT 1"
    ).fetchone()
    if collation is None:
        pytest.skip("Disposable PostgreSQL needs an en_US or en-US ICU collation")
    source.execute(
        sql.SQL("CREATE TABLE {} (label_key text COLLATE {} PRIMARY KEY, payload text)").format(
            sql.Identifier(*table.split(".")), sql.Identifier(collation[0])
        )
    )
    try:
        for key in ["a", "B", "é", "_x", "10", "9"]:
            source.execute(
                sql.SQL("INSERT INTO {} VALUES (%s,%s)").format(sql.Identifier(*table.split("."))),
                (key, 'quote" and comma, and newline\n' + key),
            )
        spec = WindowSpec(table, "_shared", "2026-11")
        result = export(source, spec, tmp_path / "new.csv")
        assert result.rows == 6
        with result.csv_path.open(encoding="utf8", newline="") as stream:
            assert [row["label_key"] for row in csv.DictReader(stream)] == [
                "10",
                "9",
                "B",
                "_x",
                "a",
                "é",
            ]
        old = tmp_path / "old.csv"
        with _snapshot(source, spec, 60) as snapshot:
            schema, statement, values = snapshot[:3]
            select = statement.as_string().split("COPY (", 1)[1].split(") TO STDOUT", 1)[0]
            plan = source.execute("EXPLAIN (FORMAT JSON) " + select, values).fetchone()[0]
            assert '"Node Type": "Sort"' not in json.dumps(plan)
            legacy = sql.SQL(
                statement.as_string().replace(
                    ") TO STDOUT", " ORDER BY " + order_by(schema).as_string() + ") TO STDOUT"
                )
            )
            with old.open("wb") as output:
                old_digest = _copy(source, legacy, values, output)
        assert result.csv_path.read_bytes() == old.read_bytes()
        assert recheck(source, spec, temp_dir=tmp_path) == old_digest
        assert (result.content_sha256, result.content_bytes, result.rows) == old_digest
        copies = [
            write_window(
                path, schema, tmp_path / f"{path.stem}.parquet", metadata={}, temp_dir=tmp_path
            )
            for path in [old, result.csv_path]
        ]
        assert copies[0].sha256 == copies[1].sha256
        assert copies[0].content_sha256 == copies[1].content_sha256
    finally:
        source.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(*table.split("."))))
