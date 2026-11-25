import hashlib
import json
from pathlib import Path
from typing import BinaryIO

import pytest

from transit_engine.sync_clean import R2, REMOTE, sync

DAY = "stm/2026-11-21/v3"
MANIFEST = f"{DAY}/manifest.json"
SEARCH = "search/v1/stm/2026-11-21/v3.json"


class CleanBucket(R2):
    def __init__(self, root: Path):
        self.root = root
        self.reads: list[str] = []
        tables = {"stop_events.parquet": b"stop events", "trip_days.parquet": b"trip days"}
        receipt = {
            "provider": "stm",
            "service_date": "2026-11-21",
            "cleaning_version": "3",
            "built_at_utc": "2026-11-23T07:00:00Z",
            "schedule_sha256": "a" * 64,
            "files": {
                name: {
                    "sha256": hashlib.sha256(data).hexdigest(), "byte_size": len(data), "rows": 1
                }
                for name, data in tables.items()
            },
            "row_counts_by_basis": {"stopped": 1},
            "row_counts_by_state": {"observed": 1},
        }
        self.objects = {
            **{f"{DAY}/{name}": data for name, data in tables.items()},
            MANIFEST: json.dumps(receipt).encode(),
            SEARCH: b"{}",
            "stm/2026-11-22/v3/stop_events.parquet": b"unpublished",
        }

    def inventory(self, version: int) -> dict[str, int]:
        assert version == 3
        return {key: len(value) for key, value in self.objects.items()}

    def run(self, *args: str, output: BinaryIO | int = -1) -> bytes:
        assert args == ("cat", f"{REMOTE}/{MANIFEST}")
        self.reads.append(MANIFEST)
        return self.objects[MANIFEST]

    def download(self, key: str, stream: BinaryIO) -> None:
        assert not (self.root / MANIFEST).exists()
        self.reads.append(key)
        stream.write(self.objects[key])


def test_sync_checks_space_before_writing(tmp_path: Path) -> None:
    remote = CleanBucket(tmp_path)
    with pytest.raises(RuntimeError, match="Insufficient space"):
        sync(remote, tmp_path, 3, 2**60)
    assert remote.reads == []
    assert list(tmp_path.iterdir()) == []


def test_sync_publishes_only_verified_days_and_skips_them_on_next_run(tmp_path: Path) -> None:
    remote = CleanBucket(tmp_path)
    key = f"{DAY}/trip_days.parquet"
    original = remote.objects[key]
    remote.objects[key] = b"?" * len(original)
    with pytest.raises(RuntimeError, match="Digest mismatch"):
        sync(remote, tmp_path, 3, 0)
    assert not (tmp_path / MANIFEST).exists()
    assert not (tmp_path / ".record-v3").exists()
    assert not list(tmp_path.rglob("*.part"))

    remote.objects[key] = original
    sync(remote, tmp_path, 3, 0)
    assert (tmp_path / MANIFEST).read_bytes() == remote.objects[MANIFEST]
    assert (tmp_path / key).read_bytes() == original
    assert (tmp_path / SEARCH).read_bytes() == b"{}"
    assert not (tmp_path / "stm/2026-11-22").exists()

    stamp = (tmp_path / ".record-v3").stat().st_mtime_ns
    remote.reads.clear()
    sync(remote, tmp_path, 3, 0)
    assert remote.reads == []
    assert (tmp_path / ".record-v3").stat().st_mtime_ns == stamp
