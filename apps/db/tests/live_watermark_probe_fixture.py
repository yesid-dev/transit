"""Owned worker process that commits cycles and its watermark, then dies by os._exit.

Stages: ``first`` creates the file, commits one cycle and its watermark; ``unmarked``
reopens, commits the next cycle and dies before its watermark; ``marked`` also writes it.
"""

import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from live_recovery_fixture import commit_pair
from test_live_facts import seed_fact_edition
from test_live_local_file import SETTINGS

from transit_ops.live.recording import Recorder
from transit_ops.live.recovery import open_worker_file
from transit_ops.live.watermark import write_committed_watermark

DEATH = 23
CYCLE = datetime(2026, 6, 20, 12, tzinfo=UTC)


def main():
    path, stage = Path(sys.argv[1]), sys.argv[2]
    local = open_worker_file(path, provider_id="network", settings=SETTINGS)
    recorder = Recorder(local, provider_id="network")
    if stage == "first":
        seed_fact_edition(local)
        local.connection.execute("INSERT INTO edition_trips VALUES ('行程','路线','weekday')")
        recorder.initialize(initial_run_id=0, seed_sha256="a" * 64)
        commit_pair(local, recorder, 42)
        assert write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
    elif stage in ("unmarked", "marked"):
        commit_pair(local, recorder, 43)
        if stage == "marked":
            at = CYCLE + timedelta(seconds=30)
            assert write_committed_watermark(path, local, provider_id="network", cycle_at=at)
    else:
        raise AssertionError(f"unknown stage {stage!r}")
    os._exit(DEATH)


if __name__ == "__main__":
    main()
