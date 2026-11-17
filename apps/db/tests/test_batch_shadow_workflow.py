"""Scheduled shadow controller contracts at its plan and evidence boundaries."""

import json
import runpy
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / ".github/scripts/batch-shadow.py"


@pytest.fixture
def controller(tmp_path, monkeypatch):
    namespace = runpy.run_path(str(SCRIPT))
    globals_ = namespace["main"].__globals__
    monkeypatch.setitem(globals_, "ROOT", tmp_path)
    monkeypatch.setenv("TRANSIT_REPLAY_DATABASE_URL", "postgresql://disposable/db")
    return globals_


def test_schedule_keeps_alert_coverage_separate_from_yesterdays_facts():
    controller = runpy.run_path(str(SCRIPT))
    stamp = datetime(2026, 11, 2, 7, tzinfo=UTC)
    assert controller["target_day"](stamp, "America/Toronto", False, "") == "2026-11-01"
    assert controller["target_day"](stamp, "America/Toronto", True, "") == "2026-10-31"
    with pytest.raises(ValueError, match="bundle_coverage"):
        controller["target_day"](stamp, "America/Toronto", True, "2026-11-01")


def test_fetch_can_pin_timezone_without_loading_transitioning_declarations(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from transit_ops.batch import input_sources
    from transit_ops.commands import batch
    from transit_ops.history import storage

    class Scope:
        def resolve(self, backend):
            return object()

        def close(self):
            pass

    seen = []
    import duckdb

    folder = tmp_path / "core.providers"
    folder.mkdir()
    with duckdb.connect() as conn:
        conn.execute(
            "COPY (SELECT 'stm' provider_id, 'America/Toronto' timezone) TO ? (FORMAT parquet)",
            [str(folder / "all.parquet")],
        )
    monkeypatch.setattr(storage, "history_storage", lambda settings: Scope())
    monkeypatch.setattr(
        input_sources,
        "fetch_from_catalog",
        lambda store, root, request, builders: seen.append(request) or {},
    )
    response = CliRunner().invoke(
        batch.app,
        [
            "fetch-inputs",
            "--provider",
            "stm",
            "--date",
            "2026-11-01",
            "--as-of",
            "2026-11-02T07:00:00Z",
            "--inputs",
            str(tmp_path),
            "--family",
            "occupancy_crowding",
            "--timezone",
            "America/Toronto",
        ],
    )
    assert response.exit_code == 0, response.output
    assert seen[0].timezone == "America/Toronto"


@pytest.mark.parametrize(
    "stamp,day",
    [
        ("2026-03-09T07:00:00Z", "2026-03-08"),
        ("2026-11-02T11:00:00Z", "2026-11-01"),
    ],
)
def test_dst_day_coverage_uses_local_midnights(controller, stamp, day):
    assert (
        controller["target_day"](datetime.fromisoformat(stamp), "America/Toronto", False, "") == day
    )
    if "11:00" in stamp:
        assert (
            controller["target_day"](datetime.fromisoformat(stamp), "America/Toronto", True, "")
            == day
        )


def test_missing_provisioning_lists_every_name(controller, monkeypatch):
    for name in (
        "BATCH_SHADOW_PROVISIONED",
        "DATABASE_URL",
        "BRONZE_S3_ACCESS_KEY",
        "BRONZE_S3_SECRET_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError, match="provisioning_missing") as failure:
        controller["require_configuration"](True)
    assert all(
        name in str(failure.value)
        for name in ("DATABASE_URL", "BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY", "batch-shadow")
    )


@pytest.fixture
def manual_archive(controller, monkeypatch):
    for name, value in {
        "BATCH_SHADOW_PROVISIONED": "false",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_REF": "refs/heads/main",
        "GITHUB_SHA": "a" * 40,
        "INPUT_MODE": "archive",
        "PROVIDERS": "stm",
        "DAY": "2026-11-12",
        "FAMILIES": "occupancy_crowding",
        "AS_OF": "2026-11-13T07:00:00Z",
        "BRONZE_S3_ACCESS_KEY": "fixture-key",
        "BRONZE_S3_SECRET_KEY": "fixture-secret",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    return controller


def test_explicit_main_archive_dispatch_keeps_automation_disabled(manual_archive, monkeypatch):
    from contextlib import contextmanager

    from transit_ops.batch import input_sources

    @contextmanager
    def catalog():
        yield SimpleNamespace(get_foreign_keys=lambda *a, **kw: [])

    monkeypatch.setattr(input_sources, "replay_catalog", catalog)
    manual_archive["main"]("plan")
    planned = json.loads((manual_archive["ROOT"] / "daily-inputs.json").read_bytes())
    assert planned["matrix"] == [
        {
            "provider": "stm",
            "day": "2026-11-12",
            "families": ["occupancy_crowding"],
            "alerts": False,
            "timezone": "America/Toronto",
        }
    ]
    assert planned["input_mode"] == "archive"
    assert planned["planned_at"] == "2026-11-13T07:00:00+00:00"
    manual_archive["require_configuration"]()
    assert manual_archive["os"].environ["BATCH_SHADOW_PROVISIONED"] == "false"
    assert "DATABASE_URL" not in manual_archive["os"].environ


@pytest.mark.parametrize(
    "name,value",
    [
        ("BATCH_SHADOW_PROVISIONED", ""),
        ("BATCH_SHADOW_PROVISIONED", "FALSE"),
        ("BATCH_SHADOW_PROVISIONED", "disabled"),
        ("GITHUB_EVENT_NAME", "workflow_run"),
        ("GITHUB_EVENT_NAME", "pull_request_target"),
        ("GITHUB_EVENT_NAME", ""),
        ("GITHUB_REF", "refs/heads/other"),
        ("GITHUB_REF", "refs/tags/main"),
        ("GITHUB_REF", ""),
        ("INPUT_MODE", "export"),
        ("INPUT_MODE", ""),
        ("PROVIDERS", ""),
        ("PROVIDERS", "stm,stm"),
        ("PROVIDERS", "stm,"),
        ("PROVIDERS", "*"),
        ("FAMILIES", ""),
        ("FAMILIES", "occupancy_crowding, occupancy_crowding"),
        ("FAMILIES", "*"),
        ("DAY", ""),
        ("DAY", "20261112"),
        ("DAY", "2026-02-30"),
        ("AS_OF", ""),
        ("AS_OF", "not-an-instant"),
        ("AS_OF", "2026-11-13T07:00:00"),
        ("AS_OF", "2026-11-13T07:00:00+01:00"),
        ("AS_OF", "9999-11-13T07:00:00Z"),
    ],
)
def test_disabled_automation_refuses_unbounded_or_untrusted_dispatch(
    manual_archive, monkeypatch, name, value
):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match="provisioning_missing"):
        manual_archive["require_configuration"]()


@pytest.mark.parametrize("name", ["BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"])
def test_manual_archive_still_requires_each_storage_credential(manual_archive, monkeypatch, name):
    monkeypatch.delenv(name)
    with pytest.raises(ValueError, match=name):
        manual_archive["require_configuration"]()
    # Plan/replay intentionally run without storage credentials in their own steps.
    manual_archive["require_configuration"](storage=False)


def test_manual_archive_cannot_enter_production_export(manual_archive, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://fixture/db")
    with pytest.raises(ValueError, match="provisioning_missing"):
        manual_archive["export_inputs"]({})


def test_plan_connection_failure_keeps_only_public_category_and_stage(
    manual_archive, tmp_path, monkeypatch, capsys
):
    from sqlalchemy.exc import OperationalError

    monkeypatch.setenv("PGSERVICEFILE", "private-service-file")

    def fail_at_connection(stamp):
        assert manual_archive["os"].environ["PGSERVICEFILE"] == "private-service-file"
        raise OperationalError(
            "private statement",
            {"key": "private parameter"},
            RuntimeError("private service or URL"),
        )

    monkeypatch.setitem(manual_archive, "plan", fail_at_connection)
    assert manual_archive["run_stage"]("plan") == 1
    assert json.loads((tmp_path / "public/refusal.json").read_bytes()) == {
        "refusal": "database_operational_error",
        "stage": "plan",
    }
    output = capsys.readouterr()
    assert output.err.strip() == "database_operational_error" and output.out == ""


@pytest.mark.parametrize("name", ["PROVIDERS", "FAMILIES"])
def test_manual_archive_plan_rejects_unknown_selection(manual_archive, monkeypatch, name):
    from contextlib import contextmanager

    from transit_ops.batch import input_sources

    @contextmanager
    def catalog():
        yield SimpleNamespace(get_foreign_keys=lambda *a, **kw: [])

    monkeypatch.setattr(input_sources, "replay_catalog", catalog)
    monkeypatch.setenv(name, "unknown")
    with pytest.raises(ValueError, match="invalid_selection"):
        manual_archive["main"]("plan")
    assert not (manual_archive["ROOT"] / "daily-inputs.json").exists()


def test_export_asserts_read_only_and_uses_locked_cli_all_provider(controller, monkeypatch):
    import psycopg

    from transit_ops.batch import daily_inputs

    for name in ("DATABASE_URL", "BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"):
        monkeypatch.setenv(name, "postgresql://example/db" if name == "DATABASE_URL" else "key")
    monkeypatch.setenv("BATCH_SHADOW_PROVISIONED", "true")
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=25_000_000_000)
    )
    queries, connections, commands = [], [], []

    class Connection:
        readonly = "on"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, query, params=None):
            queries.append(query)
            return SimpleNamespace(
                fetchone=lambda: (
                    (self.readonly,) if query.startswith("SHOW") else (False,) if params else (3,)
                )
            )

    def connect(*args, **kwargs):
        connections.append(kwargs)
        return Connection()

    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setattr(daily_inputs, "require_window_support", lambda *a: None)
    monkeypatch.setattr(daily_inputs, "require_group_reserve_support", lambda: None)
    monkeypatch.setattr(
        daily_inputs,
        "exact_windows",
        lambda *a: ("core.providers:stm:2026-11", "silver.i3_alerts:stm:2026-11"),
    )
    monkeypatch.setitem(controller, "invoke", lambda args, receipt: commands.append(args))
    data = {"code_commit": "a" * 40, "needs": [], "planned_at": "2026-11-15T12:00:00Z"}
    start = datetime.now(UTC)
    controller["export_inputs"](data)
    assert len(commands) == 2
    args = commands[1]
    assert args[:3] == ["lake", "migrate", "--execute"]
    assert "--include-open" in args and "--provider" not in args
    assert args[args.index("--statement-timeout-s") + 1] == "300"
    assert args.count("--window") == 1
    assert args[args.index("--group-reserve-s") + 1] == "4500"
    deadline = datetime.fromisoformat(args[args.index("--not-after") + 1])
    assert (deadline - start).total_seconds() >= 4500  # (2*3+7)*300+600
    assert queries[0] == "SHOW transaction_read_only"
    assert any("pg_has_role" in q and "has_table_privilege" in q for q in queries)
    assert queries[-1] == "SELECT count(*) FROM core.providers"
    assert "default_transaction_read_only=on" in connections[0]["options"]
    assert "lock_timeout=1000" in connections[0]["options"]
    free = iter((25_000_000_000, 25_000_000_000, 15_000_000_000))
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=next(free))
    )
    commands.clear()
    with pytest.raises(ValueError, match="work_space"):
        controller["export_inputs"](data)
    assert len(commands) == 1  # Stop between invocations, before the alert snapshot.
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=25_000_000_000)
    )
    Connection.readonly = "off"
    commands.clear()
    with pytest.raises(ValueError, match="not_read_only"):
        controller["export_inputs"](data)
    assert commands == []


def test_ordinary_open_export_refuses_without_group_reserve_capability(controller, monkeypatch):
    import psycopg
    from test_batch_daily_inputs import fake_lake_cli

    fake_lake_cli(monkeypatch, cuts=True, reserve=False)
    for name in ("BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"):
        monkeypatch.setenv(name, "test")
    monkeypatch.setenv("BATCH_SHADOW_PROVISIONED", "true")
    monkeypatch.setenv("DATABASE_URL", "postgresql://readonly@example/db")
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=25_000_000_000)
    )
    calls = []

    def connect(*args, **kwargs):
        calls.append("connect")
        raise AssertionError("partial lake must refuse before production access")

    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setitem(controller, "invoke", lambda *a, **kw: calls.append("export"))
    data = {
        "code_commit": "a" * 40,
        "planned_at": "2026-11-15T12:00:00Z",
        "needs": [
            {"relation": "raw.realtime_snapshot_index", "provider": "stm", "window": "2026-11-14"}
        ],
    }
    with pytest.raises(ValueError, match="open_window_unsupported|group_reserve_unsupported"):
        controller["export_inputs"](data)
    assert calls == []


def test_session_lock_refusal_is_named_and_credentials_are_redacted(
    controller, monkeypatch, tmp_path
):
    monkeypatch.setenv("DATABASE_URL", "postgresql://role:password@host/db")
    monkeypatch.setattr(
        controller["subprocess"],
        "run",
        lambda *a, **kw: SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="migration_running password postgresql://role:password@host/db",
        ),
    )
    path = tmp_path / "command.log"
    with pytest.raises(ValueError, match="migration_running"):
        controller["invoke"](["lake", "migrate"], path)
    assert "migration_running" in path.read_text()
    assert "password" not in path.read_text()


def report_seed():
    from test_batch_checkpoints import replay, result

    from transit_ops.batch.replay_report import ReplayReport

    build = result()
    report = ReplayReport(
        "sample",
        build.manifest.local_dates[0],
        build.manifest.as_of_utc,
        "a" * 40,
        families=(replay(build),),
    )
    row = {
        "provider": "sample",
        "day": "2026-11-12",
        "families": ["sample_family"],
        "timezone": "UTC",
    }
    return json.loads(report.to_json()), row


@pytest.mark.parametrize(
    "damage",
    [
        "not_compared",
        "not_implemented",
        "different",
        "missing",
        "duplicate",
        "digest",
        "commit",
        "provider",
    ],
)
def test_zero_exit_is_not_complete_evidence(controller, damage):
    report, row = report_seed()
    if damage in {"not_compared", "not_implemented", "different"}:
        report["families"][0]["status"] = damage
    elif damage == "missing":
        report["families"] = []
    elif damage == "duplicate":
        report["families"] *= 2
    elif damage == "digest":
        report["families"][0]["output_digests"] = None
    elif damage == "commit":
        report["families"][0]["code_commit"] = "b" * 40
    else:
        report["provider_id"] = "other"
    with pytest.raises(ValueError, match="incomplete_replay"):
        controller["gate"](report, row, report["as_of_utc"], "a" * 40)


def test_normalization_keeps_raw_digest_evidence(controller):
    report, row = report_seed()
    report["families"][0]["status"] = "identical_after_normalization"
    before = deepcopy(report)
    controller["gate"](report, row, report["as_of_utc"], "a" * 40)
    assert report == before


def test_bad_output_digest_refuses_before_shadow(controller):
    report, row = report_seed()
    report["families"][0]["output_digests"]["tables"]["gold.sample"]["sha256"] = "bad"
    with pytest.raises(ValueError, match="invalid output digest"):
        controller["gate"](report, row, report["as_of_utc"], "a" * 40)


def test_plan_freezes_builders_and_groups_fact_and_alert_days(controller, monkeypatch):
    from contextlib import contextmanager

    from transit_ops.batch import input_sources

    @contextmanager
    def catalog():
        yield SimpleNamespace(get_foreign_keys=lambda *a, **kw: [])

    monkeypatch.setattr(input_sources, "replay_catalog", catalog)
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setenv("PROVIDERS", "stm")
    monkeypatch.setenv("FAMILIES", "occupancy_crowding,receipts")
    monkeypatch.delenv("DAY", raising=False)
    planned = controller["plan"](datetime(2026, 11, 2, 7, tzinfo=UTC))
    assert [(row["day"], row["families"]) for row in planned["matrix"]] == [
        ("2026-11-01", ["occupancy_crowding"]),
        ("2026-10-31", ["receipts"]),
    ]
    assert "core.providers" in planned["datasets"]
    assert "silver.i3_alerts" in planned["datasets"]
    assert "gold.fact_vehicle_snapshot" in planned["datasets"]


def test_default_plan_reports_unsupported_real_families(controller, monkeypatch):
    from contextlib import contextmanager

    from transit_ops.batch import input_sources

    @contextmanager
    def catalog():
        yield SimpleNamespace(get_foreign_keys=lambda *a, **kw: [])

    monkeypatch.setattr(input_sources, "replay_catalog", catalog)
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setenv("PROVIDERS", "stm")
    monkeypatch.delenv("FAMILIES", raising=False)
    planned = controller["plan"](datetime(2026, 11, 15, 12, tzinfo=UTC))
    assert any(
        r["family"] == "route_spine_hours" and "input_not_archived" in r["reason"]
        for r in planned["family_refusals"]
    )
    assert all("route_spine_hours" not in r["families"] for r in planned["matrix"])
    selected = {family for row in planned["matrix"] for family in row["families"]}
    assert {"occupancy_crowding", "receipts"} <= selected
    monkeypatch.setenv("FAMILIES", "route_spine_hours")
    with pytest.raises(ValueError, match="input_not_archived: route_spine_hours"):
        controller["plan"](datetime(2026, 11, 15, 12, tzinfo=UTC))


def test_replay_failure_prevents_any_shadow_command(controller, monkeypatch, tmp_path):
    report, row = report_seed()
    report["families"][0]["status"] = "not_compared"
    commands = []
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda p: SimpleNamespace(free=25_000_000_000)
    )

    def invoke(args, path, **kwargs):
        commands.append(args)
        if args[1] == "replay-day":
            controller["write_json"](tmp_path / "0/replay/report-sample-2026-11-12.json", report)

    monkeypatch.setitem(controller, "invoke", invoke)
    with pytest.raises(ValueError, match="incomplete_replay"):
        controller["run_row"](row, 0, report["as_of_utc"], "a" * 40)
    assert [args[1] for args in commands] == ["fetch-inputs", "replay-day"]
    assert not (tmp_path / "0/complete.json").exists()


def test_shadow_edition_query_targets_frozen_disposable_database(controller, monkeypatch, tmp_path):
    report, row = report_seed()
    calls = []
    monkeypatch.setenv("TRANSIT_REPLAY_DATABASE_URL", "postgresql://frozen/db")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda p: SimpleNamespace(free=25_000_000_000)
    )

    def invoke(args, receipt, **kwargs):
        calls.append((args, kwargs))
        if args[1] == "replay-day":
            controller["write_json"](tmp_path / "0/replay/report-sample-2026-11-12.json", report)

    monkeypatch.setitem(controller, "invoke", invoke)
    controller["run_row"](row, 0, report["as_of_utc"], "a" * 40)
    assert calls[-1][0][1] == "shadow-build"
    assert calls[-1][1]["env"]["DATABASE_URL"] == "postgresql://frozen/db"
    assert json.loads((tmp_path / "0/complete.json").read_bytes())["accepted"] is True


def test_workflow_confines_production_secret_and_preserves_evidence():
    import yaml

    path = SCRIPT.parents[1] / "workflows/batch-shadow.yml"
    workflow = yaml.safe_load(path.read_text())
    events = workflow.get("on", workflow.get(True))
    assert "schedule" not in events
    assert events["workflow_run"] == {
        "workflows": ["Daily Warm Rollups"],
        "types": ["completed"],
        "branches": ["main"],
    }
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["concurrency"] == {"group": "batch-shadow", "cancel-in-progress": False}
    job = workflow["jobs"]["shadow"]
    assert job["environment"] == "batch-shadow"
    assert "DATABASE_URL" not in job["env"]
    assert not any("KEY" in key for key in job["env"])
    assert "conclusion == 'success'" in job["if"]
    assert "refs/heads/main" in job["if"]
    manual_guard, automatic_guard = job["if"].split("||", 1)
    assert "BATCH_SHADOW_PROVISIONED" not in manual_guard
    assert automatic_guard.lstrip().startswith("(vars.BATCH_SHADOW_PROVISIONED == 'true' &&")
    assert job["steps"][1]["with"]["ref"] == "${{ github.sha }}"
    for key, input_name in {
        "PROVIDERS": "providers",
        "DAY": "date",
        "FAMILIES": "families",
        "AS_OF": "as_of",
    }.items():
        assert job["env"][key] == "${{ inputs." + input_name + " }}"
    assert job["env"]["INPUT_MODE"] == "${{ inputs.input_mode || 'export' }}"
    exports = [s for s in job["steps"] if "BATCH_SHADOW_DATABASE_URL" in str(s)]
    assert len(exports) == 1
    assert exports[0]["env"]["PGOPTIONS"] == "-c default_transaction_read_only=on"
    assert "secrets.DATABASE_URL" not in path.read_text()
    assert "TRANSIT_REPLAY_DATABASE_URL" in job["steps"][3]["run"]
    secret_steps = [s["name"] for s in job["steps"] if "BATCH_SHADOW_R2" in str(s)]
    assert secret_steps == [
        "Export bounded read-only production inputs",
        "Fetch proven inputs",
        "Accept and write shadow evidence",
    ]
    assert job["steps"][-1]["with"]["path"] == "apps/db/artifacts/batch-shadow/public/**/*.json"
    assert exports[0]["timeout-minutes"] > 12600 / 60
    assert job["steps"][-1]["if"] == "${{ !cancelled() }}"


def test_public_artifacts_drop_connection_details_and_query_secrets(
    controller, monkeypatch, tmp_path
):
    private = {
        "database_url": "postgresql://writer:pw@db.example:6543/live_db?sslpassword=qsecret",
        "database_target": {
            "user": "writer",
            "server_addr": "203.0.113.9",
            "database": "live_db",
            "port": 6543,
        },
        "error": 'connection to server at "203.0.113.9" for user "writer" pw qsecret',
        "spec": {"dataset_id": "core.providers", "provider_id": "stm", "window_key": "2026-11"},
        "outcome": "already_copied",
        "rows": 3,
    }
    monkeypatch.setattr(
        controller["subprocess"],
        "run",
        lambda *a, **kw: SimpleNamespace(
            returncode=1, stdout=json.dumps(private), stderr="not_after"
        ),
    )
    with pytest.raises(ValueError, match="not_after"):
        controller["invoke"](["lake", "migrate"], tmp_path / "export.log")
    artifact = (tmp_path / "public/export.json").read_text()
    assert all(
        secret not in artifact
        for secret in ("db.example", "203.0.113.9", "writer", "live_db", "6543", "pw", "qsecret")
    )
    summary = json.loads(artifact)
    assert summary["records"][0]["rows"] == 3
    assert summary["records"][0]["spec"]["dataset_id"] == "core.providers"
    assert summary["refusal"] == "not_after"


def test_replay_process_receives_no_production_or_storage_credentials(
    controller, monkeypatch, tmp_path
):
    report, row = report_seed()
    for key in (
        "BRONZE_S3_ACCESS_KEY",
        "BRONZE_S3_SECRET_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "PGPASSWORD",
        "GITHUB_TOKEN",
        "DATABASE_URL",
    ):
        monkeypatch.setenv(key, "must-not-reach-replay")
    observed = []

    def invoke(args, receipt, *, env=None):
        observed.append((args[1], env))
        if args[1] == "replay-day":
            controller["write_json"](tmp_path / "0/replay/report-sample-2026-11-12.json", report)

    monkeypatch.setitem(controller, "invoke", invoke)
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda p: SimpleNamespace(free=25_000_000_000)
    )
    controller["run_row"](row, 0, report["as_of_utc"], "a" * 40)
    replay_env = next(env for stage, env in observed if stage == "replay-day")
    assert "must-not-reach-replay" not in replay_env.values()
    assert replay_env["DATABASE_URL"] == "postgresql://disposable/db"


@pytest.mark.parametrize("expected", ["UTC", "America/Toronto"])
def test_controller_fetches_proven_provider_into_existing_empty_directory(
    controller, tmp_path, monkeypatch, expected
):
    from contextlib import contextmanager

    from test_batch_input_sources import archive, store
    from typer.testing import CliRunner

    from transit_ops.batch import input_sources
    from transit_ops.batch.build import InputNeed
    from transit_ops.commands import batch
    from transit_ops.history import storage

    objects = store(tmp_path)
    archive(
        objects,
        "core.providers",
        "2026-11",
        "SELECT 'sample' provider_id, 'America/Toronto' timezone",
    )

    class Scope:
        def resolve(self, backend):
            return objects

        def close(self):
            pass

    class Builder:
        family_id = "sample_family"
        tables = ()
        published_keys = ()
        variants = {}

        def inputs(self, request):
            return (InputNeed("core.providers", "all"),)

        def build(self, *args):
            raise AssertionError("fetch must not build")

    @contextmanager
    def catalog():
        yield SimpleNamespace(get_foreign_keys=lambda *a, **kw: [])

    monkeypatch.setattr(input_sources, "replay_catalog", catalog)
    monkeypatch.setattr(storage, "history_storage", lambda settings: Scope())
    from transit_ops.batch import replay

    monkeypatch.setattr(replay, "replay_builders", lambda *a: {"sample_family": Builder()})
    calls = []

    def invoke(args, receipt, **kwargs):
        assert args[1] == "fetch-inputs"
        destination = Path(args[args.index("--inputs") + 1])
        assert destination.is_dir() and not any(destination.iterdir())
        response = CliRunner().invoke(batch.app, args[1:])
        calls.append(response)
        if response.exit_code:
            raise ValueError(response.output)

    monkeypatch.setitem(controller, "invoke", invoke)
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda p: SimpleNamespace(free=25_000_000_000)
    )
    row = {
        "provider": "sample",
        "day": "2026-11-01",
        "families": ["sample_family"],
        "timezone": expected,
    }
    if expected == "UTC":
        with pytest.raises(ValueError, match="timezone_mismatch"):
            controller["run_row"](row, 0, "2026-11-03T07:00:00Z", "a" * 40, stage="fetch")
    else:
        controller["run_row"](row, 0, "2026-11-03T07:00:00Z", "a" * 40, stage="fetch")
        assert calls[0].exit_code == 0
