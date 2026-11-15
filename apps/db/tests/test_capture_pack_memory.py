import hashlib
import json
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from history_fixtures import scripted_feed_day

from transit_ops.history.capture_pack import pack_working_day
from transit_ops.history.probe import peak_rss
from transit_ops.history.probe_duckdb import benchmark
from transit_ops.ingestion.storage import LocalBronzeStorage


def measure(count, directory):
    # One reusable source file, unique metadata, no day-sized payload fixture.
    directory.mkdir()
    store = LocalBronzeStorage("local", directory)
    payload = bytes(range(256)) * 4096
    (directory / "capture").write_bytes(payload)
    record, _ = scripted_feed_day()
    capture = replace(
        record.captures[0],
        packed=False,
        stream=None,
        offset=None,
        byte_size=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        storage_path="capture",
    )
    record = replace(
        record,
        polls=(),
        processing=(),
        captures=tuple(
            replace(capture, capture_row_id=i, ingestion_run_id=i, ingestion_object_id=i)
            for i in range(count)
        ),
    )
    local = pack_working_day(record, lambda _: store, directory=directory)
    report = benchmark(local, directory)
    assert report["duckdb_capture_count"] == count
    assert report["duckdb_byte_count"] == count * len(payload)
    peak, reason = peak_rss()
    assert peak is not None, reason
    return dict(input_bytes=count * len(payload), peak_bytes=peak)


@pytest.mark.parametrize("count", [512, 2048])
def test_generated_day_stays_below_512_mib(count, tmp_path):
    completed = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(count), str(tmp_path / "day")],
        check=True,
        capture_output=True,
        text=True,
        timeout=600,
    )
    result = json.loads(completed.stdout)
    print(result)
    assert result["peak_bytes"] < 512 * 1024**2, result


if __name__ == "__main__":
    print(json.dumps(measure(int(sys.argv[1]), Path(sys.argv[2]))))
