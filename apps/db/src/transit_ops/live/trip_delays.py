"""Resolve feed delays against dated scheduled calls without using coordinates."""

from collections import Counter, defaultdict
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.gtfs.types import parse_gtfs_service_time
from transit_ops.live.trip_schedule import DaySchedule, Stop
from transit_ops.providers.schedule import service_day_start

type Row = dict[str, Any]
type Identity = tuple[date, str]


def _with_scheduled_calls(
    stops: list[Row], calls: list[Stop], anchor: int, feed_delay: int | None
) -> tuple[list[Row], list[Row]]:
    by_sequence = {call[0]: call for call in calls}
    by_stop: dict[str, Stop | None] = {}
    for call in calls:
        stop_id = call[1]
        by_stop[stop_id] = None if stop_id in by_stop else call
    projected = []
    matched = []
    for stop in stops:
        seq, stop_id = stop["sequence"], stop["stop_id"]
        call = by_sequence.get(seq) if seq is not None else by_stop.get(stop_id)
        if (
            call is None
            or (stop_id is not None and stop_id != call[1])
            or stop["relationship"] in (1, 2)
        ):
            projected.append({**stop, "arrival_delay": None, "departure_delay": None})
        else:
            projected.append(updated := _delay_for_stop(stop, call, anchor, feed_delay))
            matched.append(updated)
    return projected, matched


def _delay_for_stop(stop: Row, call: Stop, anchor: int, feed_delay: int | None) -> Row:
    updated = {**stop, "stop_id": call[1], "sequence": call[0]}
    for field, scheduled in (("arrival", call[2]), ("departure", call[3])):
        delay = stop[f"{field}_delay"]
        predicted = stop[field]
        if delay is None and predicted is not None and scheduled is not None:
            delay = feed_delay if feed_delay is not None else predicted - (anchor + scheduled)
        updated[f"{field}_delay"] = delay
    return updated


def _first_prediction(stops: list[Row], now: float) -> Row | None:
    candidates = []
    for stop in stops:
        instant = stop["arrival"] if stop["arrival"] is not None else stop["departure"]
        # A vehicle can still be dwelling at a stop whose arrival just passed.
        if instant is not None and max(instant, stop["departure"] or instant) >= now:
            candidates.append((instant, stop["sequence"], stop))
    return min(candidates, key=lambda item: item[:2])[2] if candidates else None


def _vehicle_delay(vehicle: Row, report: Row, now: float) -> int | None:
    stops = report["matched"]
    sequence, stop_id = vehicle.get("stop_sequence"), vehicle.get("stop_id")
    if sequence is None and stop_id is None:
        selected = _first_prediction(stops, now)
    else:
        matches = [
            stop
            for stop in stops
            if (sequence is None or stop["sequence"] == sequence)
            and (stop_id is None or stop["stop_id"] == stop_id)
        ]
        selected = matches[0] if len(matches) == 1 else None
    if selected is None:
        return None
    arrival, departure = selected["arrival_delay"], selected["departure_delay"]
    if arrival is not None:
        return arrival
    return departure if departure is not None else report["delay"]


def reconcile_delays(
    vehicles: list[Row] | None,
    updates: list[Row] | None,
    days: Mapping[date, DaySchedule],
    zone: ZoneInfo,
    now: datetime,
    *,
    update_window: int,
) -> tuple[list[Row] | None, list[Row] | None]:
    """Enrich current scheduled reports; retain unmatched positions and absolute ETAs."""
    instant = now.timestamp()
    anchors = {day: int(service_day_start(day, zone).timestamp()) for day in days}
    day_codes = {day: day.strftime("%Y%m%d") for day in days}

    def identity(row: Row) -> Identity | None:
        trip = row.get("trip_id")
        if not trip:
            return None
        date_hint, time_hint = row.get("start_date"), row.get("start_time")
        try:
            first = (
                parse_gtfs_service_time(time_hint, field_name="start_time").total_seconds
                if time_hint
                else None
            )
        except ValueError:
            return None
        matches = []
        for day, schedule in days.items():
            span = schedule.trips.get(trip)
            if span is None or (date_hint and date_hint != day_codes[day]):
                continue
            direction = row.get("direction_id")
            if (
                direction is not None
                and span.direction_id is not None
                and direction != span.direction_id
            ):
                continue
            if first is not None and first != span.first:
                continue
            elapsed = instant - anchors[day]
            # A dated prediction can describe an upcoming trip. Unhinted IDs
            # must identify a single trip near its scheduled running interval.
            if date_hint or span.first - 3600 <= elapsed < span.last + 3600:
                matches.append((day, trip))
        return matches[0] if len(matches) == 1 else None

    def current(row: Row) -> bool:
        observed = row.get("observed_at")
        return (
            bool(update_window)
            and row["relationship"] == 0
            and (observed is None or -5 <= instant - observed < update_window)
        )

    identities = [identity(row) if current(row) else None for row in updates or []]
    occurrences = Counter(key for key in identities if key is not None)
    requested = defaultdict(set)
    for (day, trip), count in occurrences.items():
        if count == 1:
            requested[day].add(trip)
    calls = {day: days[day].stops(trips) for day, trips in requested.items()}
    matched: dict[Identity, Row] = {}
    projected = []
    for row, key in zip(updates or [], identities, strict=True):
        usable = []
        raw_stops = row.get("stops", [])
        # Reject duplicate updates for the same dated trip, not the whole feed.
        if key is not None and occurrences[key] == 1:
            day, trip = key
            stops, usable = _with_scheduled_calls(
                raw_stops, calls[day][trip], anchors[day], row["delay"]
            )
        else:
            stops = [{**stop, "arrival_delay": None, "departure_delay": None} for stop in raw_stops]
        selected = _first_prediction(usable, instant)
        delay = None
        if selected is not None:
            delay = row["delay"]
            if delay is None:
                delay = selected["arrival_delay"]
                if delay is None:
                    delay = selected["departure_delay"]
        if key is not None and usable:
            matched[key] = {"matched": usable, "delay": row["delay"]}
        projected.append(
            {
                **{field: value for field, value in row.items() if field != "observed_at"},
                "stops": stops,
                "delay": delay,
            }
        )

    positions = []
    for vehicle in vehicles or []:
        key = identity(vehicle)
        report = matched.get(key) if key is not None else None
        delay = _vehicle_delay(vehicle, report, instant) if report is not None else None
        positions.append({**vehicle, "delay": delay})
    return None if vehicles is None else positions, None if updates is None else projected
