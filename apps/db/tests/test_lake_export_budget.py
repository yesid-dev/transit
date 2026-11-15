"""Generated spill and host-memory proof in a fresh process, never inherited RSS."""

import json
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.fixture(scope="module")
def budget_result(tmp_path_factory):
    work = tmp_path_factory.mktemp("codec-budget")
    run = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(work)],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_payload_larger_than_memory_budget_writes_and_proves_by_spilling(budget_result):
    assert budget_result["payload_bytes"] > 128 * 1024**2
    assert budget_result["rows"] == 600_000
    assert budget_result["verified"] is True
    assert budget_result["spill_bytes"] > 0


@pytest.mark.skipif(
    sys.platform != "linux",
    reason="VmHWM requires Linux /proc/self/status; Windows has no equivalent proof here",
)
def test_codec_peak_rss_is_bounded(budget_result):
    assert budget_result["peak_kib"] < 600 * 1024


def worker(work):
    import hashlib
    import threading

    from transit_ops.lake import parquet_codec
    from transit_ops.lake.parquet_verify import Expected, prove_window
    from transit_ops.lake.table_schema import TableSchema

    parquet_codec.MEMORY_LIMIT = "128MiB"
    csv = work / "payload.csv"
    seed = [hashlib.sha256(str(i).encode()).hexdigest() * 4 for i in range(64)]
    with csv.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(600_000):
            stream.write(f"{i},{seed[i % len(seed)]}\n")
    schema = TableSchema.from_columns([("id", "integer", True), ("payload", "text", False)], ["id"])
    stopped = threading.Event()
    peak_spill = 0

    def monitor():
        nonlocal peak_spill
        while not stopped.wait(0.01):
            try:
                peak_spill = max(peak_spill, sum(p.stat().st_size for p in work.glob("*.tmp")))
            except FileNotFoundError:
                pass

    thread = threading.Thread(target=monitor)
    thread.start()
    try:
        written = parquet_codec.write_window(
            csv, schema, work / "payload.parquet", metadata={}, temp_dir=work
        )
        proof = prove_window(
            csv,
            written.path,
            schema,
            expect=Expected(written.content_sha256, written.rows, written.sha256),
            temp_dir=work,
        )
    finally:
        stopped.set()
        thread.join()
    peak = None
    if sys.platform == "linux":
        peak = int(
            next(
                line.split()[1]
                for line in Path("/proc/self/status").read_text().splitlines()
                if line.startswith("VmHWM:")
            )
        )
    print(
        json.dumps(
            dict(
                rows=proof.rows,
                verified=proof.verified,
                payload_bytes=csv.stat().st_size,
                spill_bytes=peak_spill,
                peak_kib=peak,
            )
        )
    )


if __name__ == "__main__":
    worker(Path(sys.argv[1]))
