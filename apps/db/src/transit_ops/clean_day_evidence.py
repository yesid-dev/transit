"""Read original inputs to explain a private clean day."""

import json
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from collections.abc import Iterable
from datetime import date
from pathlib import Path
from typing import NamedTuple, TextIO

import duckdb
from google.transit.gtfs_realtime_pb2 import FeedHeader, TripDescriptor, VehiclePosition

from transit_ops.clean_day import (
    GPS_ENTRY_MAX_GAP_SECONDS,
    STOPPED_AT_RADIUS_METRES,
    GPSFix,
    NearbyStop,
    _position_coords,
    capture_window,
)
from transit_ops.clean_day_inputs import declaration_for, load_contexts
from transit_ops.clean_day_realtime import DayCapture, FeedPoll, distance_metres, read_capture
from transit_ops.clean_days import _storage, day_captures, discover_editions
from transit_ops.providers.schedule_archive import ArchiveScheduleContext


class Observation(NamedTuple):
    second: int
    basis: str
    lat: float | None
    lon: float | None


class StopEvidence:
    def __init__(self, directory: Path, schedule: ArchiveScheduleContext, day: date) -> None:
        self.observations: dict[tuple[str, str], list[Observation]] = defaultdict(list)
        self.previous: dict[tuple[str, str], GPSFix] = {}
        self.results: dict[tuple[str, str, int], str] = {}
        with duckdb.connect() as db:
            rows = db.execute(
                """
                SELECT trip_id, coalesce(vehicle_id, ''), stop_id, basis,
                       epoch(observed_at_utc)::bigint
                FROM read_parquet(?)
                WHERE basis IN ('vehicle_stopped', 'vehicle_nearby')
                ORDER BY observed_at_utc, stop_sequence
                """,
                [str(directory / "stop_events.parquet")],
            ).fetchall()
        for trip, vehicle, stop_id, basis, second in rows:
            stop = schedule.stop(day, stop_id)
            self.observations[trip, vehicle].append(
                Observation(second, basis, stop.lat if stop else None, stop.lon if stop else None)
            )

    def observe(self, feed: str, vehicle: VehiclePosition, second: int) -> None:
        coords = _position_coords(vehicle)
        if not vehicle.vehicle.id or coords is None:
            return
        trip, ident = vehicle.trip.trip_id, vehicle.vehicle.id
        lat, lon = coords
        previous = self.previous.get((feed, ident))
        if previous is not None and previous.second >= second:
            previous = None
        else:
            self.previous[feed, ident] = GPSFix(trip, None, second, lat, lon)
        if previous is not None and previous.trip_id != trip:
            previous = None
        earliest = (
            max(second - GPS_ENTRY_MAX_GAP_SECONDS, previous.second)
            if previous is not None
            else second
        )
        candidates = self.observations.get((trip, ident))
        if not candidates:
            return
        first = bisect_left(candidates, earliest, key=lambda item: item.second)
        last = bisect_right(candidates, second, key=lambda item: item.second)
        for index in range(first, last):
            observed, basis, stop_lat, stop_lon = candidates[index]
            if stop_lat is None or stop_lon is None:
                continue
            distance = distance_metres(lat, lon, stop_lat, stop_lon)
            inside = distance <= STOPPED_AT_RADIUS_METRES
            key = trip, ident, index
            if basis == "vehicle_stopped":
                if observed == second and vehicle.current_status == VehiclePosition.STOPPED_AT:
                    if inside:
                        self.results[key] = "within radius"
                    else:
                        self.results.setdefault(key, "outside radius")
            elif inside and (
                observed == second
                or (
                    previous is not None
                    and NearbyStop(0, distance, stop_lat, stop_lon).entry_second(previous, second)
                    == observed
                )
            ):
                self.results[key] = "within radius"

    def counts(self) -> Counter[tuple[str, str]]:
        return Counter(
            (observation.basis, self.results.get((trip, vehicle, index), "uncorroborated"))
            for (trip, vehicle), observations in self.observations.items()
            for index, observation in enumerate(observations)
        )


def _ratio(count: int, total: int) -> str:
    return f"{count}/{total} ({count / total:.1%})" if total else "unavailable"


def _trip_match(
    descriptor: TripDescriptor, day: date, schedules: dict[date, ArchiveScheduleContext]
) -> str:
    if descriptor.schedule_relationship == TripDescriptor.ADDED:
        return "added"
    if not descriptor.trip_id:
        return "omitted"
    if descriptor.start_date:
        date_text = descriptor.start_date
        try:
            day = date.fromisoformat(date_text)
        except ValueError:
            return "invalid service date"
        schedule = schedules.get(day)
        if schedule is None or day not in schedule.days:
            return "schedule unavailable"
        return "matched" if schedule.trip(day, descriptor.trip_id) else "unmatched"
    # The padding includes service from adjacent days. An undated ID can
    # establish a schedule match without establishing which trip instance ran.
    for candidate, schedule in schedules.items():
        if schedule.trip(candidate, descriptor.trip_id) is not None:
            return "matched"
    return "unmatched"


def report_raw(
    captures: Iterable[DayCapture | FeedPoll],
    schedules: dict[date, ArchiveScheduleContext],
    day: date,
    radius: StopEvidence,
    output: TextIO,
) -> None:
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    unknown_stops: Counter[tuple[str, str]] = Counter()
    languages: Counter[tuple[str, str]] = Counter()
    seen: dict[tuple[str, bytes], FeedPoll] = {}
    for capture in captures:
        if isinstance(capture, FeedPoll):
            continue
        family = capture.family
        if family not in ("vehicle_positions", "trip_updates", "service_alerts"):
            continue
        if family == "service_alerts" and (
            capture.captured_at_utc.astimezone(schedules[day].timezone).date() != day
        ):
            continue
        _, message = read_capture(capture, seen)
        if message is None:
            continue
        stats = counts[capture.feed]
        stats["publications"] += 1
        stats["full dataset"] += message.header.incrementality == FeedHeader.FULL_DATASET
        captured = int(capture.captured_at_utc.timestamp())
        feed_second = min(message.header.timestamp or captured, captured)
        for entity in message.entity:
            if entity.is_deleted:
                continue
            if family == "vehicle_positions" and entity.HasField("vehicle"):
                vehicle = entity.vehicle
                stats["entities"] += 1
                stats["vehicle status supplied"] += vehicle.HasField("current_status")
                stats["stopped"] += vehicle.current_status == VehiclePosition.STOPPED_AT
                stats["occupancy supplied"] += vehicle.HasField(
                    "occupancy_status"
                ) or vehicle.HasField("occupancy_percentage")
                trips = [vehicle.trip]
                stops = [vehicle.stop_id]
                radius.observe(
                    capture.feed, vehicle, min(vehicle.timestamp or feed_second, captured)
                )
            elif family == "trip_updates" and entity.HasField("trip_update"):
                stats["entities"] += 1
                trips = [entity.trip_update.trip]
                stops = [row.stop_id for row in entity.trip_update.stop_time_update]
            elif family == "service_alerts" and entity.HasField("alert"):
                stats["entities"] += 1
                trips = [row.trip for row in entity.alert.informed_entity if row.HasField("trip")]
                stops = [
                    row.stop_id for row in entity.alert.informed_entity if row.HasField("stop_id")
                ]
                for field in ("header_text", "description_text", "url"):
                    for row in getattr(entity.alert, field).translation:
                        languages[field, row.language or "(untagged)"] += 1
            else:
                continue
            for descriptor in trips:
                stats["trip " + _trip_match(descriptor, day, schedules)] += 1
            for stop_id in stops:
                if not stop_id:
                    stats["stop omitted"] += 1
                elif any(
                    schedule.stop(candidate, stop_id) for candidate, schedule in schedules.items()
                ):
                    stats["stop matched"] += 1
                else:
                    stats["stop unmatched"] += 1
                    unknown_stops[capture.feed, stop_id] += 1

    print("\n### Original GTFS-Realtime coverage", file=output)
    print(
        "Counts use distinct decoded payloads in the padded movement window or alert service day.",
        file=output,
    )
    if not counts:
        print("No decoded GTFS-Realtime evidence.", file=output)
    for feed, stats in sorted(counts.items()):
        print(
            f"\n{feed}: {stats['entities']} records in {stats['publications']} publications.",
            file=output,
        )
        print(
            f"  Full datasets: {_ratio(stats['full dataset'], stats['publications'])}.", file=output
        )
        for field in ("trip", "stop"):
            categories = {
                key.removeprefix(field + " "): value
                for key, value in stats.items()
                if key.startswith(field + " ")
            }
            matched = categories.get("matched", 0)
            share = _ratio(matched, matched + categories.get("unmatched", 0))
            print(
                f"  {field.title()} match: {share}. Categories: {json.dumps(categories)}.",
                file=output,
            )
        if "vehicle status supplied" in stats:
            total = stats["entities"]
            print(
                f"  Status supplied: {_ratio(stats['vehicle status supplied'], total)}.",
                file=output,
            )
            print(
                f"  STOPPED_AT: {_ratio(stats['stopped'], total)} of all vehicle reports.",
                file=output,
            )
            print(
                f"  Occupancy supplied: {_ratio(stats['occupancy supplied'], total)}.", file=output
            )

    print("\nUnknown stop IDs by feed (including occurrence counts):", file=output)
    for (feed, ident), count in sorted(unknown_stops.items()):
        print(f"  {feed}: {json.dumps(ident)}: {count}", file=output)
    if not unknown_stops:
        print(
            "  None in decoded inputs with a reported stop ID."
            if any(c["stop matched"] for c in counts.values())
            else "  Unavailable. No stop IDs were reported in the decoded inputs.",
            file=output,
        )
    print("\nAlert languages by field:", file=output)
    for (field, language), count in sorted(languages.items()):
        print(f"  {field}: {json.dumps(language)}: {count}", file=output)
    if not languages:
        print("  No alert translations observed in the decoded inputs.", file=output)
    print(f"\nVehicle stop evidence against {STOPPED_AT_RADIUS_METRES} m:", file=output)
    for (basis, result), count in sorted(radius.counts().items()):
        print(f"  {basis}: {result}: {count}", file=output)
    if not radius.observations:
        print("  No vehicle-based stop readings.", file=output)


def report_details(
    directory: Path, provider: str, day: date, source: str, schedule_sha: str, output: TextIO
) -> None:
    declaration = declaration_for(provider)
    raw, prefix = _storage(source, "SOURCE")
    editions = discover_editions(raw, prefix, declaration)
    schedules, _ = load_contexts(declaration, day, editions, raw.read_bytes)
    if day not in schedules or schedules[day].days[day].edition_sha256 != schedule_sha:
        raise ValueError("Raw schedule differs from the clean day receipt")
    schedule = schedules[day]
    start, end = capture_window(schedule, day)
    print(f"\nRaw inspection window: {start} to {end}.", file=output)
    trips = schedule.days[day].trip_ids
    stops = sum(len(schedule.stop_times(day, trip)) for trip in trips)
    lines = len(schedule.days[day].route_ids)
    print(
        f"Schedule verification: {len(trips)} trips, {stops} stop times, {lines} lines.",
        file=output,
    )
    _, captures = day_captures(raw, prefix, declaration, start, end)
    report_raw(captures, schedules, day, StopEvidence(directory, schedule, day), output)
