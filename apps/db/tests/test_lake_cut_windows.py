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
    source, owned, archive, tmp_path, monkeypatch, insert_date, refused, real_db_engine
):
    from datetime import UTC, datetime

    from parallel_db import guarded_connect_kwargs

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

        with psycopg.connect(
            **guarded_connect_kwargs(real_db_engine.url), autocommit=True
        ) as writer:
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


def test_migrate_connection_is_read_only(source, tmp_path, monkeypatch, real_db_engine):
    from types import SimpleNamespace
    from uuid import uuid4

    import psycopg
    from parallel_db import guarded_connect_kwargs

    from transit_ops.lake.migration import MigrationPlan

    table = "ls19e_write_" + uuid4().hex
    real_connect = psycopg.connect

    def connect(*args, **kwargs):
        assert "-c default_transaction_read_only=on" in kwargs["options"]
        return real_connect(**(guarded_connect_kwargs(real_db_engine.url) | kwargs))

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
            "--allow-no-connection-check",
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


def test_connection_check_refuses_without_explicit_flag(monkeypatch):
    import psycopg

    from transit_ops.lake.connection import connect_lake

    def refuse(*a, **kw):
        error = psycopg.errors.InvalidParameterValue(
            'invalid value for parameter "client_connection_check_interval"'
        )
        raise error

    monkeypatch.setattr(psycopg, "connect", refuse)
    with pytest.raises(ValueError, match="connection_check_unsupported"):
        connect_lake("unused", allow_no_connection_check=False, log=lambda _: None)


def test_accepting_server_keeps_connection_check_with_windows_client(monkeypatch):
    import os

    import psycopg

    from transit_ops.lake.connection import connect_lake

    seen = []
    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(psycopg, "connect", lambda *a, **kw: seen.append(kw) or object())
    connect_lake("unused", allow_no_connection_check=False, log=lambda _: None)
    assert "-c client_connection_check_interval=1000" in seen[0]["options"]


def test_date_cut_excludes_the_mutable_local_day(
    source, owned, archive, tmp_path, monkeypatch, real_db_engine
):
    from dataclasses import replace
    from datetime import UTC, datetime
    from uuid import uuid4

    import psycopg
    from parallel_db import guarded_connect_kwargs

    from transit_ops.lake import table_copy

    provider = "date_" + uuid4().hex
    source.execute(
        "INSERT INTO core.providers(provider_id,provider_key,display_name,timezone) "
        "VALUES (%s,%s,%s,%s)",
        (provider, provider, provider, "America/Toronto"),
    )
    try:
        source.execute(f"UPDATE {owned.dataset_id} SET provider_id=%s", (provider,))
        source.execute(
            f"INSERT INTO {owned.dataset_id} VALUES (%s,2,%s,%s)",
            (provider, "2026-11-15", "mutable"),
        )
        owned = replace(owned, provider_id=provider)
        monkeypatch.setattr(
            table_copy, "_copy_start", lambda: datetime(2026, 11, 15, 15, tzinfo=UTC)
        )
        original = table_copy.recheck_window

        def recheck(*args, **kwargs):
            with psycopg.connect(
                **guarded_connect_kwargs(real_db_engine.url), autocommit=True
            ) as writer:
                writer.execute(
                    f"UPDATE {owned.dataset_id} SET value=%s WHERE service_date=%s",
                    ("new", "2026-11-15"),
                )
            return original(*args, **kwargs)

        monkeypatch.setattr(table_copy, "recheck_window", recheck)
        result = run(source, archive, owned, tmp_path, "date-cut")
        assert result.rows == 1
        assert json.loads(archive.read_bytes(result.proof_key))["date_bound"] == "2026-11-15"
    finally:
        source.execute("DELETE FROM core.providers WHERE provider_id=%s", (provider,))
        assert source.execute(
            "SELECT count(*) FROM core.providers WHERE provider_id=%s", (provider,)
        ).fetchone() == (0,)


def test_explicit_closed_receipt_plans_without_source_discovery(
    seeded_export, archive, tmp_path, monkeypatch
):
    from datetime import UTC, date, datetime

    from transit_ops.lake import table_copy
    from transit_ops.lake.migration import plan_migration

    monkeypatch.setattr(table_copy, "_copy_start", lambda: datetime(2026, 12, 15, tzinfo=UTC))
    run(None, archive, seeded_export, tmp_path, "proven")

    class Recording:
        autocommit = True
        from types import SimpleNamespace

        info = SimpleNamespace(transaction_status=0)

        def execute(self, *a, **kw):
            raise AssertionError("source read for pruned copied window")

        def transaction(self):
            raise AssertionError("source transaction for pruned copied window")

    plan = plan_migration(
        Recording(),
        today_utc=date(2026, 12, 15),
        include_open=False,
        datasets=None,
        providers=None,
        statement_timeout_s=60,
        windows=[f"{seeded_export.dataset_id}:{seeded_export.provider_id}:2026-11"],
        storage=archive,
    )
    assert len(plan.windows) == 1
    assert plan.windows[0].archive_copy.outcome == "already_copied"
    excluded = plan_migration(
        Recording(),
        today_utc=date(2026, 12, 15),
        include_open=False,
        datasets=None,
        providers=["excluded"],
        statement_timeout_s=60,
        windows=[f"{seeded_export.dataset_id}:{seeded_export.provider_id}:2026-11"],
        storage=archive,
    )
    assert excluded.windows == ()


def test_group_reserve_refuses_before_snapshot_at_equality(tmp_path, monkeypatch):
    from datetime import UTC, datetime, timedelta

    from transit_ops.lake import table_export
    from transit_ops.lake.alert_bundle import MEMBERS
    from transit_ops.lake.table_export import WindowSpec

    now = datetime.now(UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(table_export, "datetime", Clock)
    monkeypatch.setattr(table_export, "_snapshot", lambda *a, **k: pytest.fail("snapshot started"))
    specs = tuple(
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    )
    with pytest.raises(ValueError, match="not_after"):
        with table_export.export_group(
            object(),
            specs,
            tuple(tmp_path / f"{i}.csv" for i in range(3)),
            statement_timeout_s=60,
            not_after=now + timedelta(seconds=5000),
            group_reserve_s=5000,
        ):
            pytest.fail("snapshot started")
    table_export.require_snapshot_reserve(now + timedelta(seconds=5000, microseconds=1), 5000)


@pytest.mark.parametrize("state,allowed", [("22023", True), ("22023", False), ("08006", True)])
def test_connection_fallback_is_exact_and_logged(monkeypatch, state, allowed):
    import psycopg

    from transit_ops.lake.connection import connect_lake

    calls = []
    events = []

    class Refusal(psycopg.Error):
        sqlstate = state

    def connect(*a, **kw):
        calls.append(kw)
        if len(calls) == 1:
            raise Refusal('invalid value for parameter "client_connection_check_interval"')
        return object()

    monkeypatch.setattr(psycopg, "connect", connect)
    if state == "22023" and allowed:
        connect_lake("unused", allow_no_connection_check=True, log=events.append)
        assert len(calls) == 2
        assert "client_connection_check_interval" not in calls[1]["options"]
        assert events == [{"client_connection_check": "unsupported_on_server"}]
        assert "-c tcp_keepalives_count=3" in calls[1]["options"]
    else:
        with pytest.raises((ValueError, Refusal)):
            connect_lake("unused", allow_no_connection_check=allowed, log=events.append)
        assert len(calls) == 1
        assert events == []


def test_shared_date_cut_uses_conservative_bound_without_provider_lookup():
    from transit_ops.lake.table_export import WindowSpec, resolve_cut_spec
    from transit_ops.lake.table_schema import TableSchema

    class NoReads:
        def execute(self, *a, **kw):
            pytest.fail("shared cut looked up a provider")

    schema = TableSchema.from_columns([("service_date", "date", True)], ["service_date"])
    spec = WindowSpec(
        "gold.network_vehicle_day", "_shared", "2026-11", 2, cut_utc="2026-11-15T09:00:00+00:00"
    )
    assert resolve_cut_spec(NoReads(), spec, schema).date_bound == "2026-11-14"


def test_reserve_is_rechecked_after_transaction_setup(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from datetime import UTC, datetime, timedelta
    from types import SimpleNamespace

    from transit_ops.lake import table_export
    from transit_ops.lake.alert_bundle import MEMBERS
    from transit_ops.lake.table_export import WindowSpec

    clock = [datetime(2026, 11, 15, 18, tzinfo=UTC)]

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0]

    class Recording:
        autocommit = True
        info = SimpleNamespace(transaction_status=0)

        def transaction(self):
            return nullcontext()

        def execute(self, statement, values=None):
            if str(statement).startswith("SET TRANSACTION"):
                clock[0] += timedelta(seconds=2)
                return None
            pytest.fail("snapshot-taking SELECT dispatched after reserve expired")

    monkeypatch.setattr(table_export, "datetime", Clock)
    specs = tuple(
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    )
    with pytest.raises(ValueError, match="not_after"):
        with table_export.export_group(
            Recording(),
            specs,
            tuple(tmp_path / f"{i}.csv" for i in range(3)),
            statement_timeout_s=60,
            not_after=clock[0] + timedelta(seconds=5001),
            group_reserve_s=5000,
        ):
            pytest.fail("snapshot started")
