import json
from collections import Counter
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO, cast
from zipfile import ZipFile

import boto3
import duckdb
import pytest
from botocore.exceptions import ClientError
from google.transit.gtfs_realtime_pb2 import FeedMessage, TripDescriptor, VehiclePosition
from history_fixtures import scripted_feed_day
from typer.testing import CliRunner

from transit_ops import clean_day_inputs
from transit_ops.clean_day import CLEANING_VERSION
from transit_ops.clean_day_inputs import archived_captures
from transit_ops.clean_day_output import version_key
from transit_ops.cli import app
from transit_ops.history.manifest import build_manifest, encode_manifest
from transit_ops.history.pack import write_pack
from transit_ops.history.poll_record import PollRecord
from transit_ops.ingestion.common import build_bronze_object_storage_path
from transit_ops.ingestion.realtime_gtfs import build_realtime_object_storage_path
from transit_ops.providers.registry import load_provider_manifest

DAY = date(2026, 6, 1)
NEXT = date(2026, 6, 2)
MIDNIGHT = datetime(2026, 6, 2, 4, tzinfo=UTC)
TRIPS = {
    "night": ("r", ["24:00:00", "24:05:00", "24:10:00", "24:15:00"]),
    "cancel": ("r", ["14:00:00"]),
    "missing": ("r", ["15:00:00"]),
    "capture_gap": ("r", ["15:05:00", "15:10:00"]),
    "forecast": ("r", ["16:00:00"]),
    "gap": ("metro", ["17:00:00"]),
}


def _edition(
    path: Path,
    trips: dict[str, tuple[str, list[str]]],
    day: date,
    *,
    route_type: int = 1,
    coords: str = "45.5,-73.6",
) -> dict[str, str]:
    with ZipFile(path, "w") as archive:
        archive.writestr("routes.txt", f"route_id,route_type\nr,3\nmetro,{route_type}\n")
        archive.writestr(
            "trips.txt",
            "route_id,service_id,trip_id,direction_id\n"
            + "".join(f"{route},s,{trip},0\n" for trip, (route, _) in trips.items()),
        )
        archive.writestr(
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\n"
            + "".join(f"s{seq},Stop {seq},{coords}\n" for seq in range(1, 5)),
        )
        archive.writestr(
            "stop_times.txt",
            "trip_id,stop_sequence,stop_id,arrival_time,departure_time\n"
            + "".join(
                f"{trip},{seq},s{seq},{time},{time}\n"
                for trip, (_, times) in trips.items()
                for seq, time in enumerate(times, 1)
            ),
        )
        archive.writestr(
            "calendar_dates.txt",
            "service_id,date,exception_type\n"
            + "".join(f"s,{day + timedelta(days=offset):%Y%m%d},1\n" for offset in range(4)),
        )
    return {
        "effective_date": day.isoformat(),
        "path": path.name,
        "sha256": sha256(path.read_bytes()).hexdigest(),
    }


def _feed(published: datetime) -> FeedMessage:
    feed = FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = int(published.timestamp())
    return feed


def _save(
    root: Path, feed: FeedMessage, family: str, captured: datetime, provider: str = "stm"
) -> None:
    payload = feed.SerializeToString()
    key = build_realtime_object_storage_path(
        provider, family, captured, sha256(payload).hexdigest()
    )
    path = root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _capture_fixture(root: Path) -> None:
    stamp = MIDNIGHT - timedelta(hours=6)
    feed = _feed(stamp)
    cancel = feed.entity.add(id="cancel").trip_update
    cancel.trip.trip_id = "cancel"
    cancel.trip.start_date = "20260601"
    cancel.trip.schedule_relationship = TripDescriptor.CANCELED
    withdrawn = feed.entity.add(id="withdrawn").trip_update
    withdrawn.trip.trip_id = "night"
    withdrawn.trip.start_date = "20260601"
    withdrawn.trip.schedule_relationship = TripDescriptor.CANCELED
    forecast = feed.entity.add(id="forecast").trip_update
    forecast.trip.trip_id = "forecast"
    forecast.trip.start_date = "20260601"
    forecast.stop_time_update.add(stop_sequence=1).arrival.time = int(stamp.timestamp()) + 60
    extra = feed.entity.add(id="extra").trip_update
    extra.trip.trip_id = "extra"
    extra.trip.route_id = "r"
    extra.trip.start_date = "20260601"
    extra.trip.schedule_relationship = TripDescriptor.ADDED
    item = extra.stop_time_update.add(stop_sequence=1, stop_id="s1")
    item.arrival.time = int(stamp.timestamp()) - 20
    item.arrival.uncertainty = 0
    _save(root, feed, "trip_updates", stamp)
    _save(root, feed, "trip_updates", stamp + timedelta(seconds=30))
    feed.entity.add().CopyFrom(feed.entity[0])
    _save(root, feed, "trip_updates", stamp + timedelta(seconds=40))

    # Both feeds bracket the silent 15:00 trip. Vehicle polls lapse during
    # the later trip even though the trip-update feed stays current.
    for minute in range(-5, 12):
        stamp = MIDNIGHT - timedelta(hours=9) + timedelta(minutes=minute)
        feed = _feed(stamp)
        feed.entity.add(id="coverage").trip_update.trip.route_id = "r"
        _save(root, feed, "trip_updates", stamp)
        if not 2 <= minute <= 5:
            published = stamp - timedelta(minutes=minute - 1) if 6 <= minute <= 7 else stamp
            feed = _feed(published)
            feed.entity.add(id=f"coverage-{minute}").vehicle.trip.route_id = "r"
            _save(root, feed, "vehicle_positions", stamp)

    for seconds, delay in ((-60, 20), (-30, 10)):
        stamp = MIDNIGHT + timedelta(seconds=seconds)
        feed = _feed(stamp)
        entity = feed.entity.add(id="night")
        update = entity.trip_update
        update.trip.trip_id = "night"
        update.trip.start_date = "20260601"
        update.trip.schedule_relationship = TripDescriptor.SCHEDULED
        update.vehicle.id = "v1"
        update.stop_time_update.add(stop_sequence=1).arrival.delay = delay
        update.stop_time_update.add(stop_sequence=2).departure.delay = -40
        feed.entity.add().CopyFrom(entity)
        _save(root, feed, "trip_updates", stamp)

    for seconds, seq, lat, status in (
        (45, 1, 45.51, VehiclePosition.STOPPED_AT),
        (520, 3, 45.50, VehiclePosition.IN_TRANSIT_TO),
        (633, 3, 45.50, VehiclePosition.STOPPED_AT),
        (670, 3, 45.50, VehiclePosition.STOPPED_AT),
    ):
        stamp = MIDNIGHT + timedelta(seconds=seconds)
        feed = _feed(stamp)
        vehicle = feed.entity.add(id="v1").vehicle
        vehicle.trip.trip_id = "night"  # Match the previous service day's window without a date.
        vehicle.vehicle.id = "v1"
        vehicle.current_stop_sequence = seq
        vehicle.current_status = status
        vehicle.position.latitude = lat
        vehicle.position.longitude = -73.6
        _save(root, feed, "vehicle_positions", stamp)

    stamp = MIDNIGHT + timedelta(seconds=930)
    feed = _feed(stamp)
    update = feed.entity.add(id="night").trip_update
    update.trip.trip_id = "night"
    update.trip.start_date = "20260601"
    update.vehicle.id = "v1"
    update.stop_time_update.add(stop_sequence=1).arrival.delay = 900
    arrival = update.stop_time_update.add(stop_sequence=4).arrival
    arrival.time = int(stamp.timestamp()) - 5
    arrival.uncertainty = 0
    _save(root, feed, "trip_updates", stamp)


def _run(root: Path, day: date, provider: str = "stm") -> Path:
    result = CliRunner().invoke(app, _args(root, day, provider))
    assert result.exit_code == 0, (result.output, result.exception)
    return root / "out" / version_key(provider, day)


def _args(root: Path, day: date, provider: str = "stm") -> list[str]:
    return [
        "clean-day",
        "--provider",
        provider,
        "--date",
        day.isoformat(),
        "--bronze",
        str(root),
        "--editions",
        str(root / "editions.json"),
        "--out",
        str(root / "out"),
    ]


def _index(root: Path) -> list[dict[str, str]]:
    editions = [
        _edition(root / "old.zip", TRIPS, DAY),
        _edition(root / "new.zip", {"night": ("r", ["10:00:00"])}, NEXT),
    ]
    (root / "editions.json").write_text(
        json.dumps({"provider": "stm", "editions": editions}),
        encoding="utf-8",
    )
    return editions


def _rows(db: duckdb.DuckDBPyConnection, path: Path) -> list[dict[str, Any]]:
    source = db.read_parquet(str(path))
    projection = ", ".join(
        f"timezone('UTC', {name}) AS {name}" if name.endswith("_utc") else name
        for name in source.columns
    )
    return [
        dict(
            zip(
                source.columns,
                (
                    value.replace(tzinfo=UTC) if isinstance(value, datetime) else value
                    for value in row
                ),
                strict=True,
            )
        )
        for row in source.project(projection).fetchall()
    ]


def test_clean_day_math_and_edition_switch(tmp_path: Path) -> None:
    editions = _index(tmp_path)
    _capture_fixture(tmp_path)
    first = _run(tmp_path, DAY)
    later = _run(tmp_path, NEXT)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        trips = _rows(db, first / "trip_days.parquet")
        stops = _rows(db, first / "stop_events.parquet")
        next_stops = _rows(db, later / "stop_events.parquet")
        for directory, edition in zip((first, later), editions, strict=True):
            for path in directory.glob("*.parquet"):
                metadata = dict(
                    db.execute(
                        "SELECT key, value FROM parquet_kv_metadata(?)", [str(path)]
                    ).fetchall()
                )
                assert metadata[b"schedule_sha256"] == edition["sha256"].encode()
                assert metadata[b"cleaning_version"] == CLEANING_VERSION.encode()
    assert all(row["cleaning_version"] == CLEANING_VERSION for row in trips + stops + next_stops)
    assert [(r["trip_id"], r["scheduled_arrival_utc"]) for r in next_stops] == [
        ("night", MIDNIGHT + timedelta(hours=10)),
    ]
    assert next_stops[0]["observed_at_utc"] is None
    assert [(r["trip_id"], r["stop_sequence"]) for r in stops] == sorted(
        {(r["trip_id"], r["stop_sequence"]) for r in stops}
    )
    assert all(r["service_date"] == DAY for r in trips + stops)

    # Recompute expected totals from the seed's scheduled rows and the handful
    # of independently enumerated facts injected into the feeds.
    evidence = {
        ("night", 1): ("trip_update_passed", 10),
        ("night", 2): ("trip_update_passed", -40),
        ("night", 3): ("vehicle_stopped", 33),
        ("night", 4): ("trip_update_reported", 25),
        ("extra", 1): ("trip_update_reported", None),
    }
    expected_bases = Counter(basis for basis, _ in evidence.values())
    expected_bases["not_observed"] = sum(len(times) for _, times in TRIPS.values()) - 4
    assert Counter(r["basis"] for r in stops) == expected_bases
    assert {r["trip_id"] for r in trips if r["state"] != "added"} == TRIPS.keys()
    public_states = {
        "night": "ran",
        "cancel": "cancelled",
        "missing": "missing",
        "forecast": "unconfirmed",
        "gap": "not_measured",
        "capture_gap": "not_measured",
        "extra": "added",
    }
    assert Counter(row["state"] for row in trips) == Counter(
        public_states.get(trip) for trip in (*TRIPS, "extra")
    )
    states = {r["trip_id"]: r for r in trips}
    assert len(states) == len(trips) == len(TRIPS) + 1
    assert all(states[trip]["state"] == state for trip, state in public_states.items())
    assert states["cancel"]["first_capture_utc"] == states["cancel"]["last_capture_utc"]
    assert states["cancel"]["cancellation_notice_utc"] == MIDNIGHT - timedelta(hours=6)
    assert states["night"]["cancellation_notice_utc"] == MIDNIGHT - timedelta(hours=6)
    assert states["gap"]["route_has_live_data"] is False
    assert states["gap"]["state_reason"] == "route_without_live_data"
    assert states["capture_gap"]["route_has_live_data"] is True
    assert states["capture_gap"]["state_reason"] == "capture_gap"
    assert all(row["state_reason"] is None for row in trips if row["state"] != "not_measured")
    assert states["forecast"]["route_has_live_data"] is True
    assert states["forecast"]["first_capture_utc"]
    assert states["night"]["vehicle_id"] == "v1"
    for trip, (_, expected) in TRIPS.items():
        selected = [r for r in stops if r["trip_id"] == trip]
        observed = [r["observed_at_utc"] for r in selected if r["observed_at_utc"] is not None]
        absent = [r for r in selected if r["basis"] == "not_observed"]
        assert len(expected) == len(observed) + len(absent)
        assert observed == sorted(observed)
        if states[trip]["state"] == "ran":
            assert observed
        if states[trip]["state"] == "missing":
            assert not observed
    for row in stops:
        basis, delay = evidence.get((row["trip_id"], row["stop_sequence"]), ("not_observed", None))
        assert (row["basis"], row["delay_seconds"]) == (basis, delay)
        arrival, departure = row["scheduled_arrival_utc"], row["scheduled_departure_utc"]
        if arrival is not None:
            assert departure >= arrival
        if delay is not None:
            expected_time = departure if row["observed_event"] == "departure" else arrival
            assert (row["observed_at_utc"] - expected_time).total_seconds() == delay
    counts = Counter(row["state"] for row in trips)
    assert len(TRIPS) == sum(
        counts[state] for state in ("ran", "cancelled", "missing", "unconfirmed", "not_measured")
    )
    unchanged = {path.name: path.read_bytes() for path in first.glob("*.parquet")}
    result = CliRunner().invoke(app, _args(tmp_path, DAY))
    assert result.exit_code == 1 and "already exists" in result.output
    assert {path.name: path.read_bytes() for path in first.glob("*.parquet")} == unchanged

    receipt = json.loads((first / "manifest.json").read_bytes())
    assert receipt["provider"] == "stm" and receipt["service_date"] == DAY.isoformat()
    assert receipt["cleaning_version"] == CLEANING_VERSION
    assert receipt["schedule_sha256"] == editions[0]["sha256"]
    assert datetime.fromisoformat(receipt["built_at_utc"]).utcoffset() == timedelta(0)
    assert Counter(receipt["row_counts_by_state"]) == counts
    assert Counter(receipt["row_counts_by_basis"]) == expected_bases
    for name, rows in (("trip_days", trips), ("stop_events", stops)):
        filename = f"{name}.parquet"
        payload = (first / filename).read_bytes()
        assert receipt["files"][filename] == {
            "rows": len(rows),
            "sha256": sha256(payload).hexdigest(),
            "byte_size": len(payload),
        }


def test_local_archive_reads_the_selected_capture_bytes(tmp_path: Path) -> None:
    provider = load_provider_manifest(
        Path(__file__).resolve().parents[1] / "config" / "providers" / "stm.yaml"
    )
    record, payloads = scripted_feed_day(  # type: ignore[no-untyped-call]
        provider_id="stm", endpoint_key="trip_updates"
    )
    pack_path = tmp_path / "pack.xz"
    with pack_path.open("wb") as stream:
        pack = write_pack(payloads, stream)
    assert pack is not None
    captures = tuple(
        replace(entry, stream=part.stream, offset=part.offset)
        for entry, part in zip(record.captures[:3], pack.captures, strict=True)
    )
    manifest = build_manifest(
        replace(record, captures=(*captures, *record.captures[3:])),
        feed_endpoint_id=1,
        feed_kind="trip_updates",
        content_version=1,
        supersedes=None,
        pack_path=pack_path.name,
        pack=pack,
        sealed_at_utc=record.captures[-1].captured_at_utc,
        sealed_by="test",
    )
    path = tmp_path / "manifest.json.gz"
    path.write_bytes(encode_manifest(manifest))
    start, end = captures[1].captured_at_utc, record.captures[-1].captured_at_utc
    rows = list(archived_captures(provider, tmp_path, [path], start, end))
    assert [(row.captured_at_utc, row.payload) for row in rows] == list(
        zip((start, captures[2].captured_at_utc), payloads[1:], strict=True)
    )
    with pytest.raises(ValueError, match="duplicate capture"):
        list(archived_captures(provider, tmp_path, [path, path], start, end))


@pytest.mark.parametrize("vehicles_enabled", [True, False])
def test_ottawa_service_day(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vehicles_enabled: bool
) -> None:
    day = date(2026, 11, 1)
    # Local noon minus 12 elapsed hours is 05:00 UTC on the fall DST transition,
    # even though 00:00 wall time still has the previous offset.
    scheduled = datetime(2026, 11, 2, 5, tzinfo=UTC)
    edition = _edition(
        tmp_path / "ottawa.zip",
        {
            "night": ("r", ["24:00:00", "24:05:00", "24:10:00"]),
            "quiet": ("r", ["24:00:00"]),
            "train": ("metro", ["24:00:00"]),
        },
        day,
        route_type=0,
        coords="45.4,-75.7",
    )
    provider = "octranspo"
    (tmp_path / "editions.json").write_text(
        json.dumps({"provider": provider, "editions": [edition]}), encoding="utf-8"
    )
    if not vehicles_enabled:
        declaration = clean_day_inputs.declaration_for(provider)
        declaration.feeds["vehicle_positions"].is_enabled = False
        monkeypatch.setattr(clean_day_inputs, "declaration_for", lambda _: declaration)

    # 150-second-old feed headers fall inside Ottawa's declared lag allowance.
    for seconds in range(-300, 301, 60):
        captured = scheduled + timedelta(seconds=seconds)
        for family in ("trip_updates", "vehicle_positions"):
            feed = _feed(captured - timedelta(seconds=150))
            feed.entity.add(id="poll")
            _save(tmp_path, feed, family, captured, provider)

    published = scheduled + timedelta(seconds=20)
    updates = _feed(published)
    night = updates.entity.add(id="bus").trip_update
    night.trip.trip_id = "night"
    night.trip.start_time = "24:00:00"
    night.vehicle.id = "bus-007"
    night.stop_time_update.add(stop_id="s1").arrival.delay = 12
    wrong = updates.entity.add(id="wrong").trip_update
    wrong.trip.trip_id = "night"
    wrong.trip.start_time = "24:15:00"
    item = wrong.stop_time_update.add(stop_sequence=3)
    item.arrival.time = int(published.timestamp())
    item.arrival.uncertainty = 0
    train = updates.entity.add(id="train").trip_update
    train.trip.trip_id = "train"
    train.trip.start_date = "20261101"
    train.stop_time_update.add(stop_id="s1").arrival.CopyFrom(item.arrival)
    reported_at = scheduled + timedelta(minutes=10, seconds=24)
    exact = _feed(reported_at + timedelta(seconds=10))
    update = exact.entity.add(id="exact").trip_update
    update.trip.trip_id = "night"
    update.trip.start_date = "20261101"
    arrival = update.stop_time_update.add(stop_id="s3").arrival
    arrival.time, arrival.uncertainty = int(reported_at.timestamp()), 0
    _save(tmp_path, updates, "trip_updates", published, provider)
    _save(tmp_path, exact, "trip_updates", reported_at + timedelta(seconds=10), provider)

    stopped_at = scheduled + timedelta(minutes=5, seconds=10)
    positions = _feed(stopped_at)
    vehicle = positions.entity.add(id="position").vehicle
    vehicle.trip.trip_id = "night"
    vehicle.trip.start_date = "20261101"
    vehicle.stop_id = "s2"
    vehicle.vehicle.id = "bus-007"
    vehicle.current_status = VehiclePosition.STOPPED_AT
    vehicle.position.latitude, vehicle.position.longitude = 45.4, -75.7
    _save(tmp_path, positions, "vehicle_positions", stopped_at, provider)

    destination = _run(tmp_path, day, provider)
    with duckdb.connect() as db:
        trips = {row["trip_id"]: row for row in _rows(db, destination / "trip_days.parquet")}
        stops = {
            row["stop_id"]: row
            for row in _rows(db, destination / "stop_events.parquet")
            if row["trip_id"] == "night"
        }
    assert trips["night"]["scheduled_start_utc"] == scheduled
    assert trips["night"]["state"] == "ran"
    assert trips["quiet"]["state"] == "missing"
    assert trips["train"]["state_reason"] == "route_without_live_data"
    assert trips["train"]["first_capture_utc"] is None
    assert [
        (stops[key]["basis"], stops[key]["delay_seconds"], stops[key]["vehicle_id"])
        for key in ("s1", "s2", "s3")
    ] == [
        ("trip_update_passed", 12, "bus-007") if vehicles_enabled else ("not_observed", None, None),
        ("vehicle_stopped", 10, "bus-007") if vehicles_enabled else ("not_observed", None, None),
        ("trip_update_reported", 24, None),
    ]


def _archive_capture(root: Path, stamp: datetime) -> None:
    record, _ = scripted_feed_day(  # type: ignore[no-untyped-call]
        provider_id="stm", endpoint_key="trip_updates"
    )
    record = cast(PollRecord, record)
    feed = _feed(stamp)
    update = feed.entity.add(id="scheduled").trip_update
    update.trip.trip_id = "night"
    update.trip.start_date = f"{stamp:%Y%m%d}"
    payload = feed.SerializeToString()
    base = f"archive/v1/captures/stm/trip_updates/{stamp:%Y/%m/%Y-%m-%d}.c"
    pack_key = f"{base}10.pack.xz"
    pack_path = root / pack_key
    pack_path.parent.mkdir(parents=True, exist_ok=True)
    with pack_path.open("wb") as stream:
        pack = write_pack([payload], stream)
    assert pack is not None
    capture = replace(
        record.captures[0],
        captured_at_utc=stamp,
        object_created_at_utc=stamp,
        started_at_utc=stamp,
        feed_timestamp_utc=stamp,
        byte_size=len(payload),
        sha256=sha256(payload).hexdigest(),
    )
    poll = replace(
        record.polls[0],
        requested_at_utc=stamp,
        started_at_utc=stamp,
        completed_at_utc=stamp,
        time_utc=stamp,
        feed_timestamp_utc=stamp,
    )
    manifest = build_manifest(
        replace(
            record,
            feed_day=replace(record.feed_day, utc_date=stamp.date()),
            captures=(capture,),
            polls=(poll,),
            processing=(),
        ),
        feed_endpoint_id=1,
        feed_kind="trip_updates",
        content_version=10,
        supersedes=2,
        pack_path=pack_key,
        pack=pack,
        sealed_at_utc=stamp,
        sealed_by="test",
    )
    (root / f"{base}2.manifest.json.gz").write_bytes(b"older version")
    (root / f"{base}10.manifest.json.gz").write_bytes(encode_manifest(manifest))


class _FakeS3:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.writes: list[str] = []
        self.fail_stop_upload = False

    def head_object(self, *, Bucket: str, Key: str) -> None:  # noqa: N803
        if not (self.root / Bucket / Key).is_file():
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")

    def list_objects_v2(self, *, Bucket: str, Prefix: str) -> dict[str, object]:  # noqa: N803
        root = self.root / Bucket
        return {
            "Contents": [
                {"Key": key}
                for path in root.rglob("*")
                if path.is_file()
                if (key := path.relative_to(root).as_posix()).startswith(Prefix)
            ]
        }

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, BytesIO]:  # noqa: N803
        return {"Body": BytesIO((self.root / Bucket / Key).read_bytes())}

    def put_object(
        self,
        *,
        Bucket: str,
        Key: str,
        Body: BinaryIO,
        IfNoneMatch: str,  # noqa: N803
    ) -> None:
        assert Bucket == "clean"
        assert IfNoneMatch == "*"
        if self.fail_stop_upload and Key.endswith("stop_events.parquet"):
            raise ClientError({"Error": {"Code": "ServiceUnavailable"}}, "PutObject")
        path = self.root / Bucket / Key
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("xb") as target:
                target.write(Body.read())
        except FileExistsError as exc:
            raise ClientError(
                {
                    "ResponseMetadata": {
                        "HTTPStatusCode": 412,
                        "HTTPHeaders": {},
                        "RequestId": "",
                        "HostId": "",
                        "RetryAttempts": 0,
                    }
                },
                "PutObject",
            ) from exc
        self.writes.append(Key)


@pytest.mark.parametrize("remote", [False, True])
def test_range_builds_skips_and_continues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, remote: bool
) -> None:
    raw = tmp_path / "raw" / "in"
    dest = tmp_path / "clean" / "out"
    raw.mkdir(parents=True)
    third = DAY + timedelta(days=2)
    editions = []
    for day in (DAY, third):
        stamp = datetime(day.year, day.month, day.day, 16, tzinfo=UTC)
        path = raw / f"{day}.zip"
        entry = _edition(path, {"night": ("r", ["12:00:00"])}, day)
        key = build_bronze_object_storage_path(
            provider_id="stm",
            endpoint_key="static_schedule",
            partition_label="ingested_at_utc",
            observed_at_utc=stamp - timedelta(hours=10),
            object_name="schedule.zip",
            checksum_sha256=entry["sha256"],
        )
        original = raw / key
        original.parent.mkdir(parents=True, exist_ok=True)
        path.rename(original)
        archive = raw / "archive" / "v1" / "schedules" / "stm" / f"{entry['sha256']}.zip"
        archive.parent.mkdir(parents=True, exist_ok=True)
        if remote:
            original.rename(archive)
        else:
            archive.write_bytes(original.read_bytes())
        editions.append({**entry, "path": archive.name})
        _archive_capture(raw, stamp)

    source, destination = str(raw), str(dest)
    fake = _FakeS3(tmp_path)
    if remote:
        (archive.parent / "editions.json").write_text(
            json.dumps({"provider": "stm", "editions": editions}), encoding="utf-8"
        )
        source, destination = "s3://raw/in", "s3://clean/out"
        for role in ("SOURCE", "DEST"):
            monkeypatch.setenv(f"CLEAN_{role}_S3_ENDPOINT", "https://example.invalid")
            monkeypatch.setenv(f"CLEAN_{role}_S3_ACCESS_KEY_ID", f"{role}-test")
            monkeypatch.setenv(f"CLEAN_{role}_S3_SECRET_ACCESS_KEY", "dummy")
        monkeypatch.setattr(boto3.session.Session, "client", lambda *a, **k: fake)
    args = [
        "clean-days",
        "--provider",
        "stm",
        "--source",
        source,
        "--dest",
        destination,
        "--from",
        DAY.isoformat(),
        "--to",
    ]
    marker = f"{version_key('stm', DAY)}/manifest.json"
    runner = CliRunner()
    if remote:
        fake.fail_stop_upload = True
        attempt = runner.invoke(app, [*args, DAY.isoformat()])
        assert attempt.exit_code == 1 and "ServiceUnavailable" in attempt.output
        assert not (dest / marker).exists()
        fake.fail_stop_upload = False
    first = runner.invoke(app, [*args, DAY.isoformat()])
    assert first.exit_code == 0, (first.output, first.exception)
    assert "Built 1, skipped 0, failed 0" in first.output
    if remote:
        assert fake.writes == [
            f"out/{version_key('stm', DAY)}/{name}"
            for name in ("trip_days.parquet", "stop_events.parquet", "manifest.json")
        ]
    manifest = (dest / marker).read_bytes()
    result = runner.invoke(app, [*args, third.isoformat()])
    assert result.exit_code == 1 and "Built 1, skipped 1, failed 1" in result.output
    assert f"{NEXT}: ValueError: No archived GTFS-Realtime captures" in result.output
    assert (dest / marker).read_bytes() == manifest
    latest = json.loads((dest / version_key("stm", third) / "manifest.json").read_bytes())
    assert latest["schedule_sha256"] == entry["sha256"]
    assert latest["row_counts_by_state"]["unconfirmed"] == 1
