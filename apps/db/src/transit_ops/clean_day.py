"""Derive one service day's event rows from pinned schedule and capture evidence."""

from bisect import bisect_left
from collections import Counter
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import cache
from hashlib import sha256
from math import asin, cos, radians, sin, sqrt
from typing import Literal, NamedTuple

from google.transit.gtfs_realtime_pb2 import TripDescriptor, TripUpdate, VehiclePosition

from transit_ops.gold.vehicle_instance_rule import (
    SANITY_DELAY_SECONDS,
    TripInstance,
    accepted_instance,
    resolve_vehicle_capture,
)
from transit_ops.gtfs.types import parse_gtfs_date, parse_gtfs_service_time, validate_wgs84_position
from transit_ops.providers.formats import decode_gtfs_rt
from transit_ops.providers.normalize import RawCapture
from transit_ops.providers.schedule import ScheduledStop
from transit_ops.providers.schedule_archive import ArchiveScheduleContext

# Allow normal GPS and platform-coordinate error on these urban networks while
# requiring proximity on the scale of a stop, rather than a route segment.
STOPPED_AT_RADIUS_METRES = 50
CLEANING_VERSION = "1"
_REMOVED = {TripDescriptor.CANCELED, TripDescriptor.DELETED}
_EXTRA = {TripDescriptor.ADDED, TripDescriptor.NEW, TripDescriptor.UNSCHEDULED}

type State = Literal["ran", "cancelled", "missing", "added"]
type Basis = Literal["vehicle_stopped", "trip_update_reported", "trip_update_passed"]
type Event = Literal["arrival", "departure"]
type Row = tuple[object, ...]
_BASIS_RANK: dict[Basis, int] = {
    "vehicle_stopped": 0,
    "trip_update_reported": 1,
    "trip_update_passed": 2,
}


class Reading(NamedTuple):
    second: int
    vehicle_id: str | None
    basis: Basis
    event: Event


class Prediction(NamedTuple):
    published: int
    reading: Reading


@dataclass
class Stop:
    stop_id: str
    arrival: int | None = None
    departure: int | None = None
    observed: Reading | None = None
    prediction: Prediction | None = None

    def observe(self, reading: Reading) -> None:
        prior = self.observed
        if prior is None or (_BASIS_RANK[reading.basis], reading.second) < (
            _BASIS_RANK[prior.basis],
            prior.second,
        ):
            self.observed = reading


@dataclass
class Trip:
    route_id: str | None
    direction_id: int | None
    start: int | None
    stops: dict[int, Stop]
    added: bool = False
    unique_sequences: dict[str, int] = field(default_factory=dict)
    first_capture: datetime | None = None
    last_capture: datetime | None = None
    # Source publication time, relationship and the capture time of the notice.
    relationship: tuple[int, int, datetime] | None = None
    progress: dict[str, tuple[int, int]] = field(default_factory=dict)
    last_source: dict[str, int] = field(default_factory=dict)

    def locate(self, sequence: int | None, stop_id: str) -> tuple[int, Stop] | None:
        if sequence is None:
            sequence = self.unique_sequences.get(stop_id)
        if sequence is None:
            return None
        stop = self.stops.get(sequence)
        if stop is None and self.added and stop_id:
            stop = self.stops.setdefault(sequence, Stop(stop_id))
        return (sequence, stop) if stop and (not stop_id or stop.stop_id == stop_id) else None

    def discard_reversed_readings(self) -> None:
        candidates = [
            (seq, stop.observed) for seq, stop in self.stops.items() if stop.observed is not None
        ]
        sequences: list[int] = []
        seconds: list[int] = []
        for seq, reading in sorted(
            candidates, key=lambda pair: (_BASIS_RANK[pair[1].basis], pair[0])
        ):
            index = bisect_left(sequences, seq)
            if (index > 0 and seconds[index - 1] > reading.second) or (
                index < len(seconds) and seconds[index] < reading.second
            ):
                self.stops[seq].observed = None
            else:
                sequences.insert(index, seq)
                seconds.insert(index, reading.second)


def _timestamp(value: int | None) -> datetime | None:
    return datetime.fromtimestamp(value, UTC) if value is not None else None


def _scheduled(schedule: ArchiveScheduleContext, day: date, trip_id: str, anchor: int) -> Trip:
    trip = schedule.trip(day, trip_id)
    assert trip is not None
    stops = {}
    previous = None
    for item in schedule.stop_times(day, trip_id):
        arrival, departure = item.arrival_s, item.departure_s
        for stamp in (arrival, departure):
            if stamp is not None:
                if previous is not None and stamp < previous:
                    raise ValueError(f"Stop times go backwards for scheduled trip {trip_id}")
                previous = stamp
        if item.stop_sequence < 0:
            raise ValueError(f"Negative stop sequence for scheduled trip {trip_id}")
        stops[item.stop_sequence] = Stop(
            item.stop_id,
            None if arrival is None else anchor + arrival,
            None if departure is None else anchor + departure,
        )
    counts = Counter(stop.stop_id for stop in stops.values())
    unique = {stop.stop_id: seq for seq, stop in stops.items() if counts[stop.stop_id] == 1}
    return Trip(
        trip.route_id,
        trip.direction_id,
        anchor + trip.first_departure_s,
        stops,
        unique_sequences=unique,
    )


def _near_stop(position: VehiclePosition, stop: ScheduledStop | None) -> bool:
    if (
        stop is None
        or stop.lat is None
        or stop.lon is None
        or not position.HasField("position")
        or not position.position.IsInitialized()
    ):
        return False
    lat, lon = position.position.latitude, position.position.longitude
    if validate_wgs84_position(lat, lon) != "valid_wgs84":
        return False
    if validate_wgs84_position(stop.lat, stop.lon) != "valid_wgs84":
        return False
    arc = sin(radians(lat - stop.lat) / 2) ** 2 + (
        cos(radians(lat)) * cos(radians(stop.lat)) * sin(radians(lon - stop.lon) / 2) ** 2
    )
    distance = 2 * 6_371_008.8 * asin(sqrt(min(1.0, arc)))
    return distance <= STOPPED_AT_RADIUS_METRES


def _vehicle(
    trip: Trip, position: VehiclePosition, stamp: int, schedule: ArchiveScheduleContext, day: date
) -> None:
    located = trip.locate(
        position.current_stop_sequence if position.HasField("current_stop_sequence") else None,
        position.stop_id,
    )
    if located is None:
        return
    seq, stop = located
    vehicle = position.vehicle.id or None
    stopped = position.current_status == VehiclePosition.STOPPED_AT
    if stopped:
        if not _near_stop(position, schedule.stop(day, stop.stop_id)):
            return
        stop.observe(Reading(stamp, vehicle, "vehicle_stopped", "arrival"))
    # Retain only the first passage of a sequence per vehicle and ignore regressions.
    old_seq, old_stamp = trip.progress.get(vehicle or "", (-1, -1))
    if seq <= old_seq or stamp < old_stamp:
        return
    trip.progress[vehicle or ""] = (seq, stamp)
    for number, prior in trip.stops.items():
        if not old_seq <= number < seq or prior.prediction is None:
            continue
        published, reading = prior.prediction
        if (
            published <= stamp
            and reading.second <= stamp
            and (not reading.vehicle_id or not vehicle or reading.vehicle_id == vehicle)
        ):
            prior.observe(reading._replace(vehicle_id=reading.vehicle_id or vehicle))


def _update(trip: Trip, update: TripUpdate, stamp: int, captured: datetime) -> None:
    relationship = update.trip.schedule_relationship
    previous = trip.relationship
    # On equal timestamps, a removal wins over predictions from a conflicting entity.
    if previous is None or (stamp, relationship in _REMOVED) > (
        previous[0],
        previous[1] in _REMOVED,
    ):
        trip.relationship = (stamp, relationship, captured)
    if relationship in _REMOVED:
        return
    vehicle = update.vehicle.id or None
    for item in update.stop_time_update:
        located = trip.locate(
            item.stop_sequence if item.HasField("stop_sequence") else None, item.stop_id
        )
        if located is None:
            continue
        seq, stop = located
        if item.schedule_relationship in (item.SKIPPED, item.NO_DATA):
            if stop.prediction is None or stop.prediction.published <= stamp:
                stop.prediction = None
            continue
        prediction = _predicted_time(item, stop, stamp, vehicle)
        if prediction is None:
            continue
        if prediction.basis == "trip_update_reported":
            stop.observe(prediction)
        # At the first vehicle passage, use the last prediction received before
        # passage, provided its publication and estimated time are no later than
        # the passing reading. Never promote a later forecast simply as it ages.
        elif not any(
            ahead > seq
            for ident, (ahead, _) in trip.progress.items()
            if not vehicle or not ident or ident == vehicle
        ) and (stop.prediction is None or stamp > stop.prediction.published):
            stop.prediction = Prediction(stamp, prediction)


def _predicted_time(
    item: TripUpdate.StopTimeUpdate, stop: Stop, stamp: int, vehicle: str | None
) -> Reading | None:
    kinds: tuple[Event, ...] = ("arrival", "departure")
    forecast = None
    for kind in kinds:
        event = item.arrival if kind == "arrival" else item.departure
        scheduled = stop.arrival if kind == "arrival" else stop.departure
        absolute = event.time if event.HasField("time") and event.time > 0 else None
        if absolute is not None:
            second = absolute
        elif scheduled is not None and event.HasField("delay"):
            second = scheduled + event.delay
        else:
            continue
        # A past absolute timestamp explicitly marked exact is the feed's
        # report of a stop time. Absent uncertainty does not mean zero.
        if (
            absolute is not None
            and event.HasField("uncertainty")
            and event.uncertainty == 0
            and second <= stamp
        ):
            return Reading(second, vehicle, "trip_update_reported", kind)
        if forecast is None:
            forecast = Reading(second, vehicle, "trip_update_passed", kind)
    return forecast


def _service_date(
    descriptor: TripDescriptor, published: datetime, candidates: tuple[TripInstance, ...]
) -> date | None:
    if descriptor.start_date:
        try:
            return parse_gtfs_date(descriptor.start_date, field_name="trip start_date")
        except ValueError:
            return None
    if not candidates:
        return None
    if descriptor.start_time:
        try:
            seconds = parse_gtfs_service_time(
                descriptor.start_time, field_name="trip start_time"
            ).total_seconds
        except ValueError:
            return None
        candidates = tuple(c for c in candidates if c.first_departure_seconds == seconds)
    accepted = accepted_instance(resolve_vehicle_capture(published, candidates))
    return None if accepted is None else accepted.service_date


@dataclass
class CleanDay:
    provider: str
    date: date
    edition_sha256: str
    trips: dict[str, Trip]
    live_routes: set[str]

    def trip_rows(self) -> Iterator[Row]:
        for trip_id, trip in sorted(self.trips.items()):
            observed = [s.observed for s in trip.stops.values() if s.observed is not None]
            vehicles = [r for r in observed if r.vehicle_id is not None]
            vehicle = min(vehicles).vehicle_id if vehicles else None
            route_live = trip.route_id in self.live_routes
            notice = None
            state: State | None = None
            if trip.added:
                state = "added"
            elif trip.relationship and trip.relationship[1] in _REMOVED:
                state = "cancelled"
                notice = trip.relationship[2]
            elif observed:
                state = "ran"
            elif trip.first_capture is None and route_live:
                state = "missing"
            # A route without live coverage or a live trip without a confirmed
            # stop has insufficient evidence for any of the scheduled states.
            yield (
                *self._identity(trip_id, trip),
                _timestamp(trip.start),
                state,
                vehicle,
                route_live,
                trip.first_capture,
                trip.last_capture,
                notice,
            )

    def stop_rows(self) -> Iterator[Row]:
        for trip_id, trip in sorted(self.trips.items()):
            for seq, stop in sorted(trip.stops.items()):
                reading = stop.observed
                scheduled = (
                    stop.departure
                    if reading and reading.event == "departure"
                    else (stop.arrival if stop.arrival is not None else stop.departure)
                )
                yield (
                    *self._identity(trip_id, trip),
                    stop.stop_id,
                    seq,
                    _timestamp(stop.arrival),
                    _timestamp(stop.departure),
                    _timestamp(reading.second) if reading else None,
                    reading.second - scheduled if reading and scheduled is not None else None,
                    reading.basis if reading else "not_observed",
                    reading.event if reading else None,
                    reading.vehicle_id if reading else None,
                )

    def _identity(self, trip_id: str, trip: Trip) -> Row:
        return (
            self.provider,
            self.date,
            trip_id,
            trip.route_id,
            trip.direction_id,
            CLEANING_VERSION,
        )


def capture_window(schedule: ArchiveScheduleContext, day: date) -> tuple[datetime, datetime]:
    anchor = schedule.service_day_start(day)
    end = max(
        (
            trip.last_arrival_s
            for ident in schedule.days[day].trip_ids
            if (trip := schedule.trip(day, ident)) is not None
        ),
        default=0,
    )
    margin = timedelta(seconds=SANITY_DELAY_SECONDS)
    return anchor - margin, anchor + timedelta(seconds=max(86_400, end)) + margin


def build_clean_day(
    provider: str,
    day: date,
    schedules: Mapping[date, ArchiveScheduleContext],
    captures: Iterable[RawCapture],
) -> CleanDay:
    schedule = schedules[day]
    anchor = int(schedule.service_day_start(day).timestamp())
    trips = {
        ident: _scheduled(schedule, day, ident, anchor) for ident in schedule.days[day].trip_ids
    }
    result = CleanDay(provider, day, schedule.days[day].edition_sha256, trips, set())
    anchors = {d: context.service_day_start(d) for d, context in schedules.items()}

    @cache
    def candidates_for(ident: str) -> tuple[TripInstance, ...]:
        return tuple(
            TripInstance(
                ident,
                d,
                anchors[d] + timedelta(seconds=trip.first_departure_s),
                anchors[d] + timedelta(seconds=trip.last_arrival_s),
                trip.first_departure_s,
            )
            for d, context in schedules.items()
            if (trip := context.trip(d, ident)) is not None
        )

    seen: set[tuple[str, bytes]] = set()
    prior_capture: datetime | None = None
    for capture in captures:
        captured = capture.captured_at_utc
        if captured.utcoffset() is None or (prior_capture is not None and captured < prior_capture):
            raise ValueError("Captures must arrive in UTC time order")
        prior_capture = captured
        key = (capture.family, sha256(capture.payload).digest())
        if key in seen:
            continue
        seen.add(key)
        message = decode_gtfs_rt(capture.payload)
        if not message.IsInitialized():
            raise ValueError(f"Incomplete GTFS-Realtime capture: {capture.label}")
        capture_second = int(captured.timestamp())
        feed_second = min(message.header.timestamp or capture_second, capture_second)
        is_update = capture.family == "trip_updates"
        for entity in message.entity:
            if entity.is_deleted:
                continue
            if is_update and entity.HasField("trip_update"):
                live: TripUpdate | VehiclePosition = entity.trip_update
            elif capture.family == "vehicle_positions" and entity.HasField("vehicle"):
                live = entity.vehicle
            else:
                continue
            if not live.HasField("trip"):
                continue
            stamp = min(live.timestamp or feed_second, capture_second)
            published = datetime.fromtimestamp(stamp, UTC)
            desc = live.trip
            dated = _service_date(desc, published, candidates_for(desc.trip_id))
            if dated != day:
                if (
                    dated is None
                    and not desc.start_date
                    and not candidates_for(desc.trip_id)
                    and published.astimezone(schedule.timezone).date() == day
                    and desc.route_id
                ):
                    result.live_routes.add(desc.route_id)
                continue
            trip = trips.get(desc.trip_id)
            if trip is None:
                if desc.route_id:
                    result.live_routes.add(desc.route_id)
                if not desc.trip_id or desc.schedule_relationship not in _EXTRA | {
                    TripDescriptor.SCHEDULED
                }:
                    continue
                trip = trips.setdefault(
                    desc.trip_id,
                    Trip(
                        desc.route_id or None,
                        desc.direction_id if desc.HasField("direction_id") else None,
                        None,
                        {},
                        added=True,
                    ),
                )
            if desc.route_id and trip.route_id and desc.route_id != trip.route_id:
                continue
            if trip.added and trip.route_id is None:
                trip.route_id = desc.route_id or None
            if trip.route_id:
                result.live_routes.add(trip.route_id)
            trip.first_capture = trip.first_capture or captured
            if stamp > trip.last_source.get(capture.family, -1):
                trip.last_capture = captured
                trip.last_source[capture.family] = stamp
            if isinstance(live, TripUpdate):
                _update(trip, live, stamp, captured)
            elif desc.schedule_relationship not in _REMOVED:
                _vehicle(trip, live, stamp, schedule, day)
    for trip in trips.values():
        trip.discard_reversed_readings()
    return result
