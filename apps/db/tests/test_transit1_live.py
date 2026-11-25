import json
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path

import pytest
from google.transit.gtfs_realtime_pb2 import FeedMessage, VehiclePosition

from transit_ops.clean_day_inputs import declaration_for
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.playback import LivePublisher, _publish

NOW = datetime(2026, 11, 23, 0, 0, 5, tzinfo=UTC)


def message() -> FeedMessage:
    feed = FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = int(NOW.timestamp()) - 12
    return feed


def capture(root: Path, endpoint: str, message: FeedMessage, captured: datetime) -> Path:
    body = message.SerializeToString()
    name = f"{captured:%Y%m%dT%H%M%S%fZ}__{sha256(body).hexdigest()[:12]}__{endpoint}.pb"
    path = root / "stm" / endpoint / f"captured_at_utc={captured:%Y-%m-%d}" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def test_live_projection_retains_measurements_and_uses_the_previous_utc_day(tmp_path):
    vehicles = message()
    entity = vehicles.entity.add(id="run")
    entity.vehicle.position.latitude = 45.5
    entity.vehicle.position.longitude = -73.6
    entity.vehicle.vehicle.id = "40001"
    entity.vehicle.trip.trip_id = "a-trip"
    entity.vehicle.current_status = VehiclePosition.STOPPED_AT
    entity.vehicle.occupancy_status = VehiclePosition.EMPTY
    entity.vehicle.current_stop_sequence = 1
    captured = NOW - timedelta(seconds=10)
    capture(tmp_path, "vehicle_positions", vehicles, captured)

    updates = message()
    update = updates.entity.add(id="update").trip_update
    update.trip.trip_id = "a-trip"
    stop = update.stop_time_update.add(stop_id="a-stop", stop_sequence=1)
    stop.departure.delay = 0
    stop.departure.time = int(NOW.timestamp()) + 600
    capture(tmp_path, "trip_updates", updates, NOW)

    publisher = LivePublisher(declaration_for("stm"), LocalBronzeStorage("local", tmp_path))
    snapshot = publisher.poll(NOW)
    row = snapshot["vehicle_positions"][0]
    assert (row["latitude"], row["trip_id"], row["status"], row["occupancy"]) == (
        45.5,
        "a-trip",
        VehiclePosition.STOPPED_AT,
        VehiclePosition.EMPTY,
    )
    assert row["bearing"] is None
    assert row["delay"] is None
    assert snapshot["trip_updates"][0]["stops"][0]["departure_delay"] == 0
    assert snapshot["alerts"] is None
    assert snapshot["feeds"]["i3_alerts"]["captured_at"] is None
    assert snapshot["feeds"]["vehicle_positions"]["captured_at"] == captured.isoformat()


def test_observed_empty_feed_and_corrupt_successor_keep_distinct_states(tmp_path):
    publisher = LivePublisher(declaration_for("stm"), LocalBronzeStorage("local", tmp_path))
    assert publisher.poll(NOW)["vehicle_positions"] is None
    first = NOW + timedelta(seconds=20)
    capture(tmp_path, "vehicle_positions", message(), first)
    assert publisher.poll(first)["vehicle_positions"] == []

    second = first + timedelta(seconds=20)
    capture(tmp_path, "vehicle_positions", message(), second).write_bytes(b"corrupt")
    snapshot = publisher.poll(second)
    assert snapshot["vehicle_positions"] == []
    feed = snapshot["feeds"]["vehicle_positions"]
    assert feed["captured_at"] == first.isoformat()
    assert feed["read_failed"] is True


def test_local_destination_replaces_only_the_city_snapshot(tmp_path):
    dest = LocalBronzeStorage("local", tmp_path)
    key = "live/v2/stm.json"
    _publish(dest, key, b'{"version":2,"vehicle_positions":[]}')
    _publish(dest, key, b'{"version":2,"vehicle_positions":null}')
    assert json.loads(dest.read_bytes(key))["vehicle_positions"] is None
    assert list(dest.list_keys("live/")) == [key]


def test_city_poll_publishes_no_inline_updates_and_scopes_durable_trip_ranges(
    tmp_path, monkeypatch
):
    updates = message()
    for trip_id, route_id, stop_id in (
        ("linked", "24", "common"),
        ("other", "25", "common"),
        ("unassigned", "", "single"),
    ):
        update = updates.entity.add(id=trip_id).trip_update
        update.trip.trip_id = trip_id
        if route_id:
            update.trip.route_id = route_id
        stop = update.stop_time_update.add(stop_id=stop_id, stop_sequence=1)
        stop.departure.time = int(NOW.timestamp()) + 600
    capture(tmp_path, "trip_updates", updates, NOW)
    source = LocalBronzeStorage("local", tmp_path)
    publisher = LivePublisher(declaration_for("stm"), source)
    observed = publisher.poll(NOW)
    monkeypatch.setattr(publisher, "poll", lambda _: observed)
    dest = LocalBronzeStorage("local", tmp_path / "published")
    publisher.run(dest, "", once=True)

    main = json.loads(dest.read_bytes("live/v2/stm.json"))
    assert main["version"] == 2 and "trip_updates" not in main
    assert main["feeds"]["trip_updates"]["captured_at"] == NOW.isoformat()
    packed = dest.read_bytes("live/v2/stm/trips.bin")
    index = json.loads(dest.read_bytes("live/v2/stm/trips.json"))

    def read(scope):
        start, length = index["ranges"][scope]
        return json.loads(packed[start : start + length])

    assert read("trip:unassigned")["trip_id"] == "unassigned"
    assert [row[0] for row in read("stop:common")] == ["linked", "other"]
    assert [row["trip_id"] for row in read("line:24")] == ["linked"]

    # A scoped publication failure must leave the main city report available.
    monkeypatch.setattr("transit_ops.live.playback.MAX_TRIP_BUNDLE_BYTES", 1)
    small = LocalBronzeStorage("local", tmp_path / "limited")
    with pytest.raises(SystemExit) as error:
        publisher.run(small, "", once=True)
    assert error.value.code == 1
    assert json.loads(small.read_bytes("live/v2/stm.json"))["version"] == 2
    assert not small.exists("live/v2/stm/trips.json")


def test_installer_dry_check_requires_real_movement_captures(tmp_path):
    source = LocalBronzeStorage("local", tmp_path / "empty")
    publisher = LivePublisher(declaration_for("stm"), source)
    dest = LocalBronzeStorage("local", tmp_path / "scratch")
    with pytest.raises(SystemExit) as error:
        publisher.run(dest, "", once=True, require_captures=True)
    assert error.value.code == 1
    assert not dest.exists("live/v2/stm.json")
