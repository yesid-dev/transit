import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zipfile import ZipFile
from zoneinfo import ZoneInfo

import pytest
import yaml
from google.transit.gtfs_realtime_pb2 import FeedHeader, FeedMessage, VehiclePosition

from transit_ops.readiness import check_provider

NOW = datetime(2026, 11, 23, 18, tzinfo=UTC)
CONFIG = Path(__file__).resolve().parents[1] / "config" / "providers"


def write_samples(directory: Path, now: datetime, zone: str = "America/Toronto"):
    """Write the same standalone files used by the command-line smoke checks."""
    static = directory / "schedule.zip"
    day = now.astimezone(ZoneInfo(zone)).strftime("%Y%m%d")
    with ZipFile(static, "w") as archive:
        for name, content in {
            "agency": f"agency_name,agency_url,agency_timezone\nExample,https://example.org,{zone}",
            "routes": "route_id,route_type,route_short_name\nR,3,1",
            "trips": "route_id,service_id,trip_id,shape_id\nR,weekday,T,SHP",
            "stops": "stop_id,stop_name,stop_lat,stop_lon\nS,Example,45,-75\nS2,Second,45.1,-75",
            "stop_times": "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n"
            "T,S,1,12:00:00,12:00:00\nT,S2,2,12:10:00,12:10:00",
            "calendar_dates": f"service_id,date,exception_type\nweekday,{day},1",
            "shapes": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
            "SHP,45,-75,1\nSHP,45.1,-75,2",
        }.items():
            archive.writestr(f"{name}.txt", content + "\n")

    samples = {}
    for endpoint in ("trip_updates", "vehicle_positions", "service_alerts"):
        message = FeedMessage()
        message.header.gtfs_realtime_version = "2.0"
        message.header.timestamp = int((now - timedelta(seconds=5)).timestamp())
        entity = message.entity.add(id="example")
        if endpoint == "trip_updates":
            entity.trip_update.trip.trip_id = "T"
            update = entity.trip_update.stop_time_update.add(stop_id="S", stop_sequence=1)
            update.arrival.delay = 0
            update.departure.delay = 10
        elif endpoint == "vehicle_positions":
            entity.vehicle.trip.trip_id = "T"
            entity.vehicle.stop_id = "S"
            entity.vehicle.current_status = VehiclePosition.IN_TRANSIT_TO
            entity.vehicle.position.latitude = 45
            entity.vehicle.position.longitude = -75
            entity.vehicle.occupancy_percentage = 0
        else:
            entity.alert.informed_entity.add(stop_id="S")
        path = directory / f"{endpoint}.pb"
        path.write_bytes(message.SerializeToString())
        samples[endpoint] = path
    alerts = directory / "i3_alerts.json"
    alerts.write_text(json.dumps([{"id": "example", "title": "Example"}]), encoding="utf-8")
    samples["i3_alerts"] = alerts
    return static, samples


@pytest.fixture
def city(tmp_path):
    declaration = yaml.safe_load((CONFIG / "stm.yaml").read_text(encoding="utf-8"))
    declaration["id"] = "fixture_city"
    declaration["feeds"] = [
        feed for feed in declaration["feeds"] if feed["family"] not in {"geometry", "alerts"}
    ]
    document = tmp_path / "fixture_city.yaml"
    document.write_text(yaml.safe_dump(declaration), encoding="utf-8")
    static, samples = write_samples(tmp_path, NOW)
    return document, static, {key: samples[key] for key in ("vehicle_positions", "trip_updates")}


def test_readiness_uses_gps_when_sample_has_no_stopped_at(city):
    declaration, static, samples = city
    report = check_provider(declaration, static=static, samples=samples, now=NOW)
    assert report["ready"], report["blockers"]
    assert report["capabilities"]["static_schedule"]["evidence"]["service_end"] == "2026-11-23"
    vehicle = report["capabilities"]["vehicle_positions"]["evidence"]
    assert vehicle["stop_detection"] == "gps_50m"
    assert vehicle["trip_id"] == {"reported": 1, "matched": 1}
    assert vehicle["occupancy_percentage"] == 1
    assert vehicle["timestamp_age_seconds"] == 5
    update = report["capabilities"]["trip_updates"]["evidence"]
    assert update["arrival"] == update["departure"] == 1
    assert report["capabilities"]["service_alerts"]["status"] == "not_applicable"


@pytest.mark.parametrize("defect", ["differential", "mismatch", "bad_zone", "stale"])
def test_readiness_reports_blockers(city, defect):
    declaration, static, samples = city
    vehicle = samples["vehicle_positions"]
    message = FeedMessage.FromString(vehicle.read_bytes())
    match defect:
        case "differential":
            message.header.incrementality = FeedHeader.DIFFERENTIAL
            expected = "differential feed requires full dataset"
        case "mismatch":
            message.entity[0].vehicle.trip.trip_id = "unmatched"
            message.entity[0].vehicle.stop_id = "unmatched"
            expected = "trip_id mismatch with static GTFS"
        case "stale":
            message.header.timestamp -= 3600
            expected = "timestamp outside"
        case "bad_zone":
            text = declaration.read_text(encoding="utf-8").replace(
                "America/Toronto", "Invalid/City"
            )
            declaration.write_text(text, encoding="utf-8")
            expected = "IANA timezone"
    vehicle.write_bytes(message.SerializeToString())
    report = check_provider(declaration, static=static, samples=samples, now=NOW)
    assert not report["ready"]
    assert any(expected in blocker for blocker in report["blockers"])
    if defect == "mismatch":
        assert any("stop_id mismatch" in blocker for blocker in report["blockers"])


def test_missing_key_does_not_stop_other_checks(city, monkeypatch):
    declaration, static, samples = city
    monkeypatch.delenv("STM_API_KEY", raising=False)
    del samples["trip_updates"]
    report = check_provider(declaration, static=static, samples=samples, now=NOW)
    assert report["blockers"] == ["trip_updates: key required"]
    assert report["capabilities"]["trip_updates"]["status"] == "key_required"
    assert report["capabilities"]["vehicle_positions"]["status"] == "supported"
