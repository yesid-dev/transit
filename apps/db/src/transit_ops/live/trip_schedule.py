"""Compact GTFS trip spans, loaded off the live polling loop."""

from __future__ import annotations

import csv
import logging
import zlib
from collections import defaultdict
from collections.abc import Iterator
from concurrent.futures import Executor, Future
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from hashlib import sha256
from io import BytesIO, TextIOWrapper
from pathlib import PurePosixPath
from zipfile import BadZipFile, ZipFile
from zoneinfo import ZoneInfo

from botocore.exceptions import BotoCoreError, ClientError

from transit_ops.clean_day_inputs import Edition
from transit_ops.clean_days import discover_editions
from transit_ops.core.models import ProviderManifest
from transit_ops.gtfs.types import parse_gtfs_date, parse_gtfs_service_time
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.live.silent_trips import TripSpan
from transit_ops.providers.schedule import service_day_start

LOGGER = logging.getLogger(__name__)
REFRESH = timedelta(minutes=30)
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
# Allow service through the following day, including a 23-hour local day.
MAX_SERVICE_SECONDS = 48 * 3600
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
)
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


@dataclass(frozen=True)
class CompactEdition:
    trips: dict[str, list[TripSpan]]
    calendar: list[tuple[str, date, date, tuple[bool, ...]]]
    exceptions: dict[date, dict[str, bool]]
    coverage: tuple[date, date]

    def on(self, day: date) -> tuple[TripSpan, ...] | None:
        if not self.coverage[0] <= day <= self.coverage[1]:
            return None
        active = {
            service
            for service, first, last, weekdays in self.calendar
            if first <= day <= last and weekdays[day.weekday()]
        }
        for service, added in self.exceptions.get(day, {}).items():
            if added:
                active.add(service)
            else:
                active.discard(service)
        return tuple(trip for service in active for trip in self.trips.get(service, ()))


def read_edition(data: bytes, manifest: ProviderManifest) -> CompactEdition:
    """Read only the schedule fields needed for active service and trip spans."""
    with ZipFile(BytesIO(data)) as archive:
        members = {}
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            basename = PurePosixPath(name).name.lower()
            if basename in members:
                raise ValueError("Duplicate schedule member")
            members[basename] = name

        def records(member: str, *, optional: bool = False) -> Iterator[dict[str, str]]:
            if optional and member not in members:
                return
            with TextIOWrapper(
                archive.open(members[member]), encoding="utf-8-sig", newline=""
            ) as f:
                yield from csv.DictReader(f, strict=True)

        gaps = manifest.realtime.lines_without_live_data
        excluded_routes = {route for gap in gaps for route in gap.route_ids}
        excluded_types = {kind for gap in gaps for kind in gap.route_types}
        routes = {r["route_id"]: int(r["route_type"]) for r in records("routes.txt")}
        identities = {}
        for row in records("trips.txt"):
            trip, route = row["trip_id"], row["route_id"]
            if route in excluded_routes or routes[route] in excluded_types:
                continue
            if not trip or trip in identities:
                raise ValueError("Invalid scheduled trip identity")
            identities[trip] = (row["service_id"], route)
        if any(r["trip_id"] in identities for r in records("frequencies.txt", optional=True)):
            raise ValueError("Trip templates do not identify individual scheduled journeys")

        # Retain only the two boundary rows per trip. Stop records can arrive
        # out of sequence and intermediate stops can have blank times.
        endpoints = {}
        with TextIOWrapper(
            archive.open(members["stop_times.txt"]), encoding="utf-8-sig", newline=""
        ) as f:
            rows = csv.reader(f, strict=True)
            header = next(rows, [])
            trip_col, seq_col, departure_col, arrival_col = (
                header.index(col)
                for col in ("trip_id", "stop_sequence", "departure_time", "arrival_time")
            )
            for row in rows:
                if not row or (trip := row[trip_col]) not in identities:
                    continue
                seq = int(row[seq_col])
                previous = endpoints.get(trip)
                if previous is None:
                    endpoints[trip] = (seq, row[departure_col], seq, row[arrival_col])
                else:
                    first_seq, first, last_seq, last = previous
                    if seq < first_seq:
                        endpoints[trip] = (seq, row[departure_col], last_seq, last)
                    elif seq > last_seq:
                        endpoints[trip] = (first_seq, first, seq, row[arrival_col])

        trips = defaultdict(list)
        for trip, (service, route) in identities.items():
            _, first, _, last = endpoints[trip]
            start = parse_gtfs_service_time(first, field_name="departure_time").total_seconds
            end = parse_gtfs_service_time(last, field_name="arrival_time").total_seconds
            if not start <= end <= MAX_SERVICE_SECONDS:
                raise ValueError("Unsupported scheduled service span")
            trips[service].append(TripSpan(trip, route, start, end))

        calendar = [
            (
                row["service_id"],
                parse_gtfs_date(row["start_date"], field_name="start_date"),
                parse_gtfs_date(row["end_date"], field_name="end_date"),
                tuple(row[weekday] == "1" for weekday in WEEKDAYS),
            )
            for row in records("calendar.txt", optional=True)
        ]
        exceptions: dict[date, dict[str, bool]] = defaultdict(dict)
        for row in records("calendar_dates.txt", optional=True):
            day = parse_gtfs_date(row["date"], field_name="date")
            exceptions[day][row["service_id"]] = row["exception_type"] == "1"
        starts = [row[1] for row in calendar] + list(exceptions)
        ends = [row[2] for row in calendar] + list(exceptions)
        return CompactEdition(dict(trips), calendar, dict(exceptions), (min(starts), max(ends)))


class LiveTripSchedule:
    def __init__(
        self, manifest: ProviderManifest, raw: BronzeStorage, prefix: str, executor: Executor
    ):
        self.manifest = manifest
        self.raw = raw
        self.prefix = prefix
        self.executor = executor
        self.zone = ZoneInfo(manifest.provider.timezone)
        self._cache: dict[str, CompactEdition] = {}
        self._pending: Future[dict[date, tuple[TripSpan, ...] | None]] | None = None
        self._checked: datetime | None = None
        self._days: dict[date, tuple[TripSpan, ...] | None] = {}

    def _read(self, edition: Edition) -> CompactEdition:
        if edition.sha256 in self._cache:
            return self._cache[edition.sha256]
        with self.raw.open_stream(edition.key) as stream:
            data = stream.read(MAX_ARCHIVE_BYTES + 1)
        if len(data) > MAX_ARCHIVE_BYTES or not sha256(data).hexdigest().startswith(edition.sha256):
            raise ValueError("Unreadable or unverified schedule edition")
        self._cache[edition.sha256] = read_edition(data, self.manifest)
        return self._cache[edition.sha256]

    def _load(self, today: date) -> dict[date, tuple[TripSpan, ...] | None]:
        editions = discover_editions(self.raw, self.prefix, self.manifest)
        by_date = sorted(editions, reverse=True)
        days = {}
        selections = {}
        for offset in (0, -1, -2, 1):
            day = today + timedelta(days=offset)
            effective = next((candidate for candidate in by_date if candidate <= day), None)
            if effective is not None:
                selections[day] = editions[effective][0]
        used = {edition.sha256 for edition in selections.values()}
        self._cache = {key: value for key, value in self._cache.items() if key in used}
        unreadable = set()
        for day, edition in selections.items():
            if edition.sha256 in unreadable:
                continue
            try:
                days[day] = self._read(edition).on(day)
            except SCHEDULE_ERRORS as error:
                unreadable.add(edition.sha256)
                LOGGER.warning("Live trip schedule edition unavailable (%s)", type(error).__name__)
        return days

    def at(self, now: datetime, *, wait: bool = False) -> dict[date, tuple[TripSpan, ...]] | None:
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
                LOGGER.warning("Live trip schedule unavailable (%s)", type(error).__name__)
            finally:
                self._pending = None

        if self._days.get(today) is None:
            return None
        result = {}
        for offset in (-2, -1, 0, 1):
            day = today + timedelta(days=offset)
            age = (now - service_day_start(day, self.zone)).total_seconds()
            if 0 <= age < MAX_SERVICE_SECONDS:
                if (trips := self._days.get(day)) is None:
                    return None
                result[day] = trips
        return result
