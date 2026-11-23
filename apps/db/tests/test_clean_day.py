import json
from collections import Counter
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO, cast
from zipfile import ZipFile

import boto3
import duckdb
import pytest
from botocore.exceptions import ClientError
from google.transit.gtfs_realtime_pb2 import Alert, FeedMessage, TripDescriptor, VehiclePosition
from history_fixtures import scripted_feed_day
from typer.testing import CliRunner

from transit_ops import clean_day_inputs
from transit_ops.clean_day import CLEANING_VERSION
from transit_ops.clean_day_inputs import archived_captures
from transit_ops.clean_day_output import version_key
from transit_ops.clean_day_realtime import DayCapture, FeedPoll
from transit_ops.cli import app
from transit_ops.history.manifest import build_manifest, encode_manifest
from transit_ops.history.pack import write_pack
from transit_ops.history.poll_record import PollRecord
from transit_ops.ingestion.common import build_bronze_object_storage_path
from transit_ops.ingestion.i3 import build_i3_object_storage_path
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
    coords: str | tuple[str, ...] = "45.5,-73.6",
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
            + "".join(
                f"s{seq},Stop {seq},{pair}\n"
                for seq, pair in enumerate((coords,) * 4 if isinstance(coords, str) else coords, 1)
            ),
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


def test_gps_passage_corroborates_forecast_between_two_unambiguous_stops(tmp_path: Path) -> None:
    edition = _edition(
        tmp_path / "schedule.zip",
        {"gps": ("r", ["12:00:00", "12:02:00", "12:03:00", "12:04:00"])},
        DAY,
        coords=("45.5,-73.6", "45.5,-73.61", "45.5,-73.62", "45.5,-73.621"),
    )
    (tmp_path / "editions.json").write_text(
        json.dumps({"provider": "stm", "editions": [edition]}), encoding="utf-8"
    )
    noon = datetime(2026, 6, 1, 16, tzinfo=UTC)
    for published, forecasts in ((0, {1: 20, 2: 120, 3: 190}), (170, {2: 180})):
        captured = noon + timedelta(seconds=published)
        feed = _feed(captured)
        update = feed.entity.add(id="forecast").trip_update
        update.trip.trip_id, update.trip.start_date = "gps", "20260601"
        update.vehicle.id = "bus"
        for sequence, estimate in forecasts.items():
            event = update.stop_time_update.add(stop_sequence=sequence).arrival
            event.time = int(noon.timestamp()) + estimate
        _save(tmp_path, feed, "trip_updates", captured)
    for seconds, longitude, ident in (
        (80, -73.61, "bus"),
        (140, -73.621, "different-bus"),
        (160, -73.6205, "bus"),
        (240, -73.621, "bus"),
    ):
        captured = noon + timedelta(seconds=seconds)
        feed = _feed(captured)
        vehicle = feed.entity.add(id="gps").vehicle
        vehicle.trip.trip_id, vehicle.trip.start_date = "gps", "20260601"
        vehicle.vehicle.id = ident
        vehicle.position.latitude, vehicle.position.longitude = 45.5, longitude
        _save(tmp_path, feed, "vehicle_positions", captured)
    with duckdb.connect() as db:
        rows = _rows(db, _run(tmp_path, DAY) / "stop_events.parquet")
    assert [
        (row["stop_sequence"], row["basis"], row["delay_seconds"])
        for row in sorted(rows, key=lambda row: row["stop_sequence"])
    ] == [
        (1, "not_observed", None),
        (2, "trip_update_passed", 60),
        (3, "trip_update_passed", 10),
        (4, "not_observed", None),
    ]


def test_overnight_origin_departure_terminus_and_stop_capture_gap(tmp_path: Path) -> None:
    edition = _edition(
        tmp_path / "overnight.zip",
        {"night": ("r", ["24:00:00", "24:02:00", "24:06:00", "24:08:00"])},
        DAY,
        coords=("45.5,-73.6", "45.5,-73.61", "45.5,-73.62", "45.5,-73.63"),
    )
    (tmp_path / "editions.json").write_text(
        json.dumps({"provider": "stm", "editions": [edition]}), encoding="utf-8"
    )
    for seconds, sequence, lon, status in (
        (-120, 1, -73.6, VehiclePosition.STOPPED_AT),
        (0, 1, -73.6, VehiclePosition.STOPPED_AT),
        (30, 2, -73.602, VehiclePosition.IN_TRANSIT_TO),
        (45, 1, -73.6, VehiclePosition.STOPPED_AT),  # Regression after progression.
        (360, 3, -73.62, VehiclePosition.STOPPED_AT),
        (480, 4, -73.6302, VehiclePosition.IN_TRANSIT_TO),
    ):
        captured = MIDNIGHT + timedelta(seconds=seconds)
        feed = _feed(captured)
        vehicle = feed.entity.add(id="v").vehicle
        vehicle.trip.trip_id, vehicle.trip.start_date = "night", "20260602"
        vehicle.vehicle.id = "v"
        vehicle.current_stop_sequence = sequence
        vehicle.current_status = status
        vehicle.position.latitude, vehicle.position.longitude = 45.5, lon
        _save(tmp_path, feed, "vehicle_positions", captured)
    for seconds in range(-300, 541, 60):
        captured = MIDNIGHT + timedelta(seconds=seconds)
        feed = _feed(captured)
        feed.entity.add(id="poll")
        _save(tmp_path, feed, "trip_updates", captured)

    directory = _run(tmp_path, DAY)
    with duckdb.connect() as db:
        stops = sorted(
            _rows(db, directory / "stop_events.parquet"), key=lambda r: r["stop_sequence"]
        )
        (trip,) = _rows(db, directory / "trip_days.parquet")
    assert trip["state"] == "ran"
    assert stops[0]["observed_event"] == "departure"
    assert stops[0]["observed_at_utc"] == MIDNIGHT
    assert stops[1]["basis"] == "not_observed"
    assert stops[1]["trip_exclusion_reason"] == "capture_gap"
    assert stops[2]["basis"] == "vehicle_stopped"
    assert stops[2]["trip_exclusion_reason"] is None
    assert stops[3]["basis"] == "not_observed"
    assert trip["terminus_reached_at_utc"] == MIDNIGHT + timedelta(minutes=8)
    assert trip["terminus_vehicle_id"] == "v"


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
        (650, 3, 45.50, VehiclePosition.STOPPED_AT),
        (670, 3, 45.50, VehiclePosition.STOPPED_AT),
        (680, 3, 45.50003, VehiclePosition.STOPPED_AT),  # GPS jitter
        (700, 3, 45.50, VehiclePosition.STOPPED_AT),
        (730, 3, 45.50, VehiclePosition.STOPPED_AT),
        (790, 3, 45.50, VehiclePosition.STOPPED_AT),  # Exactly 60 seconds keeps the interval.
        (860, 3, 45.50, VehiclePosition.STOPPED_AT),  # Same state after a reporting gap.
        (870, 3, 45.5002, VehiclePosition.STOPPED_AT),  # Movement alone exceeds 15 m.
        (880, 3, 45.5002, VehiclePosition.STOPPED_AT),  # Occupancy alone changes.
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
        if seconds == 880:
            vehicle.occupancy_status = VehiclePosition.FEW_SEATS_AVAILABLE
            vehicle.occupancy_percentage = 42
        if seconds == 650:
            feed.entity.add().CopyFrom(feed.entity[0])
        _save(root, feed, "vehicle_positions", stamp)
        if seconds == 790:
            # A replay during the gap does not extend vehicle reporting.
            _save(root, feed, "vehicle_positions", stamp + timedelta(seconds=40))

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
    _save(root, _feed(stamp), "trip_updates", stamp + timedelta(seconds=10))
    malformed = b"not protobuf"
    key = build_realtime_object_storage_path(
        "stm", "trip_updates", stamp + timedelta(seconds=20), sha256(malformed).hexdigest()
    )
    (root / key).write_bytes(malformed)


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
    periods = (
        "list_transform(active_periods, lambda p: struct_pack("
        "start_utc := timezone('UTC', p.start_utc), end_utc := timezone('UTC', p.end_utc)"
        ")) AS active_periods"
    )
    projection = ", ".join(
        periods
        if name == "active_periods"
        else f"timezone('UTC', {name}) AS {name}"
        if name.endswith("_utc")
        else name
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


def _verify_manifest(
    db: duckdb.DuckDBPyConnection, directory: Path, edition: dict[str, str]
) -> None:
    manifest = json.loads((directory / "manifest.json").read_bytes())
    expected = {
        "trip_days.parquet",
        "stop_events.parquet",
        "scheduled_stop_times.parquet",
        "vehicle_positions.parquet",
        "feed_polls.parquet",
        "prediction_samples.parquet",
    }
    assert manifest["schedule_sha256"] == edition["sha256"]
    assert manifest["cleaning_version"] == CLEANING_VERSION
    declaration = clean_day_inputs.declaration_for(manifest["provider"])
    assert manifest["scorecard_declaration"] == {
        "timezone": declaration.provider.timezone,
        "live_source_lag_seconds": declaration.provider.live_source_lag_seconds,
        "feeds": [
            *sorted(set(clean_day_inputs.realtime_feeds(declaration).values())),
            *(["alerts"] if "alerts" not in manifest else []),
        ],
        "unpublished_vehicle_fields": declaration.realtime.unpublished_vehicle_fields,
    }
    if manifest["provider"] == "octranspo":
        assert manifest["alerts"] == "not_tracked"
    else:
        assert "alerts" not in manifest
        expected.add("alerts.parquet")
    assert set(manifest["files"]) == {p.name for p in directory.glob("*.parquet")} == expected
    for name in expected:
        path = directory / name
        metadata = dict(
            db.execute("SELECT key, value FROM parquet_kv_metadata(?)", [str(path)]).fetchall()
        )
        assert metadata[b"schedule_sha256"] == edition["sha256"].encode()
        assert metadata[b"cleaning_version"] == CLEANING_VERSION.encode()
        rows = _rows(db, path)
        assert all(row["cleaning_version"] == CLEANING_VERSION for row in rows)
        payload = path.read_bytes()
        assert manifest["files"][name] == {
            "rows": len(rows),
            "sha256": sha256(payload).hexdigest(),
            "byte_size": len(payload),
        }


@pytest.mark.parametrize("continuous", [False, True])
def test_prediction_samples_use_latest_publication_in_each_covered_bucket(
    tmp_path: Path, continuous: bool
) -> None:
    editions = _index(tmp_path)
    observed = MIDNIGHT + timedelta(minutes=5)
    leads = [50, 100, 150, 200, 250, 350, 400, 450, 500, 550, 610, 0]
    if continuous:
        leads.extend(range(660, 2461, 60))
    for lead in leads:
        captured = observed - timedelta(seconds=lead)
        poll = _feed(captured)
        poll.entity.add(id="poll")
        _save(tmp_path, poll, "trip_updates", captured)
    for lead, capture_lead, error in (
        (1500, 1499, -26),  # In the 20-minute bucket, across a capture outage.
        (2400, 2399, -28),  # At the exclusive cap.
        (601, 599, -12),
        (310, 309, 17),
        (300, 298, 31),
        (180, 125, 2**62),  # Invalid timestamp at the cutoff cannot mask a valid prediction.
        (180, 120, 20),
        (230, 100, 99),  # An older publication arrives after the 3-minute candidate.
        (60, 57, -4),
        (59, 56, 50),
    ):
        published = observed - timedelta(seconds=lead)
        captured = observed - timedelta(seconds=capture_lead)
        feed = _feed(captured)
        update = feed.entity.add(id="night").trip_update
        update.trip.trip_id = "night"
        update.trip.start_date = "20260601"
        update.timestamp = int(published.timestamp())
        arrival = update.stop_time_update.add(stop_sequence=2).arrival
        if lead == 300:
            arrival.delay = error
        else:
            arrival.time = int(observed.timestamp()) + error
        _save(tmp_path, feed, "trip_updates", captured)

    feed = _feed(observed)
    vehicle = feed.entity.add(id="v1").vehicle
    vehicle.trip.trip_id = "night"
    vehicle.trip.start_date = "20260601"
    vehicle.vehicle.id = "v1"
    vehicle.current_stop_sequence = 2
    vehicle.current_status = VehiclePosition.STOPPED_AT
    vehicle.position.latitude = 45.5
    vehicle.position.longitude = -73.6
    _save(tmp_path, feed, "vehicle_positions", observed)

    directory = _run(tmp_path, DAY)
    with duckdb.connect() as db:
        stops = _rows(db, directory / "stop_events.parquet")
        samples = _rows(db, directory / "prediction_samples.parquet")
        _verify_manifest(db, directory, editions[0])
    night = {row["stop_sequence"]: row for row in stops if row["trip_id"] == "night"}
    assert night[1]["observed_at_utc"] is None
    assert night[2]["observed_at_utc"] == observed
    expected = [(1, 60, -4), (3, 180, 20), (5, 300, 31), (10, 601, -12)]
    if continuous:
        expected.append((20, 1500, -26))
    assert samples == [
        {
            "provider": "stm",
            "service_date": DAY,
            "route_id": "r",
            "direction_id": 0,
            "trip_id": "night",
            "stop_id": "s2",
            "stop_sequence": 2,
            "basis": "vehicle_stopped",
            "observed_event": "arrival",
            "cleaning_version": CLEANING_VERSION,
            "horizon_minutes": horizon,
            "published_at_utc": observed - timedelta(seconds=lead),
            "predicted_at_utc": observed + timedelta(seconds=error),
            "error_seconds": error,
            "actual_lead_seconds": lead,
        }
        for horizon, lead, error in expected
    ]


def _alert_body(description: str) -> bytes:
    return json.dumps(
        {
            "messages": [
                {
                    "id": "night-work",
                    "header": {"fr": "Travaux", "en": "Construction"},
                    "description": {"en": description},
                    "informed_entities": [{"route_short_name": "r", "stop_code": "s1"}],
                    "activePeriod": [{"start": int(MIDNIGHT.timestamp()) - 600}],
                    "cause": "Agency cause",
                    "effect": "Agency effect",
                }
            ]
        }
    ).encode()


def test_clean_i3_alert_versions_across_local_midnight(tmp_path: Path) -> None:
    editions = _index(tmp_path)
    first, repeat, revised, later = (
        MIDNIGHT + timedelta(minutes=minute) for minute in (-10, -5, -1, 0)
    )
    original, updated = _alert_body("Use the temporary stop"), _alert_body("Use stop 2")
    for captured, body in (
        (first, original),
        (repeat, original),
        (revised, updated),
        (later, updated),
    ):
        path = tmp_path / build_i3_object_storage_path(
            provider_id="stm", captured_at_utc=captured, checksum_sha256=sha256(body).hexdigest()
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        _save(tmp_path, _feed(captured), "trip_updates", captured)

    current, following = _run(tmp_path, DAY), _run(tmp_path, NEXT)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        for directory, edition in zip((current, following), editions, strict=True):
            _verify_manifest(db, directory, edition)
        rows = _rows(db, current / "alerts.parquet")
        next_rows = _rows(db, following / "alerts.parquet")

    initial, changed = sorted(rows, key=lambda row: row["first_seen_at_utc"])
    assert initial["version"] != changed["version"]
    assert initial["description_en"] == "Use the temporary stop"
    assert changed["description_en"] == "Use stop 2"
    assert (initial["first_seen_at_utc"], initial["last_seen_at_utc"]) == (first, repeat)
    assert (changed["first_seen_at_utc"], changed["last_seen_at_utc"]) == (revised, revised)
    assert next_rows == [
        {**changed, "service_date": NEXT, "first_seen_at_utc": later, "last_seen_at_utc": later}
    ]
    for row in rows:
        assert (row["alert_id"], row["source"]) == ("night-work", "api_i3_json")
        assert (row["header_en"], row["header_fr"], row["description_fr"]) == (
            "Construction",
            "Travaux",
            None,
        )
        assert row["active_periods"] == [{"start_utc": first.replace(tzinfo=None), "end_utc": None}]
        assert (row["route_ids"], row["stop_ids"]) == (["r"], ["s1"])
        assert (row["cause"], row["effect"]) == ("Agency cause", "Agency effect")


def test_clean_declared_gtfs_rt_alert_feed(tmp_path: Path) -> None:
    provider = "sto"
    edition = _edition(tmp_path / "schedule.zip", TRIPS, DAY)
    (tmp_path / "editions.json").write_text(
        json.dumps({"provider": provider, "editions": [edition]}), encoding="utf-8"
    )
    captured = MIDNIGHT - timedelta(hours=1)
    feed = _feed(captured)
    alert = feed.entity.add(id="test-alert").alert
    alert.header_text.translation.add(language="fr", text="Arrêt déplacé")
    selector = alert.informed_entity.add(route_id="r", stop_id="s1", direction_id=0)
    alert.cause, alert.effect = Alert.CONSTRUCTION, Alert.DETOUR
    _save(tmp_path, feed, "service_alerts", captured, provider)
    selector.direction_id = 1
    _save(tmp_path, feed, "service_alerts", captured + timedelta(minutes=1), provider)

    destination = _run(tmp_path, DAY, provider)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        _verify_manifest(db, destination, edition)
        rows = _rows(db, destination / "alerts.parquet")
        polls = _rows(db, destination / "feed_polls.parquet")
    assert [(p["feed"], p["result"], p["entity_count"]) for p in polls] == [
        ("service_alerts", "ok", 1),
        ("service_alerts", "ok", 1),
    ]
    assert len({r["version"] for r in rows}) == len(rows) == 2
    for row in rows:
        assert row["source"] == "gtfs_rt_service_alerts"
        assert (row["route_ids"], row["stop_ids"]) == (["r"], ["s1"])
        assert (row["header_en"], row["header_fr"]) == (None, "Arrêt déplacé")
        assert (row["cause"], row["effect"]) == ("CONSTRUCTION", "DETOUR")


def test_alert_feed_polls_record_every_attempt(tmp_path: Path) -> None:
    provider = "sto"
    edition = _edition(tmp_path / "schedule.zip", TRIPS, DAY)
    (tmp_path / "editions.json").write_text(
        json.dumps({"provider": provider, "editions": [edition]}), encoding="utf-8"
    )
    captured = MIDNIGHT - timedelta(hours=1)
    feed = _feed(captured)
    alert = feed.entity.add(id="a").alert
    alert.informed_entity.add(route_id="r")
    _save(tmp_path, feed, "service_alerts", captured, provider)
    _save(tmp_path, feed, "service_alerts", captured + timedelta(seconds=30), provider)
    _save(
        tmp_path,
        _feed(captured + timedelta(minutes=1)),
        "service_alerts",
        captured + timedelta(minutes=1),
        provider,
    )
    malformed = b"not protobuf"
    key = build_realtime_object_storage_path(
        "sto", "service_alerts", captured + timedelta(minutes=2), sha256(malformed).hexdigest()
    )
    (tmp_path / key).write_bytes(malformed)

    destination = _run(tmp_path, DAY, provider)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        polls = _rows(db, destination / "feed_polls.parquet")
    assert [p["feed"] for p in polls] == ["service_alerts"] * 4
    assert [(p["result"], p["entity_count"], p["feed_timestamp_utc"]) for p in polls] == [
        ("ok", 1, captured),
        ("duplicate", 1, captured),
        ("empty", 0, captured + timedelta(minutes=1)),
        ("error", None, None),
    ]
    assert [p["captured_at_utc"] for p in polls] == [
        captured + timedelta(seconds=offset) for offset in (0, 30, 60, 120)
    ]
    assert [p["payload_bytes"] for p in polls] == [
        len(feed.SerializeToString()),
        len(feed.SerializeToString()),
        len(_feed(captured + timedelta(minutes=1)).SerializeToString()),
        len(malformed),
    ]
    assert len({p["attempt_id"] for p in polls}) == 4
    assert polls[-1]["attempt_id"] == (tmp_path / key).name


def test_i3_alert_feed_polls(tmp_path: Path) -> None:
    _index(tmp_path)
    captured = MIDNIGHT - timedelta(hours=1)
    original = _alert_body("Use the temporary stop")
    for stamp, body in (
        (captured, original),
        (captured + timedelta(seconds=30), original),
        (captured + timedelta(minutes=1), b'{"messages": []}'),
        (captured + timedelta(minutes=2), b"invalid JSON"),
        (captured + timedelta(minutes=3), b"null"),
    ):
        path = tmp_path / build_i3_object_storage_path(
            provider_id="stm", captured_at_utc=stamp, checksum_sha256=sha256(body).hexdigest()
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        _save(tmp_path, _feed(stamp), "trip_updates", stamp)

    destination = _run(tmp_path, DAY)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        polls = _rows(db, destination / "feed_polls.parquet")
    alert_polls = [p for p in polls if p["feed"] == "i3_alerts"]
    assert [(p["result"], p["entity_count"], p["feed_timestamp_utc"]) for p in alert_polls] == [
        ("ok", 1, None),
        ("duplicate", 1, None),
        ("empty", 0, None),
        ("error", None, None),
        ("error", None, None),
    ]


def _verify_schedule(
    db: duckdb.DuckDBPyConnection, directory: Path, edition: dict[str, str], anchor: datetime
) -> None:
    schedule = _rows(db, directory / "scheduled_stop_times.parquet")
    stops = _rows(db, directory / "stop_events.parquet")
    scheduled_trips = {
        row["trip_id"]
        for row in _rows(db, directory / "trip_days.parquet")
        if row["state"] != "added"
    }
    fields = (
        "provider",
        "service_date",
        "trip_id",
        "route_id",
        "direction_id",
        "cleaning_version",
        "stop_id",
        "stop_sequence",
        "scheduled_arrival_utc",
        "scheduled_departure_utc",
    )
    assert [{key: row[key] for key in fields} for row in schedule] == [
        {key: row[key] for key in fields} for row in stops if row["trip_id"] in scheduled_trips
    ]
    for row in schedule:
        assert row["schedule_sha256"] == edition["sha256"]
        for event in ("arrival", "departure"):
            scheduled = row[f"scheduled_{event}_utc"]
            seconds = (scheduled - anchor).total_seconds() if scheduled is not None else None
            assert row[f"scheduled_{event}_seconds"] == seconds


def test_clean_day_math_and_edition_switch(tmp_path: Path) -> None:
    editions = _index(tmp_path)
    _capture_fixture(tmp_path)
    first = _run(tmp_path, DAY)
    later = _run(tmp_path, NEXT)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        trips = _rows(db, first / "trip_days.parquet")
        stops = _rows(db, first / "stop_events.parquet")
        _verify_stop_eligibility(db, first)
        next_stops = _rows(db, later / "stop_events.parquet")
        for directory, edition, anchor in zip(
            (first, later), editions, (MIDNIGHT - timedelta(days=1), MIDNIGHT), strict=True
        ):
            _verify_manifest(db, directory, edition)
            _verify_schedule(db, directory, edition, anchor)
        positions = _rows(db, first / "vehicle_positions.parquet")
        assert not _rows(db, later / "vehicle_positions.parquet")
        polls = _rows(db, first / "feed_polls.parquet")
    assert [
        (row["captured_at_utc"], row["last_seen_at_utc"], row["readings"]) for row in positions
    ] == [
        (MIDNIGHT + timedelta(seconds=first), MIDNIGHT + timedelta(seconds=last), count)
        for first, last, count in (
            (45, 45, 1),
            (520, 520, 1),
            (633, 790, 7),
            (860, 860, 1),
            (870, 870, 1),
            (880, 880, 1),
        )
    ]
    assert all(
        (r["vehicle_id"], r["service_date"], r["trip_id"], r["route_id"])
        == ("v1", DAY, "night", "r")
        for r in positions
    )
    assert positions[-1]["occupancy_status"] == VehiclePosition.FEW_SEATS_AVAILABLE
    assert positions[-1]["occupancy_percentage"] == 42
    assert len(polls) == len(list((tmp_path / "stm").rglob("*.pb")))
    by_result = {r["result"]: r for r in polls}
    assert Counter(r["result"] for r in polls) == {
        "ok": len(polls) - 4,
        "duplicate": 2,
        "empty": 1,
        "error": 1,
    }
    duplicate = next(r for r in polls if r["feed"] == "trip_updates" and r["result"] == "duplicate")
    original = next(
        r
        for r in polls
        if r["feed"] == "trip_updates"
        and r["captured_at_utc"] == duplicate["captured_at_utc"] - timedelta(seconds=30)
    )
    for value in ("feed_timestamp_utc", "payload_bytes", "entity_count"):
        assert duplicate[value] == original[value]
    assert by_result["empty"]["entity_count"] == 0
    assert by_result["error"]["entity_count"] is None
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
    assert states["gap"]["route_type"] == 1
    assert states["night"]["route_type"] == 3
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
    assert [
        (row.captured_at_utc, row.payload) for row in rows if isinstance(row, DayCapture)
    ] == list(zip((start, captures[2].captured_at_utc), payloads[1:], strict=True))
    assert [
        (row.attempt_id, row.result, row.feed_timestamp_utc, row.payload_bytes)
        for row in rows
        if isinstance(row, FeedPoll)
    ] == [("3", "error", None, None), ("4", "error", None, None), ("5", "error", None, 7)]
    with pytest.raises(ValueError, match="duplicate capture"):
        list(archived_captures(provider, tmp_path, [path, path], start, end))


def _verify_stop_eligibility(db: duckdb.DuckDBPyConnection, directory: Path) -> None:
    manifest = json.loads((directory / "manifest.json").read_bytes())
    zone = manifest["scorecard_declaration"]["timezone"]
    mismatches = db.execute(
        """
        WITH legacy AS (
            SELECT s.*, t.route_has_live_data AS trip_live,
                CASE WHEN t.scheduled_start_utc IS NULL THEN 'added'
                    WHEN t.state = 'cancelled' THEN 'cancelled'
                    WHEN NOT t.route_has_live_data THEN 'route_without_live_data'
                    WHEN t.state_reason = 'capture_gap' THEN 'capture_gap'
                END AS exclusion,
                hour(timezone(?, coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc)))
                    AS local_hour,
                epoch(t.scheduled_start_utc)
                    - epoch(timezone(?, s.service_date + INTERVAL '12 hours')) + 43200
                    AS start_seconds
            FROM read_parquet(?) s JOIN read_parquet(?) t USING (provider, service_date, trip_id)
        )
        SELECT trip_id, stop_sequence FROM legacy
        WHERE (trip_exclusion_reason IS DISTINCT FROM exclusion AND NOT (
                exclusion IS NULL AND observed_at_utc IS NULL
                AND trip_exclusion_reason IS NOT DISTINCT FROM 'capture_gap'
            ))
            OR route_has_live_data IS DISTINCT FROM trip_live
            OR scheduled_local_hour IS DISTINCT FROM local_hour
            OR service_weekday IS DISTINCT FROM isodow(service_date)
            OR scheduled_start_seconds IS DISTINCT FROM start_seconds
        """,
        [zone, zone, str(directory / "stop_events.parquet"), str(directory / "trip_days.parquet")],
    ).fetchall()
    assert mismatches == []


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
            "clock_change": ("r", ["00:45:00", "01:00:00", "02:00:00"]),
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
            if family == "vehicle_positions" and seconds == -60:
                unknown = feed.entity.add(id="unassigned").vehicle
                unknown.vehicle.id = "unassigned"
                unknown.position.latitude, unknown.position.longitude = 45.4, -75.7
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
    _save(tmp_path, _feed(stopped_at), "service_alerts", stopped_at, provider)

    destination = _run(tmp_path, day, provider)
    manifest = json.loads((destination / "manifest.json").read_bytes())
    assert manifest["scorecard_declaration"]["live_source_lag_seconds"] == 60
    with duckdb.connect() as db:
        _verify_manifest(db, destination, edition)
        _verify_schedule(db, destination, edition, scheduled - timedelta(days=1))
        _verify_stop_eligibility(db, destination)
        position_rows = _rows(db, destination / "vehicle_positions.parquet")
        polls = _rows(db, destination / "feed_polls.parquet")
        trips = {row["trip_id"]: row for row in _rows(db, destination / "trip_days.parquet")}
        events = _rows(db, destination / "stop_events.parquet")
        stops = {row["stop_id"]: row for row in events if row["trip_id"] == "night"}
        assert [
            (row["scheduled_local_hour"], row["service_weekday"])
            for row in events
            if row["trip_id"] == "clock_change"
        ] == [(1, 7), (1, 7), (2, 7)]
        assert all(
            (row["scheduled_local_hour"], row["service_weekday"]) == (0, 7)
            for row in stops.values()
        )
    assert len(position_rows) == 2 * int(vehicles_enabled)
    assert Counter(r["feed"] for r in polls) == (
        {"trip_updates": 13, "vehicle_positions": 12} if vehicles_enabled else {"trip_updates": 13}
    )
    if vehicles_enabled:
        unassigned, bus = position_rows
        assert (unassigned["vehicle_id"], unassigned["service_date"], unassigned["trip_id"]) == (
            "unassigned",
            None,
            None,
        )
        assert unassigned["feed_timestamp_utc"] == scheduled - timedelta(seconds=210)
        assert bus["service_date"] == day
        assert bus["observed_at_utc"] == stopped_at
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


def _archive_capture(root: Path, stamp: datetime, alert_body: bytes | None = None) -> None:
    endpoint = "trip_updates" if alert_body is None else "i3_alerts"
    index_family = "realtime_snapshot" if alert_body is None else "alert_snapshot"
    record, _ = scripted_feed_day(  # type: ignore[no-untyped-call]
        provider_id="stm", endpoint_key=endpoint, index_family=index_family
    )
    record = cast(PollRecord, record)
    feed = _feed(stamp)
    update = feed.entity.add(id="scheduled").trip_update
    update.trip.trip_id = "night"
    update.trip.start_date = f"{stamp:%Y%m%d}"
    payload = feed.SerializeToString() if alert_body is None else alert_body
    base = f"archive/v1/captures/stm/{endpoint}/{stamp:%Y/%m/%Y-%m-%d}.c"
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
    failed = replace(
        record.polls[3],
        time_utc=stamp + timedelta(seconds=30),
        started_at_utc=stamp + timedelta(seconds=30),
        completed_at_utc=stamp + timedelta(seconds=30),
        requested_at_utc=stamp + timedelta(seconds=30),
    )
    duplicate = replace(
        failed,
        ingestion_run_id=4,
        status="skipped_identical",
        duplicate_of_row_id=poll.capture_row_id,
        time_utc=stamp + timedelta(seconds=60),
        feed_timestamp_utc=stamp,
        feed_timestamp_source="header" if alert_body is None else "capture_time",
        entity_count=1,
    )
    manifest = build_manifest(
        replace(
            record,
            feed_day=replace(record.feed_day, utc_date=stamp.date()),
            captures=(capture,),
            polls=(poll, failed, duplicate),
            processing=(),
        ),
        feed_endpoint_id=1,
        feed_kind=endpoint,
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
        self.fail_upload: str | None = None

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
        if self.fail_upload and Key.endswith(self.fail_upload):
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
        if day == third:
            feed = _feed(stamp)
            update = feed.entity.add(id="scheduled").trip_update
            update.trip.trip_id = "night"
            update.trip.start_date = f"{day:%Y%m%d}"
            _save(raw, feed, "trip_updates", stamp)
        else:
            _archive_capture(raw, stamp)
        alert_body = json.loads(_alert_body("An archived alert"))
        alert = alert_body["messages"][0]
        del alert["informed_entities"]
        alert.update(routes=["r", "metro"], stops=["s1", "s2"])
        _archive_capture(raw, stamp, json.dumps(alert_body).encode())

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
        for name in ("feed_polls.parquet", "prediction_samples.parquet", "alerts.parquet"):
            fake.fail_upload = name
            attempt = runner.invoke(app, [*args, DAY.isoformat()])
            assert attempt.exit_code == 1 and "ServiceUnavailable" in attempt.output
            assert not (dest / marker).exists()
        fake.fail_upload = None
    earlier = DAY - timedelta(days=1)
    _archive_capture(raw, datetime.combine(earlier, time(16), UTC))
    earlier_marker = f"{version_key('stm', earlier)}/manifest.json"
    first = runner.invoke(app, [*args[:-2], earlier.isoformat(), "--to", DAY.isoformat()])
    assert first.exit_code == 0, (first.output, first.exception)
    assert "Built 1, skipped 0, no raw captures 0, no schedule edition 1, failed 0" in first.output
    earlier_receipt = json.loads((dest / earlier_marker).read_bytes())
    assert earlier_receipt["status"] == "no_schedule_edition"
    assert earlier_receipt["provider"] == "stm"
    assert earlier_receipt["service_date"] == str(earlier)
    assert earlier_receipt["cleaning_version"] == CLEANING_VERSION
    assert "files" not in earlier_receipt
    assert list((dest / earlier_marker).parent.iterdir()) == [dest / earlier_marker]
    search_key = f"search/v1/{version_key('stm', DAY)}.json"
    search = json.loads((dest / search_key).read_bytes())
    assert search["date"] == str(DAY)
    assert any(route["id"] == "r" for route in search["routes"])
    if remote:
        assert fake.writes.count(f"out/{search_key}") == 1
        fake.writes.remove(f"out/{search_key}")
        earlier_key = f"out/{earlier_marker}"
        assert fake.writes.count(earlier_key) == 1
        fake.writes.remove(earlier_key)
        assert fake.writes == [
            f"out/{version_key('stm', DAY)}/{name}"
            for name in (
                "trip_days.parquet",
                "stop_events.parquet",
                "scheduled_stop_times.parquet",
                "vehicle_positions.parquet",
                "feed_polls.parquet",
                "prediction_samples.parquet",
                "alerts.parquet",
                "manifest.json",
            )
        ]
    with duckdb.connect() as db:
        polls = _rows(db, (dest / marker).with_name("feed_polls.parquet"))
        alerts = _rows(db, (dest / marker).with_name("alerts.parquet"))
    assert len(alerts) == 1 and alerts[0]["description_en"] == "An archived alert"
    assert (alerts[0]["route_ids"], alerts[0]["stop_ids"]) == (["metro", "r"], ["s1", "s2"])
    alert_polls = [r for r in polls if r["feed"] == "i3_alerts"]
    assert [(r["attempt_id"], r["result"], r["entity_count"]) for r in alert_polls] == [
        ("0", "ok", 1),
        ("3", "error", None),
        ("4", "duplicate", 1),
    ]
    assert all(r["feed_timestamp_utc"] is None for r in alert_polls)
    assert alert_polls[1]["payload_bytes"] is None
    assert alert_polls[2]["payload_bytes"] == alert_polls[0]["payload_bytes"]
    polls = [r for r in polls if r["feed"] == "trip_updates"]
    assert [r["result"] for r in polls] == ["ok", "error", "duplicate"]
    assert polls[1]["payload_bytes"] is None
    assert polls[2]["payload_bytes"] == polls[0]["payload_bytes"]
    assert polls[2]["feed_timestamp_utc"] == polls[0]["feed_timestamp_utc"]
    manifest = (dest / marker).read_bytes()
    result = runner.invoke(app, [*args[:-2], earlier.isoformat(), "--to", third.isoformat()])
    assert result.exit_code == 0, (result.output, result.exception)
    assert "Built 1, skipped 2, no raw captures 1, no schedule edition 0, failed 0" in result.output
    assert (dest / marker).read_bytes() == manifest
    unmeasured = dest / version_key("stm", NEXT)
    receipt = json.loads((unmeasured / "manifest.json").read_bytes())
    assert receipt["status"] == "no_raw_captures"
    assert receipt["provider"] == "stm"
    assert receipt["service_date"] == NEXT.isoformat()
    assert receipt["cleaning_version"] == CLEANING_VERSION
    assert datetime.fromisoformat(receipt["built_at_utc"]).utcoffset() == timedelta(0)
    assert "builder_git_commit" in receipt
    assert "files" not in receipt
    assert list(unmeasured.glob("*.parquet")) == []
    if remote:
        assert f"out/{version_key('stm', NEXT)}/manifest.json" in fake.writes
        assert not any(
            key.startswith(f"out/{version_key('stm', NEXT)}/")
            and not key.endswith("/manifest.json")
            for key in fake.writes
        )
    latest = json.loads((dest / version_key("stm", third) / "manifest.json").read_bytes())
    assert latest["schedule_sha256"] == entry["sha256"]
    assert latest["row_counts_by_state"]["unconfirmed"] == 1
    with duckdb.connect() as db:
        third_polls = _rows(db, dest / version_key("stm", third) / "feed_polls.parquet")
    assert [row["result"] for row in third_polls if row["feed"] == "trip_updates"] == ["ok"]
    assert [row["result"] for row in third_polls if row["feed"] == "i3_alerts"] == [
        "ok",
        "error",
        "duplicate",
    ]


@pytest.mark.parametrize("previous_edition", [True, False])
def test_unreadable_bronze_original_does_not_become_an_edition(
    tmp_path: Path, previous_edition: bool
) -> None:
    raw = tmp_path / "raw"
    raw.mkdir()
    third = NEXT + timedelta(days=1)
    first = DAY if previous_edition else NEXT
    days = (DAY, NEXT, third) if previous_edition else (NEXT, third)
    checksums = {}
    ignored = []
    for day in days:
        path = raw / "schedule.zip"
        if day == NEXT:
            path.write_bytes(b"<!DOCTYPE html><title>Schedule unavailable</title>")
        else:
            _edition(path, {"scheduled": ("r", ["12:00:00"])}, day)
        checksums[day] = sha256(path.read_bytes()).hexdigest()
        stamp = datetime.combine(day, time(16), UTC)
        key = build_bronze_object_storage_path(
            provider_id="stm",
            endpoint_key="static_schedule",
            partition_label="ingested_at_utc",
            observed_at_utc=stamp - timedelta(hours=10),
            object_name=path.name,
            checksum_sha256=checksums[day],
        )
        original = raw / key
        original.parent.mkdir(parents=True)
        path.rename(original)
        if day == NEXT:
            ignored.append({"object_key": key, "sha256": checksums[day]})
        feed = _feed(stamp)
        trip = feed.entity.add(id="scheduled").trip_update.trip
        trip.trip_id = "scheduled"
        trip.start_date = f"{day:%Y%m%d}"
        _save(raw, feed, "trip_updates", stamp)

    dest = tmp_path / "clean"
    result = CliRunner().invoke(
        app,
        [
            "clean-days",
            "--provider",
            "stm",
            "--from",
            str(first),
            "--to",
            str(third),
            "--source",
            str(raw),
            "--dest",
            str(dest),
        ],
    )
    assert result.exit_code == 0, result.output
    for day in days:
        directory = dest / version_key("stm", day)
        marker = directory / "manifest.json"
        manifest = json.loads(marker.read_bytes())
        assert manifest["ignored_invalid_original"] == ignored
        if day == NEXT and not previous_edition:
            assert manifest["status"] == "schedule_archive_unreadable"
            assert list(directory.iterdir()) == [marker]
        else:
            effective = DAY if day == NEXT else day
            assert manifest["schedule_sha256"] == checksums[effective]
            assert manifest["files"]["trip_days.parquet"]["rows"] == 1
            assert manifest["row_counts_by_state"]["unconfirmed"] == 1


def _wheelchair_edition(path: Path, *, include_wheelchair: bool = True) -> dict[str, str]:
    trips = {
        "night": ("r", ["24:00:00", "24:05:00", "24:10:00"]),
        "plain": ("r", ["14:00:00"]),
        "unknown": ("r", ["16:00:00"]),
    }
    with ZipFile(path, "w") as archive:
        archive.writestr("routes.txt", "route_id,route_type\nr,3\n")
        if include_wheelchair:
            archive.writestr(
                "trips.txt",
                "route_id,service_id,trip_id,direction_id,wheelchair_accessible\n"
                + "r,s,night,0,1\nr,s,plain,0,2\nr,s,unknown,0,\n",
            )
            archive.writestr(
                "stops.txt",
                "stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding,parent_station\n"
                + "s1,Stop 1,45.5,-73.6,1,\n"
                + "s2,Stop 2,45.5,-73.6,2,\n"
                + "s3,Stop 3,45.5,-73.6,,s1\n"
                + "s4,Stop 4,45.5,-73.6,,\n",
            )
        else:
            archive.writestr(
                "trips.txt",
                "route_id,service_id,trip_id,direction_id\n"
                + "r,s,night,0\nr,s,plain,0\nr,s,unknown,0\n",
            )
            archive.writestr(
                "stops.txt",
                "stop_id,stop_name,stop_lat,stop_lon\n"
                + "s1,Stop 1,45.5,-73.6\ns2,Stop 2,45.5,-73.6\n"
                + "s3,Stop 3,45.5,-73.6\ns4,Stop 4,45.5,-73.6\n",
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
            + "".join(f"s,{DAY + timedelta(days=offset):%Y%m%d},1\n" for offset in range(4)),
        )
    return {
        "effective_date": DAY.isoformat(),
        "path": path.name,
        "sha256": sha256(path.read_bytes()).hexdigest(),
    }


def _run_wheelchair(root: Path, include_wheelchair: bool) -> Path:
    edition = _wheelchair_edition(root / "schedule.zip", include_wheelchair=include_wheelchair)
    (root / "editions.json").write_text(
        json.dumps({"provider": "stm", "editions": [edition]}), encoding="utf-8"
    )
    _save(root, _feed(MIDNIGHT - timedelta(hours=6)), "trip_updates", MIDNIGHT - timedelta(hours=6))
    destination = _run(root, DAY)
    return destination


def test_clean_day_copies_wheelchair_accessibility(tmp_path: Path) -> None:
    destination = _run_wheelchair(tmp_path, include_wheelchair=True)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        trips = {row["trip_id"]: row for row in _rows(db, destination / "trip_days.parquet")}
        schedule = {
            (row["trip_id"], row["stop_sequence"]): row
            for row in _rows(db, destination / "scheduled_stop_times.parquet")
        }
    assert {key: row["wheelchair_accessible"] for key, row in trips.items()} == {
        "night": 1,
        "plain": 2,
        "unknown": 0,
    }
    assert [
        (schedule[key]["stop_id"], schedule[key]["wheelchair_boarding"]) for key in sorted(schedule)
    ] == [
        ("s1", 1),
        ("s2", 2),
        ("s3", 1),  # Inherited from its parent station s1.
        ("s1", 1),
        ("s1", 1),
    ]
    assert len(trips) == 3
    assert len(schedule) == 5


def test_clean_day_absent_wheelchair_columns_are_null(tmp_path: Path) -> None:
    destination = _run_wheelchair(tmp_path, include_wheelchair=False)
    with duckdb.connect(config={"TimeZone": "UTC"}) as db:
        trips = _rows(db, destination / "trip_days.parquet")
        schedule = _rows(db, destination / "scheduled_stop_times.parquet")
    assert all(row["wheelchair_accessible"] is None for row in trips)
    assert all(row["wheelchair_boarding"] is None for row in schedule)
    assert len(trips) == 3
    assert len(schedule) == 5
