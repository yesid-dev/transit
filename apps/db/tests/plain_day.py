"""Independent audit of a service day from GTFS ZIP and GTFS-Realtime messages."""

import csv
import json
from argparse import ArgumentParser
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import cache
from hashlib import file_digest
from io import TextIOWrapper
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from zipfile import ZipFile
from zoneinfo import ZoneInfo

from google.transit import gtfs_realtime_pb2 as pb


@dataclass(frozen=True)
class Stop:
    id: str
    arrival: int | None
    departure: int | None


@dataclass
class Trip:
    route: str
    stops: dict[int, Stop]
    live: bool
    added: bool = False

    @property
    def start(self) -> int | None:
        return min(
            (stop.departure for stop in self.stops.values() if stop.departure is not None),
            default=None,
        )

    @property
    def end(self) -> int | None:
        return max(
            (stop.arrival for stop in self.stops.values() if stop.arrival is not None),
            default=None,
        )


@dataclass(frozen=True)
class Reading:
    basis: str
    second: int
    event: str
    published: int
    vehicle: str
    passage: int | None = None


@dataclass(frozen=True)
class StopEvent:
    stop_id: str
    arrival: int | None
    departure: int | None
    basis: str
    observed: int | None
    event: str | None
    delay: int | None
    punctuality: str | None

    @property
    def scheduled(self) -> int | None:
        if self.event == "departure" or self.arrival is None:
            return self.departure
        return self.arrival

    @property
    def on_time(self) -> bool | None:
        return None if self.punctuality is None else self.punctuality == "on_time"


@dataclass(frozen=True)
class TripDay:
    route: str
    state: str
    live: bool
    scheduled_start: int | None


type Capture = tuple[str, datetime, bytes]
type EventKey = tuple[str, int]


def table(archive: ZipFile, name: str) -> Iterator[dict[str, str]]:
    if name in archive.namelist():
        with archive.open(name) as file, TextIOWrapper(file, encoding="utf-8-sig") as stream:
            yield from csv.DictReader(stream)


def service_seconds(clock: str) -> int:
    hours, minutes, seconds = map(int, clock.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def service_anchor(day: date, zone: ZoneInfo) -> int:
    # GTFS uses local noon minus 12 elapsed hours, including on DST transitions.
    return int(datetime.combine(day, time(12), zone).timestamp()) - 12 * 3600


def active_services(archive: ZipFile, day: date) -> set[str]:
    day_code = day.strftime("%Y%m%d")
    weekday = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    services = {
        row["service_id"]
        for row in table(archive, "calendar.txt")
        if row["start_date"] <= day_code <= row["end_date"] and row[weekday[day.weekday()]] == "1"
    }
    for row in table(archive, "calendar_dates.txt"):
        if row["date"] == day_code:
            if row["exception_type"] == "1":
                services.add(row["service_id"])
            elif row["exception_type"] == "2":
                services.discard(row["service_id"])
    return services


def read_schedule(
    path: Path, day: date, zone: ZoneInfo, routes: set[str], no_live_types: set[str]
) -> tuple[dict[str, Trip], dict[str, tuple[float, float]], dict[str, set[date]], set[str]]:
    days = [day + timedelta(days=offset) for offset in (-1, 0, 1)]
    with ZipFile(path) as archive:
        operating = {when: active_services(archive, when) for when in days}
        no_live = {
            row["route_id"]
            for row in table(archive, "routes.txt")
            if row["route_type"] in no_live_types
        }
        trips, dates = {}, {}
        for row in table(archive, "trips.txt"):
            if row["route_id"] in routes:
                trip_id = row["trip_id"]
                dates[trip_id] = {when for when in days if row["service_id"] in operating[when]}
                if day in dates[trip_id]:
                    trips[trip_id] = Trip(row["route_id"], {}, row["route_id"] not in no_live)
        anchor = service_anchor(day, zone)
        for row in table(archive, "stop_times.txt"):
            if (trip := trips.get(row["trip_id"])) is not None:
                seq = int(row["stop_sequence"])
                if seq in trip.stops:
                    raise ValueError(f"Duplicate stop sequence for {row['trip_id']}: {seq}")
                trip.stops[seq] = Stop(
                    row["stop_id"],
                    anchor + service_seconds(row["arrival_time"]) if row["arrival_time"] else None,
                    anchor + service_seconds(row["departure_time"])
                    if row["departure_time"]
                    else None,
                )
        coordinates = {
            row["stop_id"]: (float(row["stop_lat"]), float(row["stop_lon"]))
            for row in table(archive, "stops.txt")
            if row["stop_lat"] and row["stop_lon"]
        }
    return trips, coordinates, dates, no_live


def stop_sequence(stops: dict[int, Stop], item, field: str) -> int | None:
    if item.HasField(field):
        seq = getattr(item, field)
        if seq in stops and (not item.stop_id or stops[seq].id == item.stop_id):
            return seq
        return None
    matches = [seq for seq, stop in stops.items() if stop.id == item.stop_id]
    return matches[0] if len(matches) == 1 else None


def separation(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat, lon = map(radians, a)
    stop_lat, stop_lon = map(radians, b)
    haversine = sin((lat - stop_lat) / 2) ** 2
    haversine += cos(lat) * cos(stop_lat) * sin((lon - stop_lon) / 2) ** 2
    return 2 * 6_371_008.8 * asin(sqrt(min(1.0, haversine)))


def near_stop(position: pb.VehiclePosition, stop: Stop, coords: dict) -> bool:
    return (
        position.HasField("position")
        and position.position.IsInitialized()
        and stop.id in coords
        and separation(
            (position.position.latitude, position.position.longitude), coords[stop.id]
        ) <= 50
    )


def vehicle_facts(trip: Trip, positions: list, coords: dict) -> tuple[dict, dict]:
    stopped = defaultdict(list)
    progress = defaultdict(list)
    for stamp, position in sorted(positions, key=lambda entry: entry[0]):
        vehicle = position.vehicle.id
        has_stop = position.HasField("current_stop_sequence") or position.stop_id
        if has_stop:
            seq = stop_sequence(trip.stops, position, "current_stop_sequence")
            if seq is None:
                continue
            if (
                position.HasField("current_status")
                and position.current_status == pb.VehiclePosition.STOPPED_AT
            ):
                if not near_stop(position, trip.stops[seq], coords):
                    continue
                stopped[seq].append(Reading("vehicle_stopped", stamp, "arrival", stamp, vehicle))
        else:
            # With coordinates alone, establish progress only between two
            # unambiguous fixes for the same vehicle on the same trip.
            matches = [seq for seq, stop in trip.stops.items() if near_stop(position, stop, coords)]
            if not vehicle or len(matches) != 1:
                continue
            seq = matches[0]
        history = progress[vehicle]
        if not history or (seq > history[-1][0] and stamp > history[-1][1]):
            history.append((seq, stamp, bool(has_stop)))
    if trip.stops and not trip.added:
        origin = min(trip.stops)
        departures = []
        for vehicle, history in progress.items():
            passage = next((stamp for seq, stamp, _ in history if seq > origin), None)
            if passage is None:
                continue
            reports = [
                reading for reading in stopped[origin]
                if reading.vehicle == vehicle and reading.second <= passage
            ]
            if reports:
                last = max(reports, key=lambda reading: reading.second)
                departures.append(
                    Reading(last.basis, last.second, "departure", last.published, vehicle)
                )
        stopped[origin] = departures
    return stopped, progress


def nearby_facts(trip: Trip, positions: list, coords: dict) -> dict:
    readings = defaultdict(list)
    if trip.added or not trip.stops:
        return readings
    by_vehicle = defaultdict(list)
    for stamp, position in positions:
        if not position.vehicle.id or not position.position.IsInitialized():
            continue
        lat, lon = position.position.latitude, position.position.longitude
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        distances = {
            seq: metres for seq, stop in trip.stops.items()
            if stop.id in coords and (metres := separation((lat, lon), coords[stop.id])) <= 50
        }
        if len(distances) == 1:
            seq = next(iter(distances))
        else:
            seq = stop_sequence(trip.stops, position, "current_stop_sequence")
            if seq not in distances:
                continue
        by_vehicle[position.vehicle.id].append((stamp, seq, distances[seq]))

    origin = min(trip.stops)
    for vehicle, fixes in by_vehicle.items():
        visits = defaultdict(list)
        previous_stamp, furthest = -1, -1
        for stamp, seq, distance in sorted(fixes, key=lambda fact: fact[0]):
            if seq >= furthest and stamp > previous_stamp:
                previous_stamp, furthest = stamp, seq
                visits[seq].append((distance, stamp))
        for seq, fixes_at_stop in visits.items():
            if seq == origin:
                if furthest == origin:
                    continue
                stamp = fixes_at_stop[-1][1]
                event = "departure"
            else:
                _, stamp = min(fixes_at_stop)
                event = "arrival"
            readings[seq].append(Reading("vehicle_nearby", stamp, event, stamp, vehicle))
    return readings


REMOVED = {pb.TripDescriptor.CANCELED, pb.TripDescriptor.DELETED}
ADDED = {pb.TripDescriptor.ADDED, pb.TripDescriptor.NEW, pb.TripDescriptor.UNSCHEDULED}


def update_facts(trip: Trip, updates: list) -> tuple[dict, dict]:
    exact = defaultdict(list)
    predictions = defaultdict(list)
    for stamp, update in updates:
        if update.trip.schedule_relationship in REMOVED:
            continue
        for item in update.stop_time_update:
            seq = stop_sequence(trip.stops, item, "stop_sequence")
            if seq is None:
                continue
            vehicle = update.vehicle.id
            if item.schedule_relationship in (item.SKIPPED, item.NO_DATA):
                predictions[seq].append((stamp, vehicle, None))
                continue
            stop = trip.stops[seq]
            candidates = []
            for kind, schedule in (("arrival", stop.arrival), ("departure", stop.departure)):
                value = getattr(item, kind)
                if value.time > 0:
                    second = value.time
                elif schedule is not None and value.HasField("delay"):
                    second = schedule + value.delay
                else:
                    continue
                if second <= stamp and value.HasField("uncertainty") and value.uncertainty == 0:
                    candidates.append(Reading("trip_update_reported", second, kind, stamp, vehicle))
                else:
                    candidates.append(Reading("trip_update_passed", second, kind, stamp, vehicle))
            if precise := next((r for r in candidates if r.basis == "trip_update_reported"), None):
                exact[seq].append(precise)
            elif candidates:
                predictions[seq].append((stamp, vehicle, candidates[0]))
    return exact, predictions


def passed_reading(sequence: int, progress: dict, predictions: list) -> Reading | None:
    passages = []
    for vehicle, history in progress.items():
        for index, (later, seen, has_stop) in enumerate(history):
            if later > sequence:
                if has_stop or (index > 0 and history[index - 1][0] <= sequence):
                    passages.append((seen, vehicle))
                break
    for seen, vehicle in sorted(passages):
        # Equal source seconds do not establish that publication preceded passage.
        candidates = [
            (stamp, reading)
            for stamp, reported_vehicle, reading in predictions
            if stamp < seen and (not reported_vehicle or not vehicle or reported_vehicle == vehicle)
        ]
        if candidates:
            published, reading = max(candidates, key=lambda entry: entry[0])
            if reading is not None and reading.second <= seen:
                return Reading(
                    reading.basis, reading.second, reading.event, published, vehicle, seen
                )
    return None


def classify(delay: int | None, trip: TripDay) -> str | None:
    if delay is None or not trip.live or trip.state in {"added", "cancelled"}:
        return None
    if delay < -60:
        return "early"
    if delay > 300:
        return "late"
    return "on_time"


def covered(polls: list[tuple[float, int]], start: int, end: int) -> bool:
    before = [captured for captured, _ in polls if captured <= start]
    if not before:
        return False
    previous = max(before)
    for captured, _ in polls:
        if captured <= previous:
            continue
        if captured - previous > 120:
            return False
        if captured >= end:
            return True
        previous = captured
    return False


def recompute(
    schedule: Path,
    captures: Iterable[Capture],
    day: date,
    routes: set[str],
    *,
    zone: ZoneInfo,
    no_live_types: set[str],
) -> tuple[dict[str, TripDay], dict[EventKey, StopEvent], dict[EventKey, Reading]]:
    trips, coords, dates, no_live = read_schedule(schedule, day, zone, routes, no_live_types)
    scheduled_trips = len(trips)
    scheduled_stops = sum(len(trip.stops) for trip in trips.values())
    operating_codes = {ident: {d.strftime("%Y%m%d") for d in days} for ident, days in dates.items()}
    updates, positions = defaultdict(list), defaultdict(list)
    polls: dict[str, list[tuple[float, int]]] = {"trip_updates": [], "vehicle_positions": []}
    day_code = day.strftime("%Y%m%d")
    has_stopped = False

    @cache
    def windows(trip_id: str) -> list[tuple[date, int, int]]:
        trip = trips[trip_id]
        if trip.start is None or trip.end is None:
            return []
        anchor = service_anchor(day, zone)
        return [
            (
                when,
                trip.start - anchor + service_anchor(when, zone) - 900,
                trip.end - anchor + service_anchor(when, zone) + 10_800,
            )
            for when in dates[trip_id]
        ]

    for family, captured, payload in captures:
        feed = pb.FeedMessage.FromString(payload)
        if not feed.IsInitialized():
            continue
        capture_second = captured.timestamp()
        header = feed.header.timestamp
        if (
            feed.entity
            and feed.header.incrementality == pb.FeedHeader.FULL_DATASET
            and 0 <= capture_second - header <= 120
            and (not polls[family] or header > polls[family][-1][1])
        ):
            polls[family].append((capture_second, header))
        field = "trip_update" if family == "trip_updates" else "vehicle"
        for entity in feed.entity:
            if entity.is_deleted or not entity.HasField(field):
                continue
            fact = getattr(entity, field)
            if (
                field == "vehicle"
                and fact.HasField("current_status")
                and fact.current_status == pb.VehiclePosition.STOPPED_AT
            ):
                has_stopped = True
            desc = fact.trip
            trip_id = desc.trip_id
            trip = trips.get(trip_id)
            route = trip.route if trip else desc.route_id
            if not trip_id or route not in routes or route in no_live:
                continue
            if desc.route_id and desc.route_id != route:
                continue
            stamp = min(fact.timestamp or header or int(capture_second), int(capture_second))
            if trip is not None and not trip.added:
                if desc.start_date in operating_codes[trip_id]:
                    if desc.start_date != day_code:
                        continue
                else:
                    # STM can report the calendar date of an overnight reading.
                    # If that date cannot operate this trip, require one timetable
                    # instance in range before attributing the evidence to this day.
                    plausible = [
                        when for when, start, end in windows(trip_id) if start <= stamp <= end
                    ]
                    if plausible != [day]:
                        continue
            elif desc.start_date != day_code:
                continue
            if trip is None:
                if desc.schedule_relationship not in ADDED:
                    continue
                trip = trips[trip_id] = Trip(route, {}, True, added=True)
            if family == "trip_updates":
                update = pb.TripUpdate()
                update.CopyFrom(fact)
                updates[trip_id].append((stamp, update))
                if trip.added and desc.schedule_relationship not in REMOVED:
                    for item in fact.stop_time_update:
                        if item.HasField("stop_sequence") and item.stop_id:
                            trip.stops.setdefault(
                                item.stop_sequence,
                                Stop(item.stop_id, None, None),
                            )
            elif desc.schedule_relationship not in REMOVED:
                if trip.added and fact.HasField("current_stop_sequence") and fact.stop_id:
                    trip.stops.setdefault(
                        fact.current_stop_sequence, Stop(fact.stop_id, None, None)
                    )
                position = pb.VehiclePosition()
                position.CopyFrom(fact)
                positions[trip_id].append((stamp, position))

    trip_days, events, evidence = {}, {}, {}
    for trip_id, trip in trips.items():
        stopped, progress = vehicle_facts(trip, positions[trip_id], coords)
        nearby = {} if has_stopped else nearby_facts(trip, positions[trip_id], coords)
        exact, predictions = update_facts(trip, updates[trip_id])
        observed = {}
        for seq in trip.stops:
            direct = stopped[seq] or nearby.get(seq) or exact[seq]
            reading = (
                min(direct, key=lambda r: r.second)
                if direct
                else passed_reading(seq, progress, predictions[seq])
            )
            if reading is not None:
                observed[seq] = reading
        if updates[trip_id]:
            _, latest = max(
                updates[trip_id],
                key=lambda entry: (entry[0], entry[1].trip.schedule_relationship in REMOVED),
            )
            cancelled = latest.trip.schedule_relationship in REMOVED
        else:
            cancelled = False
        if trip.added:
            state = "added"
        elif cancelled:
            state = "cancelled"
        elif observed:
            state = "ran"
        elif updates[trip_id] or positions[trip_id]:
            state = "unconfirmed"
        elif not trip.live:
            state = "not_measured"
        else:
            start, end = trip.start, trip.end
            state = (
                "missing"
                if start is not None
                and end is not None
                and all(covered(p, start - 300, end) for p in polls.values())
                else "not_measured"
            )
        trip_day = trip_days[trip_id] = TripDay(trip.route, state, trip.live, trip.start)
        for seq, stop in trip.stops.items():
            key = trip_id, seq
            reading = observed.get(seq)
            if reading is None:
                events[key] = StopEvent(
                    stop.id, stop.arrival, stop.departure, "not_observed", None, None, None, None
                )
            else:
                scheduled = (
                    stop.departure
                    if reading.event == "departure" or stop.arrival is None
                    else stop.arrival
                )
                delay = reading.second - scheduled if scheduled is not None else None
                events[key] = StopEvent(
                    stop.id,
                    stop.arrival,
                    stop.departure,
                    reading.basis,
                    reading.second,
                    reading.event,
                    delay,
                    classify(delay, trip_day),
                )
                evidence[key] = reading
    assert scheduled_trips == sum(trip.state != "added" for trip in trip_days.values())
    assert scheduled_stops == sum(trip_days[trip].state != "added" for trip, _ in events)
    return trip_days, events, evidence


def loose_captures(root: Path, start: datetime, end: datetime) -> Iterator[Capture]:
    files = sorted(
        (file.name.split("__")[0], file)
        for family in ("trip_updates", "vehicle_positions")
        for file in (root / family).glob("*.pb")
    )
    for stamp, file in files:
        captured = datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
        if start <= captured <= end:
            yield file.parent.name, captured, file.read_bytes()


def counts(trips: dict[str, TripDay], events: dict[EventKey, StopEvent]) -> dict[str, dict]:
    states = Counter(t.state for t in trips.values())
    bases = Counter(e.basis for e in events.values())
    bands = Counter(e.punctuality for e in events.values() if e.punctuality)
    return {
        "trip_state": {
            name: states[name]
            for name in ("ran", "cancelled", "missing", "unconfirmed", "not_measured", "added")
        },
        "basis": {
            name: bases[name]
            for name in (
                "vehicle_stopped",
                "vehicle_nearby",
                "trip_update_reported",
                "trip_update_passed",
                "not_observed",
            )
        },
        "punctuality": {
            "classified": sum(bands.values()),
            **{name: bands[name] for name in ("on_time", "early", "late")},
        },
    }


def differences(left: dict, right: dict) -> dict:
    return {
        key: (left.get(key), right.get(key))
        for key in sorted(left.keys() | right.keys())
        if left.get(key) != right.get(key)
    }


def clean_tables(
    root: Path, provider: str, day: date, version: str, routes: set[str]
) -> tuple[dict[str, TripDay], dict[EventKey, StopEvent]]:
    """Read only the public clean-table contract, using the same scope as the raw pass."""
    import duckdb

    with duckdb.connect() as db:
        trip_rows = db.execute(
            """
            SELECT trip_id, route_id, state, route_has_live_data,
                   epoch(scheduled_start_utc)::BIGINT
            FROM read_parquet(?)
            WHERE provider = ? AND service_date = ? AND cleaning_version = ? AND route_id IN ?
            """,
            [str(root / "trip_days.parquet"), provider, day, version, sorted(routes)],
        ).fetchall()
        stop_rows = db.execute(
            """
            SELECT trip_id, stop_sequence, stop_id, epoch(scheduled_arrival_utc)::BIGINT,
                   epoch(scheduled_departure_utc)::BIGINT, basis, epoch(observed_at_utc)::BIGINT,
                   observed_event, delay_seconds
            FROM read_parquet(?)
            WHERE provider = ? AND service_date = ? AND cleaning_version = ? AND route_id IN ?
            """,
            [str(root / "stop_events.parquet"), provider, day, version, sorted(routes)],
        ).fetchall()
    trips = {
        trip: TripDay(route, state, live, start) for trip, route, state, live, start in trip_rows
    }
    events = {
        (trip, seq): StopEvent(
            stop, arrival, departure, basis, observed, event, delay, classify(delay, trips[trip])
        )
        for trip, seq, stop, arrival, departure, basis, observed, event, delay in stop_rows
    }
    if len(trips) != len(trip_rows) or len(events) != len(stop_rows):
        raise ValueError("Duplicate trip or stop event in the clean tables")
    if not trips or not events:
        raise ValueError("No clean rows match the selected provider, date, version and lines")
    return trips, events


def check_math(trips: dict[str, TripDay], events: dict[EventKey, StopEvent]) -> None:
    summary = counts(trips, events)
    states, bases, bands = (summary[key] for key in ("trip_state", "basis", "punctuality"))
    assert len(trips) == sum(states.values())
    assert len(events) == sum(bases.values())
    assert bands["classified"] == bands["early"] + bands["on_time"] + bands["late"]
    for (trip, _), event in events.items():
        if event.basis == "not_observed":
            assert event.observed is None and event.delay is None and event.event is None
        else:
            assert event.observed is not None
            expected = event.observed - event.scheduled if event.scheduled is not None else None
            assert event.delay == expected
        state = trips[trip]
        eligible = (
            state.live and state.state not in {"added", "cancelled"} and event.delay is not None
        )
        assert (event.on_time is not None) == eligible
        if eligible:
            assert event.on_time == (-60 <= event.delay <= 300)


def comparison(plain: tuple[dict, dict], clean: tuple[dict, dict]) -> dict:
    plain_trips, plain_events = plain
    clean_trips, clean_events = clean
    check_math(plain_trips, plain_events)
    check_math(clean_trips, clean_events)

    def rows(raw: dict, published: dict) -> list:
        return [
            [
                list(key) if isinstance(key, tuple) else key,
                asdict(a) if a is not None else None,
                asdict(b) if b is not None else None,
            ]
            for key, (a, b) in differences(raw, published).items()
        ]

    return {
        "plain_counts": counts(plain_trips, plain_events),
        "clean_counts": counts(clean_trips, clean_events),
        "trips": rows(plain_trips, clean_trips),
        "stops": rows(plain_events, clean_events),
    }


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument(
        "root", type=Path, help="Schedule ZIP, loose captures and clean Parquet files"
    )
    parser.add_argument(
        "--routes", nargs="+", required=True, help="Complete lines by GTFS route ID"
    )
    parser.add_argument("--from-utc", required=True, type=datetime.fromisoformat)
    parser.add_argument("--through-utc", required=True, type=datetime.fromisoformat)
    args = parser.parse_args()
    manifest = json.loads((args.root / "manifest.json").read_bytes())
    if manifest["provider"] != "stm":
        parser.error("The archive audit is configured for STM")
    for name in ("schedule.zip", "trip_days.parquet", "stop_events.parquet"):
        with (args.root / name).open("rb") as stream:
            actual = file_digest(stream, "sha256").hexdigest()
        expected = (
            manifest["schedule_sha256"]
            if name == "schedule.zip"
            else manifest["files"][name]["sha256"]
        )
        if actual != expected:
            parser.error(f"{name} differs from the manifest checksum")

    day = date.fromisoformat(manifest["service_date"])
    routes = set(args.routes)
    captures = loose_captures(args.root, args.from_utc, args.through_utc)
    trips, events, evidence = recompute(
        args.root / "schedule.zip",
        captures,
        day,
        routes,
        zone=ZoneInfo("America/Toronto"),
        no_live_types={"1"},
    )
    clean = clean_tables(args.root, "stm", day, manifest["cleaning_version"], routes)
    result = comparison((trips, events), clean)
    result["provider"] = "stm"
    result["service_date"] = day.isoformat()
    result["cleaning_version"] = manifest["cleaning_version"]
    result["routes"] = sorted(routes)
    result["reading_evidence"] = [
        [key, asdict(evidence[tuple(key)])]
        for key, _, _ in result["stops"]
        if tuple(key) in evidence
    ]
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
