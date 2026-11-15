import json

import pytest
from test_lake_table_copy_real_db import archive as archive
from test_lake_table_copy_real_db import run
from test_lake_table_copy_real_db import seeded_export as seeded_export
from test_lake_table_export_real_db import owned as owned
from test_lake_table_export_real_db import source as source
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.lake.table_copy import ServerChanged


def test_closed_copy_returns_without_source_reads(seeded_export, archive, tmp_path, monkeypatch):
    from datetime import UTC, datetime

    from transit_ops.lake import table_copy

    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 12, 15, tzinfo=UTC))
    first = run(None, archive, seeded_export, tmp_path, "closed-first")

    def refuse(*a, **k):
        raise AssertionError("source read for proven closed window")

    monkeypatch.setattr(table_copy, "export_window", refuse)
    monkeypatch.setattr(table_copy, "recheck_window", refuse)
    second = run(None, archive, seeded_export, tmp_path, "closed-second")
    assert (second.outcome, second.key) == ("already_copied", first.key)


def test_later_cut_is_new_revision_even_when_rows_match(
    seeded_export, archive, tmp_path, monkeypatch
):
    from datetime import UTC, datetime

    from transit_ops.lake import table_copy

    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 11, 15, 15, tzinfo=UTC))
    first = run(None, archive, seeded_export, tmp_path, "cut-one")
    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 11, 15, 16, tzinfo=UTC))
    second = run(None, archive, seeded_export, tmp_path, "cut-two")
    receipt = json.loads(archive.read_bytes(second.proof_key))
    assert first.key != second.key
    assert second.key.endswith(".c2.s1.parquet")
    assert receipt["cut_utc"] == receipt["proof"]["cut_utc"] == "2026-11-15T10:00:00+00:00"
    assert receipt["partial"] is receipt["proof"]["partial"] is True


@pytest.mark.parametrize(
    "insert_date,refused",
    [("2026-11-15T10:00:00+00:00", False), ("2026-11-02T00:00:00+00:00", True)],
)
def test_concurrent_insert_respects_fixed_cut(
    source, owned, archive, tmp_path, monkeypatch, insert_date, refused
):
    from datetime import UTC, datetime

    from transit_ops.lake import table_copy

    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 11, 15, 15, tzinfo=UTC))
    from dataclasses import replace
    from uuid import uuid4

    provider = "cut_" + uuid4().hex
    source.execute(
        f"ALTER TABLE {owned.dataset_id} ALTER COLUMN service_date TYPE timestamptz "
        "USING service_date::timestamp AT TIME ZONE 'UTC'"
    )
    source.execute(f"UPDATE {owned.dataset_id} SET provider_id=%s", (provider,))
    owned = replace(owned, provider_id=provider)
    original = table_copy.recheck_window

    def recheck(*args, **kwargs):
        import psycopg

        with psycopg.connect(source.info.dsn, autocommit=True) as writer:
            writer.execute(
                f"INSERT INTO {owned.dataset_id} VALUES (%s,2,%s,%s)",
                (owned.provider_id, insert_date, "concurrent"),
            )
        return original(*args, **kwargs)

    monkeypatch.setattr(table_copy, "recheck_window", recheck)
    try:
        if refused:
            with pytest.raises(ServerChanged):
                run(source, archive, owned, tmp_path, "race")
            assert not list(archive.list_keys("archive/"))
        else:
            result = run(source, archive, owned, tmp_path, "race")
            assert result.rows == 1
            assert result.spec.cut_utc == "2026-11-15T09:00:00+00:00"
    finally:
        source.execute(f"DELETE FROM {owned.dataset_id} WHERE provider_id=%s", (provider,))
        assert source.execute(
            f"SELECT count(*) FROM {owned.dataset_id} WHERE provider_id=%s", (provider,)
        ).fetchone() == (0,)


def test_migrate_connection_is_read_only(source, tmp_path, monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    import psycopg

    from transit_ops.lake.migration import MigrationPlan

    table = "ls19e_write_" + uuid4().hex
    real_connect = psycopg.connect

    def connect(*args, **kwargs):
        assert "-c default_transaction_read_only=on" in kwargs["options"]
        return real_connect(source.info.dsn, **kwargs)

    def plan(connection, **kwargs):
        assert connection.execute("SHOW default_transaction_read_only").fetchone() == ("on",)
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            connection.execute(f"CREATE TABLE public.{table}(id int)")
        return MigrationPlan(SimpleNamespace(complete=True), (), ())

    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setattr("transit_ops.lake.migration.plan_migration", plan)
    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: SimpleNamespace(
            DATABASE_URL="postgresql://unused/test",
            BRONZE_STORAGE_BACKEND="local",
            BRONZE_LOCAL_ROOT="tmp",
            redacted_database_url="unused",
        ),
    )
    result = CliRunner().invoke(
        app,
        [
            "lake",
            "migrate",
            "--statement-timeout-s",
            "60",
            "--work-dir",
            str(tmp_path),
            "--copied-by",
            "a" * 40,
        ],
    )
    assert result.exit_code == 0, (result.output, result.exception)
    assert source.execute("SELECT to_regclass(%s)", ("public." + table,)).fetchone() == (None,)


def test_closed_revision_replaces_partial_before_it_can_be_skipped(
    seeded_export, archive, tmp_path, monkeypatch
):
    from datetime import UTC, datetime

    from transit_ops.lake import table_copy

    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 11, 15, 15, tzinfo=UTC))
    partial = run(None, archive, seeded_export, tmp_path, "partial")
    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 12, 15, tzinfo=UTC))
    complete = run(None, archive, seeded_export, tmp_path, "complete")
    assert complete.key != partial.key
    receipt = json.loads(archive.read_bytes(complete.proof_key))
    assert receipt["cut_utc"] is None
    assert receipt["partial"] is False

    def refuse(*args, **kwargs):
        raise AssertionError("closed copy reads the source")

    monkeypatch.setattr(table_copy, "export_window", refuse)
    assert run(None, archive, seeded_export, tmp_path, "skip").key == complete.key


def test_legacy_open_copy_is_not_a_complete_closed_window(
    seeded_export, archive, tmp_path, monkeypatch
):
    from datetime import UTC, datetime

    from transit_ops.lake import table_copy

    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 11, 15, 15, tzinfo=UTC))
    first = run(None, archive, seeded_export, tmp_path, "legacy")
    receipt = json.loads(archive.read_bytes(first.proof_key))
    for value in (receipt, receipt["proof"]):
        value.pop("cut_utc")
        value.pop("partial")
    (archive.root / first.proof_key).write_text(json.dumps(receipt))
    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 12, 15, tzinfo=UTC))
    result = run(None, archive, seeded_export, tmp_path, "closed")
    assert result.outcome == "copied"
    assert result.key.endswith(".c2.s1.parquet")
