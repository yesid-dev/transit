"""Project recent, durable captures into the public Transit1 live contract."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from math import isfinite
from pathlib import Path
from tempfile import NamedTemporaryFile

from botocore.exceptions import BotoCoreError, ClientError
from google.transit.gtfs_realtime_pb2 import FeedHeader, FeedMessage

from transit_ops.clean_day_alerts import alert_sources, read_alert_capture
from transit_ops.clean_day_inputs import (
    LooseCapture,
    capture_feeds,
    read_loose_captures,
)
from transit_ops.clean_day_realtime import DayCapture, read_capture, vehicle_reading
from transit_ops.core.models import ProviderManifest
from transit_ops.ingestion.storage import BronzeStorage, LocalBronzeStorage, S3BronzeStorage
from transit_ops.providers.alert_record import AlertRecord

LOGGER = logging.getLogger(__name__)
NAME = re.compile(r"(\d{8}T\d{12}Z)__([a-f0-9]{12})__[^/]+\.(?:pb|json)")
MOTION_POLL_SECONDS = 20
ALERT_POLL_SECONDS = 60
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024


def _iso(stamp: datetime | None) -> str | None:
    return stamp.isoformat() if stamp is not None else None


def _vehicles(
    message: FeedMessage,
    captured: datetime,
    header: datetime | None,
    manifest: ProviderManifest,
) -> list[dict[str, object]]:
    rows = []
    hidden = set(manifest.realtime.unpublished_vehicle_fields)
    gap_routes = {
        route for gap in manifest.realtime.lines_without_live_data for route in gap.route_ids
    }
    for entity in message.entity:
        if entity.is_deleted or not entity.HasField("vehicle"):
            continue
        live = entity.vehicle
        reading = vehicle_reading(live, captured, header, captured, None, None)
        state = reading.state
        if reading.coords is None or state.route_id in gap_routes or "position" in hidden:
            continue
        lat, lon = reading.coords
        bounds = manifest.provider.bounds
        if bounds and not (
            bounds.min_latitude <= lat <= bounds.max_latitude
            and bounds.min_longitude <= lon <= bounds.max_longitude
        ):
            continue
        observed = datetime.fromtimestamp(live.timestamp, UTC) if live.timestamp else header
        position = live.position
        bearing = position.bearing
        speed = position.speed
        rows.append(
            {
                "id": entity.id,
                "vehicle_id": live.vehicle.id or None
                if manifest.public.stable_vehicle_ids is not False
                else None,
                "trip_id": state.trip_id if "trip" not in hidden else None,
                "start_date": (live.trip.start_date or None) if "trip" not in hidden else None,
                "start_time": (live.trip.start_time or None) if "trip" not in hidden else None,
                "route_id": state.route_id if "route" not in hidden else None,
                "direction_id": live.trip.direction_id
                if "trip" not in hidden and live.trip.HasField("direction_id")
                else None,
                "latitude": lat,
                "longitude": lon,
                "bearing": bearing if position.HasField("bearing") and 0 <= bearing < 360 else None,
                "speed_mps": speed
                if position.HasField("speed") and isfinite(speed) and speed >= 0
                else None,
                "stop_id": state.stop_id if "stop" not in hidden else None,
                "stop_sequence": state.stop_sequence if "stop" not in hidden else None,
                "status": state.current_status if "current_status" not in hidden else None,
                "occupancy": state.occupancy_status if "occupancy" not in hidden else None,
                "occupancy_percentage": state.occupancy_percentage
                if "occupancy" not in hidden
                else None,
                "observed_at": _iso(observed),
            }
        )
    return rows


def _trip_updates(message: FeedMessage, captured: datetime) -> list[dict[str, object]]:
    cutoff = int(captured.timestamp()) - 120
    rows = []
    for entity in message.entity:
        if entity.is_deleted or not entity.HasField("trip_update"):
            continue
        update = entity.trip_update
        trip = update.trip
        if not trip.trip_id:
            continue
        stops = []
        for stop in update.stop_time_update:
            arrival, departure = stop.arrival, stop.departure
            if (stamp := departure.time or arrival.time) and stamp < cutoff:
                continue
            # Delay-only and skipped updates need their schedule edition to resolve the stop.
            stops.append(
                {
                    "stop_id": stop.stop_id or None,
                    "sequence": stop.stop_sequence if stop.HasField("stop_sequence") else None,
                    "arrival": arrival.time or None,
                    "departure": departure.time or None,
                    "arrival_delay": arrival.delay if arrival.HasField("delay") else None,
                    "departure_delay": departure.delay if departure.HasField("delay") else None,
                    "relationship": stop.schedule_relationship,
                }
            )
        rows.append(
            {
                "trip_id": trip.trip_id,
                "route_id": trip.route_id or None,
                "direction_id": trip.direction_id if trip.HasField("direction_id") else None,
                "start_date": trip.start_date or None,
                "start_time": trip.start_time or None,
                "relationship": trip.schedule_relationship,
                "delay": update.delay if update.HasField("delay") else None,
                "stops": stops,
            }
        )
    return rows


def _with_vehicle_delays(
    vehicles: list[dict[str, object]] | None,
    updates: list[dict[str, object]] | None,
) -> list[dict[str, object]] | None:
    if vehicles is None:
        return None
    by_trip: dict[str, list[dict[str, object]]] = {}
    for update in updates or []:
        by_trip.setdefault(str(update["trip_id"]), []).append(update)
    result = []
    for vehicle in vehicles:
        matches = [
            update
            for update in by_trip.get(str(vehicle["trip_id"]), [])
            if all(
                not vehicle[field] or not update[field] or vehicle[field] == update[field]
                for field in ("start_date", "start_time")
            )
        ]
        delay = None
        if len(matches) == 1:
            update = matches[0]
            delay = update["delay"]
            stops = update["stops"]
            assert isinstance(stops, list)
            for stop in stops:
                if vehicle["stop_sequence"] is not None:
                    matched = stop["sequence"] == vehicle["stop_sequence"]
                else:
                    matched = (
                        vehicle["stop_id"] is not None and stop["stop_id"] == vehicle["stop_id"]
                    )
                if matched:
                    for field in ("departure_delay", "arrival_delay"):
                        if stop[field] is not None:
                            delay = stop[field]
                            break
                    break
        result.append({**vehicle, "delay": delay})
    return result


def _alerts(records: tuple[AlertRecord, ...], now: datetime) -> list[dict[str, object]]:
    rows = {}
    for record in records:
        periods = record.active_periods
        if periods and not any(
            (start is None or start <= now) and (end is None or now < end) for start, end in periods
        ):
            continue
        identity = record.id or record.identity.content_hash()
        rows[identity] = {
            "id": identity,
            "header": record.header,
            "description": record.description,
            "url": record.url,
            "cause": record.cause,
            "effect": record.effect,
            "severity": record.severity_level,
            "routes": sorted({item.route_id for item in record.informed_entities if item.route_id}),
            "stops": sorted({item.stop_id for item in record.informed_entities if item.stop_id}),
            "periods": [[_iso(start), _iso(end)] for start, end in periods],
        }
    return list(rows.values())


@dataclass(frozen=True)
class Observation:
    captured: datetime
    source_time: datetime | None
    rows: list[dict[str, object]] | tuple[AlertRecord, ...]


def _latest(
    raw: BronzeStorage,
    prefix: str,
    city: str,
    endpoint: str,
    family: str,
    now: datetime,
) -> LooseCapture | None:
    for hour in (now, now - timedelta(hours=1)):
        partition = f"{prefix}{city}/{endpoint}/captured_at_utc={hour:%Y-%m-%d}/"
        latest = None
        for key in raw.list_keys(partition + hour.strftime("%Y%m%dT%H")):
            match = NAME.fullmatch(key.removeprefix(partition))
            if match is None:
                continue
            captured = datetime.strptime(match[1], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
            if captured <= now and (latest is None or captured > latest.captured):
                latest = LooseCapture(captured, endpoint, family, key, match[2])
        if latest is not None:
            return latest
    return None


def _publish(destination: BronzeStorage, key: str, body: bytes) -> None:
    if isinstance(destination, S3BronzeStorage):
        destination.client.put_object(
            Bucket=destination.bucket,
            Key=key,
            Body=body,
            ContentType="application/json",
        )
    elif isinstance(destination, LocalBronzeStorage):
        target = destination.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=target.parent, delete_on_close=False) as artifact:
            artifact.write(body)
            artifact.close()
            Path(artifact.name).replace(target)
    else:
        raise TypeError("Unsupported live destination")


class LivePublisher:
    def __init__(self, manifest: ProviderManifest, raw: BronzeStorage, prefix: str = ""):
        if not manifest.public.enabled or not manifest.provider.is_active:
            raise ValueError("Live publication requires an active public city")
        self.manifest = manifest
        self.raw = raw
        self.prefix = prefix
        self.feeds = capture_feeds(manifest)
        self.alerts = alert_sources(manifest)
        self.captures: dict[str, Observation] = {}
        self.checked: dict[str, datetime] = {}
        self.failures: set[str] = set()

    def _read(self, capture: DayCapture) -> Observation:
        if source := self.alerts.get(capture.feed):
            poll, records = read_alert_capture(capture, source[0], {})
            if poll.result == "error":
                raise ValueError("Unreadable alert capture")
            return Observation(capture.captured_at_utc, poll.feed_timestamp_utc, records)
        poll, message = read_capture(capture, {})
        if message is None or message.header.incrementality == FeedHeader.DIFFERENTIAL:
            raise ValueError("Expected a full realtime capture")
        rows = (
            _vehicles(message, capture.captured_at_utc, poll.feed_timestamp_utc, self.manifest)
            if capture.family == "vehicle_positions"
            else _trip_updates(message, capture.captured_at_utc)
        )
        return Observation(capture.captured_at_utc, poll.feed_timestamp_utc, rows)

    def poll(self, now: datetime) -> dict[str, object]:
        city = self.manifest.provider.provider_id
        data: dict[str, list[dict[str, object]] | None] = {
            "vehicle_positions": None,
            "trip_updates": None,
            "alerts": None,
        }
        feeds = {}
        for endpoint, kind in self.feeds.items():
            is_alert = endpoint in self.alerts
            family = "alerts" if is_alert else kind
            cadence = ALERT_POLL_SECONDS if is_alert else MOTION_POLL_SECONDS
            observed = self.captures.get(endpoint)
            if (
                endpoint not in self.checked
                or (now - self.checked[endpoint]).total_seconds() >= cadence
            ):
                self.checked[endpoint] = now
                try:
                    latest = _latest(self.raw, self.prefix, city, endpoint, family, now)
                    if latest and (observed is None or latest.captured > observed.captured):
                        observed = self._read(next(read_loose_captures(self.raw, [latest])))
                        self.captures[endpoint] = observed
                    self.failures.discard(endpoint)
                except (OSError, ValueError, OverflowError) as error:
                    self.failures.add(endpoint)
                    LOGGER.warning(
                        "Live capture read failed for %s/%s (%s)",
                        city,
                        endpoint,
                        type(error).__name__,
                    )
            fresh_for = max(60, 3 * self.manifest.feeds[endpoint].refresh_interval_seconds)
            feeds[endpoint] = {
                "family": family,
                "captured_at": _iso(observed.captured) if observed else None,
                "source_at": _iso(observed.source_time) if observed else None,
                "fresh_for_seconds": fresh_for,
                "source_lag_seconds": self.manifest.provider.live_source_lag_seconds,
                "read_failed": endpoint in self.failures,
            }
            if observed:
                rows = observed.rows
                projected = _alerts(rows, now) if isinstance(rows, tuple) else rows
                data[family] = [*(data[family] or []), *projected]
        data["vehicle_positions"] = _with_vehicle_delays(
            data["vehicle_positions"],
            data["trip_updates"],
        )
        return {
            "version": 1,
            "city": city,
            "stable_vehicle_ids": self.manifest.public.stable_vehicle_ids,
            "feeds": feeds,
            **data,
        }

    def run(self, destination: BronzeStorage, prefix: str, *, once: bool) -> None:
        previous = None
        city = self.manifest.provider.provider_id
        while True:
            try:
                now = datetime.now(UTC)
                snapshot = self.poll(now)
                if snapshot != previous:
                    document = {**snapshot, "published_at": _iso(now)}
                    body = json.dumps(
                        document,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode()
                    if len(body) > MAX_SNAPSHOT_BYTES:
                        raise ValueError("Live snapshot exceeds the publication size limit")
                    _publish(destination, f"{prefix}live/v1/{city}.json", body)
                    previous = snapshot
                    LOGGER.info("Published %s live snapshot (%s bytes)", city, len(body))
            except (OSError, BotoCoreError, ClientError, ValueError) as error:
                LOGGER.error("Live publication failed for %s (%s)", city, type(error).__name__)
                if once:
                    raise SystemExit(1) from None
            if once:
                return
            time.sleep(MOTION_POLL_SECONDS)


def main() -> None:
    import argparse

    from transit_ops.clean_day_inputs import declaration_for
    from transit_ops.clean_days import _storage

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("city")
    parser.add_argument("--source", required=True)
    parser.add_argument("--dest", required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    if os.environ.get("TRANSIT1_LIVE_ENABLED", "1") != "1":
        LOGGER.info("Transit1 live publisher disabled")
        return
    raw, source_prefix = _storage(args.source, "SOURCE")
    clean, dest_prefix = _storage(args.dest, "DEST")
    LivePublisher(declaration_for(args.city), raw, source_prefix).run(
        clean,
        dest_prefix,
        once=args.once,
    )


if __name__ == "__main__":
    main()
