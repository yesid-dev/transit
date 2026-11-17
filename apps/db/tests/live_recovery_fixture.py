"""Small owned process fixture; stdout is the bounded parent handshake."""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from cold_recovery_fixture import capture_record
from test_live_facts import seed_fact_edition, trip_message, vehicle_message
from test_live_local_file import SETTINGS

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
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


def payload(endpoint):
    return (trip_message() if endpoint == "trip_updates" else vehicle_message()).SerializeToString()


def record(number, endpoint="vehicle_positions"):
    return capture_record(endpoint, number, number, payload(endpoint), 0)


def apply(local, recorder, number, endpoint="vehicle_positions"):
    entry = record(number, endpoint).captures[0]
    parsed = parse_capture(
        payload(endpoint),
        CaptureRef.from_entry(entry, provider_id="network", endpoint_key=endpoint),
        ParsePolicy(None, 100),
    )
    return recorder.apply(
        endpoint,
        number,
        lambda: apply_capture(local, parsed, provider_timezone="America/Toronto"),
        capture=entry,
    )


def commit_pair(local, recorder, number):
    records = (record(number), record(number + 100, "trip_updates"))
    # The later page also observes the late lower-ID vehicle run through its tail.
    ids = [42, 44, 142] if number == 42 else [143, 145]
    recorder._commit_page(records, ids, 0, 145)
    apply(local, recorder, number)
    apply(local, recorder, number + 100, "trip_updates")


class PendingStorage(LocalBronzeStorage):
    def put_if_absent(self, path, key):
        print(json.dumps({"ready": snapshot(self.local)}), flush=True)
        sys.stdin.read()
        raise AssertionError("fixture must be killed while the segment is pending")


def main():
    path, stage = Path(sys.argv[1]), sys.argv[2]
    local = reopen(path, provider_id="network", settings=SETTINGS)
    seed_fact_edition(local)
    local.connection.execute("INSERT INTO edition_trips VALUES ('行程','路线','weekday')")
    recorder = Recorder(local, provider_id="network")
    recorder.initialize(initial_run_id=0, seed_sha256="a" * 64)
    commit_pair(local, recorder, 42)
    expected = snapshot(local)
    if stage == "precommit":
        transaction = local.transaction()
        transaction.__enter__()
        commit_pair(local, recorder, 43)
    elif stage == "postcommit":
        commit_pair(local, recorder, 43)
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
