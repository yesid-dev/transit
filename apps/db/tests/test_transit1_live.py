import json
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path

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
    assert row["delay"] == 0
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
    key = "live/v1/stm.json"
    _publish(dest, key, b'{"version":1,"vehicle_positions":[]}')
    _publish(dest, key, b'{"version":1,"vehicle_positions":null}')
    assert json.loads(dest.read_bytes(key))["vehicle_positions"] is None
    assert list(dest.list_keys("live/")) == [key]
