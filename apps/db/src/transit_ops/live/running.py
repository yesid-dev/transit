"""Detached serving inputs. No activation, connections, settings or implicit clock.

The cached edition is scalar; running schedules require an explicitly complete
all-current inventory from the caller's snapshot. Gold dimensions remain provider
scoped, independent of schedule version. Capture evidence never certifies serving
freshness: the caller retains ownership of publication/serving timestamps.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol
from zoneinfo import ZoneInfo

from transit_ops.live.captures import Frame, ParsedCapture
from transit_ops.live.edition import EDITION_TABLES, EditionId, loaded_edition
from transit_ops.live.local_file import LocalFile

Row = dict[str, Any]


class TripHolder(Protocol):
    def latest(self) -> ParsedCapture | None: ...


@dataclass(frozen=True)
class Schedule:
    edition: EditionId
    frames: Mapping[str, Frame]


@dataclass(frozen=True)
class ScheduleInputs:
    selected: Schedule
    current_ids: frozenset[int]
    current: tuple[Schedule, ...]
    # Already-resolved provider policy, including automatic promotion in 0096.
    excluded_routes: frozenset[str] = frozenset()


@dataclass(frozen=True)
class FeedPolicy:
    enabled: bool
    freshness_seconds: int  # Resolved by the existing policy owner, not redefined here.


@dataclass(frozen=True)
class Evidence:
    state: str
    capture_id: int | None = None
    captured_at: datetime | None = None
    age_seconds: Decimal | None = None
    observed_count: int | None = None


@dataclass(frozen=True)
class Projection:
    running: tuple[tuple[str, str], ...]
    vehicles: tuple[Row, ...]
    delays: tuple[Row, ...]
    departures: tuple[Row, ...]
    trip_evidence: Evidence
    vehicle_evidence: Evidence


def _aware(value: datetime) -> datetime:
    if value.utcoffset() is None:
        raise ValueError("cycle and evidence timestamps must be aware")
    return value.astimezone(UTC)


def service_anchor(day: date, timezone: str) -> datetime:
    """GTFS elapsed-time origin, including transition days."""
    return datetime.combine(day, time(12), ZoneInfo(timezone)).astimezone(UTC) - timedelta(hours=12)


def _seconds(value: str) -> int:
    hours, minutes, seconds = map(int, value.split(":"))
    if hours < 0 or not 0 <= minutes < 60 or not 0 <= seconds < 60:
        raise ValueError("invalid service time")
    return hours * 3600 + minutes * 60 + seconds


def _rows(frame: Frame) -> list[Row]:
    return [dict(zip(frame.columns, row, strict=True)) for row in frame.rows]


def cached_schedule(local: LocalFile) -> Schedule:
    """Copy the scalar cache without changing/reopening the borrowed handle."""
    edition = loaded_edition(local.connection)
    if edition is None:
        raise ValueError("selected edition missing")
    frames = {}
    for name, columns in EDITION_TABLES.items():
        names = tuple(n for n, _ in columns)
        rows = local.connection.execute(f"SELECT {', '.join(names)} FROM {name}").fetchall()
        frames[name] = Frame(name, names, tuple(rows))
    return Schedule(edition, frames)


def _validate(inputs: ScheduleInputs, provider: str) -> None:
    editions = (inputs.selected, *inputs.current)
    if any(s.edition.provider_id != provider for s in editions):
        raise ValueError("schedule provider differs")
    ids = [s.edition.dataset_version_id for s in inputs.current]
    if len(set(ids)) != len(ids) or set(ids) != inputs.current_ids:
        raise ValueError("incomplete all-current schedule inventory")
    if inputs.selected.edition.dataset_version_id not in inputs.current_ids:
        raise ValueError("selected edition is not current")
    selected = next(s for s in inputs.current if s.edition == inputs.selected.edition)
    if selected.frames != inputs.selected.frames:
        raise ValueError("selected edition content differs")


def _active(schedule: Schedule, service: str, day: date) -> bool:
    exceptions = _rows(schedule.frames["edition_calendar_dates"])
    for row in exceptions:
        if (row["service_id"], row["service_date"]) == (service, day):
            return bool(row["exception_type"] == 1)
    weekday = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    return any(
        r["service_id"] == service
        and r["start_date"] <= day <= r["end_date"]
        and r[weekday[day.weekday()]]
        for r in _rows(schedule.frames["edition_calendar"])
    )


def running_trips(
    inputs: ScheduleInputs, *, provider_id: str, timezone: str, cycle: datetime
) -> tuple[tuple[str, str], ...]:
    cycle = _aware(cycle)
    _validate(inputs, provider_id)
    routes = {r["route_id"] for r in _rows(inputs.selected.frames["edition_routes"])}
    result = set()
    for schedule in inputs.current:
        for span in _rows(schedule.frames["edition_trip_service_span"]):
            if span["route_id"] not in routes or span["route_id"] in inputs.excluded_routes:
                continue
            first, last = span["first_seconds"], span["last_seconds"]
            if type(first) is not int or type(last) is not int or not 0 <= first <= last:
                raise ValueError("invalid integer service span")
            start = (cycle - timedelta(seconds=last)).astimezone(ZoneInfo(timezone)).date()
            end = (cycle - timedelta(seconds=first)).astimezone(ZoneInfo(timezone)).date()
            for offset in range(-1, (end - start).days + 2):
                day = start + timedelta(days=offset)
                elapsed = cycle - service_anchor(day, timezone)
                if timedelta(seconds=first) <= elapsed <= timedelta(seconds=last):
                    if _active(schedule, span["service_id"], day):
                        result.add((span["route_id"], span["trip_id"]))
    return tuple(sorted(result))


def _evidence(
    policy: FeedPolicy, cycle: datetime, identity: tuple[int, datetime, int] | None
) -> Evidence:
    if type(policy.freshness_seconds) is not int or policy.freshness_seconds < 0:
        raise ValueError("invalid freshness budget")
    if not policy.enabled:
        return Evidence("unsupported")
    if identity is None:
        return Evidence("missing")
    capture_id, captured, count = identity
    delta = cycle - _aware(captured)
    age = Decimal(delta.days * 86400 + delta.seconds) + Decimal(delta.microseconds) / 1000000
    if age < 0:
        raise ValueError("capture is after cycle")
    state = (
        "stale" if age > policy.freshness_seconds else "observed-empty" if count == 0 else "fresh"
    )
    return Evidence(state, capture_id, captured, age, count)


def _trip_rows(parsed: ParsedCapture | None, provider: str) -> tuple[list[Row], list[Row]]:
    if parsed is None:
        return [], []
    if parsed.capture.provider_id != provider or parsed.capture.endpoint_key != "trip_updates":
        raise ValueError("trip capture identity differs")
    return _rows(parsed.frames["rt_trip_updates"]), _rows(
        parsed.frames["rt_trip_update_stop_times"]
    )


def _match(schedule: list[Row], trip: Row, stop: Row) -> Row | None:
    matches = [
        r
        for r in schedule
        if r["trip_id"] == trip["trip_id"]
        and (
            r["stop_sequence"] == stop["stop_sequence"]
            if stop["stop_sequence"] is not None
            else stop["stop_id"] is not None and r["stop_id"] == stop["stop_id"]
        )
    ]
    if len(matches) != 1:
        return None
    row = matches[0]
    if stop["stop_id"] is not None and stop["stop_id"] != row["stop_id"]:
        return None
    return row


def _stop_key(stop: Row) -> tuple[Any, ...]:
    return (
        stop["stop_sequence"] is None,
        stop["stop_sequence"] or 0,
        stop["stop_time_update_index"],
        stop["entity_index"],
    )


def _delay(trip: Row, stops: list[Row], schedule: list[Row], timezone: str) -> int | None:
    if trip["start_date"] is None or trip["schedule_relationship"] == 3:
        return None
    candidates = []
    for stop in stops:
        match = _match(schedule, trip, stop)
        if stop["schedule_relationship"] in (1, 2) or match is None:
            continue
        for kind in ("arrival", "departure"):
            stamp, service_time = stop[f"{kind}_time_utc"], match[f"{kind}_time"]
            if stamp is None or service_time is None:
                continue
            expected = service_anchor(trip["start_date"], timezone)
            delta = _aware(stamp) - expected - timedelta(seconds=_seconds(service_time))
            seconds = delta.days * 86400 + delta.seconds
            if delta.microseconds or not -(2**31) <= seconds < 2**31:
                raise ValueError("delay is fractional or outside INTEGER")
            distance = _aware(stamp) - _aware(trip["feed_timestamp_utc"])
            candidates.append(((distance < timedelta(), abs(distance), *_stop_key(stop)), seconds))
            break  # Like-for-like arrival preferred, never mix arrival and departure.
    return min(candidates)[1] if candidates else None


def _departures(
    trip: Row, children: list[Row], schedule: list[Row], provider: str, cycle: datetime
) -> list[Row]:
    departures: list[Row] = []
    if trip["schedule_relationship"] == 3:
        return []
    for stop in children:
        if stop["schedule_relationship"] in (1, 2):
            continue
        stamp = stop["departure_time_utc"] or stop["arrival_time_utc"]
        match = _match(schedule, trip, stop)
        # An explicit ID remains useful for added trips; ambiguous ID-less stops do not.
        stop_id = stop["stop_id"] or (match["stop_id"] if match else None)
        if stamp is not None and _aware(stamp) >= cycle and stop_id is not None:
            departures.append(
                dict(
                    provider_id=provider,
                    trip_id=trip["trip_id"],
                    route_id=trip["route_id"],
                    stop_id=stop_id,
                    stop_sequence=stop["stop_sequence"],
                    predicted_departure_utc=_aware(stamp),
                    entity_index=trip["entity_index"],
                    stop_time_update_index=stop["stop_time_update_index"],
                )
            )
    return departures


def _movement(
    parsed: ParsedCapture | None,
    inputs: ScheduleInputs,
    provider: str,
    timezone: str,
    cycle: datetime,
) -> tuple[list[Row], list[Row]]:
    trips, stops = _trip_rows(parsed, provider)
    schedule = _rows(inputs.selected.frames["edition_stop_times"])
    delays, departures = [], []
    groups: dict[tuple[Any, ...], list[tuple[int, int]]] = {}
    for trip in trips:
        children = [s for s in stops if s["entity_index"] == trip["entity_index"]]
        delay = _delay(trip, children, schedule, timezone)
        day = cycle.astimezone(ZoneInfo(timezone)).date()
        if (
            delay is not None
            and abs(delay) <= 3600
            and trip["start_date"] >= day - timedelta(days=1)
        ):
            key = (trip["trip_id"], trip["route_id"], trip["direction_id"])
            groups.setdefault(key, []).append((delay, len(children)))
        departures.extend(_departures(trip, children, schedule, provider, cycle))
    for key, values in groups.items():
        average = (Decimal(sum(v[0] for v in values)) / len(values)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        delays.append(
            dict(
                provider_id=provider,
                trip_id=key[0],
                route_id=key[1],
                direction_id=key[2],
                avg_delay_seconds=average,
                max_delay_seconds=max(v[0] for v in values),
                stop_time_observation_count=sum(v[1] for v in values),
            )
        )
    return delays, departures


def _vehicles(
    local: LocalFile, provider: str
) -> tuple[list[Row], tuple[int, datetime, int] | None]:
    conn = local.connection
    tables = {r[0] for r in conn.execute("SHOW TABLES").fetchall()}
    if "fact_processing" not in tables:
        return [], None
    receipt = conn.execute(
        "SELECT capture_row_id, captured_at_utc, row_count FROM fact_processing "
        "WHERE provider_id=? AND endpoint_key='vehicle_positions' "
        "ORDER BY captured_at_utc DESC, capture_row_id DESC LIMIT 1",
        [provider],
    ).fetchone()
    if receipt is None:
        return [], None
    cursor = conn.execute(
        "SELECT * FROM fact_vehicle_snapshot WHERE provider_id=? AND realtime_snapshot_id=?",
        [provider, receipt[0]],
    )
    names = tuple(c[0] for c in cursor.description)
    rows = _rows(Frame("vehicles", names, tuple(cursor.fetchall())))
    if len(rows) != receipt[2]:
        raise ValueError("vehicle receipt row count differs")
    for row in rows:
        for key, value in row.items():
            if isinstance(value, datetime):
                row[key] = value.replace(tzinfo=UTC)
    return rows, (receipt[0], receipt[1].replace(tzinfo=UTC), receipt[2])


def _vehicle_stops(vehicles: list[Row], departures: list[Row], inputs: ScheduleInputs) -> list[Row]:
    dimensions = {r["stop_id"]: r for r in _rows(inputs.selected.frames["edition_stops"])}
    result = []
    for vehicle in vehicles:
        lat, lon = vehicle["latitude"], vehicle["longitude"]
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        row = dict(vehicle)
        upcoming = [
            d
            for d in departures
            if d["trip_id"] == row["trip_id"]
            and row["trip_id"] is not None
            and d["predicted_departure_utc"] >= row["captured_at_utc"]
        ]
        stop = row["stop_id"] or (min(upcoming, key=_stop_key)["stop_id"] if upcoming else None)
        dimension = dimensions.get(stop, {})
        row.update(
            next_stop=stop,
            next_stop_lat=dimension.get("stop_lat"),
            next_stop_lon=dimension.get("stop_lon"),
        )
        result.append(row)
    return result


def _attach_delays(vehicles: list[Row], delays: list[Row]) -> None:
    for row in vehicles:
        matches = [
            d
            for d in delays
            if row["trip_id"] is not None
            and d["trip_id"] == row["trip_id"]
            and d["route_id"] == row["route_id"]
        ]
        # Ambiguous directions cannot certify a vehicle's delay.
        match = matches[0] if len(matches) == 1 else {}
        row["trip_avg_delay_seconds"] = match.get("avg_delay_seconds")
        row["trip_max_delay_seconds"] = match.get("max_delay_seconds")


def _rank_departures(departures: list[Row]) -> None:
    departures.sort(
        key=lambda r: (
            r["stop_id"],
            r["predicted_departure_utc"],
            r["route_id"] or "",
            r["trip_id"] or "",
            *_stop_key(r),
        )
    )
    ranks: dict[str, int] = {}
    for row in departures:
        ranks[row["stop_id"]] = ranks.get(row["stop_id"], 0) + 1
        row["departure_rank"] = ranks[row["stop_id"]]


def project_running(
    local: LocalFile,
    holder: TripHolder,
    inputs: ScheduleInputs,
    *,
    provider_id: str,
    timezone: str,
    cycle: datetime,
    trip_policy: FeedPolicy,
    vehicle_policy: FeedPolicy,
) -> Projection:
    """Borrow current inputs; stale rows remain evidence, never a new serving stamp.

    The caller supplies provider bbox/capability policy to later builders. No
    historical fact is selected without its successful application receipt.
    """
    cycle = _aware(cycle)
    if local.connection.execute("SELECT provider_id FROM meta").fetchall() != [(provider_id,)]:
        raise ValueError("local provider differs")
    running = running_trips(inputs, provider_id=provider_id, timezone=timezone, cycle=cycle)
    parsed = holder.latest() if trip_policy.enabled else None
    delays, departures = _movement(parsed, inputs, provider_id, timezone, cycle)
    vehicles, receipt = _vehicles(local, provider_id) if vehicle_policy.enabled else ([], None)
    trip_identity = (
        None
        if parsed is None
        else (parsed.capture.capture_row_id, parsed.capture.captured_at_utc, parsed.entity_count)
    )
    trip_evidence = _evidence(trip_policy, cycle, trip_identity)
    vehicle_evidence = _evidence(vehicle_policy, cycle, receipt)
    _rank_departures(departures)
    vehicles = _vehicle_stops(vehicles, departures, inputs)
    _attach_delays(vehicles, delays)
    vehicles.sort(
        key=lambda r: (
            r["vehicle_id"] is None,
            r["vehicle_id"] or "",
            r["realtime_snapshot_id"],
            r["entity_index"],
        )
    )
    delays.sort(key=lambda r: (r["trip_id"] or "", r["route_id"] or "", r["direction_id"] or 0))
    return Projection(
        running, tuple(vehicles), tuple(delays), tuple(departures), trip_evidence, vehicle_evidence
    )
