import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from test_maintenance import PerBeginRecordingEngine, RecordingConnection
from typer.testing import CliRunner

from transit_ops import cli, orchestration
from transit_ops.maintenance import gold, retention
from transit_ops.settings import Settings


def held_settings(monkeypatch):
    monkeypatch.setenv("LIGHTER_STORAGE", json.dumps({"control": {"fact_prune_mode": "hold"}}))
    return Settings(_env_file=None, DATABASE_URL="postgresql://localhost/disposable")


def test_direct_command_refuses_gold_prune(monkeypatch):
    settings = held_settings(monkeypatch)
    engine = PerBeginRecordingEngine()
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(retention, "make_engine", lambda _: engine)
    response = CliRunner().invoke(cli.app, ["prune-gold-storage", "stm"])
    assert response.exit_code != 0 and "fact_pruning_held" in response.output
    assert not any("DELETE" in sql for c in engine.connections for sql in c.calls)


def test_loop_continues_under_hold_without_reporting_gold_success(monkeypatch, caplog):
    settings = held_settings(monkeypatch)
    engine = PerBeginRecordingEngine()
    silver = []

    def prune_silver(provider, **kwargs):
        silver.append(provider)
        return SimpleNamespace(display_dict=dict)

    monkeypatch.setattr(orchestration, "prune_silver_storage", prune_silver)
    orchestration.run_pruner_loop(
        "stm",
        settings=settings,
        engine=engine,
        max_cycles=2,
        should_shutdown=lambda: False,
        sleep_fn=lambda _: None,
    )
    assert silver == ["stm", "stm"]
    assert "fact_pruning_held" in caplog.text
    assert not any("DELETE" in sql for c in engine.connections for sql in c.calls)


def test_combined_retention_reports_hold_and_runs_later_tiers(monkeypatch):
    engine = PerBeginRecordingEngine()
    settings = held_settings(monkeypatch)
    tier = retention.RetentionTier
    receipt = retention.prune(
        "stm",
        retention.RetentionPolicy(
            settings, tiers=frozenset({tier.GOLD, tier.WARM_ROLLUP}), prove=False
        ),
        engine=engine,
    )
    assert not receipt.is_complete
    body = receipt.display_dict()
    assert body["held_tiers"] == {"gold": "fact_pruning_held"}
    assert set(body["results"]) == {"warm_rollup"}
    assert not any("DELETE FROM gold.fact_" in sql for c in engine.connections for sql in c.calls)


@pytest.mark.parametrize("mode", [None, "", "unknown"])
def test_invalid_explicit_mode_refuses_before_sql(monkeypatch, mode):
    monkeypatch.setenv("LIGHTER_STORAGE", json.dumps({"control": {"fact_prune_mode": mode}}))
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
    conn = RecordingConnection()
    with pytest.raises(ValueError, match="invalid_fact_prune_mode"):
        gold.prune_gold_fact_history(conn, mode=mode, provider_id="stm", retention_days=14)
    assert conn.calls == []
