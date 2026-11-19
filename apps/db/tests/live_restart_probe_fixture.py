"""Owned shadow-role worker for the restart probe; it dies by os._exit, never cleanly.

stdout's last line is the bounded handshake: what the process had committed when it died.
"""

import json
import os
import sys
from datetime import timedelta
from pathlib import Path

from live_recovery_fixture import commit_pair
from snapshot_storage_fixtures import MemorySnapshotStore
from test_live_facts import seed_fact_edition
from test_live_local_file import SETTINGS
from test_live_running import AT
from test_live_shadow import Clock, recorded_postgres, shadow

from transit_ops.live.admission import committed_rows
from transit_ops.live.recording import Recorder
from transit_ops.live.recovery import open_worker_file

DEATH = 17


def seed(local):
    seed_fact_edition(local)
    for statement in (
        "INSERT INTO edition_trips VALUES ('行程','路线','weekday')",
        "INSERT INTO edition_routes VALUES ('路线',3)",
        "INSERT INTO edition_stops VALUES ('站',45.5,-73.5)",
        "INSERT INTO edition_trip_service_span VALUES ('行程','路线','S',0,360000)",
        "INSERT INTO edition_calendar_dates VALUES ('S','2026-06-20',1)",
    ):
        local.connection.execute(statement)


def die(committed):
    print(json.dumps({"committed": committed}), flush=True)
    os._exit(DEATH)


def main():
    path, point = Path(sys.argv[1]), sys.argv[2]
    local = open_worker_file(path, provider_id="network", settings=SETTINGS)
    seed(local)
    recorder = Recorder(local, provider_id="network")
    recorder.initialize(initial_run_id=0, seed_sha256="a" * 64)
    commit_pair(local, recorder, 42)
    clock, store = Clock(), MemorySnapshotStore()
    paired = shadow(local, clock=clock, store=store)
    paired.run_cycle(recorded_postgres(local), snapshot_ids=(42,))
    assert paired.evidence.status == "compared", paired.evidence
    clock.at = AT + timedelta(seconds=30)
    if point == "committed":
        commit_pair(local, recorder, 43)
        die(committed_rows(local))
    elif point == "in_transaction":
        committed = committed_rows(local)
        # Keep the reference: a collected generator would roll back before the work.
        transaction = local.transaction()
        transaction.__enter__()
        commit_pair(local, recorder, 43)
        die(committed)
    elif point == "shadow_publish":
        commit_pair(local, recorder, 43)
        committed = committed_rows(local)
        store.pause = lambda key: die(committed)
        paired.run_cycle(recorded_postgres(local), snapshot_ids=(42, 43))
    raise AssertionError(f"probe point {point!r} returned instead of dying")


if __name__ == "__main__":
    main()
