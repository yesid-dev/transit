"""ScheduleContext over one caller-identified GTFS archive, without storage reads."""

import csv
import zlib
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
from io import BytesIO, TextIOWrapper
from pathlib import PurePosixPath, PureWindowsPath
from types import MappingProxyType
from typing import Any
from zipfile import BadZipFile, ZipFile
from zoneinfo import ZoneInfo

from transit_ops.gtfs.types import parse_gtfs_service_time
from transit_ops.lake.gtfs_names import GTFS_FILES
from transit_ops.providers.schedule import (
    InvalidScheduleEdition,
    ScheduleDay,
    ScheduledStop,
    ScheduledStopTime,
    ScheduledTrip,
    ScheduleMembersUnknown,
    context_id,
    service_day_start,
)
from transit_ops.silver.static_rows import (
    FREQUENCIES_MEMBER,
    RowRejection,
    iter_member_rows,
    required_members,
)


@dataclass(frozen=True, init=False)
class ArchiveScheduleContext:
    context_id: str
    timezone: ZoneInfo
    days: Mapping[date, ScheduleDay]
    unavailable: Mapping[date, str]
    _trips: Mapping[str, ScheduledTrip]
    _times: Mapping[str, tuple[ScheduledStopTime, ...]]
    _stops: Mapping[str, ScheduledStop]
    route_types: Mapping[str, int]

    def __init__(
        self,
        *,
        provider_id: str,
        dataset_version_id: int,
        edition_sha256: str,
        archive_bytes: bytes | None,
        service_dates: Collection[date],
        timezone: ZoneInfo,
    ) -> None:
        dates = frozenset(service_dates)
        identity = context_id(
            provider_id=provider_id,
            dataset_version_id=dataset_version_id,
            edition_sha256=edition_sha256,
            service_dates=dates,
            timezone=timezone,
        )
        rows, times, trips_columns, stops_columns = _read_archive(
            provider_id, dataset_version_id, edition_sha256, archive_bytes
        )
        trips = _trips(
            rows,
            times,
            dataset_version_id,
            wheelchair_accessible_present="wheelchair_accessible" in trips_columns,
        )
        boarding = {
            r["stop_id"]: _declared_value(
                r["wheelchair_boarding"], present="wheelchair_boarding" in stops_columns
            )
            for r in rows["stops"]
        }
        parents = {r["stop_id"]: r["parent_station"] for r in rows["stops"]}
        resolved_boarding = _inherit_wheelchair_boarding(boarding, parents)
        stops = {
            r["stop_id"]: ScheduledStop(
                r["stop_id"],
                r["stop_lat"],
                r["stop_lon"],
                resolved_boarding[r["stop_id"]],
                r["parent_station"],
            )
            for r in rows["stops"]
        }
        if len(stops) != len(rows["stops"]):
            raise InvalidScheduleEdition(dataset_version_id, "duplicate_stop_ids")
        days = _days(rows, trips, dates, edition_sha256)
        object.__setattr__(self, "context_id", identity)
        object.__setattr__(self, "timezone", timezone)
        object.__setattr__(self, "days", MappingProxyType(days))
        object.__setattr__(self, "unavailable", MappingProxyType({}))
        object.__setattr__(self, "_trips", MappingProxyType(trips))
        object.__setattr__(self, "_times", MappingProxyType(times))
        object.__setattr__(self, "_stops", MappingProxyType(stops))
        object.__setattr__(
            self,
            "route_types",
            MappingProxyType({r["route_id"]: r["route_type"] for r in rows["routes"]}),
        )

    def trip(self, service_date: date, trip_id: str) -> ScheduledTrip | None:
        return self._trips[trip_id] if trip_id in self.days[service_date].trip_ids else None

    def stop_times(self, service_date: date, trip_id: str) -> tuple[ScheduledStopTime, ...]:
        return self._times[trip_id] if trip_id in self.days[service_date].trip_ids else ()

    def stop(self, service_date: date, stop_id: str) -> ScheduledStop | None:
        self.days[service_date]
        return self._stops.get(stop_id)

    def service_day_start(self, service_date: date) -> datetime:
        self.days[service_date]
        return service_day_start(service_date, self.timezone)


def _seconds(value: str | None) -> int | None:
    return (
        None if value is None else parse_gtfs_service_time(value, field_name="time").total_seconds
    )


def _member_columns(archive: ZipFile, member_name: str) -> set[str]:
    """Column names present in a GTFS member header."""
    with archive.open(member_name, "r") as raw, TextIOWrapper(
        raw, encoding="utf-8-sig", newline=""
    ) as text:
        reader = csv.reader(text)
        try:
            header = next(reader)
        except StopIteration:
            return set()
        return {cell.strip() for cell in header}


def _declared_value(raw: int | None, *, present: bool) -> int | None:
    """GTFS 0/1/2 for a present column, None when the edition omits the column.

    Empty and any value other than 1 or 2 mean no information (0).
    """
    if not present:
        return None
    return raw if raw in (1, 2) else 0


def _inherit_wheelchair_boarding(
    boarding: Mapping[str, int | None], parents: Mapping[str, str | None]
) -> dict[str, int | None]:
    """Resolve 0 (no information) through each stop's parent station, per the GTFS reference."""
    resolved: dict[str, int | None] = {}
    resolving: set[str] = set()

    def resolve(stop_id: str) -> int | None:
        if stop_id in resolved:
            return resolved[stop_id]
        value = boarding.get(stop_id)
        if value is None or value in (1, 2):
            resolved[stop_id] = value
            return value
        parent = parents.get(stop_id)
        if parent is None or parent not in boarding or stop_id in resolving:
            resolved[stop_id] = 0
            return 0
        resolving.add(stop_id)
        inherited = resolve(parent)
        resolving.discard(stop_id)
        resolved[stop_id] = inherited if inherited in (1, 2) else 0
        return resolved[stop_id]

    for stop_id in boarding:
        resolve(stop_id)
    return resolved


def _trips(
    rows: dict[str, list[dict[str, Any]]],
    times: dict[str, tuple[ScheduledStopTime, ...]],
    edition: int,
    *,
    wheelchair_accessible_present: bool,
) -> dict[str, ScheduledTrip]:
    trip_ids = [r["trip_id"] for r in rows["trips"]]
    if len(set(trip_ids)) != len(trip_ids):
        raise InvalidScheduleEdition(edition, "duplicate_trip_ids")
    frequency_ids = {r["trip_id"] for r in rows["frequencies"]}
    if frequency_ids - set(trip_ids):
        raise InvalidScheduleEdition(edition, "unknown_frequency_trip")
    trips = {}
    for r in rows["trips"]:
        stops = times.get(r["trip_id"], ())
        if not stops or stops[0].departure_s is None or stops[-1].arrival_s is None:
            raise InvalidScheduleEdition(edition, "missing_trip_endpoints")
        trips[r["trip_id"]] = ScheduledTrip(
            r["trip_id"],
            r["route_id"],
            r["direction_id"],
            r["service_id"],
            stops[0].stop_sequence,
            stops[0].departure_s,
            stops[-1].arrival_s,
            len(stops),
            r["trip_id"] in frequency_ids,
            r["block_id"],
            r["shape_id"],
            _declared_value(r["wheelchair_accessible"], present=wheelchair_accessible_present),
        )
    return trips


def _days(
    rows: dict[str, list[dict[str, Any]]],
    trips: dict[str, ScheduledTrip],
    dates: frozenset[date],
    checksum: str,
) -> dict[date, ScheduleDay]:
    days = {}
    weekdays = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    for day in dates:
        active = {
            r["service_id"]
            for r in rows["calendar"]
            if r["start_date"] <= day <= r["end_date"] and r[weekdays[day.weekday()]]
        }
        exceptions = [r for r in rows["calendar_dates"] if r["service_date"] == day]
        active -= {r["service_id"] for r in exceptions if r["exception_type"] == 2}
        active |= {r["service_id"] for r in exceptions if r["exception_type"] == 1}
        selected = [t for t in trips.values() if t.service_id in active]
        trip_ids = frozenset(t.trip_id for t in selected)
        route_ids = frozenset(t.route_id for t in selected)
        days[day] = ScheduleDay(day, checksum, None, trip_ids, route_ids)
    return days


def _read_archive(
    provider: str, edition: int, checksum: str, data: bytes | None
) -> tuple[
    dict[str, list[dict[str, Any]]],
    dict[str, tuple[ScheduledStopTime, ...]],
    set[str],
    set[str],
]:
    if data is None:
        raise ScheduleMembersUnknown("schedule_members_unknown")
    try:
        archive = ZipFile(BytesIO(data))
        names = [PurePosixPath(n).name.lower() for n in archive.namelist() if not n.endswith("/")]
    except (BadZipFile, OSError, ValueError) as exc:
        raise ScheduleMembersUnknown("schedule_members_unknown") from exc
    with archive:
        if sha256(data).hexdigest() != checksum:
            raise InvalidScheduleEdition(edition, "checksum_mismatch")
        # Refuse spellings that shared discovery could interpret differently by host.
        for info in archive.infolist():
            raw = info.orig_filename
            win = PureWindowsPath(raw)
            if "\\" in raw or win.drive or win.anchor or win.name != PurePosixPath(raw).name:
                raise InvalidScheduleEdition(edition, "invalid_member_path")
        if len(names) != len(set(names)):
            raise InvalidScheduleEdition(edition, "duplicate_member_basename")
        rows: dict[str, list[dict[str, Any]]] = {}
        times: dict[str, dict[int, ScheduledStopTime]] = {}
        members = {
            table: GTFS_FILES[f"silver.{table}"].file_name
            for table in ("routes", "trips", "stops", "stop_times", "calendar", "calendar_dates")
        }
        members["frequencies"] = FREQUENCIES_MEMBER
        try:
            required_members(archive)
            for table, member in members.items():
                assert member is not None
                records = rows.setdefault(table, [])
                for row in iter_member_rows(
                    archive, member, provider_id=provider, dataset_version_id=edition
                ):
                    if isinstance(row, RowRejection):
                        raise InvalidScheduleEdition(edition, "invalid_member_row")
                    if table != "stop_times":
                        records.append(row)
                        continue
                    # Store each parsed stop once. Real schedule ZIPs can contain
                    # millions of stop times across their service calendar.
                    trip_times = times.setdefault(row["trip_id"], {})
                    sequence = row["stop_sequence"]
                    if sequence in trip_times:
                        raise InvalidScheduleEdition(edition, "duplicate_stop_sequence")
                    trip_times[sequence] = ScheduledStopTime(
                        sequence,
                        row["stop_id"],
                        _seconds(row["arrival_time"]),
                        _seconds(row["departure_time"]),
                        row["timepoint"],
                        row["shape_dist_traveled"],
                    )
            for info in archive.infolist():
                if (
                    not info.is_dir()
                    and PurePosixPath(info.filename).name.lower() not in members.values()
                ):
                    with archive.open(info) as handle:
                        while handle.read(65536):
                            pass
        except InvalidScheduleEdition:
            raise
        except (
            ValueError,
            OSError,
            BadZipFile,
            RuntimeError,
            csv.Error,
            zlib.error,
            EOFError,
        ) as exc:
            raise InvalidScheduleEdition(edition, "invalid_member") from exc
        member_names = {
            PurePosixPath(name).name.lower(): name
            for name in archive.namelist()
            if not name.endswith("/")
        }
        trips_columns = _member_columns(archive, member_names[members["trips"]])
        stops_columns = _member_columns(archive, member_names[members["stops"]])
    ordered = {trip: tuple(stops[seq] for seq in sorted(stops)) for trip, stops in times.items()}
    return rows, ordered, trips_columns, stops_columns
