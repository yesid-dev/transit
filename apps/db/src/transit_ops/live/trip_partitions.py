"""Pack route-scoped trip reports so publication takes one data PUT per city."""

import json
from collections import defaultdict
from dataclasses import dataclass

type Row = dict[str, object]
type Range = tuple[int, int]


@dataclass(frozen=True)
class TripPartitions:
    body: bytes
    ranges: dict[str, Range]


def encode(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def trip_partitions(rows: list[Row], vehicles: list[Row] | None) -> TripPartitions:
    groups: dict[str, list[Row]] = defaultdict(list)
    by_trip: dict[str, list[Range]] = defaultdict(list)
    by_stop: dict[str, list[list[object]]] = defaultdict(list)
    vehicle_routes: dict[str, set[str]] = defaultdict(set)
    for vehicle in vehicles or []:
        trip, route = vehicle.get("trip_id"), vehicle.get("route_id")
        if isinstance(trip, str) and isinstance(route, str):
            vehicle_routes[trip].add(route)

    for row in rows:
        trip_id = str(row["trip_id"])
        route = row.get("route_id")
        candidates = vehicle_routes.get(trip_id)
        if route is None and candidates and len(candidates) == 1:
            route = next(iter(candidates))
            row = {**row, "route_id": route}
        # A reported trip with no known route remains available by trip or stop.
        group = f"line:{route}" if isinstance(route, str) else "unassigned"
        groups[group].append(row)
        stops = row.get("stops")
        if isinstance(stops, list):
            for stop in stops:
                if isinstance(stop_id := stop.get("stop_id"), str):
                    # Stop scopes include only their own stop updates. The ID is implied
                    # by the range key and restored at the proxy boundary.
                    by_stop[stop_id].append(
                        [
                            trip_id,
                            route,
                            row["direction_id"],
                            row["start_date"],
                            row["start_time"],
                            row["relationship"],
                            row["delay"],
                            stop["sequence"],
                            stop["arrival"],
                            stop["departure"],
                            stop["arrival_delay"],
                            stop["departure_delay"],
                            stop["relationship"],
                            stop.get("scheduled_arrival"),
                            stop.get("scheduled_departure"),
                            row.get("trip_headsign"),
                        ]
                    )

    payload = bytearray()
    ranges: dict[str, Range] = {}
    for key, updates in sorted(groups.items()):
        offset = len(payload)
        payload.extend(b"[")
        for i, row in enumerate(updates):
            if i:
                payload.extend(b",")
            document = encode(row)
            by_trip[str(row["trip_id"])].append((len(payload), len(document)))
            payload.extend(document)
        payload.extend(b"]")
        if key.startswith("line:"):
            ranges[key] = (offset, len(payload) - offset)

    for trip, parts in sorted(by_trip.items()):
        key = f"trip:{trip}"
        if len(parts) == 1:
            ranges[key] = parts[0]
        else:
            offset = len(payload)
            payload.extend(b"[")
            payload.extend(b",".join(payload[start : start + size] for start, size in parts))
            payload.extend(b"]")
            ranges[key] = (offset, len(payload) - offset)

    for stop, calls in sorted(by_stop.items()):
        document = encode(calls)
        ranges[f"stop:{stop}"] = (len(payload), len(document))
        payload.extend(document)
    return TripPartitions(bytes(payload), ranges)
