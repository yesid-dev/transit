"""Build compact, checksum-pinned service-day schedules off the live loop."""

from __future__ import annotations

import csv
import logging
import sqlite3
import sys
import zlib
from collections import defaultdict
from collections.abc import Iterator
from concurrent.futures import Executor, Future
from contextlib import closing
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from io import TextIOWrapper
from itertools import batched
from pathlib import Path, PurePosixPath
from uuid import uuid4
from zipfile import BadZipFile, ZipFile
from zoneinfo import ZoneInfo

from botocore.exceptions import BotoCoreError, ClientError

from transit_ops.clean_day_inputs import Edition
from transit_ops.clean_days import discover_editions
from transit_ops.core.models import ProviderManifest
from transit_ops.gtfs.types import parse_gtfs_date, parse_gtfs_service_time
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.live.silent_trips import TripSpan

LOGGER = logging.getLogger(__name__)
REFRESH = timedelta(minutes=30)
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
SCHEDULE_ERRORS = (
    OSError,
    ValueError,
    KeyError,
    IndexError,
    csv.Error,
    BadZipFile,
    EOFError,
    zlib.error,
    NotImplementedError,
    BotoCoreError,
    ClientError,
    sqlite3.Error,
)
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
# Prefetch tomorrow before a service-day rollover. Keep both preceding days
# for service times through 48:00, including short local days.
DAY_OFFSETS = (0, -1, -2, 1)
MAX_SERVICE_SECONDS = 48 * 3600

type Stop = tuple[int, str, int | None, int | None]
type ScheduledTrip = tuple[str, str, int | None, str | None]


@dataclass(frozen=True)
class DaySchedule:
    path: Path
    trips: dict[str, TripSpan]
    evidence: dict[str, str | int | None] | None = None

    def stops(self, trip_ids: set[str]) -> dict[str, list[Stop]]:
        with closing(sqlite3.connect(f"{self.path.as_uri()}?mode=ro", uri=True)) as conn:
            return {
                trip: conn.execute(
                    "SELECT seq, stop, arrival, departure FROM stops WHERE trip = ?",
                    (trip,),
                ).fetchall()
                for trip in trip_ids
            }


@dataclass(frozen=True)
class Calendar:
    regular: list[tuple[str, date, date, tuple[bool, ...]]]
    exceptions: dict[date, dict[str, bool]]
    coverage: tuple[date, date]

    def on(self, day: date) -> set[str] | None:
        if not self.coverage[0] <= day <= self.coverage[1]:
            return None
        active = {
            service
            for service, first, last, weekdays in self.regular
            if first <= day <= last and weekdays[day.weekday()]
        }
        for service, added in self.exceptions.get(day, {}).items():
            if added:
                active.add(service)
            else:
                active.discard(service)
        return active


def _seconds(value: str) -> int | None:
    if not value:
        return None
    return parse_gtfs_service_time(value, field_name="stop time").total_seconds


def _archive_rows(
    archive: ZipFile, member: str, *, optional: bool = False
) -> Iterator[dict[str, str]]:
    members = [name for name in archive.namelist() if PurePosixPath(name).name.lower() == member]
    if not members and optional:
        return
    if len(members) != 1:
        raise ValueError("Schedule member missing or duplicated")
    with TextIOWrapper(archive.open(members[0]), encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f, strict=True)


def _calendar(archive: ZipFile) -> Calendar:
    regular = [
        (
            row["service_id"],
            parse_gtfs_date(row["start_date"], field_name="start_date"),
            parse_gtfs_date(row["end_date"], field_name="end_date"),
            tuple(row[weekday] == "1" for weekday in WEEKDAYS),
        )
        for row in _archive_rows(archive, "calendar.txt", optional=True)
    ]
    exceptions: dict[date, dict[str, bool]] = defaultdict(dict)
    for row in _archive_rows(archive, "calendar_dates.txt", optional=True):
        day = parse_gtfs_date(row["date"], field_name="date")
        exceptions[day][row["service_id"]] = row["exception_type"] == "1"
    starts = [row[1] for row in regular] + list(exceptions)
    ends = [row[2] for row in regular] + list(exceptions)
    return Calendar(regular, dict(exceptions), (min(starts), max(ends)))


def _selected_trips(
    archive: ZipFile, manifest: ProviderManifest, services: set[str]
) -> dict[str, ScheduledTrip]:
    gaps = manifest.realtime.lines_without_live_data
    excluded_routes = {route for gap in gaps for route in gap.route_ids}
    excluded_types = {kind for gap in gaps for kind in gap.route_types}
    routes = {r["route_id"]: int(r["route_type"]) for r in _archive_rows(archive, "routes.txt")}
    selected = {}
    for row in _archive_rows(archive, "trips.txt"):
        service, trip, route = row["service_id"], row["trip_id"], row["route_id"]
        if service not in services or route in excluded_routes or routes[route] in excluded_types:
            continue
        if not trip or trip in selected:
            raise ValueError("Invalid scheduled trip identity")
        direction = row.get("direction_id") or None
        headsign = (row.get("trip_headsign") or "").strip()
        selected[trip] = (
            service,
            route,
            None if direction is None else int(direction),
            sys.intern(headsign) if headsign else None,
        )
    if any(
        r["trip_id"] in selected for r in _archive_rows(archive, "frequencies.txt", optional=True)
    ):
        raise ValueError("Trip templates do not identify single scheduled journeys")
    return selected


def _stop_rows(
    archive: ZipFile, trips: dict[str, ScheduledTrip]
) -> Iterator[tuple[str, int, str, int | None, int | None]]:
    members = [
        name for name in archive.namelist() if PurePosixPath(name).name.lower() == "stop_times.txt"
    ]
    if len(members) != 1:
        raise ValueError("Schedule stop times missing or duplicated")
    with TextIOWrapper(archive.open(members[0]), encoding="utf-8-sig", newline="") as f:
        rows = csv.reader(f, strict=True)
        header = next(rows, [])
        trip_id, seq, stop, arrival, departure = (
            header.index(col)
            for col in ("trip_id", "stop_sequence", "stop_id", "arrival_time", "departure_time")
        )
        for row in rows:
            if row and row[trip_id] in trips:
                yield (
                    row[trip_id],
                    int(row[seq]),
                    row[stop],
                    _seconds(row[arrival]),
                    _seconds(row[departure]),
                )


def build_days(
    source: Path, target: Path, manifest: ProviderManifest, days: list[date]
) -> dict[date, DaySchedule | None]:
    """Store the selected service days' stop calls in a compact indexed scratch file."""
    with ZipFile(source) as archive:
        calendar = _calendar(archive)
        active = {day: calendar.on(day) for day in days}
        services = set().union(*(value for value in active.values() if value is not None))
        trips = _selected_trips(archive, manifest, services)
        with closing(sqlite3.connect(target)) as conn, conn:
            conn.execute(
                "CREATE TABLE stops (trip TEXT, seq INTEGER, stop TEXT, arrival INTEGER,"
                " departure INTEGER, PRIMARY KEY (trip, seq)) WITHOUT ROWID"
            )
            for batch in batched(_stop_rows(archive, trips), 4096):
                conn.executemany("INSERT INTO stops VALUES (?, ?, ?, ?, ?)", batch)
            ends = {
                trip: (first, last)
                for trip, first, last in conn.execute(
                    """WITH seqs AS (
                        SELECT trip, min(seq) AS first, max(seq) AS last FROM stops GROUP BY trip
                    )
                    SELECT seqs.trip, a.departure, b.arrival FROM seqs
                    JOIN stops a ON (a.trip, a.seq) = (seqs.trip, seqs.first)
                    JOIN stops b ON (b.trip, b.seq) = (seqs.trip, seqs.last)"""
                )
            }
    by_service: dict[str, list[TripSpan]] = defaultdict(list)
    for trip, (service, route, direction, headsign) in trips.items():
        first, last = ends[trip]
        if first is None or last is None or not first <= last <= MAX_SERVICE_SECONDS:
            raise ValueError("Unsupported or missing scheduled service span")
        by_service[service].append(TripSpan(trip, route, first, last, direction, headsign))
    return {
        day: None
        if value is None
        else DaySchedule(
            target,
            {trip.trip_id: trip for service in value for trip in by_service[service]},
        )
        for day, value in active.items()
    }


class LiveTripSchedule:
    def __init__(
        self,
        manifest: ProviderManifest,
        raw: BronzeStorage,
        prefix: str,
        executor: Executor,
        workspace: Path,
    ):
        self.manifest = manifest
        self.raw = raw
        self.prefix = prefix
        self.executor = executor
        self.workspace = workspace
        self.zone = ZoneInfo(manifest.provider.timezone)
        self._cache: dict[tuple[str, date], DaySchedule | None] = {}
        self._pending: Future[dict[date, DaySchedule | None]] | None = None
        self._checked: datetime | None = None
        self._days: dict[date, DaySchedule | None] = {}

    def _archive(self, edition: Edition) -> Path:
        path = self.workspace / f"{edition.sha256}.zip"
        if path.exists():
            return path
        digest = sha256()
        size = 0
        try:
            with self.raw.open_stream(edition.key) as stream, path.open("wb") as output:
                while chunk := stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_ARCHIVE_BYTES:
                        raise ValueError("Oversized schedule archive")
                    digest.update(chunk)
                    output.write(chunk)
            if not digest.hexdigest().startswith(edition.sha256):
                raise ValueError("Unverified schedule edition")
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return path

    def _load(self, today: date) -> dict[date, DaySchedule | None]:
        editions = discover_editions(self.raw, self.prefix, self.manifest)
        by_date = sorted(editions, reverse=True)
        selections = {}
        build = defaultdict(list)
        for offset in DAY_OFFSETS:
            day = today + timedelta(days=offset)
            effective = next((candidate for candidate in by_date if candidate <= day), None)
            if effective is not None:
                edition = editions[effective][0]
                selections[day] = (effective, edition)
                if (edition.sha256, day) not in self._cache:
                    build[edition].append(day)
        for edition, dates in build.items():
            target = self.workspace / f"{uuid4().hex}.sqlite"
            try:
                built = build_days(self._archive(edition), target, self.manifest, dates)
            except SCHEDULE_ERRORS as error:
                target.unlink(missing_ok=True)
                LOGGER.warning("Live trip schedule edition unavailable (%s)", type(error).__name__)
            else:
                self._cache.update({(edition.sha256, day): result for day, result in built.items()})
        self._cache = {
            key: value
            for key, value in self._cache.items()
            if key[1] in selections and selections[key[1]][1].sha256 == key[0]
        }
        days = {}
        for day, (effective, edition) in selections.items():
            schedule = self._cache.get((edition.sha256, day))
            if schedule is not None:
                original = (edition.original_key or edition.key).rsplit("/", 1)[-1]
                stamp, separator, _ = original.partition("__")
                captured = (
                    datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
                    if separator
                    else None
                )
                # This is the same ZIP already read and verified to build the index.
                size = (self.workspace / f"{edition.sha256}.zip").stat().st_size
                schedule = replace(
                    schedule,
                    evidence={
                        "captured_at": captured.isoformat() if captured else None,
                        "effective_date": effective.isoformat(),
                        "bytes": size,
                    },
                )
            days[day] = schedule
        return days

    def at(self, now: datetime, *, wait: bool = False) -> dict[date, DaySchedule | None]:
        today = now.astimezone(self.zone).date()
        if self._pending is None and (
            self._checked is None
            or now - self._checked >= REFRESH
            or today != self._checked.astimezone(self.zone).date()
        ):
            self._checked = now
            self._pending = self.executor.submit(self._load, today)
        if self._pending is not None and (wait or self._pending.done()):
            try:
                self._days = self._pending.result()
            except SCHEDULE_ERRORS as error:
                self._days = {}
                self._cache = {}
                LOGGER.warning("Live trip schedule unavailable (%s)", type(error).__name__)
            finally:
                self._pending = None
            # No reader has an open connection here, and the builder has stopped.
            keep = {day.path for day in self._days.values() if day is not None}
            for path in self.workspace.glob("*.sqlite"):
                if path not in keep:
                    path.unlink(missing_ok=True)
            for path in self.workspace.glob("*.zip"):
                if not any(path.stem == digest for digest, _ in self._cache):
                    path.unlink(missing_ok=True)
        return self._days
