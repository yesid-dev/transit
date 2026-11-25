"""Project recent, durable captures into the public Transit1 live contract."""

from __future__ import annotations

import logging
import os
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import md5
from math import isfinite
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from typing import Any, cast

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
from transit_ops.live.silent_trips import (
    UNMEASURED,
    TripReporting,
    count_silent_trips,
    feed_is_fresh,
)
from transit_ops.live.trip_delays import reconcile_delays
from transit_ops.live.trip_partitions import encode, trip_partitions
from transit_ops.live.trip_schedule import DAY_OFFSETS, MAX_SERVICE_SECONDS, LiveTripSchedule
from transit_ops.providers.alert_record import AlertRecord
from transit_ops.providers.schedule import service_day_start

LOGGER = logging.getLogger(__name__)
NAME = re.compile(r"(\d{8}T\d{12}Z)__([a-f0-9]{12})__[^/]+\.(?:pb|json)")
MOTION_POLL_SECONDS = 20
ALERT_POLL_SECONDS = 60
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
MAX_TRIP_BUNDLE_BYTES = 64 * 1024 * 1024


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
                "delay": None,
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
                "observed_at": update.timestamp or None,
                "delay": update.delay if update.HasField("delay") else None,
                "stops": stops,
            }
        )
    return rows


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


def _publish(
    destination: BronzeStorage,
    key: str,
    body: bytes,
    mime: str = "application/json",
) -> str:
    if isinstance(destination, S3BronzeStorage):
        result = destination.client.put_object(
            Bucket=destination.bucket,
            Key=key,
            Body=body,
            ContentType=mime,
        )
        etag = result.get("ETag")
        if not isinstance(etag, str) or not etag:
            raise ValueError("Live storage did not return an ETag")
        return etag
    elif isinstance(destination, LocalBronzeStorage):
        target = destination.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=target.parent, delete_on_close=False) as artifact:
            artifact.write(body)
            artifact.close()
            Path(artifact.name).replace(target)
        return f'"{md5(body, usedforsecurity=False).hexdigest()}"'
    else:
        raise TypeError("Unsupported live destination")


class LivePublisher:
    def __init__(self, manifest: ProviderManifest, raw: BronzeStorage, prefix: str = ""):
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
        return {
            "version": 1,
            "city": city,
            "stable_vehicle_ids": self.manifest.public.stable_vehicle_ids,
            "feeds": feeds,
            **data,
        }

    def run(
        self,
        destination: BronzeStorage,
        prefix: str,
        *,
        once: bool,
        require_captures: bool = False,
    ) -> None:
        if not self.manifest.public.enabled or not self.manifest.provider.is_active:
            raise ValueError("Live publication requires an active public city")
        with (
            TemporaryDirectory(prefix="transit-live-schedule-") as workspace,
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            schedule = LiveTripSchedule(
                self.manifest, self.raw, self.prefix, executor, Path(workspace)
            )
            self._run(destination, prefix, schedule, once=once, require_captures=require_captures)

    def _run(
        self,
        destination: BronzeStorage,
        prefix: str,
        schedule: LiveTripSchedule,
        *,
        once: bool,
        require_captures: bool,
    ) -> None:
        previous = None
        previous_trips: tuple[object, object] | None = None
        city = self.manifest.provider.provider_id
        reporting = TripReporting(self.manifest.provider.live_source_lag_seconds)
        while True:
            try:
                now = datetime.now(UTC)
                snapshot = self.poll(now)
                feeds = snapshot["feeds"]
                assert isinstance(feeds, dict)
                if require_captures:
                    movement = [
                        feed
                        for feed in feeds.values()
                        if feed["family"] in ("vehicle_positions", "trip_updates")
                    ]
                    if not movement or any(
                        not feed["captured_at"] or feed["read_failed"] for feed in movement
                    ):
                        raise ValueError("No complete movement capture for dry check")
                snapshot = (
                    {**snapshot, **UNMEASURED}
                    if require_captures
                    else _scheduled_snapshot(snapshot, schedule, reporting, now, wait=once)
                )
                if snapshot != previous:
                    document = {
                        key: value for key, value in snapshot.items() if key != "trip_updates"
                    }
                    document.update(version=2, published_at=_iso(now))
                    body = encode(document)
                    if len(body) > MAX_SNAPSHOT_BYTES:
                        raise ValueError("Live snapshot exceeds the publication size limit")
                    _publish(destination, f"{prefix}live/v2/{city}.json", body)
                    previous = snapshot
                    LOGGER.info("Published %s live snapshot (%s bytes)", city, len(body))
                updates = snapshot["trip_updates"]
                trip_feed = next(
                    (feed for feed in feeds.values() if feed["family"] == "trip_updates"),
                    None,
                )
                signature = (updates, trip_feed)
                if (
                    isinstance(updates, list)
                    and trip_feed is not None
                    and signature != previous_trips
                ):
                    vehicles = snapshot["vehicle_positions"]
                    _publish_trip_scopes(
                        destination,
                        prefix,
                        city,
                        trip_feed,
                        updates,
                        vehicles if isinstance(vehicles, list) else None,
                    )
                    previous_trips = signature
            except (OSError, BotoCoreError, ClientError, ValueError) as error:
                LOGGER.error("Live publication failed for %s (%s)", city, type(error).__name__)
                if once:
                    raise SystemExit(1) from None
            if once:
                return
            time.sleep(MOTION_POLL_SECONDS)


def _scheduled_snapshot(
    snapshot: dict[str, object],
    schedule: LiveTripSchedule,
    reporting: TripReporting,
    now: datetime,
    *,
    wait: bool,
) -> dict[str, object]:
    vehicles = cast(list[dict[str, Any]] | None, snapshot["vehicle_positions"])
    updates = cast(list[dict[str, Any]] | None, snapshot["trip_updates"])
    if vehicles is None and updates is None:
        return {**snapshot, **UNMEASURED}
    loaded = schedule.at(now, wait=wait)
    today = now.astimezone(schedule.zone).date()
    candidate_days = [today + timedelta(days=offset) for offset in DAY_OFFSETS]
    active_days = [
        day
        for day in candidate_days
        if 0 <= (now - service_day_start(day, schedule.zone)).total_seconds() < MAX_SERVICE_SECONDS
    ]
    days = {
        day: item
        for day, item in loaded.items()
        if item is not None
        and (
            day == today
            or -3600
            <= (now - service_day_start(day, schedule.zone)).total_seconds()
            < MAX_SERVICE_SECONDS + 3600
        )
    }
    if today not in days:
        days = {}
    trip_feed = next(
        (
            feed
            for feed in cast(dict[str, dict[str, Any]], snapshot["feeds"]).values()
            if feed["family"] == "trip_updates"
        ),
        None,
    )
    freshness = (
        trip_feed["fresh_for_seconds"] + trip_feed["source_lag_seconds"]
        if trip_feed is not None and feed_is_fresh(trip_feed, now)
        else 0
    )
    try:
        projected_vehicles, projected_updates = reconcile_delays(
            vehicles, updates, days, schedule.zone, now, update_window=freshness
        )
    except (OSError, sqlite3.Error) as error:
        LOGGER.warning("Live scheduled calls unavailable (%s)", type(error).__name__)
        days = {}
        projected_vehicles, projected_updates = reconcile_delays(
            vehicles, updates, days, schedule.zone, now, update_window=0
        )
    counts = UNMEASURED
    evidence = reporting.observe(snapshot, now)
    if evidence is not None and all(day in days for day in active_days):
        reports, cancellations = evidence
        counts = count_silent_trips(
            now,
            schedule.zone,
            {day: tuple(days[day].trips.values()) for day in active_days},
            reports=reports,
            cancellations=cancellations,
        )
    return {
        **snapshot,
        **counts,
        "vehicle_positions": projected_vehicles,
        "trip_updates": projected_updates,
    }


def _publish_trip_scopes(
    destination: BronzeStorage,
    prefix: str,
    city: str,
    feed: dict[str, object],
    updates: list[dict[str, object]],
    vehicles: list[dict[str, object]] | None,
) -> None:
    scoped = trip_partitions(updates, vehicles)
    if len(scoped.body) > MAX_TRIP_BUNDLE_BYTES:
        raise ValueError("Live trips exceed the publication size limit")
    trip_prefix = f"{prefix}live/v2/{city}/trips"
    etag = (
        _publish(
            destination,
            f"{trip_prefix}.bin",
            scoped.body,
            "application/octet-stream",
        )
        if scoped.body
        else None
    )
    index = encode(
        {
            "version": 2,
            "city": city,
            "feed": feed,
            "etag": etag,
            "ranges": scoped.ranges,
        }
    )
    if len(index) > MAX_SNAPSHOT_BYTES:
        raise ValueError("Live trip index exceeds the publication size limit")
    _publish(destination, f"{trip_prefix}.json", index)


def main() -> None:
    import argparse

    from transit_ops.clean_day_inputs import declaration_for
    from transit_ops.clean_days import _storage

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("city")
    parser.add_argument("--source", required=True)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--dest")
    output.add_argument(
        "--inspect", action="store_true", help="Read only, including private cities"
    )
    parser.add_argument("--provider-dir", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--require-captures", action="store_true")
    args = parser.parse_args()
    if args.require_captures and (not args.once or args.inspect):
        parser.error("--require-captures requires publication with --once")
    logging.basicConfig(level=logging.INFO)
    if not args.inspect and os.environ.get("TRANSIT1_LIVE_ENABLED", "1") != "1":
        LOGGER.info("Transit1 live publisher disabled")
        if args.require_captures:
            raise SystemExit(1)
        return
    raw, source_prefix = _storage(args.source, "SOURCE")
    publisher = LivePublisher(
        declaration_for(args.city, directory=args.provider_dir), raw, source_prefix
    )
    if args.inspect:
        result = publisher.poll(datetime.now(UTC))
        print(encode({"city": args.city, "feeds": result["feeds"]}).decode())
        return
    clean, dest_prefix = _storage(args.dest, "DEST")
    publisher.run(
        clean,
        dest_prefix,
        once=args.once,
        require_captures=args.require_captures,
    )


if __name__ == "__main__":
    main()
