import json
from collections import Counter
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import duckdb
import pytest
from google.transit.gtfs_realtime_pb2 import FeedMessage, TripDescriptor, VehiclePosition
from history_fixtures import scripted_feed_day
from typer.testing import CliRunner

from transit_ops.clean_day_inputs import archived_captures
from transit_ops.cli import app
from transit_ops.history.manifest import build_manifest, encode_manifest
from transit_ops.history.pack import write_pack
from transit_ops.ingestion.realtime_gtfs import build_realtime_object_storage_path
from transit_ops.providers.registry import load_provider_manifest

DAY = date(2026, 6, 1)
NEXT = date(2026, 6, 2)
MIDNIGHT = datetime(2026, 6, 2, 4, tzinfo=UTC)
TRIPS = {
    "night": ("r", ["24:00:00", "24:05:00", "24:10:00", "24:15:00"]),
    "cancel": ("r", ["14:00:00"]),
    "missing": ("r", ["15:00:00"]),
    "forecast": ("r", ["16:00:00"]),
    "gap": ("metro", ["17:00:00"]),
}


def _edition(path: Path, trips: dict[str, tuple[str, list[str]]], day: date) -> dict[str, str]:
    with ZipFile(path, "w") as archive:
        archive.writestr("routes.txt", "route_id,route_type\nr,3\nmetro,1\n")
        archive.writestr(
            "trips.txt",
            "route_id,service_id,trip_id,direction_id\n"
            + "".join(f"{route},s,{trip},0\n" for trip, (route, _) in trips.items()),
        )
        archive.writestr(
            "stops.txt",
            "stop_id,stop_name,stop_lat,stop_lon\n"
            + "".join(f"s{seq},Stop {seq},45.5,-73.6\n" for seq in range(1, 5)),
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
            "service_id,date,exception_type\ns,20260601,1\ns,20260602,1\n",
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


def _save(root: Path, feed: FeedMessage, family: str, captured: datetime) -> None:
    payload = feed.SerializeToString()
    key = build_realtime_object_storage_path("stm", family, captured, sha256(payload).hexdigest())
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

    for seconds, delay in ((-60, 20), (-30, 10)):
        stamp = MIDNIGHT + timedelta(seconds=seconds)
        feed = _feed(stamp)
        entity = feed.entity.add(id="night")
        update = entity.trip_update
        update.trip.trip_id = "night"
        update.trip.start_date = "20260601"
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


def _run(root: Path, day: date) -> Path:
    result = CliRunner().invoke(app, _args(root, day))
    assert result.exit_code == 0, (result.output, result.exception)
    return root / "out" / "stm" / day.isoformat() / "v1"


def _args(root: Path, day: date) -> list[str]:
    return [
        "clean-day",
        "--provider",
        "stm",
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
                assert metadata[b"cleaning_version"] == b"1"
    assert all(row["cleaning_version"] == "1" for row in trips + stops + next_stops)
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
    public_states = {"night": "ran", "cancel": "cancelled", "missing": "missing", "extra": "added"}
    assert Counter(row["state"] for row in trips) == Counter(
        public_states.get(trip) for trip in (*TRIPS, "extra")
    )
    states = {r["trip_id"]: r for r in trips}
    assert len(states) == len(trips) == len(TRIPS) + 1
    assert all(states[trip]["state"] == state for trip, state in public_states.items())
    assert states["cancel"]["first_capture_utc"] == states["cancel"]["last_capture_utc"]
    assert states["cancel"]["cancellation_notice_utc"] == MIDNIGHT - timedelta(hours=6)
    assert states["gap"]["route_has_live_data"] is False and states["gap"]["state"] is None
    assert states["forecast"]["route_has_live_data"] is True
    assert states["forecast"]["first_capture_utc"] and states["forecast"]["state"] is None
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
    assert len(TRIPS) == sum(r["state"] in {"ran", "cancelled", "missing", None} for r in trips)
    unchanged = {path.name: path.read_bytes() for path in first.glob("*.parquet")}
    result = CliRunner().invoke(app, _args(tmp_path, DAY))
    assert result.exit_code == 1 and "already exists" in result.output
    assert {path.name: path.read_bytes() for path in first.glob("*.parquet")} == unchanged


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
        replace(record, captures=captures, polls=record.polls[:3], processing=()),
        feed_endpoint_id=1,
        feed_kind="trip_updates",
        content_version=1,
        supersedes=None,
        pack_path=pack_path.name,
        pack=pack,
        sealed_at_utc=captures[-1].captured_at_utc,
        sealed_by="test",
    )
    path = tmp_path / "manifest.json.gz"
    path.write_bytes(encode_manifest(manifest))
    start, end = captures[1].captured_at_utc, captures[2].captured_at_utc
    rows = list(archived_captures(provider, tmp_path, [path], start, end))
    assert [(row.captured_at_utc, row.payload) for row in rows] == list(
        zip((start, end), payloads[1:], strict=True)
    )
    with pytest.raises(ValueError, match="duplicate capture"):
        list(archived_captures(provider, tmp_path, [path, path], start, end))
