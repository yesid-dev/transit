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
    stops: list[Row], calls: list[Stop], anchor: int, feed_delay: int | None, expiry: float
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
            updated = _delay_for_stop(stop, call, anchor, feed_delay, expiry)
            projected.append(updated)
            matched.append(updated)
    return projected, matched


def _delay_for_stop(
    stop: Row, call: Stop, anchor: int, feed_delay: int | None, expiry: float
) -> Row:
    updated = {**stop, "stop_id": call[1], "sequence": call[0]}
    if _expired(stop, expiry):
        return {**updated, "arrival_delay": None, "departure_delay": None}
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
        if instant is not None and _upcoming(stop, now):
            candidates.append((instant, stop["sequence"], stop))
    return min(candidates, key=lambda item: item[:2])[2] if candidates else None


def _upcoming(stop: Row, now: float) -> bool:
    # A vehicle can still be dwelling at a stop whose arrival just passed.
    stamp = last_prediction_time(stop)
    return stamp is not None and stamp >= now


def last_prediction_time(stop: Row) -> int | None:
    arrival, departure = stop["arrival"], stop["departure"]
    if arrival is None:
        return departure
    return arrival if departure is None else max(arrival, departure)


def _expired(stop: Row, expiry: float) -> bool:
    stamp = last_prediction_time(stop)
    return stamp is not None and stamp < expiry


def _stop_delay(stop: Row, feed_delay: int | None) -> int | None:
    for delay in (stop["arrival_delay"], stop["departure_delay"], feed_delay):
        if delay is not None:
            return delay
    return None


def _vehicle_delay(
    vehicle: Row, report: Row, calls: list[Stop], now: float, expiry: float
) -> tuple[int | None, str]:
    stops, feed_delay = report["matched"], report["delay"]
    sequence, stop_id = vehicle.get("stop_sequence"), vehicle.get("stop_id")
    if sequence is None and stop_id is None:
        selected = _first_prediction(stops, now)
        delay = None if selected is None else _stop_delay(selected, feed_delay)
    else:
        reported = [
            call
            for call in calls
            if (sequence is None or call[0] == sequence) and (stop_id is None or call[1] == stop_id)
        ]
        if len(reported) != 1:
            return None, "ambiguous" if reported else "no_schedule"
        sequence = reported[0][0]
        exact = [stop for stop in stops if stop["sequence"] == sequence]
        if len(exact) > 1:
            return None, "ambiguous"
        if (
            exact
            and not _expired(exact[0], expiry)
            and (delay := _stop_delay(exact[0], feed_delay)) is not None
        ):
            return delay, "delay"
        following = [
            (stop["sequence"], delay)
            for stop in stops
            if stop["sequence"] > sequence
            and _upcoming(stop, now)
            and (delay := _stop_delay(stop, feed_delay)) is not None
        ]
        first = min((seq for seq, _ in following), default=None)
        next_values = [value for seq, value in following if seq == first]
        if len(next_values) > 1:
            return None, "ambiguous"
        delay = next_values[0] if next_values else None
    if delay is not None:
        return delay, "delay"
    if any(
        (sequence is None or stop["sequence"] >= sequence) and _expired(stop, expiry)
        for stop in stops
    ):
        return None, "expired"
    skipped = any(
        sequence is None or stop is None or stop >= sequence for stop in report["skipped"]
    )
    return None, "skipped" if skipped else "no_usable_prediction"


def reconcile_delays(
    vehicles: list[Row] | None,
    updates: list[Row] | None,
    days: Mapping[date, DaySchedule],
    zone: ZoneInfo,
    now: datetime,
    *,
    update_window: int,
    coverage: Counter[str] | None = None,
) -> tuple[list[Row] | None, list[Row] | None]:
    """Enrich current scheduled reports; retain unmatched positions and absolute ETAs."""
    instant = now.timestamp()
    expiry = instant - update_window
    anchors = {day: int(service_day_start(day, zone).timestamp()) for day in days}
    day_codes = {day: day.strftime("%Y%m%d") for day in days}

    def candidates(row: Row) -> list[Identity]:
        trip = row.get("trip_id")
        if not trip:
            return []
        date_hint, time_hint = row.get("start_date"), row.get("start_time")
        try:
            first = (
                parse_gtfs_service_time(time_hint, field_name="start_time").total_seconds
                if time_hint
                else None
            )
        except ValueError:
            return []
        matches = []
        for day, schedule in days.items():
            span = schedule.trips.get(trip)
            if span is None or (date_hint and date_hint != day_codes[day]):
                continue
            if first is not None and first != span.first:
                continue
            elapsed = instant - anchors[day]
            # A dated prediction can describe an upcoming trip. Unhinted IDs
            # must identify a single trip near its scheduled running interval.
            if date_hint or span.first - 3600 <= elapsed < span.last + 3600:
                matches.append((day, trip))
        return matches

    identities = []
    for row in updates or []:
        matches = candidates(row) if update_window and row["relationship"] == 0 else []
        identities.append(matches[0] if len(matches) == 1 else None)
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
                raw_stops, calls[day][trip], anchors[day], row["delay"], expiry
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
        if key is not None and occurrences[key] == 1:
            matched[key] = {
                "matched": usable,
                "delay": row["delay"],
                "skipped": [stop["sequence"] for stop in raw_stops if stop["relationship"] == 1],
            }
        projected.append(
            {
                **{field: value for field, value in row.items() if field != "observed_at"},
                "stops": stops,
                "delay": delay,
            }
        )

    positions = []
    for vehicle in vehicles or []:
        matches = candidates(vehicle)
        delay = None
        if not matches:
            reason = "no_schedule"
        elif len(matches) > 1 or occurrences[matches[0]] > 1:
            reason = "ambiguous"
        elif (report := matched.get(matches[0])) is None:
            reason = "no_update"
        else:
            day, trip = matches[0]
            delay, reason = _vehicle_delay(vehicle, report, calls[day][trip], instant, expiry)
        if coverage is not None and vehicle.get("trip_id"):
            coverage[reason] += 1
        positions.append({**vehicle, "delay": delay})
    return None if vehicles is None else positions, None if updates is None else projected
