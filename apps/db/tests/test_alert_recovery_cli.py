import json

import pytest
from test_alert_recovery import NOW
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.commands import alert_recovery as command
from transit_ops.history.alert_recovery_models import RecoveryReport, SourceReport
from transit_ops.settings import Settings

ARGS = [
    "recover-alert-archive-entries",
    "fixture",
    "--capture-from",
    "2020-01-01T01:00:00+01:00",
    "--capture-to",
    "2020-02-01T00:00:00Z",
]


def test_registered_help():
    result = CliRunner().invoke(app, ["recover-alert-archive-entries", "--help"])
    assert result.exit_code == 0
    assert "--capture-from" in result.output and "--apply" in result.output


@pytest.mark.parametrize(
    "bounds",
    [
        [],
        ["--capture-from", "bad", "--capture-to", "bad"],
        ["--capture-from", "2020-01-01", "--capture-to", "2020-02-01"],
        ["--capture-from", "2020-02-01T00:00:00Z", "--capture-to", "2020-01-01T00:00:00Z"],
    ],
)
def test_bad_capture_scope_is_refused(bounds):
    result = CliRunner().invoke(app, ARGS[:2] + bounds)
    assert result.exit_code == 2


@pytest.mark.parametrize("flags,mode", [([], True), (["--dry-run"], True), (["--apply"], False)])
@pytest.mark.parametrize("inventory", [None, ["z", "a", "z"]])
def test_mode_inventory_and_diagnostic_json(monkeypatch, tmp_path, flags, mode, inventory):
    from transit_ops.settings import Settings

    monkeypatch.setattr(
        command,
        "get_settings",
        lambda: Settings(SNAPSHOT_STORAGE_BACKEND="local", SNAPSHOT_LOCAL_ROOT=str(tmp_path)),
    )
    monkeypatch.setattr(
        command.ProviderRegistry,
        "from_project_root",
        lambda **kw: type("Registry", (), {"get_provider": lambda self, p: None})(),
    )
    monkeypatch.setattr(
        command,
        "make_engine",
        lambda settings: type("Engine", (), {"dispose": lambda self: None})(),
    )

    def run(engine, **kwargs):
        assert kwargs["dry_run"] is mode
        assert kwargs["expected_ids"] == inventory
        assert set(kwargs["source_readers"]) == {"published", "backup"}
        return RecoveryReport("fixture", mode, tuple(SourceReport(k) for k in command.KINDS), NOW)

    monkeypatch.setattr(command, "run_alert_archive_recovery", run)
    options = [v for identity in inventory or [] for v in ("--expected-id", identity)]
    result = CliRunner().invoke(app, ARGS + flags + options)
    assert result.exit_code == 1
    report = json.loads(result.stdout)
    assert report["unrecovered_expected_ids"] is None and report["inserted"] == []
    assert [r["coverage"] for r in report["source_reports"]] == [["not read"]] * 3


def test_failure_output_does_not_echo_credentials(monkeypatch):
    def fail():
        raise ValueError("postgresql://secret:password@private/raw-payload")

    monkeypatch.setattr(command, "get_settings", fail)
    result = CliRunner().invoke(app, ARGS)
    assert result.exit_code == 1
    assert json.loads(result.stdout) == {"error": "alert archive recovery failed"}


def test_published_composition_leaves_other_slots_unread(tmp_path):
    from test_alert_recovery_published import index, page

    from transit_ops.snapshots.storage import LocalSnapshotStorage

    storage = LocalSnapshotStorage(str(tmp_path), "v1/fixture")
    index(storage, *page(storage, "old"))
    readers = command.build_recovery_source_readers(storage, settings=Settings(_env_file=None))
    items, report = readers["published"](None, provider_id="fixture", recovered_at_utc=NOW)
    assert set(readers) == {"published", "backup"} and report.complete
    assert items[0].alert_id == "old"
