import hashlib
import json
from dataclasses import replace

import pytest
from test_live_oracle_alert_rows_real_db import alerts_case as alerts_case
from test_live_oracle_runner import replay_case as replay_case
from test_live_oracle_seed import case as case
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.providers import ProviderRegistry


@pytest.fixture
def command_case(alerts_case, tmp_path, monkeypatch):
    case, _ = alerts_case
    refs = set(case.window.cycles[0].captures)
    case.window = replace(
        case.window,
        cycles=case.window.cycles[:1],
        poll_records=tuple(
            r
            for r in case.window.poll_records
            if any((c.index_family, c.capture_row_id) in refs for c in r.captures)
        ),
    )
    manifest = case.registry.get_provider(case.window.provider_id)
    (case.registry.config_dir / "test.yaml").write_text(
        manifest.model_dump_json(), encoding="utf-8"
    )
    # Only relocate config: the real registry loads generated provider files.
    monkeypatch.setattr(
        ProviderRegistry,
        "from_project_root",
        classmethod(lambda cls, **kw: cls(case.registry.config_dir, kw["settings"])),
    )
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(case.bronze("local").root))
    monkeypatch.setenv("TRANSIT_TEST_DATABASE_URL", "postgresql://stranger@remote/production")
    path = tmp_path / "window.json"

    def run(output, prior=None):
        path.write_bytes(case.window.to_json())
        args = ["live-oracle", "replay", "--window", str(path), "--output", str(output)]
        if prior is not None:
            args += ["--prior-manifest", str(prior)]
        return CliRunner().invoke(app, args)

    return case, run, path


def test_malformed_window_is_refused_before_database_access(tmp_path, monkeypatch):
    monkeypatch.delenv("TRANSIT_TEST_DATABASE_URL", raising=False)
    window = tmp_path / "window.json"
    window.write_text("[]", encoding="utf-8")
    output = tmp_path / "output"
    result = CliRunner().invoke(
        app, ["live-oracle", "replay", "--window", str(window), "--output", str(output)]
    )
    assert result.exit_code == 1
    assert "malformed_window" in result.output
    assert not output.exists()


@pytest.mark.parametrize("failure", ["foreign", "conflict", "corrupt", "alerts", "escape"])
def test_named_refusals(command_case, tmp_path, failure):
    case, run, _ = command_case
    output = tmp_path / "output"
    expected = {
        "foreign": "foreign_target",
        "conflict": "output_path_conflict",
        "corrupt": "corrupt_bytes",
        "alerts": "missing_alert_evidence",
        "escape": "local_capture_path",
    }
    if failure == "conflict":
        output.mkdir()
        (output / "keep").write_bytes(b"original")
    if failure == "corrupt":
        (case.bronze("local").root / case.window.edition.storage_path).write_bytes(b"broken")
    if failure == "escape":
        case.window = replace(
            case.window, edition=replace(case.window.edition, storage_path="../secret")
        )
    if failure == "alerts":
        cycle = case.window.cycles[0]
        case.window = replace(
            case.window,
            cycles=(
                replace(
                    cycle,
                    captures=tuple(ref for ref in cycle.captures if ref[0] != "alert_snapshot"),
                ),
            ),
        )
    result = run(output)
    assert result.exit_code == 1
    assert expected[failure] in result.output
    if failure == "foreign":
        assert "stranger" not in result.output
        assert "remote" not in result.output
    assert not (output / "completed").exists()
    if failure == "conflict":
        assert (output / "keep").read_bytes() == b"original"


def test_command_replays_complete_window_deterministically(
    real_db_engine, command_case, tmp_path, monkeypatch
):
    _, run, path = command_case
    monkeypatch.setenv(
        "TRANSIT_TEST_DATABASE_URL", real_db_engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "must-not-appear-in-evidence")
    receipts = []
    for name in ("first", "second"):
        output = tmp_path / name
        result = run(output)
        assert result.exit_code == 0, result.output
        completed = output / "completed"
        receipt = json.loads((completed / "receipt.json").read_bytes())
        assert receipt["status"] == "completed"
        assert receipt["cycle_count"] == 1
        assert receipt["source_window_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert len(receipt["code_commit"]) == 40
        publications = receipt["cycles"][0]["publications"]
        assert "manifest.json" in publications
        assert any("alert" in key for key in publications)
        for key, digest in publications.items():
            body = (completed / "objects" / digest).read_bytes()
            assert hashlib.sha256(body).hexdigest() == digest, key
        for file in completed.rglob("*"):
            if file.is_file():
                body = file.read_bytes()
                for secret in (
                    "must-not-appear-in-evidence",
                    real_db_engine.url.password,
                    real_db_engine.url.host,
                    real_db_engine.url.username,
                ):
                    if secret:
                        assert secret.encode() not in body
        receipts.append(receipt)
    assert receipts[0] == receipts[1]


def test_failed_cycle_has_chained_reason_and_no_receipt(
    real_db_engine, command_case, tmp_path, monkeypatch
):
    case, run, _ = command_case
    monkeypatch.setenv(
        "TRANSIT_TEST_DATABASE_URL", real_db_engine.url.render_as_string(hide_password=False)
    )
    record = next(r for r in case.window.poll_records if r.feed_day.endpoint_key == "trip_updates")
    capture = record.captures[0]
    payload = b"not protobuf"
    (case.bronze("local").root / capture.storage_path).write_bytes(payload)
    bad = replace(capture, byte_size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    case.window = replace(
        case.window,
        poll_records=tuple(
            replace(r, captures=(bad,)) if r is record else r for r in case.window.poll_records
        ),
    )
    output = tmp_path / "output"
    result = run(output)
    assert result.exit_code == 1
    assert "Live oracle cycle 2025-03-24T12:06:40+00:00 failed" in result.output
    assert " -> " in result.output
    assert not list(output.rglob("receipt.json"))
