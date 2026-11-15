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
    bounds = (date(2026, 5, 25), date(2026, 11, 14))
    queries = []
    nullable = False

    def transaction(self):
        return nullcontext()

    def execute(self, query, values=None):
        query = query.as_string() if hasattr(query, "as_string") else str(query)
        self.queries.append((query, values))
        if "pg_try_advisory_lock" in query or "pg_advisory_unlock" in query:
            return SimpleNamespace(fetchone=lambda: (True,))
        if "current_database()" in query:
            return SimpleNamespace(fetchone=lambda: ("transit_ci", "transit_ci", "127.0.0.1"))
        if "FROM core.providers" in query:
            return SimpleNamespace(fetchall=lambda: [("p",)])
        if "SELECT EXISTS" in query:
            return SimpleNamespace(fetchone=lambda: ("IS NULL" not in query,))
        if "DISTINCT" in query:
            return SimpleNamespace(fetchall=lambda: [("p", 0)])
        if "min(" in query:
            return SimpleNamespace(
                fetchone=lambda: (*self.bounds, 0) if "count(" in query else self.bounds
            )
        return SimpleNamespace(fetchall=lambda: [])


@pytest.fixture
def planning(monkeypatch):
    from transit_ops.history.datasets import TableSource, get_dataset
    from transit_ops.lake import migration as m
    from transit_ops.lake.catalog import CatalogTable
    from transit_ops.lake.inventory import Inventory
    from transit_ops.lake.table_schema import Column

    def run(names=("gold.route_delay_spine",), **kw):
        catalog = []
        for n in names:
            columns = [] if n == "gold.report_labels" else [Column("provider_id", "text", True)]
            if n != "silver.rt_entities":
                source = get_dataset(n).source
                if isinstance(source, TableSource) and source.window_column:
                    columns.append(Column(source.window_column, "date", not Source.nullable))
            catalog.append(CatalogTable(n, "table", tuple(columns), ()))
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
    monkeypatch.setattr(Source, "nullable", True)

    def with_missing(self, query, values=None):
        if "IS NULL" in str(query):
            return SimpleNamespace(fetchone=lambda: (True,))
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
        "--storage",
        "local",
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
    records = [json.loads(line) for line in path.read_text().splitlines()]
    header = json.loads(result.stdout.splitlines()[0])
    summary = json.loads(result.stdout.splitlines()[-1])
    assert records == [
        {
            "outcome": "copied",
            "rows": 2,
            "storage_backend": "local",
            "storage_location": header["storage_location"],
        }
    ]
    assert summary["storage_backend"] == "local"
    assert header["storage_backend"] == "local"
    assert header["database_url"] == "postgresql://unused/unused"
    assert header["database"] == "transit_ci"
    assert header["user"] == "transit_ci"
    assert header["server_addr"] == "127.0.0.1"
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


@pytest.mark.parametrize(
    "hour,minute,planned,explicit_date", [(5, 59, 0, False), (6, 0, 1, False), (6, 0, 0, True)]
)
def test_command_fact_day_uses_current_utc_cutoff(
    planning, monkeypatch, tmp_path, hour, minute, planned, explicit_date
):
    import datetime as dt
    import json

    from typer.testing import CliRunner

    from transit_ops.cli import app
    from transit_ops.settings import Settings

    planning(("gold.fact_vehicle_snapshot",))

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, 15, hour, minute, tzinfo=UTC)

    monkeypatch.setattr(dt, "datetime", Clock)
    monkeypatch.setattr(Source, "bounds", (date(2026, 11, 14), date(2026, 11, 14)))
    monkeypatch.setattr("psycopg.connect", lambda *a, **kw: nullcontext(Source()))
    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: Settings(DATABASE_URL="postgresql://unused/unused", _env_file=None),
    )
    result = CliRunner().invoke(
        app,
        [
            "lake",
            "migrate",
            "--statement-timeout-s",
            "60",
            "--dataset",
            "gold.fact_vehicle_snapshot",
            "--work-dir",
            str(tmp_path),
            "--copied-by",
            "a" * 40,
        ]
        + (["--today", "2026-11-15"] if explicit_date else []),
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout.splitlines()[-1])["planned"] == planned


def test_not_null_fact_planning_uses_only_index_answerable_bounds(planning):
    Source.queries = []
    planning(("gold.fact_vehicle_snapshot",))
    queries = [q for q, _ in Source.queries if "gold" in q and "fact_vehicle_snapshot" in q]
    assert any("min(" in q and "max(" in q for q in queries)
    assert all("count(" not in q.lower() and "distinct" not in q.lower() for q in queries)
    assert not any("IS NULL" in q for q in queries)


def test_plan_total_budget_refuses_between_statements(planning, monkeypatch):
    from transit_ops.lake import migration as m

    ticks = iter([0, 10000, 10000, 10000])
    monkeypatch.setattr(m, "monotonic", lambda: next(ticks, 10000))
    with pytest.raises(m.MigrationRefused, match="plan_budget"):
        planning(plan_budget_s=1)


def test_window_read_reserve_refuses_before_connect(tmp_path, monkeypatch):
    from datetime import timedelta

    from transit_ops.lake import migration as m

    now = datetime(2026, 11, 15, 5, 44, tzinfo=UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(m, "datetime", Clock)
    plan = MigrationPlan(
        SimpleNamespace(complete=True),
        (PlannedWindow(WindowSpec("gold.report_labels", "_shared", "2026-11"), "whole_state"),),
        (),
    )

    def connect():
        pytest.fail("insufficient read reserve must refuse before connecting")

    result = run_migration(
        plan,
        connect,
        None,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=now + timedelta(seconds=120),
        log=lambda r: None,
    )
    assert result.failure["reason"] == "not_after"


def test_execute_local_backend_requires_explicit_opt_in(monkeypatch, tmp_path):
    from typer.testing import CliRunner

    from transit_ops.cli import app
    from transit_ops.settings import Settings

    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: Settings(DATABASE_URL="postgresql://unused/unused", _env_file=None),
    )
    monkeypatch.setattr(
        "psycopg.connect", lambda *a, **kw: pytest.fail("must refuse before planning")
    )
    result = CliRunner().invoke(
        app,
        [
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
        ],
    )
    assert result.exit_code == 1
    assert "--storage local" in result.output


def test_work_space_floor_refuses_before_connect(tmp_path, monkeypatch):

    monkeypatch.setattr("shutil.disk_usage", lambda p: SimpleNamespace(free=0))
    plan = MigrationPlan(
        SimpleNamespace(complete=True),
        (PlannedWindow(WindowSpec("gold.report_labels", "_shared", "2026-11"), "whole_state"),),
        (),
    )
    result = run_migration(
        plan,
        lambda: pytest.fail("disk full"),
        None,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2099, 1, 1, tzinfo=UTC),
        log=lambda r: None,
    )
    assert result.failure["reason"] == "work_space"


def test_command_rechecks_read_deadline_after_planning(planning, monkeypatch, tmp_path):
    import datetime as dt

    from typer.testing import CliRunner

    from transit_ops.cli import app
    from transit_ops.lake import migration as m
    from transit_ops.settings import Settings

    planned = planning()
    clock = [datetime(2026, 11, 15, 5, 30, tzinfo=UTC)]
    deadline = datetime(2026, 11, 15, 5, 45, tzinfo=UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock[0]

    monkeypatch.setattr(dt, "datetime", Clock)
    monkeypatch.setattr(m, "datetime", Clock)

    def plan(*a, **kw):
        assert kw["not_after"] == deadline
        clock[0] = datetime(2026, 11, 15, 5, 44, tzinfo=UTC)
        return planned

    monkeypatch.setattr(m, "plan_migration", plan)
    monkeypatch.setattr("psycopg.connect", lambda *a, **kw: nullcontext(Source()))
    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: Settings(
            DATABASE_URL="postgresql://unused/unused",
            BRONZE_STORAGE_BACKEND="s3",
            BRONZE_S3_BUCKET="test-archive",
            _env_file=None,
        ),
    )
    monkeypatch.setattr(
        "transit_ops.history.storage.history_storage",
        lambda *a: pytest.fail("must refuse before starting execution"),
    )
    result = CliRunner().invoke(
        app,
        [
            "lake",
            "migrate",
            "--execute",
            "--not-after",
            deadline.isoformat(),
            "--statement-timeout-s",
            "60",
            "--work-dir",
            str(tmp_path),
            "--copied-by",
            "a" * 40,
        ],
    )
    assert result.exit_code == 1
    assert "insufficient reserve" in result.output
    assert not list(tmp_path.iterdir())
