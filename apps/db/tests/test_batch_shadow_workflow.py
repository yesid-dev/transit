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


def test_export_asserts_read_only_and_uses_locked_cli_all_provider(controller, monkeypatch):
    import psycopg

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

        def execute(self, query):
            queries.append(query)
            return SimpleNamespace(
                fetchone=lambda: (self.readonly,) if query.startswith("SHOW") else (3,)
            )

    def connect(*args, **kwargs):
        connections.append(kwargs)
        return Connection()

    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setitem(controller, "invoke", lambda args, receipt: commands.append(args))
    data = {"code_commit": "a" * 40, "datasets": ["silver.i3_alerts", "core.providers"]}
    start = datetime.now(UTC)
    controller["export_inputs"](data)
    args = commands[0]
    assert args[:3] == ["lake", "migrate", "--execute"]
    assert "--include-open" in args and "--provider" not in args
    assert args[args.index("--statement-timeout-s") + 1] == "300"
    assert args.count("--dataset") == 2
    deadline = datetime.fromisoformat(args[args.index("--not-after") + 1])
    assert (deadline - start).total_seconds() >= 4500  # (2*3+7)*300+600
    assert queries == ["SHOW transaction_read_only", "SELECT count(*) FROM core.providers"]
    assert "default_transaction_read_only=on" in connections[0]["options"]
    Connection.readonly = "off"
    commands.clear()
    with pytest.raises(ValueError, match="not_read_only"):
        controller["export_inputs"](data)
    assert commands == []


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
    assert events["schedule"] == [{"cron": "0 7 * * *"}]
    assert workflow["permissions"] == {"contents": "read"}
    assert workflow["concurrency"] == {"group": "batch-shadow", "cancel-in-progress": False}
    job = workflow["jobs"]["shadow"]
    assert job["environment"] == "batch-shadow"
    assert "DATABASE_URL" not in job["env"]
    exports = [s for s in job["steps"] if "BATCH_SHADOW_DATABASE_URL" in str(s)]
    assert len(exports) == 1
    assert exports[0]["env"]["PGOPTIONS"] == "-c default_transaction_read_only=on"
    assert "secrets.DATABASE_URL" not in path.read_text()
    assert "TRANSIT_REPLAY_DATABASE_URL" in job["steps"][3]["run"]
    assert job["steps"][-1]["if"] == "${{ !cancelled() }}"
