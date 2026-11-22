"""Derive one service day's event rows from pinned schedule and capture evidence."""

from bisect import bisect_left, bisect_right
from collections import Counter
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import cache, lru_cache
from pathlib import Path
from struct import Struct
from tempfile import TemporaryDirectory
from typing import BinaryIO, Literal, NamedTuple

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
    accepted_instance,
    resolve_vehicle_capture,
)
from transit_ops.gtfs.types import parse_gtfs_date, parse_gtfs_service_time, validate_wgs84_position
from transit_ops.providers.formats import decode_gtfs_rt
from transit_ops.providers.schedule import ScheduledStop
from transit_ops.providers.schedule_archive import ArchiveScheduleContext

# Allow normal GPS and platform-coordinate error on these urban networks while
# requiring proximity on the scale of a stop, rather than a route segment.
STOPPED_AT_RADIUS_METRES = 50
# Require several opportunities to see early reporting around departure, even
# for short trips, at the providers' normal 20–60 second feed cadences.
ABSENCE_LEAD_SECONDS = 300
# v7 adds fixed-lead prediction samples for observed stop events.
CLEANING_VERSION = "7"
PREDICTION_HORIZONS_MINUTES = (1, 3, 5, 10, 15, 20, 30)
_PREDICTION_HORIZONS_SECONDS = tuple(minutes * 60 for minutes in PREDICTION_HORIZONS_MINUTES)
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


type Prediction = tuple[int, int, str | None, Event]  # publication, estimate, vehicle, event


@dataclass(slots=True)
class Stop:
    stop_id: str
    arrival: int | None = None
    departure: int | None = None
    observed: Reading | None = None
    prediction: Prediction | None = None
    prediction_samples: list[tuple[int, int] | None] | None = None

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
        end=anchor + trip.last_arrival_s,
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
    return distance_metres(lat, lon, stop.lat, stop.lon) <= STOPPED_AT_RADIUS_METRES


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


@lru_cache(maxsize=32)
def _reported_service_date(value: str) -> date | None:
    try:
        return parse_gtfs_date(value, field_name="trip start_date")
    except ValueError:
        return None


def _service_date(
    descriptor: TripDescriptor, published: datetime, candidates: tuple[TripInstance, ...]
) -> date | None:
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
    schedule_anchor: int
    coverage: dict[Feed, list[CoveredInterval]] = field(default_factory=dict)
    vehicle_positions: list[VehicleStateInterval] = field(default_factory=list)
    feed_polls: list[FeedPoll] = field(default_factory=list)
    alerts: dict[tuple[str, str, SourceFormat], AlertVersion] | None = None
    route_types: Mapping[str, int] = field(default_factory=dict)

    def _covered(self, trip: Trip) -> bool:
        assert trip.start is not None and trip.end is not None
        start = datetime.fromtimestamp(trip.start - ABSENCE_LEAD_SECONDS, UTC)
        end = datetime.fromtimestamp(trip.end, UTC)
        # A continuous interval from each declared feed must bracket the span.
        # covered_intervals uses the shared 120-second maximum between usable polls.
        for intervals in self.coverage.values():
            index = bisect_right(intervals, start, key=lambda interval: interval.start_utc) - 1
            if index < 0 or intervals[index].end_utc < end:
                return False
        return bool(self.coverage)

    def trip_rows(self) -> Iterator[Row]:
        for trip_id, trip in sorted(self.trips.items()):
            observed = [s.observed for s in trip.stops.values() if s.observed is not None]
            vehicles = [r for r in observed if r.vehicle_id is not None]
            vehicle = min(vehicles).vehicle_id if vehicles else None
            route_live = trip.route_id in self.live_routes
            state: State
            reason: StateReason | None = None
            if trip.added:
                state = "added"
            elif trip.relationship and trip.relationship[1] in _REMOVED:
                state = "cancelled"
            elif observed:
                state = "ran"
            elif trip.first_capture is not None:
                state = "unconfirmed"
            elif not route_live:
                state, reason = "not_measured", "route_without_live_data"
            elif self._covered(trip):
                state = "missing"
            else:
                state, reason = "not_measured", "capture_gap"
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
                    *self._scheduled_fields(trip_id, trip, seq, stop),
                    _timestamp(reading.second) if reading else None,
                    reading.second - scheduled if reading and scheduled is not None else None,
                    reading.basis if reading else "not_observed",
                    reading.event if reading else None,
                    reading.vehicle_id if reading else None,
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

    def trip_date(desc: TripDescriptor, stamp: int) -> date | None:
        if desc.start_date:
            return _reported_service_date(desc.start_date)
        return _service_date(desc, datetime.fromtimestamp(stamp, UTC), candidates_for(desc.trip_id))

    seen: dict[tuple[str, bytes], FeedPoll] = {}
    last_vehicle: dict[str, VehicleStateInterval] = {}
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
            else:
                continue
            has_trip = live.HasField("trip")
            stamp = min(live.timestamp or feed_second, capture_second)
            desc = live.trip
            dated = trip_date(desc, stamp) if has_trip else None
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
                _vehicle(trip, live, stamp, schedule, day)
    for trip in trips.values():
        trip.discard_reversed_readings()
    _sample_predictions(result, history, trip_date, routes_without_live_data)
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
    return result


def _sample_predictions(
    day: CleanDay,
    history: BinaryIO,
    trip_date: Callable[[TripDescriptor, int], date | None],
    routes_without_live_data: Collection[str],
) -> None:
    observed_trips = {
        trip_id: trip
        for trip_id, trip in day.trips.items()
        if any(stop.observed is not None for stop in trip.stops.values())
    }
    if not observed_trips:
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
            if trip_date(desc, stamp) != day.date:
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
                _sample_stop(stop, stop.observed, item, stamp)


def _sample_stop(
    stop: Stop, observed: Reading, item: TripUpdate.StopTimeUpdate, stamp: int
) -> None:
    lead = observed.second - stamp
    if lead < _PREDICTION_HORIZONS_SECONDS[0]:
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
    for index, horizon in enumerate(_PREDICTION_HORIZONS_SECONDS):
        if horizon > lead:
            break
        previous = samples[index]
        if previous is None or stamp > previous[0]:
            samples[index] = candidate
