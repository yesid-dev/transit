import hashlib
import json
from datetime import date
from pathlib import Path
from typing import BinaryIO

import pytest

from transit_engine.sync_clean import R2, REMOTE, sync, sync_stretches

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
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "byte_size": len(data),
                    "rows": 1,
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


TODAY = date(2026, 11, 28)


def _stretch_day(day: str, marker: bytes = b"") -> dict[str, bytes]:
    folder = f"stretch/v13/stm/{day}"
    files, tables, objects = {}, {}, {}
    for table in ("stretches", "stretch_passes", "stretch_summary"):
        data = f"{table} {day}".encode() + marker
        digest = hashlib.sha256(data).hexdigest()
        name = f"{table}-{digest[:16]}.parquet"
        files[name] = {"sha256": digest, "byte_size": len(data), "rows": 1}
        tables[table] = name
        objects[f"{folder}/{name}"] = data
    receipt = {
        "provider": "stm", "service_date": day, "cleaning_version": "13",
        "tables": tables, "files": files,
    }  # fmt: skip
    objects[f"{folder}/manifest.json"] = json.dumps(receipt).encode()
    return objects


class StretchBucket(R2):
    def __init__(self, root: Path, *days: str):
        self.root = root
        self.objects: dict[str, bytes] = {}
        for day in days:
            self.objects.update(_stretch_day(day))
        self.reads: list[str] = []

    def listing(self, include: str) -> dict[str, int]:
        assert include == "/stretch/v13/**"
        return {key: len(value) for key, value in self.objects.items()}

    def run(self, *args: str, output: BinaryIO | int = -1) -> bytes:
        assert args[0] == "cat" and args[1].startswith(f"{REMOTE}/")
        key = args[1].removeprefix(f"{REMOTE}/")
        self.reads.append(key)
        return self.objects[key]

    def download(self, key: str, stream: BinaryIO) -> None:
        assert not (self.root / key.rsplit("/", 1)[0] / "manifest.json").exists()
        self.reads.append(key)
        stream.write(self.objects[key])


def _local_days(root: Path) -> list[str]:
    return sorted(path.parent.name for path in root.glob("stretch/v13/*/*/manifest.json"))


def test_stretch_mirror_keeps_the_latest_thirty_days(tmp_path: Path) -> None:
    remote = StretchBucket(tmp_path, "2026-10-29", "2026-10-30", "2026-11-27")
    with pytest.raises(RuntimeError, match="Insufficient space"):
        sync_stretches(remote, tmp_path, 2**60, TODAY, rollups=False)
    assert remote.reads == [] and not list(tmp_path.iterdir())
    sync_stretches(remote, tmp_path, 0, TODAY, check=True, rollups=False)
    assert not list(tmp_path.iterdir())
    sync_stretches(remote, tmp_path, 0, TODAY, rollups=False)
    # 2026-10-30 is the 30th day back from 2026-11-28; 2026-10-29 stays in R2 only.
    assert _local_days(tmp_path) == ["2026-10-30", "2026-11-27"]
    for key, data in remote.objects.items():
        if "2026-10-29" not in key:
            assert (tmp_path / key).read_bytes() == data
    remote.reads.clear()
    sync_stretches(remote, tmp_path, 0, TODAY, rollups=False)
    assert remote.reads == []


def test_a_tampered_stretch_file_is_not_published(tmp_path: Path) -> None:
    remote = StretchBucket(tmp_path, "2026-11-27")
    key = next(key for key in remote.objects if "stretch_passes" in key)
    original = remote.objects[key]
    remote.objects[key] = b"?" * len(original)
    with pytest.raises(RuntimeError, match="Digest mismatch"):
        sync_stretches(remote, tmp_path, 0, TODAY, rollups=False)
    assert _local_days(tmp_path) == [] and not list(tmp_path.rglob("*.part"))
    remote.objects[key] = original
    sync_stretches(remote, tmp_path, 0, TODAY, rollups=False)
    assert _local_days(tmp_path) == ["2026-11-27"]


def test_old_local_days_leave_only_when_r2_holds_them(tmp_path: Path) -> None:
    remote = StretchBucket(tmp_path, "2026-10-01", "2026-10-02", "2026-10-03", "2026-11-27")
    sync_stretches(remote, tmp_path, 0, date(2026, 10, 5), rollups=False)
    assert _local_days(tmp_path) == ["2026-10-01", "2026-10-02", "2026-10-03", "2026-11-27"]
    # R2 holds 10-01 as published. 10-02 now has another receipt in R2, and 10-03's
    # summary is missing there: both stay on this host.
    remote.objects.update(
        {
            key: value
            for key, value in _stretch_day("2026-10-02", b"!").items()
            if key.endswith("manifest.json")
        }
    )
    del remote.objects[next(key for key in remote.objects if "2026-10-03/stretch_summary" in key)]
    sync_stretches(remote, tmp_path, 0, TODAY, rollups=False)
    assert _local_days(tmp_path) == ["2026-10-02", "2026-10-03", "2026-11-27"]
    assert not (tmp_path / "stretch/v13/stm/2026-10-01").exists()
    assert all(key in remote.objects for key in _stretch_day("2026-10-01"))
    # A local file that differs from its receipt is not taken as verified either.
    local = next((tmp_path / "stretch/v13/stm/2026-11-27").glob("stretch_passes-*"))
    local.write_bytes(b"!" * local.stat().st_size)
    sync_stretches(remote, tmp_path, 0, date(2026, 12, 30), rollups=False)
    assert "2026-11-27" in _local_days(tmp_path)
