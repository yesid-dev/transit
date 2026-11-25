"""Derive one service day's event rows from pinned schedule and capture evidence."""

from bisect import bisect_left, bisect_right
from collections import Counter
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import cache
from pathlib import Path
from struct import Struct
from tempfile import TemporaryDirectory
from typing import BinaryIO, Literal, NamedTuple
from zoneinfo import ZoneInfo

from google.transit.gtfs_realtime_pb2 import FeedHeader, TripDescriptor, TripUpdate, VehiclePosition

from transit_ops.capture_coverage.rules import (
    CoveredInterval,
    Feed,
    PollFacts,
    covered_intervals,
    usable_polls,
)
from transit_ops.clean_day_alerts import AlertVersion
from transit_ops.clean_day_realtime import (
    DayCapture,
    FeedPoll,
    VehicleStateInterval,
    distance_metres,
    read_capture,
    vehicle_reading,
)
from transit_ops.core.models import SourceFormat
from transit_ops.gold.vehicle_instance_rule import (
    SANITY_DELAY_SECONDS,
    TripInstance,
    VehicleDescriptor,
)
from transit_ops.gtfs.trip_identity import reported_service_date, resolve_trip_instance
from transit_ops.gtfs.types import validate_wgs84_position
from transit_ops.providers.formats import decode_gtfs_rt
from transit_ops.providers.schedule import ScheduledStop
from transit_ops.providers.schedule_archive import ArchiveScheduleContext

# Allow normal GPS and platform-coordinate error on these urban networks while
# requiring proximity on the scale of a stop, rather than a route segment.
STOPPED_AT_RADIUS_METRES = 50
# Allow two p90 fix intervals at the measured slower feed cadence.
GPS_ENTRY_MAX_GAP_SECONDS = 160
# Require several opportunities to see early reporting around departure, even
# for short trips, at the providers' normal 20–60 second feed cadences.
ABSENCE_LEAD_SECONDS = 300
CLEANING_VERSION = "12"
MAX_SEGMENT_RUN_MULTIPLE = 5
PREDICTION_HORIZONS_MINUTES = (1, 3, 5, 10, 15, 20, 30)
_PREDICTION_HORIZONS_SECONDS = tuple(minutes * 60 for minutes in PREDICTION_HORIZONS_MINUTES)
_PREDICTION_LIMIT_SECONDS = 40 * 60
_CAPTURE_FRAME = Struct(">qQ")  # capture second and payload length
_UTC_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_LAST_TIMESTAMP_SECOND = (datetime.max.replace(tzinfo=UTC) - _UTC_EPOCH) // timedelta(seconds=1)
REALTIME_FEEDS: tuple[Feed, ...] = ("trip_updates", "vehicle_positions")
_REMOVED = {TripDescriptor.CANCELED, TripDescriptor.DELETED}
_EXTRA = {
    TripDescriptor.ADDED,
    TripDescriptor.NEW,
    TripDescriptor.UNSCHEDULED,
    TripDescriptor.SCHEDULED,
}
_SKIPPED_OR_NO_DATA = {TripUpdate.StopTimeUpdate.SKIPPED, TripUpdate.StopTimeUpdate.NO_DATA}

type State = Literal["ran", "cancelled", "missing", "unconfirmed", "not_measured", "added"]
type StateReason = Literal["route_without_live_data", "capture_gap"]
type Basis = Literal[
    "vehicle_stopped", "vehicle_nearby", "trip_update_reported", "trip_update_passed"
]
type Event = Literal["arrival", "departure"]
type Row = tuple[object, ...]
_BASIS_RANK: dict[Basis, int] = {
    "vehicle_stopped": 0,
    "vehicle_nearby": 1,
    "trip_update_reported": 2,
    "trip_update_passed": 3,
}


class Reading(NamedTuple):
    second: int
    vehicle_id: str | None
    basis: Basis
    event: Event


type Prediction = tuple[int, int, str | None, Event]  # publication, estimate, vehicle, event


@dataclass(slots=True)
class Stop:
    stop_id: str
    arrival: int | None = None
    departure: int | None = None
    observed: Reading | None = None
    prediction: Prediction | None = None
    prediction_samples: list[tuple[int, int] | None] | None = None
    wheelchair_boarding: int | None = None

    def observe(self, reading: Reading) -> None:
        prior = self.observed
        if prior is None or (_BASIS_RANK[reading.basis], reading.second) < (
            _BASIS_RANK[prior.basis],
            prior.second,
        ):
            self.observed = reading


@dataclass(slots=True)
class Trip:
    route_id: str | None
    direction_id: int | None
    start: int | None
    stops: dict[int, Stop]
    end: int | None = None
    added: bool = False
    unique_sequences: dict[str, int] = field(default_factory=dict)
    first_capture: datetime | None = None
    last_capture: datetime | None = None
    # Source publication time and relationship from the latest trip update.
    relationship: tuple[int, int] | None = None
    cancellation_notice: datetime | None = None
    progress: dict[str, tuple[int, int]] = field(default_factory=dict)
    last_source: dict[str, int] = field(default_factory=dict)
    wheelchair_accessible: int | None = None
    endpoints: tuple[int, int] | None = None
    origin_layovers: dict[str, Reading] = field(default_factory=dict)
    terminus: tuple[int, str] | None = None

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


class GPSFix(NamedTuple):
    trip_id: str
    service_date: date | None
    second: int
    latitude: float
    longitude: float


class NearbyStop(NamedTuple):
    sequence: int
    distance: float
    latitude: float
    longitude: float

    def entry_second(self, previous: GPSFix | None, second: int) -> int | None:
        if previous is None or not 0 < second - previous.second <= GPS_ENTRY_MAX_GAP_SECONDS:
            return None
        before = distance_metres(
            previous.latitude, previous.longitude, self.latitude, self.longitude
        )
        if before <= STOPPED_AT_RADIUS_METRES:
            return None
        fraction = (before - STOPPED_AT_RADIUS_METRES) / (before - self.distance)
        return round(previous.second + fraction * (second - previous.second))


@dataclass(slots=True)
class NearbyVisits:
    # Keep only forward visits by a single vehicle within this trip instance.
    sequence: int = -1
    second: int = -1
    readings: dict[int, int] = field(default_factory=dict)

    def record(self, stop: NearbyStop, second: int, previous: GPSFix | None, origin: int) -> None:
        if stop.sequence < self.sequence or second <= self.second:
            return
        if stop.sequence == origin:
            self.readings[origin] = second
        elif stop.sequence > self.sequence:
            entry = stop.entry_second(previous, second)
            if entry is not None:
                self.readings[stop.sequence] = entry
        self.sequence, self.second = stop.sequence, second

    def apply(self, trip: Trip, vehicle: str) -> None:
        assert trip.endpoints is not None
        origin = trip.endpoints[0]
        for seq, second in self.readings.items():
            if seq == origin and self.sequence == origin:
                continue
            event: Event = "departure" if seq == origin else "arrival"
            trip.stops[seq].observe(Reading(second, vehicle, "vehicle_nearby", event))


@dataclass(slots=True)
class NearbyFeed:
    visits: dict[tuple[str, str], NearbyVisits] = field(default_factory=dict)
    fixes: dict[str, GPSFix] = field(default_factory=dict)


def _position_coords(position: VehiclePosition) -> tuple[float, float] | None:
    if not position.HasField("position") or not position.position.IsInitialized():
        return None
    lat, lon = position.position.latitude, position.position.longitude
    return (lat, lon) if validate_wgs84_position(lat, lon) == "valid_wgs84" else None


def _nearby_visit(
    trip: Trip,
    position: VehiclePosition,
    schedule: ArchiveScheduleContext,
    day: date,
) -> NearbyStop | None:
    if (coords := _position_coords(position)) is None:
        return None
    lat, lon = coords
    sequence = (
        position.current_stop_sequence if position.HasField("current_stop_sequence") else None
    )
    located = trip.locate(sequence, position.stop_id)
    match = None
    ambiguous = False
    for seq, stop in trip.stops.items():
        point = schedule.stop(day, stop.stop_id)
        if point is None or point.lat is None or point.lon is None:
            continue
        # More than 50 m of latitude alone cannot fit the stop radius.
        if abs(lat - point.lat) > 0.00046:
            continue
        if validate_wgs84_position(point.lat, point.lon) != "valid_wgs84":
            continue
        distance = distance_metres(lat, lon, point.lat, point.lon)
        if distance > STOPPED_AT_RADIUS_METRES:
            continue
        nearby = NearbyStop(seq, distance, point.lat, point.lon)
        if located is not None and seq == located[0]:
            return nearby
        ambiguous |= match is not None
        match = nearby
    return None if ambiguous else match


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
        scheduled_stop = schedule.stop(day, item.stop_id)
        stops[item.stop_sequence] = Stop(
            item.stop_id,
            None if arrival is None else anchor + arrival,
            None if departure is None else anchor + departure,
            wheelchair_boarding=(
                scheduled_stop.wheelchair_boarding if scheduled_stop is not None else None
            ),
        )
    counts = Counter(stop.stop_id for stop in stops.values())
    unique = {stop.stop_id: seq for seq, stop in stops.items() if counts[stop.stop_id] == 1}
    return Trip(
        trip.route_id,
        trip.direction_id,
        anchor + trip.first_departure_s,
        stops,
        end=anchor + trip.last_arrival_s,
        unique_sequences=unique,
        wheelchair_accessible=trip.wheelchair_accessible,
        endpoints=(min(stops), max(stops)) if stops else None,
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
    return distance_metres(lat, lon, stop.lat, stop.lon) <= STOPPED_AT_RADIUS_METRES


def _vehicle(
    trip: Trip,
    position: VehiclePosition,
    stamp: int,
    schedule: ArchiveScheduleContext,
    day: date,
    nearby: NearbyFeed | None,
    previous_fix: GPSFix | None,
) -> None:
    sequence = (
        position.current_stop_sequence if position.HasField("current_stop_sequence") else None
    )
    vehicle = position.vehicle.id or None
    gps_only = sequence is None and not position.stop_id
    match = None
    if gps_only:
        if not vehicle or trip.added or not position.HasField("position"):
            return
        match = _nearby_visit(trip, position, schedule, day)
        located = (match.sequence, trip.stops[match.sequence]) if match is not None else None
    else:
        located = trip.locate(sequence, position.stop_id)
    if nearby is not None and vehicle and trip.endpoints is not None:
        if not gps_only:
            match = _nearby_visit(trip, position, schedule, day)
        if match is not None:
            key = position.trip.trip_id, vehicle
            if (visits := nearby.visits.get(key)) is None:
                nearby.visits[key] = visits = NearbyVisits()
            visits.record(match, stamp, previous_fix, trip.endpoints[0])
    if located is None:
        return
    seq, stop = located
    stopped = not gps_only and position.current_status == VehiclePosition.STOPPED_AT
    origin, terminus = trip.endpoints or (-1, -1)
    old_seq, old_stamp = trip.progress.get(vehicle or "", (-1, -1))
    near = (stopped or seq == terminus) and (
        gps_only or _near_stop(position, schedule.stop(day, stop.stop_id))
    )
    if seq == terminus and near and vehicle and stamp >= old_stamp:
        if trip.terminus is None or stamp < trip.terminus[0]:
            trip.terminus = (stamp, vehicle)
    if stopped:
        if not near:
            return
        if seq == origin:
            last = trip.origin_layovers.get(vehicle or "")
            if old_seq <= origin and (last is None or stamp > last.second):
                trip.origin_layovers[vehicle or ""] = Reading(
                    stamp, vehicle, "vehicle_stopped", "departure"
                )
        else:
            stop.observe(Reading(stamp, vehicle, "vehicle_stopped", "arrival"))
    # Retain only the first passage of a sequence per vehicle and ignore regressions.
    if seq <= old_seq or stamp < old_stamp or (gps_only and stamp == old_stamp):
        return
    trip.progress[vehicle or ""] = (seq, stamp)
    if seq > origin >= old_seq and (layover := trip.origin_layovers.pop(vehicle or "", None)):
        if layover.second <= stamp:
            trip.stops[origin].observe(layover)
    # Start GPS-only progress at the first fix. A subsequent fix for the same
    # vehicle at a unique later stop can corroborate forecasts between them.
    if gps_only and old_seq < 0:
        return
    for number, prior in trip.stops.items():
        if not old_seq <= number < seq or prior.prediction is None:
            continue
        published, second, prediction_vehicle, event = prior.prediction
        if (
            published <= stamp
            and second <= stamp
            and (not prediction_vehicle or not vehicle or prediction_vehicle == vehicle)
        ):
            prior.observe(
                Reading(second, prediction_vehicle or vehicle, "trip_update_passed", event)
            )


def _update(trip: Trip, update: TripUpdate, stamp: int, captured: datetime) -> None:
    relationship = update.trip.schedule_relationship
    previous = trip.relationship
    # On equal timestamps, a removal wins over predictions from a conflicting entity.
    if previous is None or (stamp, relationship in _REMOVED) > (
        previous[0],
        previous[1] in _REMOVED,
    ):
        trip.relationship = (stamp, relationship)
    if relationship in _REMOVED:
        trip.cancellation_notice = trip.cancellation_notice or captured
        return
    vehicle = update.vehicle.id or None
    # Vehicle progression is shared by all stop updates in this entity.
    if vehicle:
        passed = max(trip.progress.get(vehicle, (-1, -1))[0], trip.progress.get("", (-1, -1))[0])
    else:
        passed = max((seq for seq, _ in trip.progress.values()), default=-1)
    for item in update.stop_time_update:
        seq, stop_id = item.stop_sequence, item.stop_id
        stop = trip.stops.get(seq) if seq else None
        if stop is None:
            located = trip.locate(seq if seq or item.HasField("stop_sequence") else None, stop_id)
            if located is None:
                continue
            seq, stop = located
        elif stop_id and stop_id != stop.stop_id:
            continue
        prior = stop.prediction
        if item.schedule_relationship in _SKIPPED_OR_NO_DATA:
            if prior is None or prior[0] <= stamp:
                stop.prediction = None
            continue
        # At the first vehicle passage, use the last prediction received before
        # passage, provided its publication and estimated time are no later than
        # the passing reading. Never promote a later forecast simply as it ages.
        may_forecast = seq >= passed and (prior is None or stamp > prior[0])
        prediction = _predicted_time(item, stop, stamp, may_forecast)
        if prediction is None:
            continue
        second, event, reported = prediction
        if reported:
            stop.observe(Reading(second, vehicle, "trip_update_reported", event))
        else:
            stop.prediction = (stamp, second, vehicle, event)


def _predicted_time(
    item: TripUpdate.StopTimeUpdate, stop: Stop, stamp: int, may_forecast: bool
) -> tuple[int, Event, bool] | None:
    arrival, departure = item.arrival, item.departure
    arrival_time, departure_time = arrival.time, departure.time
    # A past absolute timestamp explicitly marked exact is the feed's
    # report of a stop time. Absent uncertainty does not mean zero.
    if 0 < arrival_time <= stamp and arrival.HasField("uncertainty") and arrival.uncertainty == 0:
        return arrival_time, "arrival", True
    if (
        0 < departure_time <= stamp
        and departure.HasField("uncertainty")
        and departure.uncertainty == 0
    ):
        return departure_time, "departure", True
    if not may_forecast:
        return None
    if arrival_time > 0:
        return arrival_time, "arrival", False
    if stop.arrival is not None and arrival.HasField("delay"):
        return stop.arrival + arrival.delay, "arrival", False
    if departure_time > 0:
        return departure_time, "departure", False
    if stop.departure is not None and departure.HasField("delay"):
        return stop.departure + departure.delay, "departure", False
    return None


def _covered_span(intervals: list[CoveredInterval], start: datetime, end: datetime) -> bool:
    index = bisect_right(intervals, start, key=lambda interval: interval.start_utc) - 1
    return index >= 0 and intervals[index].end_utc >= end


def _segment_run(
    identity: Row,
    previous: tuple[int, Stop, int | None, datetime | None],
    current: tuple[int, Stop, int | None, datetime | None],
    trip_exclusion: str | None,
) -> Row:
    from_sequence, start, scheduled_from, observed_from = previous
    to_sequence, end, scheduled_to, observed_to = current
    from_basis = start.observed.basis if start.observed else "not_observed"
    to_basis = end.observed.basis if end.observed else "not_observed"
    scheduled = (
        scheduled_to - scheduled_from
        if scheduled_from is not None and scheduled_to is not None
        else None
    )
    observed = (
        (observed_to - observed_from) // timedelta(seconds=1)
        if observed_from is not None and observed_to is not None
        else None
    )
    exclusion = trip_exclusion
    if exclusion is None:
        if observed is None:
            exclusion = "missing_observation"
        elif from_basis != to_basis:
            exclusion = "incomparable_basis"
        elif scheduled is None or scheduled <= 0:
            exclusion = "invalid_scheduled_run"
        elif observed < 0:
            exclusion = "negative_observed_run"
        elif observed > MAX_SEGMENT_RUN_MULTIPLE * scheduled:
            exclusion = "excessive_observed_run"
    return (
        *identity,
        start.stop_id,
        end.stop_id,
        from_sequence,
        to_sequence,
        observed_from,
        observed_to,
        observed,
        scheduled,
        from_basis,
        to_basis,
        _timestamp(start.departure if start.departure is not None else start.arrival),
        exclusion,
    )


@dataclass
class CleanDay:
    provider: str
    date: date
    edition_sha256: str
    trips: dict[str, Trip]
    live_routes: set[str]
    schedule_anchor: int
    timezone: ZoneInfo
    coverage: dict[Feed, list[CoveredInterval]] = field(default_factory=dict)
    vehicle_positions: list[VehicleStateInterval] = field(default_factory=list)
    feed_polls: list[FeedPoll] = field(default_factory=list)
    alerts: dict[tuple[str, str, SourceFormat], AlertVersion] | None = None
    route_types: Mapping[str, int] = field(default_factory=dict)
    scorecard_declaration: dict[str, int | str | list[str]] | None = None
    source_date: str | None = None

    def _covered(self, trip: Trip) -> bool:
        assert trip.start is not None and trip.end is not None
        start = datetime.fromtimestamp(trip.start - ABSENCE_LEAD_SECONDS, UTC)
        end = datetime.fromtimestamp(trip.end, UTC)
        # A continuous interval from each declared feed must bracket the span.
        # covered_intervals uses the shared 120-second maximum between usable polls.
        return bool(self.coverage) and all(
            _covered_span(intervals, start, end) for intervals in self.coverage.values()
        )

    def _trip_state(
        self, trip: Trip, route_live: bool, observed: bool
    ) -> tuple[State, StateReason | None]:
        if trip.added:
            return "added", None
        if trip.relationship and trip.relationship[1] in _REMOVED:
            return "cancelled", None
        if observed:
            return "ran", None
        if trip.first_capture is not None:
            return "unconfirmed", None
        if not route_live:
            return "not_measured", "route_without_live_data"
        if self._covered(trip):
            return "missing", None
        return "not_measured", "capture_gap"

    def trip_rows(self) -> Iterator[Row]:
        for trip_id, trip in sorted(self.trips.items()):
            observed = [s.observed for s in trip.stops.values() if s.observed is not None]
            vehicles = [r for r in observed if r.vehicle_id is not None]
            vehicle = min(vehicles).vehicle_id if vehicles else None
            route_live = trip.route_id in self.live_routes
            state, reason = self._trip_state(trip, route_live, bool(observed))
            yield (
                *self._identity(trip_id, trip),
                _timestamp(trip.start),
                state,
                reason,
                vehicle,
                route_live,
                trip.first_capture,
                trip.last_capture,
                trip.cancellation_notice,
                self.route_types.get(trip.route_id) if trip.route_id is not None else None,
                trip.wheelchair_accessible,
                _timestamp(trip.terminus[0]) if trip.terminus else None,
                trip.terminus[1] if trip.terminus else None,
            )

    def stop_rows(self, *, write_segment: Callable[[Row], object] | None = None) -> Iterator[Row]:
        weekday = self.date.isoweekday()
        for trip_id, trip in sorted(self.trips.items()):
            route_live = trip.route_id in self.live_routes
            state, reason = self._trip_state(
                trip, route_live, any(stop.observed is not None for stop in trip.stops.values())
            )
            exclusion: str | None
            if trip.start is None:
                exclusion = "added"
            elif state == "cancelled":
                exclusion = "cancelled"
            elif not route_live:
                exclusion = "route_without_live_data"
            else:
                exclusion = reason
            # Match the corridor guard order, which differs from stop eligibility.
            if not route_live:
                segment_exclusion = "route_without_live_data"
            elif state == "cancelled":
                segment_exclusion = "cancelled"
            elif state != "ran":
                segment_exclusion = reason or "missing_observation"
            else:
                segment_exclusion = None
            previous = None
            start_seconds = None if trip.start is None else trip.start - self.schedule_anchor
            for seq, stop in sorted(trip.stops.items()):
                reading = stop.observed
                scheduled = (
                    stop.departure
                    if reading and reading.event == "departure"
                    else (stop.arrival if stop.arrival is not None else stop.departure)
                )
                bucket_time = stop.departure if stop.departure is not None else stop.arrival
                stop_exclusion = exclusion
                if (
                    stop_exclusion is None
                    and reading is None
                    and (scheduled_time := _timestamp(scheduled)) is not None
                    and any(
                        not _covered_span(intervals, scheduled_time, scheduled_time)
                        for intervals in self.coverage.values()
                    )
                ):
                    stop_exclusion = "capture_gap"
                observed_at = _timestamp(reading.second) if reading else None
                if write_segment is not None and not trip.added and trip.route_id is not None:
                    current = (seq, stop, scheduled if reading else None, observed_at)
                    if previous is not None:
                        write_segment(
                            _segment_run(
                                self._identity(trip_id, trip), previous, current, segment_exclusion
                            )
                        )
                    previous = current
                yield (
                    *self._scheduled_fields(trip_id, trip, seq, stop),
                    observed_at,
                    reading.second - scheduled if reading and scheduled is not None else None,
                    reading.basis if reading else "not_observed",
                    reading.event if reading else None,
                    reading.vehicle_id if reading else None,
                    stop_exclusion,
                    route_live,
                    start_seconds,
                    datetime.fromtimestamp(bucket_time, self.timezone).hour
                    if bucket_time is not None
                    else None,
                    weekday,
                )

    def scheduled_stop_rows(self) -> Iterator[Row]:
        for trip_id, trip in sorted(self.trips.items()):
            if not trip.added:
                for seq, stop in sorted(trip.stops.items()):
                    yield (
                        *self._scheduled_fields(trip_id, trip, seq, stop),
                        None if stop.arrival is None else stop.arrival - self.schedule_anchor,
                        None if stop.departure is None else stop.departure - self.schedule_anchor,
                        self.edition_sha256,
                        stop.wheelchair_boarding,
                    )

    def prediction_rows(self) -> Iterator[Row]:
        for trip_id, trip in sorted(self.trips.items()):
            for seq, stop in sorted(trip.stops.items()):
                reading = stop.observed
                if reading is None or stop.prediction_samples is None:
                    continue
                for horizon, sample in zip(
                    PREDICTION_HORIZONS_MINUTES, stop.prediction_samples, strict=True
                ):
                    if sample is not None:
                        published, predicted = sample
                        yield (
                            *self._identity(trip_id, trip),
                            stop.stop_id,
                            seq,
                            reading.basis,
                            reading.event,
                            horizon,
                            _timestamp(published),
                            _UTC_EPOCH + timedelta(seconds=predicted),
                            predicted - reading.second,
                            reading.second - published,
                        )

    def vehicle_rows(self) -> Iterator[Row]:
        for interval in self.vehicle_positions:
            reading = interval.first
            yield (
                self.provider,
                CLEANING_VERSION,
                reading.vehicle_id,
                reading.captured_at_utc,
                interval.last_seen_at_utc,
                interval.readings,
                reading.feed_timestamp_utc,
                reading.observed_at_utc,
                *reading.state,
                *(reading.coords or (None, None)),
            )

    def poll_rows(self) -> Iterator[Row]:
        for poll in self.feed_polls:
            yield (
                self.provider,
                self.date,
                CLEANING_VERSION,
                poll.feed,
                poll.captured_at_utc,
                poll.attempt_id,
                poll.result,
                poll.feed_timestamp_utc,
                poll.payload_bytes,
                poll.entity_count,
            )

    def _scheduled_fields(self, trip_id: str, trip: Trip, seq: int, stop: Stop) -> Row:
        return (
            *self._identity(trip_id, trip),
            stop.stop_id,
            seq,
            _timestamp(stop.arrival),
            _timestamp(stop.departure),
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


def capture_window_end(anchor: datetime, last_arrival_s: int = 0) -> datetime:
    return anchor + timedelta(seconds=max(86_400, last_arrival_s) + SANITY_DELAY_SECONDS)


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
    return anchor - margin, capture_window_end(anchor, end)


def build_clean_day(
    provider: str,
    day: date,
    schedules: Mapping[date, ArchiveScheduleContext],
    captures: Iterable[DayCapture | FeedPoll],
    *,
    required_feeds: tuple[Feed, ...] = REALTIME_FEEDS,
    source_lag_seconds: int = 0,
    routes_without_live_data: Collection[str] = (),
) -> CleanDay:
    # Observed times are final only after both feeds and the chronology pass.
    # Replay valid trip-update payloads from disk without rereading the archive
    # or retaining an unbounded history of predictions in memory.
    with (
        TemporaryDirectory(prefix="clean-predictions-") as scratch,
        (Path(scratch) / "trip-updates").open("w+b") as history,
    ):
        return _build_clean_day(
            provider,
            day,
            schedules,
            captures,
            required_feeds,
            source_lag_seconds,
            routes_without_live_data,
            history,
        )


def _build_clean_day(
    provider: str,
    day: date,
    schedules: Mapping[date, ArchiveScheduleContext],
    captures: Iterable[DayCapture | FeedPoll],
    required_feeds: tuple[Feed, ...],
    source_lag_seconds: int,
    routes_without_live_data: Collection[str],
    history: BinaryIO,
) -> CleanDay:
    schedule = schedules[day]
    anchor = int(schedule.service_day_start(day).timestamp())
    trips = {
        ident: _scheduled(schedule, day, ident, anchor) for ident in schedule.days[day].trip_ids
    }
    result = CleanDay(
        provider,
        day,
        schedule.days[day].edition_sha256,
        trips,
        set(),
        anchor,
        schedule.timezone,
        route_types=schedule.route_types,
    )
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

    def trip_date(desc: TripDescriptor, stamp: int, is_update: bool) -> date | None:
        reported = reported_service_date(desc.start_date) if desc.start_date else None
        candidates = candidates_for(desc.trip_id)
        published = datetime.fromtimestamp(stamp, UTC)
        if candidates:
            accepted, _ = resolve_trip_instance(
                published,
                candidates,
                VehicleDescriptor(reported, desc.start_time),
                advance_notice=is_update,
                removed=desc.schedule_relationship in _REMOVED,
            )
            return None if accepted is None else accepted.service_date
        # Unknown IDs cannot override a dated schedule instance. Some feeds mark
        # true additions as SCHEDULED, so also require a matching local date.
        if desc.schedule_relationship != TripDescriptor.SCHEDULED:
            return reported
        return reported if reported == published.astimezone(schedule.timezone).date() else None

    seen: dict[tuple[str, bytes], FeedPoll] = {}
    last_vehicle: dict[str, VehicleStateInterval] = {}
    stopped_feeds: set[str] = set()
    nearby: dict[str, NearbyFeed] = {}
    polls: list[PollFacts] = []
    prior_capture: datetime | None = None
    for capture in captures:
        if isinstance(capture, FeedPoll):
            result.feed_polls.append(capture)
            continue
        is_update = capture.family == "trip_updates"
        feed: Feed = "trip_updates" if is_update else "vehicle_positions"
        if capture.family != feed or feed not in required_feeds:
            continue
        captured = capture.captured_at_utc
        if captured.utcoffset() is None or (prior_capture is not None and captured < prior_capture):
            raise ValueError("Captures must arrive in UTC time order")
        prior_capture = captured
        poll, message = read_capture(capture, seen)
        result.feed_polls.append(poll)
        if message is None:
            continue
        header = poll.feed_timestamp_utc
        capture_second = int(captured.timestamp())
        feed_second = min(message.header.timestamp or capture_second, capture_second)
        if is_update and message.entity:
            history.write(_CAPTURE_FRAME.pack(capture_second, len(capture.payload)))
            history.write(capture.payload)
        if message.header.incrementality == FeedHeader.FULL_DATASET:
            header_timestamp = header
            if header_timestamp is not None and header_timestamp > captured:
                header_timestamp = None
            polls.append(
                PollFacts(
                    feed,
                    captured,
                    "stored",
                    None,
                    header_timestamp,
                    "header" if header_timestamp is not None else None,
                    len(message.entity),
                    True,
                )
            )
        for entity in message.entity:
            if entity.is_deleted:
                continue
            if is_update and entity.HasField("trip_update"):
                live: TripUpdate | VehiclePosition = entity.trip_update
            elif capture.family == "vehicle_positions" and entity.HasField("vehicle"):
                live = entity.vehicle
                if (
                    live.HasField("current_status")
                    and live.current_status == VehiclePosition.STOPPED_AT
                ):
                    stopped_feeds.add(capture.feed)
                    nearby.pop(capture.feed, None)
            else:
                continue
            has_trip = live.HasField("trip")
            stamp = min(live.timestamp or feed_second, capture_second)
            desc = live.trip
            dated = trip_date(desc, stamp, is_update) if has_trip else None
            nearby_feed = None
            previous_fix = None
            if (
                isinstance(live, VehiclePosition)
                and live.vehicle.id
                and capture.feed not in stopped_feeds
                and (coords := _position_coords(live)) is not None
            ):
                candidates = nearby.get(capture.feed)
                if candidates is None:
                    nearby[capture.feed] = candidates = NearbyFeed()
                previous = candidates.fixes.get(live.vehicle.id)
                if previous is None or stamp > previous.second:
                    nearby_feed = candidates
                    trip_id = desc.trip_id if desc.schedule_relationship not in _REMOVED else ""
                    candidates.fixes[live.vehicle.id] = GPSFix(trip_id, dated, stamp, *coords)
                    if previous is not None and (previous.trip_id, previous.service_date) == (
                        trip_id,
                        dated,
                    ):
                        previous_fix = previous
            if (
                dated is None
                and has_trip
                and not desc.start_date
                and desc.route_id
                and desc.route_id not in routes_without_live_data
                and not candidates_for(desc.trip_id)
                and datetime.fromtimestamp(stamp, UTC).astimezone(schedule.timezone).date() == day
            ):
                result.live_routes.add(desc.route_id)
            if (
                isinstance(live, VehiclePosition)
                and live.vehicle.id
                and (
                    dated == day
                    or dated is None
                    and captured.astimezone(schedule.timezone).date() == day
                )
            ):
                matched = trips.get(desc.trip_id) if dated == day else None
                reading = vehicle_reading(
                    live,
                    captured,
                    header,
                    datetime.fromtimestamp(stamp, UTC),
                    dated,
                    matched.route_id if matched else None,
                )
                last = last_vehicle.get(reading.vehicle_id)
                if last is None or last.last_seen_at_utc != captured:
                    if last is not None and last.can_extend(reading):
                        last.last_seen_at_utc = captured
                        last.readings += 1
                    else:
                        interval = VehicleStateInterval(reading, captured)
                        result.vehicle_positions.append(interval)
                        last_vehicle[reading.vehicle_id] = interval
            if not has_trip or dated != day:
                continue
            trip = trips.get(desc.trip_id)
            if (trip.route_id if trip is not None else desc.route_id) in routes_without_live_data:
                continue
            if trip is None:
                if desc.route_id:
                    result.live_routes.add(desc.route_id)
                if not desc.trip_id or desc.schedule_relationship not in _EXTRA:
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
                _vehicle(trip, live, stamp, schedule, day, nearby_feed, previous_fix)
    for nearby_feed in nearby.values():
        for (trip_id, vehicle), visits in nearby_feed.visits.items():
            visits.apply(trips[trip_id], vehicle)
    for trip in trips.values():
        trip.discard_reversed_readings()
    usable = usable_polls(
        polls,
        read_source="worker_facts",
        consumed_captures=None,
        service_spans=(capture_window(schedule, day),),
        source_lag_seconds=source_lag_seconds,
    )
    result.coverage = {
        feed: covered_intervals([poll for poll in usable if poll.feed == feed])
        for feed in required_feeds
    }
    _sample_predictions(result, history, trip_date, routes_without_live_data)
    return result


def _sample_predictions(
    day: CleanDay,
    history: BinaryIO,
    trip_date: Callable[[TripDescriptor, int, bool], date | None],
    routes_without_live_data: Collection[str],
) -> None:
    observed_trips = {
        trip_id: trip
        for trip_id, trip in day.trips.items()
        if any(stop.observed is not None for stop in trip.stops.values())
    }
    coverage = day.coverage.get("trip_updates", [])
    if not observed_trips or not coverage:
        return
    history.seek(0)
    while frame := history.read(_CAPTURE_FRAME.size):
        captured, size = _CAPTURE_FRAME.unpack(frame)
        payload = history.read(size)
        if len(payload) != size:
            raise ValueError("Incomplete trip-update replay")
        message = decode_gtfs_rt(payload)
        feed_stamp = min(message.header.timestamp or captured, captured)
        for entity in message.entity:
            if entity.is_deleted or not entity.HasField("trip_update"):
                continue
            update = entity.trip_update
            desc = update.trip
            trip = observed_trips.get(desc.trip_id)
            if (
                trip is None
                or desc.schedule_relationship in _REMOVED
                or (desc.route_id and trip.route_id and desc.route_id != trip.route_id)
                or trip.route_id in routes_without_live_data
            ):
                continue
            stamp = min(update.timestamp or feed_stamp, captured)
            if trip_date(desc, stamp, True) != day.date:
                continue
            for item in update.stop_time_update:
                sequence = (
                    item.stop_sequence
                    if item.HasField("stop_sequence")
                    else trip.unique_sequences.get(item.stop_id)
                )
                stop = trip.stops.get(sequence) if sequence is not None else None
                if (
                    stop is None
                    or stop.observed is None
                    or (item.stop_id and item.stop_id != stop.stop_id)
                    or item.schedule_relationship in _SKIPPED_OR_NO_DATA
                ):
                    continue
                if captured <= stop.observed.second:
                    _sample_stop(stop, stop.observed, item, stamp, coverage)


def _sample_stop(
    stop: Stop,
    observed: Reading,
    item: TripUpdate.StopTimeUpdate,
    stamp: int,
    coverage: list[CoveredInterval],
) -> None:
    lead = observed.second - stamp
    index = bisect_right(_PREDICTION_HORIZONS_SECONDS, lead) - 1
    if index < 0 or lead >= _PREDICTION_LIMIT_SECONDS:
        return
    if not _covered_span(
        coverage, datetime.fromtimestamp(stamp, UTC), datetime.fromtimestamp(observed.second, UTC)
    ):
        return
    # Compare forecasts and observations of the same stop event.
    event = item.arrival if observed.event == "arrival" else item.departure
    scheduled = stop.arrival if observed.event == "arrival" else stop.departure
    if 0 < event.time <= stamp and event.HasField("uncertainty") and event.uncertainty == 0:
        return
    if event.time > 0:
        predicted = event.time
    elif scheduled is not None and event.HasField("delay"):
        predicted = scheduled + event.delay
    else:
        return
    if not 0 < predicted <= _LAST_TIMESTAMP_SECOND:
        return
    samples = stop.prediction_samples
    if samples is None:
        samples = [None] * len(_PREDICTION_HORIZONS_SECONDS)
        stop.prediction_samples = samples
    candidate = (stamp, predicted)
    previous = samples[index]
    if previous is None or stamp > previous[0]:
        samples[index] = candidate
