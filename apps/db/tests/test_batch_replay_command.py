from datetime import UTC, date, datetime

import pytest
from typer.testing import CliRunner

from transit_ops.batch import pg_load, replay
from transit_ops.commands import batch


@pytest.mark.parametrize("code", [0, 2])
@pytest.mark.parametrize("as_of", [None, "2026-11-03T09:10:11+00:00"])
def test_replay_arguments_report_and_exit(tmp_path, monkeypatch, code, as_of):
    calls = []

    class Report:
        def to_json(self, **kwargs):
            return b'{"evidence":true}'

        def exit_code(self):
            return code

    class Database:
        class engine:
            @staticmethod
            def dispose():
                pass

    def run(**kwargs):
        calls.append(kwargs)
        return Report()

    monkeypatch.setenv("TRANSIT_REPLAY_DATABASE_URL", "disposable")
    monkeypatch.setattr(pg_load, "prepare_replay_database", lambda *args: Database())
    monkeypatch.setattr(replay, "replay_day", run)
    monkeypatch.setattr(batch, "_code_commit", lambda: "a" * 40)
    result = CliRunner().invoke(
        batch.app,
        [
            "replay-day",
            "--provider",
            "sample",
            "--date",
            "2026-11-01",
            "--inputs",
            str(tmp_path),
            "--workdir",
            str(tmp_path),
            "--family",
            "headways",
            "--family",
            "hotspots",
            "--bodies",
        ]
        + (["--as-of", as_of] if as_of else []),
    )
    assert result.exit_code == code, result.output
    assert calls[0]["provider_id"] == "sample"
    assert calls[0]["local_date"] == date(2026, 11, 1)
    assert calls[0]["as_of_utc"] == (
        datetime.fromisoformat(as_of) if as_of else datetime(2026, 11, 2, 7, tzinfo=UTC)
    )
    assert calls[0]["inputs_root"] == tmp_path
    assert calls[0]["workdir"] == tmp_path
    assert calls[0]["code_commit"] == "a" * 40
    assert calls[0]["families"] == ["headways", "hotspots"]
    assert calls[0]["publish_bodies"] is True
    assert (tmp_path / "report-sample-2026-11-01.json").read_bytes() == b'{"evidence":true}'


def test_refusal_and_bare_help(tmp_path, monkeypatch):
    monkeypatch.delenv("TRANSIT_REPLAY_DATABASE_URL", raising=False)
    runner = CliRunner()
    result = runner.invoke(
        batch.app,
        [
            "replay-day",
            "--provider",
            "sample",
            "--date",
            "2026-11-01",
            "--inputs",
            str(tmp_path),
            "--workdir",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 1
    assert "TRANSIT_REPLAY_DATABASE_URL" in result.output
    assert runner.invoke(batch.app, []).exit_code == 0
    assert "replay-day" in runner.invoke(batch.app, []).output


def test_database_refusal_does_not_write_report(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSIT_REPLAY_DATABASE_URL", "sqlite://")
    result = CliRunner().invoke(
        batch.app,
        [
            "replay-day",
            "--provider",
            "sample",
            "--date",
            "2026-11-01",
            "--inputs",
            str(tmp_path),
            "--workdir",
            str(tmp_path),
        ],
    )
    assert result.exit_code == 1
    assert not (tmp_path / "report-sample-2026-11-01.json").exists()
