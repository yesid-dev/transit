"""Resolve feed delays against dated scheduled calls without using coordinates."""

from collections import Counter, defaultdict
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.gold.vehicle_instance_rule import SANITY_DELAY_SECONDS
from transit_ops.live.trip_instances import REMOVED_TRIPS, LiveTripInstances
from transit_ops.live.trip_schedule import DaySchedule, Stop

type Row = dict[str, Any]
type Identity = tuple[date, str]


def _with_scheduled_calls(
    stops: list[Row], calls: list[Stop], anchor: int, feed_delay: int | None, expiry: float | None
) -> tuple[list[Row], list[Row]]:
    """Keep timetable calls for skipped and no-data stops while suppressing their delay."""
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
        if call is None or (stop_id is not None and stop_id != call[1]):
            projected.append(_without_scheduled_call(stop))
            continue

        arrival, departure = call[2:]
        updated = {
            **stop,
            "stop_id": call[1],
            "sequence": call[0],
            "scheduled_arrival": None if arrival is None else anchor + arrival,
            "scheduled_departure": None if departure is None else anchor + departure,
        }
        if expiry is None or stop["relationship"] in (1, 2):
            updated.update(arrival_delay=None, departure_delay=None)
        else:
            _set_stop_delays(updated, feed_delay, expiry)
            matched.append(updated)
        projected.append(updated)
    return projected, matched


def _without_scheduled_call(stop: Row) -> Row:
    return {
        **stop,
        "arrival_delay": None,
        "departure_delay": None,
        "scheduled_arrival": None,
        "scheduled_departure": None,
    }


def _set_stop_delays(stop: Row, feed_delay: int | None, expiry: float) -> None:
    if _expired(stop, expiry):
        stop.update(arrival_delay=None, departure_delay=None)
        return
    for field in ("arrival", "departure"):
        delay = stop[f"{field}_delay"]
        predicted = stop[field]
        scheduled = stop[f"scheduled_{field}"]
        if delay is None and predicted is not None and scheduled is not None:
            delay = feed_delay if feed_delay is not None else predicted - scheduled
        stop[f"{field}_delay"] = _bounded_delay(delay)


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


def _bounded_delay(delay: int | None) -> int | None:
    return delay if delay is not None and abs(delay) <= SANITY_DELAY_SECONDS else None


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
    instances: LiveTripInstances | None = None,
    positions_captured: datetime | None = None,
) -> tuple[list[Row] | None, list[Row] | None]:
    """Attach dated timetable evidence and use fresh scheduled updates for delays."""
    instant = now.timestamp()
    expiry = instant - update_window
    instances = instances or LiveTripInstances(
        {day: item.trips for day, item in days.items()}, zone
    )
    anchors = {day: int(anchor.timestamp()) for day, anchor in instances.anchors.items()}

    identities = []
    for row in updates or []:
        instance = (
            instances.resolve(row, now, update=True)[0]
            if row["relationship"] == 0 or row["relationship"] in REMOVED_TRIPS
            else None
        )
        identities.append((instance.service_date, instance.trip_id) if instance else None)
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
        headsign = None
        # Reject duplicate updates for the same dated trip, not the whole feed.
        if key is not None and occurrences[key] == 1:
            day, trip = key
            headsign = days[day].trips[trip].headsign
            delay_is_eligible = update_window and row["relationship"] == 0
            stops, usable = _with_scheduled_calls(
                raw_stops,
                calls[day][trip],
                anchors[day],
                row.get("delay"),
                expiry if delay_is_eligible else None,
            )
            if delay_is_eligible:
                matched[key] = {
                    "matched": usable,
                    "delay": _bounded_delay(row["delay"]),
                    "skipped": [
                        stop["sequence"] for stop in raw_stops if stop["relationship"] == 1
                    ],
                }
        else:
            stops = [_without_scheduled_call(stop) for stop in raw_stops]
        selected = _first_prediction(usable, instant)
        delay = None
        if selected is not None:
            delay = _bounded_delay(row["delay"])
            if delay is None:
                delay = selected["arrival_delay"]
                if delay is None:
                    delay = selected["departure_delay"]
        projected.append(
            {
                **{
                    field: value
                    for field, value in row.items()
                    if field not in {"observed_at", "_published_at"}
                },
                "stops": stops,
                "delay": delay,
                "trip_headsign": headsign,
            }
        )

    positions = []
    for vehicle in vehicles or []:
        instance, ambiguous = instances.resolve(vehicle, positions_captured or now)
        key = (instance.service_date, instance.trip_id) if instance else None
        delay = None
        if ambiguous or (update_window and key is not None and occurrences[key] > 1):
            reason = "ambiguous"
        elif key is None:
            reason = "no_schedule"
        elif (report := matched.get(key)) is None:
            reason = "no_update"
        else:
            day, trip = key
            delay, reason = _vehicle_delay(vehicle, report, calls[day][trip], instant, expiry)
        if coverage is not None and vehicle.get("trip_id"):
            coverage[reason] += 1
        positions.append({**vehicle, "delay": delay})
    return None if vehicles is None else positions, None if updates is None else projected
