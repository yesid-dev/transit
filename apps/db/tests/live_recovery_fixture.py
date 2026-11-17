"""Small owned process fixture; stdout is the bounded parent handshake."""

import json
import sys
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from test_live_facts import parsed_vehicle
from test_live_local_file import CAPTURE, POLL, RECORD, SETTINGS

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.compare import canonical_row
from transit_ops.live.facts import apply_capture
from transit_ops.live.recording import Recorder
from transit_ops.live.recovery import reopen
from transit_ops.live.segments import export_segment


def snapshot(local):
    tables = local.connection.execute(
        "SELECT table_name FROM duckdb_tables() WHERE schema_name='main' "
        "AND database_name=current_database() AND NOT temporary ORDER BY table_name"
    ).fetchall()
    return {
        name: [
            canonical_row(
                tuple(
                    value.replace(tzinfo=UTC) if isinstance(value, datetime) else value
                    for value in row
                )
            )
            for row in local.connection.execute(f'SELECT * FROM "{name}" ORDER BY ALL').fetchall()
        ]
        for (name,) in tables
    }


def record(number):
    capture = replace(
        CAPTURE,
        capture_row_id=number,
        ingestion_run_id=number,
        sha256=parsed_vehicle().capture.sha256,
    )
    return replace(
        RECORD,
        feed_day=replace(RECORD.feed_day, endpoint_key="vehicle_positions"),
        polls=(replace(POLL, ingestion_run_id=number, capture_row_id=number),),
        captures=(capture,),
        processing=(),
    )


def apply(local, recorder, number):
    parsed = parsed_vehicle()
    parsed = replace(parsed, capture=replace(parsed.capture, capture_row_id=number))
    return recorder.apply(
        "vehicle_positions",
        number,
        lambda: apply_capture(local, parsed, provider_timezone="UTC"),
        capture=record(number).captures[0],
    )


class PendingStorage(LocalBronzeStorage):
    def put_if_absent(self, path, key):
        print(json.dumps({"ready": snapshot(self.local)}), flush=True)
        sys.stdin.read()
        raise AssertionError("fixture must be killed while the segment is pending")


def main():
    path, stage = Path(sys.argv[1]), sys.argv[2]
    local = reopen(path, provider_id="network", settings=SETTINGS)
    recorder = Recorder(local, provider_id="network")
    recorder.initialize(initial_run_id=0, seed_sha256="a" * 64)
    recorder._commit_page((record(42),), [42, 44], 0, 44)
    apply(local, recorder, 42)
    expected = snapshot(local)
    if stage == "precommit":
        transaction = local.transaction()
        transaction.__enter__()
        recorder._commit_page((record(43),), [43, 45], 0, 45)
        apply(local, recorder, 43)
    elif stage == "postcommit":
        recorder._commit_page((record(43),), [43, 45], 0, 45)
        apply(local, recorder, 43)
        expected = snapshot(local)
    elif stage == "pending":
        storage = PendingStorage("local", path.parent / "objects")
        storage.root.mkdir()
        storage.local = local
        export_segment(local, storage)
        raise AssertionError("pending fixture returned before handshake")
    else:
        raise ValueError(stage)
    print(json.dumps({"ready": expected}), flush=True)
    sys.stdin.read()
    raise AssertionError("fixture must end with abrupt process death")


if __name__ == "__main__":
    main()
