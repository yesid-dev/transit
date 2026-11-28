"""Cut the published street paths from the GTFS shape of each serving pattern."""

from collections.abc import Iterable, Mapping
from math import cos, radians

from transit_ops.providers.schedule import ScheduledStop

Coordinate = tuple[float, float]
Projection = tuple[int, float, Coordinate]
Pattern = tuple[str, int, tuple[str, ...], str]
CorridorPath = tuple[str, int, str, str, tuple[Coordinate, ...]]
_TWO_METRES_SQUARED = (2 / 111_195) ** 2


def _project(path: list[Coordinate], stop: ScheduledStop, start: Projection | None) -> Projection:
    assert stop.lon is not None and stop.lat is not None
    longitude_scale = cos(radians(stop.lat)) ** 2
    first, limit = (start[0], start[1]) if start else (0, 0.0)
    best = (first, limit, path[first])
    distance = float("inf")
    for index in range(first, len(path) - 1):
        x, y = path[index]
        dx, dy = path[index + 1][0] - x, path[index + 1][1] - y
        length = dx * dx * longitude_scale + dy * dy
        if not length:
            continue
        fraction = ((stop.lon - x) * dx * longitude_scale + (stop.lat - y) * dy) / length
        fraction = min(1.0, max(limit if index == first else 0.0, fraction))
        point = (x + fraction * dx, y + fraction * dy)
        error = (point[0] - stop.lon) ** 2 * longitude_scale + (point[1] - stop.lat) ** 2
        if error < distance:
            best, distance = (index, fraction, point), error
    return best


def _sections(
    pattern: tuple[str, ...], path: list[Coordinate], stops: Mapping[str, ScheduledStop]
) -> Iterable[tuple[str, str, tuple[Coordinate, ...]]]:
    last: Projection | None = None
    previous_stop: str | None = None
    for stop_id in pattern:
        stop = stops.get(stop_id)
        if not stop or stop.lon is None or stop.lat is None:
            previous_stop = None
            continue
        current = _project(path, stop, last)
        if last and previous_stop and previous_stop != stop_id:
            vertices = [last[2], *path[last[0] + 1 : current[0] + 1], current[2]]
            piece: list[Coordinate] = []
            for x, y in vertices:
                point = (round(x, 5), round(y, 5))
                if not piece or point != piece[-1]:
                    piece.append(point)
            if len(piece) >= 2:
                yield previous_stop, stop_id, tuple(piece)
        last, previous_stop = current, stop_id


def _simplify(piece: tuple[Coordinate, ...]) -> tuple[Coordinate, ...]:
    """Keep the endpoints and the bends that deviate by more than two metres."""
    longitude_scale = cos(radians(piece[0][1])) ** 2
    selected = {0, len(piece) - 1}
    ranges = [(0, len(piece) - 1)]
    while ranges:
        first, last = ranges.pop()
        x, y = piece[first]
        dx, dy = piece[last][0] - x, piece[last][1] - y
        length = dx * dx * longitude_scale + dy * dy
        largest = _TWO_METRES_SQUARED
        bend = None
        for index in range(first + 1, last):
            px, py = piece[index][0] - x, piece[index][1] - y
            projection = (px * dx * longitude_scale + py * dy) / length if length else 0
            fraction = min(1.0, max(0.0, projection))
            error = (px - fraction * dx) ** 2 * longitude_scale + (py - fraction * dy) ** 2
            if error > largest:
                largest, bend = error, index
        if bend is not None:
            selected.add(bend)
            ranges.extend(((first, bend), (bend, last)))
    return tuple(piece[index] for index in sorted(selected))


def cut_corridor_paths(
    patterns: Iterable[Pattern],
    shapes: Mapping[str, list[Coordinate]],
    stops: Mapping[str, ScheduledStop],
) -> tuple[CorridorPath, ...]:
    """One path per line, direction and pair, preferring the most served pattern."""
    paths: dict[tuple[str, int, str, str], tuple[Coordinate, ...]] = {}
    seen: set[Pattern] = set()
    for candidate in patterns:
        if candidate in seen:
            continue
        seen.add(candidate)
        route, direction, pattern, shape = candidate
        coordinates = shapes.get(shape, [])
        if len(coordinates) < 2:
            continue
        for first, last, piece in _sections(pattern, coordinates, stops):
            key = (route, direction, first, last)
            if key not in paths:
                paths[key] = _simplify(piece) if len(piece) > 2 else piece
    return tuple((*key, piece) for key, piece in sorted(paths.items()))
