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
    by_trip: dict[str, list[str]]
    by_stop: dict[str, list[str]]


def encode(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def trip_partitions(rows: list[Row], vehicles: list[Row] | None) -> TripPartitions:
    groups: dict[str, list[Row]] = defaultdict(list)
    by_trip: dict[str, set[str]] = defaultdict(set)
    by_stop: dict[str, set[str]] = defaultdict(set)
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
        group = f"line:{route}" if isinstance(route, str) else f"trip:{trip_id}"
        groups[group].append(row)
        by_trip[trip_id].add(group)
        stops = row.get("stops")
        if isinstance(stops, list):
            for stop in stops:
                if isinstance(stop_id := stop.get("stop_id"), str):
                    by_stop[stop_id].add(group)

    payload = bytearray()
    ranges = {}
    for key, updates in sorted(groups.items()):
        document = encode(updates)
        ranges[key] = (len(payload), len(document))
        payload.extend(document)
    return TripPartitions(
        bytes(payload),
        ranges,
        {trip: sorted(keys) for trip, keys in by_trip.items()},
        {stop: sorted(keys) for stop, keys in by_stop.items()},
    )
