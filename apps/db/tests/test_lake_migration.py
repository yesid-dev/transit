from contextlib import nullcontext
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest

from transit_ops.lake.migration import (
    MigrationPlan,
    PlannedWindow,
    plan_migration,
    run_migration,
)
from transit_ops.lake.table_export import WindowSpec


class Source:
    autocommit = True
    info = SimpleNamespace(transaction_status=0)

    def transaction(self):
        return nullcontext()

    def execute(self, query, values=None):
        query = str(query)
        if "DISTINCT" in query:
            return SimpleNamespace(fetchall=lambda: [("p", 0)])
        if "min(" in query:
            return SimpleNamespace(fetchone=lambda: (date(2026, 5, 25), date(2026, 11, 14), 0))
        return SimpleNamespace(fetchall=lambda: [])


@pytest.fixture
def planning(monkeypatch):
    from transit_ops.lake import migration as m
    from transit_ops.lake.catalog import CatalogTable
    from transit_ops.lake.inventory import Inventory
    from transit_ops.lake.table_schema import Column

    def run(names=("gold.route_delay_spine",), **kw):
        catalog = [
            CatalogTable(
                n,
                "table",
                () if n == "gold.report_labels" else (Column("provider_id", "text", True),),
                (),
            )
            for n in names
        ]
        copied = tuple(n for n in names if n != "silver.rt_entities")
        monkeypatch.setattr(m, "read_catalog", lambda c: catalog)
        monkeypatch.setattr(
            m, "take_inventory", lambda c: Inventory(copied, (), (), (), (), (), (), ())
        )
        return plan_migration(
            Source(),
            today_utc=date(2026, 11, 15),
            include_open=kw.pop("include_open", False),
            datasets=kw.pop("datasets", None),
            providers=kw.pop("providers", None),
            statement_timeout_s=60,
            **kw,
        )

    return run


def test_month_windows_run_from_first_row_to_last_closed_month(planning):
    plan = planning()
    assert [w.spec.window_key for w in plan.windows] == [
        "2026-05",
        "2026-06",
        "2026-07",
        "2026-08",
        "2026-09",
        "2026-10",
    ]
    assert [w.window_key for w in plan.skipped_open] == ["2026-11"]


def test_include_open_adds_the_current_month(planning):
    assert planning(include_open=True).windows[-1].reason == "open_included"


def test_fact_days_close_six_hours_after_their_end(planning):
    names = ("gold.fact_vehicle_snapshot",)
    before = planning(names, now_utc=datetime(2026, 11, 15, 5, 59, tzinfo=UTC))
    after = planning(names, now_utc=datetime(2026, 11, 15, 6, tzinfo=UTC))
    assert before.skipped_open[-1].window_key == "2026-11-14"
    assert after.windows[-1].spec.window_key == "2026-11-14"
    assert after.skipped_open == ()


def test_whole_state_tables_are_one_window_in_the_current_month(planning):
    result = planning(("gold.report_labels",))
    assert result.windows == (
        PlannedWindow(WindowSpec("gold.report_labels", "_shared", "2026-11"), "whole_state"),
    )


def test_working_only_tables_are_never_planned(planning):
    assert planning(("silver.rt_entities",)).windows == ()


def test_plan_order_is_whole_state_then_months_oldest_first_then_editions_then_facts(
    planning,
    monkeypatch,
):
    from transit_ops.lake import migration as m

    monkeypatch.setattr(m, "_editions", lambda *a: ["b" * 64])
    result = planning(
        (
            "gold.fact_vehicle_snapshot",
            "silver.routes",
            "gold.route_delay_spine",
            "gold.report_labels",
        )
    )
    ids = [w.spec.dataset_id for w in result.windows]
    assert ids[0] == "gold.report_labels"
    assert ids[1:7] == ["gold.route_delay_spine"] * 6
    assert ids[7] == "silver.routes"
    assert set(ids[8:]) == {"gold.fact_vehicle_snapshot"}


def test_dataset_filter_can_leave_a_dataset_out_by_name(planning):
    result = planning(
        ("gold.alert_archive_entry", "gold.report_labels"), datasets=["gold.report_labels"]
    )
    assert [w.spec.dataset_id for w in result.windows] == ["gold.report_labels"]


def test_missing_window_refuses_instead_of_omitting_rows(planning, monkeypatch):
    from transit_ops.lake.migration import MigrationRefused

    execute = Source.execute

    def with_missing(self, query, values=None):
        if "min(" in str(query):
            return SimpleNamespace(fetchone=lambda: (date(2026, 5, 25), date(2026, 11, 14), 1))
        return execute(self, query, values)

    monkeypatch.setattr(Source, "execute", with_missing)
    with pytest.raises(MigrationRefused, match="missing_window"):
        planning()


@pytest.mark.parametrize("deadline", [None, "2099-01-01T00:00:00", "2099-01-01T00:00:00+01:00"])
def test_execute_requires_an_aware_utc_deadline(deadline, tmp_path):
    from typer.testing import CliRunner

    from transit_ops.cli import app

    args = [
        "lake",
        "migrate",
        "--execute",
        "--statement-timeout-s",
        "60",
        "--work-dir",
        str(tmp_path),
        "--copied-by",
        "a" * 40,
    ]
    if deadline:
        args.extend(["--not-after", deadline])
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 1
    assert "aware UTC" in result.output
    assert not list(tmp_path.iterdir())


def test_command_default_plans_without_storage_or_files(planning, monkeypatch, tmp_path):
    from typer.testing import CliRunner

    from transit_ops.cli import app
    from transit_ops.lake import migration as m
    from transit_ops.settings import Settings

    plan = planning()
    monkeypatch.setattr(m, "plan_migration", lambda *a, **kw: plan)
    monkeypatch.setattr("psycopg.connect", lambda *a, **kw: nullcontext(Source()))
    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: Settings(DATABASE_URL="postgresql://unused/unused", _env_file=None),
    )

    def refuse(*a):
        raise AssertionError("storage must not be resolved")

    monkeypatch.setattr("transit_ops.history.storage.history_storage", refuse)
    result = CliRunner().invoke(
        app,
        [
            "lake",
            "migrate",
            "--statement-timeout-s",
            "60",
            "--work-dir",
            str(tmp_path / "absent"),
            "--copied-by",
            "a" * 40,
        ],
    )
    assert result.exit_code == 0, result.output
    assert '"planned": 6' in result.output
    assert not list(tmp_path.iterdir())


def test_execute_writes_create_only_json_log(planning, monkeypatch, tmp_path):
    import json

    from typer.testing import CliRunner

    from transit_ops.cli import app
    from transit_ops.lake import migration as m
    from transit_ops.settings import Settings

    planned = planning()
    monkeypatch.setattr(m, "plan_migration", lambda *a, **kw: planned)
    monkeypatch.setattr("psycopg.connect", lambda *a, **kw: nullcontext(Source()))
    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: Settings(DATABASE_URL="postgresql://unused/unused", _env_file=None),
    )
    scopes = []
    scope = SimpleNamespace(resolve=lambda backend: object(), close=lambda: None)

    def storage(settings):
        scopes.append(scope)
        return scope

    monkeypatch.setattr("transit_ops.history.storage.history_storage", storage)

    def run(*args, **kwargs):
        kwargs["log"]({"outcome": "copied", "rows": 2})
        return m.MigrationSummary({"month": {"copied": 1}}, None)

    monkeypatch.setattr(m, "run_migration", run)
    args = [
        "lake",
        "migrate",
        "--execute",
        "--not-after",
        "2099-01-01T00:00:00Z",
        "--statement-timeout-s",
        "60",
        "--work-dir",
        str(tmp_path),
        "--copied-by",
        "a" * 40,
    ]
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 0, result.output
    path = tmp_path / "migration-log.jsonl"
    assert [json.loads(line) for line in path.read_text().splitlines()] == [
        {"outcome": "copied", "rows": 2}
    ]
    original = path.read_bytes()
    assert CliRunner().invoke(app, args).exit_code == 1
    assert path.read_bytes() == original
    assert scopes == [scope]


def test_run_stops_at_first_failure_and_never_starts_after_not_after(tmp_path, monkeypatch):
    from transit_ops.lake import migration as m

    windows = tuple(
        PlannedWindow(WindowSpec("gold.report_labels", "_shared", month), "whole_state")
        for month in ("2026-09", "2026-10", "2026-11")
    )
    plan = MigrationPlan(SimpleNamespace(complete=True), windows, ())
    calls, logs = [], []

    def copy(connection, storage, spec, **kw):
        calls.append(spec)
        if len(calls) == 2:
            raise ValueError("broken")
        return SimpleNamespace(
            outcome="copied",
            rows=4,
            content_sha256="a" * 64,
            proof=SimpleNamespace(object_sha256="b" * 64),
        )

    monkeypatch.setattr(m, "copy_table_window", copy)
    summary = run_migration(
        plan,
        lambda: nullcontext(),
        None,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2099, 1, 1, tzinfo=UTC),
        log=logs.append,
    )
    assert calls == [w.spec for w in windows[:2]]
    assert summary.failure["spec"] == windows[1].spec.__dict__
    assert [r["outcome"] for r in logs] == ["copied", "failed"]
    calls.clear()
    summary = run_migration(
        plan,
        lambda: nullcontext(),
        None,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2000, 1, 1, tzinfo=UTC),
        log=logs.append,
    )
    assert not calls
    assert summary.failure["reason"] == "not_after"


def test_rerun_reports_already_copied_and_copies_nothing(tmp_path, monkeypatch):
    from transit_ops.lake import migration as m

    plan = MigrationPlan(
        SimpleNamespace(complete=True),
        (PlannedWindow(WindowSpec("gold.report_labels", "_shared", "2026-11"), "whole_state"),),
        (),
    )
    monkeypatch.setattr(
        m,
        "copy_table_window",
        lambda *a, **kw: SimpleNamespace(
            outcome="already_copied",
            rows=1,
            content_sha256="a" * 64,
            proof=SimpleNamespace(object_sha256="b" * 64),
        ),
    )
    summary = run_migration(
        plan,
        lambda: nullcontext(),
        None,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2099, 1, 1, tzinfo=UTC),
        log=lambda r: None,
    )
    assert summary.outcomes == {"whole_state": {"already_copied": 1}}
    assert summary.failure is None
