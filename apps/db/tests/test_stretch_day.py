import json
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from io import StringIO
from math import cos, pi, radians
from pathlib import Path
from zipfile import ZipFile

import duckdb
import pytest
from google.transit.gtfs_realtime_pb2 import FeedMessage

from transit_ops import clean_days
from transit_ops.clean_day_output import version_key
from transit_ops.ingestion.realtime_gtfs import build_realtime_object_storage_path
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.stretch_day import CleanDayNotMeasured, fetch_clean_day, stretch_key_prefix

DAY = date(2026, 6, 1)
NOON = datetime(2026, 6, 1, 16, tzinfo=UTC)  # 12:00 in Montréal
LAT, LON = 45.5, -73.6
_METRES_PER_DEGREE_LON = pi / 180 * 6_371_008.8 * cos(radians(LAT))


def _lon(metres: float) -> float:
    return round(LON - metres / _METRES_PER_DEGREE_LON, 6)


def _schedule(raw: Path) -> None:
    path = raw / "archive/v1/schedules/stm/schedule.zip"
    path.parent.mkdir(parents=True)
    with ZipFile(path, "w") as archive:
        archive.writestr("routes.txt", "route_id,route_type\nr,3\n")
        archive.writestr(
            "trips.txt", "route_id,service_id,trip_id,direction_id,shape_id\nr,s,t1,0,sh\n"
        )
        archive.writestr(
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\n"
            + "".join(f"s{i},Stop {i},{LAT},{_lon(x)}\n" for i, x in enumerate((0, 500, 1000), 1)),
        )
        archive.writestr(
            "stop_times.txt",
            "trip_id,stop_sequence,stop_id,arrival_time,departure_time\n"
            "t1,1,s1,12:00:00,12:00:00\nt1,2,s2,12:01:00,12:01:00\nt1,3,s3,12:02:00,12:02:00\n",
        )
        archive.writestr(
            "shapes.txt",
            "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
            + "".join(f"sh,{LAT},{_lon(x)},{i}\n" for i, x in enumerate(range(0, 1001, 50))),
        )
        archive.writestr(
            "calendar_dates.txt",
            "service_id,date,exception_type\n"
            + "".join(f"s,{DAY + timedelta(days=offset):%Y%m%d},1\n" for offset in range(-1, 3)),
        )
    checksum = sha256(path.read_bytes()).hexdigest()
    path.rename(path.with_name(f"{checksum}.zip"))
    edition = {"effective_date": "2026-05-01", "path": f"{checksum}.zip", "sha256": checksum}
    (path.parent / "editions.json").write_text(
        json.dumps({"provider": "stm", "editions": [edition]}), encoding="utf-8"
    )


def _drive(raw: Path) -> None:
    """One vehicle at 10 m/s along the 1 km street, a reading every 20 s."""
    for step in range(-3, 9):
        captured = NOON + timedelta(seconds=20 * step)
        feed = FeedMessage()
        feed.header.gtfs_realtime_version = "2.0"
        feed.header.timestamp = int(captured.timestamp())
        vehicle = feed.entity.add(id="v").vehicle
        vehicle.trip.trip_id, vehicle.trip.start_date = "t1", "20260601"
        vehicle.vehicle.id = "v1"
        vehicle.timestamp = int(captured.timestamp())
        vehicle.position.latitude = LAT
        vehicle.position.longitude = _lon(min(max(step, 0) * 200, 1000))
        payload = feed.SerializeToString()
        key = build_realtime_object_storage_path(
            "stm", "vehicle_positions", captured, sha256(payload).hexdigest()
        )
        (raw / key).parent.mkdir(parents=True, exist_ok=True)
        (raw / key).write_bytes(payload)


def _clean(raw: Path, dest: Path) -> str:
    summary = StringIO()
    clean_days.run_clean_days(
        "stm", str(raw), str(dest), selection=(DAY.isoformat(), DAY.isoformat()), summary=summary
    )
    return summary.getvalue()


@pytest.fixture
def raw(tmp_path: Path) -> Path:
    root = tmp_path / "raw"
    _schedule(root)
    _drive(root)
    return root


def test_nightly_cleaning_times_stretches_after_the_v12_day(raw: Path, tmp_path: Path) -> None:
    dest = tmp_path / "clean"
    report = _clean(raw, dest)
    assert f"- Built: {DAY}\n" in report
    assert f"- Stretch timing built: {DAY}\n" in report
    folder = dest / stretch_key_prefix("stm", DAY)
    receipt = json.loads((folder / "manifest.json").read_text("utf-8"))
    v12 = (dest / version_key("stm", DAY) / "manifest.json").read_bytes()
    assert receipt["source_manifest_sha256"] == sha256(v12).hexdigest()
    assert receipt["schedule_sha256"] == json.loads(v12)["schedule_sha256"]
    assert receipt["cleaning_version"] == "13"
    assert set(receipt["files"]) == {
        "stretches.parquet",
        "stretch_passes.parquet",
        "stretch_summary.parquet",
    }
    for name, entry in receipt["files"].items():
        data = (folder / name).read_bytes()
        assert (sha256(data).hexdigest(), len(data)) == (entry["sha256"], entry["byte_size"])
    with duckdb.connect() as connection:
        passes = connection.execute(
            "SELECT count(*), count(DISTINCT from_stop), min(route_id), max(route_id) "
            "FROM read_parquet(?)",
            [str(folder / "stretch_passes.parquet")],
        ).fetchone()
        counted = connection.execute(
            "SELECT sum(passes), min(route_type), min(hour) FROM read_parquet(?)",
            [str(folder / "stretch_summary.parquet")],
        ).fetchone()
    assert passes == (10, 2, "r", "r")
    assert counted == (receipt["facts"]["summary_passes"], 3, 12)
    # The v12 day folder keeps exactly the files its receipt lists.
    listed = set(json.loads(v12)["files"]) | {"manifest.json"}
    assert {path.name for path in (dest / version_key("stm", DAY)).iterdir()} == listed

    again = _clean(raw, dest)
    assert f"- Skipped as already built: {DAY}\n" in again
    assert "- Stretch timing built: none\n" in again


def test_a_stretch_failure_keeps_the_v12_day_and_is_retried(
    raw: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = tmp_path / "clean"

    def broken(*_: object) -> None:
        raise ValueError("boom")

    with monkeypatch.context() as patch:
        patch.setattr(clean_days, "_build_stretch_day", broken)
        report = _clean(raw, dest)
    assert f"- Built: {DAY}\n" in report
    assert f"- Stretch timing failed: {DAY}\n" in report
    assert not (dest / stretch_key_prefix("stm", DAY)).exists()
    assert f"- Stretch timing built: {DAY}\n" in _clean(raw, dest)


def test_source_files_must_match_their_receipt(raw: Path, tmp_path: Path) -> None:
    dest = tmp_path / "clean"
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(clean_days, "_build_stretch_day", lambda *_: None)
        _clean(raw, dest)
    storage = LocalBronzeStorage(storage_backend="local", root=dest)
    target = dest / version_key("stm", DAY) / "trip_days.parquet"
    target.write_bytes(target.read_bytes() + b"x")
    folder = tmp_path / "copy"
    folder.mkdir()
    with pytest.raises(ValueError, match="differs from its receipt"):
        fetch_clean_day(storage, "", "stm", DAY, folder)


def test_a_day_settled_without_tables_has_no_stretch_timing(tmp_path: Path) -> None:
    dest = tmp_path / "clean"
    marker = dest / version_key("stm", DAY) / "manifest.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(
        json.dumps({
            "status": "no_raw_captures", "provider": "stm", "service_date": DAY.isoformat(),
            "cleaning_version": "12",
        }),
        encoding="utf-8",
    )  # fmt: skip
    storage = LocalBronzeStorage(storage_backend="local", root=dest)
    folder = tmp_path / "copy"
    folder.mkdir()
    with pytest.raises(CleanDayNotMeasured):
        fetch_clean_day(storage, "", "stm", DAY, folder)
