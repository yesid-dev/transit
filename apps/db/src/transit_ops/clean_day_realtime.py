"""Capture attempts and changes in reported vehicle state for a clean service day."""

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from hashlib import sha256
from math import asin, cos, radians, sin, sqrt
from typing import Literal, NamedTuple

from google.protobuf.message import DecodeError  # type: ignore[import-untyped]
from google.transit.gtfs_realtime_pb2 import FeedMessage, VehiclePosition

from transit_ops.gtfs.types import validate_wgs84_position
from transit_ops.providers.formats import decode_gtfs_rt

# Suppress small GPS fluctuations, measured from the last retained position.
VEHICLE_MOVEMENT_METRES = 15
_EARTH_RADIUS_METRES = 6_371_008.8

type PollResult = Literal["ok", "empty", "duplicate", "error"]


@dataclass(frozen=True, slots=True)
class DayCapture:
    family: str
    feed: str
    captured_at_utc: datetime
    attempt_id: str
    payload: bytes


@dataclass(frozen=True, slots=True)
class FeedPoll:
    feed: str
    captured_at_utc: datetime
    attempt_id: str
    result: PollResult
    feed_timestamp_utc: datetime | None
    payload_bytes: int | None
    entity_count: int | None


def read_capture(
    capture: DayCapture, seen: dict[tuple[str, bytes], FeedPoll]
) -> tuple[FeedPoll, FeedMessage | None]:
    key = (capture.feed, sha256(capture.payload).digest())
    if (previous := seen.get(key)) is not None:
        return replace(
            previous,
            captured_at_utc=capture.captured_at_utc,
            attempt_id=capture.attempt_id,
            result="error" if previous.result == "error" else "duplicate",
        ), None

    message: FeedMessage | None
    header, entities = None, None
    try:
        message = decode_gtfs_rt(capture.payload)
        if not message.IsInitialized():
            raise DecodeError("Incomplete GTFS-Realtime capture")
        if message.header.timestamp:
            header = datetime.fromtimestamp(message.header.timestamp, UTC)
        entities = len(message.entity)
        status: PollResult = "ok" if entities else "empty"
    except (DecodeError, OverflowError, OSError, ValueError):
        status = "error"
        message = None
    poll = FeedPoll(
        capture.feed,
        capture.captured_at_utc,
        capture.attempt_id,
        status,
        header,
        len(capture.payload),
        entities,
    )
    seen[key] = poll
    return poll, message


def distance_metres(lat: float, lon: float, other_lat: float, other_lon: float) -> float:
    arc = sin(radians(lat - other_lat) / 2) ** 2 + (
        cos(radians(lat)) * cos(radians(other_lat)) * sin(radians(lon - other_lon) / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_METRES * asin(sqrt(min(1.0, arc)))


class VehicleState(NamedTuple):
    service_date: date | None
    trip_id: str | None
    route_id: str | None
    stop_id: str | None
    stop_sequence: int | None
    current_status: int | None
    occupancy_status: int | None
    occupancy_percentage: int | None


@dataclass(frozen=True, slots=True)
class VehicleReading:
    vehicle_id: str
    captured_at_utc: datetime
    feed_timestamp_utc: datetime | None
    observed_at_utc: datetime
    state: VehicleState
    coords: tuple[float, float] | None

    def changed_since(self, last: "VehicleReading") -> bool:
        if self.state != last.state:
            return True
        if self.coords is None or last.coords is None:
            return self.coords != last.coords
        return distance_metres(*self.coords, *last.coords) > VEHICLE_MOVEMENT_METRES


def vehicle_reading(
    live: VehiclePosition,
    captured: datetime,
    header: datetime | None,
    observed: datetime,
    dated: date | None,
    route_id: str | None,
) -> VehicleReading:
    position = live.position
    latitude, longitude = position.latitude, position.longitude
    coords = (
        (latitude, longitude)
        if position.IsInitialized()
        and validate_wgs84_position(latitude, longitude) == "valid_wgs84"
        else None
    )
    return VehicleReading(
        live.vehicle.id,
        captured,
        header,
        observed,
        VehicleState(
            dated,
            live.trip.trip_id or None,
            live.trip.route_id or route_id,
            live.stop_id or None,
            live.current_stop_sequence if live.HasField("current_stop_sequence") else None,
            live.current_status if live.HasField("current_status") else None,
            live.occupancy_status if live.HasField("occupancy_status") else None,
            live.occupancy_percentage if live.HasField("occupancy_percentage") else None,
        ),
        coords,
    )
