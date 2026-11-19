"""Restart probe: a real shadow-role worker process dies by os._exit and is reopened."""

import json
import subprocess
import sys
from contextlib import closing
from datetime import timedelta
from pathlib import Path

import pytest
from live_restart_probe_fixture import DEATH
from test_live_local_file import SETTINGS
from test_live_running import AT
from test_live_shadow import Clock, recorded_postgres, shadow

from transit_ops.live import recovery
from transit_ops.live.admission import (
    ShadowRecord,
    classify_restart,
    committed_rows,
    declared_cadence,
    observe_restart,
)
from transit_ops.providers.registry import load_provider_manifest

# Points: a committed application, an open transaction, and the shadow's own upload.
POINTS = ("committed", "in_transaction", "shadow_publish")


def run_until_death(path, point):
    script = Path(__file__).with_name("live_restart_probe_fixture.py")
    child = subprocess.run(
        [sys.executable, str(script), str(path), point],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert child.returncode == DEATH, child.stderr
    return json.loads(child.stdout.strip().splitlines()[-1])["committed"]


@pytest.mark.parametrize("point", POINTS)
def test_killed_shadow_worker_reopens_inside_the_gate_with_every_committed_row(tmp_path, point):
    path = tmp_path / "provider-network.duckdb"
    committed = run_until_death(path, point)
    assert committed["fact_vehicle_snapshot"] and committed["fact_trip_delay_snapshot"]
    assert Path(str(path) + ".wal").is_file(), "the probe must exercise DuckDB WAL replay"

    observation = observe_restart(
        path, provider_id="network", settings=SETTINGS, committed=committed, point=point
    )
    assert observation.reopened and observation.wal_present
    assert observation.committed_rows_lost == 0
    assert observation.reopen_seconds is not None and observation.reopen_seconds >= 0
    stm = Path(__file__).parents[1] / "config" / "providers" / "stm.yaml"
    cadence = declared_cadence(load_provider_manifest(stm))
    assert cadence == 20  # STM's declared vehicle_positions every_seconds.
    assert classify_restart(observation, cadence) == "recovered"

    with closing(recovery.reopen(path, provider_id="network", settings=SETTINGS)) as local:
        # Exactly the committed state: nothing lost and nothing uncommitted resurrected.
        assert committed_rows(local) == committed
        restarted = shadow(local, clock=Clock(AT + timedelta(minutes=1)))
        restarted.run_cycle(recorded_postgres(local), snapshot_ids=(42,))
        assert restarted.evidence.status == "compared", restarted.evidence
        # The gate reads exactly what the shadow logs.
        logged = json.loads(json.dumps(restarted.evidence.display_dict()))
        record = ShadowRecord.from_dict(logged)
        assert (record.status, record.capture_seconds) == ("compared", logged["capture_seconds"])


def test_a_committed_row_missing_after_reopen_is_lost_committed_row(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    committed = run_until_death(path, "committed")
    committed["fact_vehicle_snapshot"] = [*committed["fact_vehicle_snapshot"], '["ghost"]']
    observation = observe_restart(
        path, provider_id="network", settings=SETTINGS, committed=committed, point="committed"
    )
    assert observation.committed_rows_lost == 1
    assert classify_restart(observation, 20) == "lost_committed_row"


def test_unreadable_file_without_wal_is_a_named_refusal_not_wal_replay(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    path.write_bytes(b"not a duckdb file")
    observation = observe_restart(
        path, provider_id="network", settings=SETTINGS, committed={}, point="unreadable"
    )
    assert not observation.reopened and not observation.wal_present
    assert classify_restart(observation, 20) == "local_file_unreadable_without_wal"
