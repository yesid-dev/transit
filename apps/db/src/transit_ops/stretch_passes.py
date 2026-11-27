"""Place each vehicle reading along its trip's shape and time every ~100 m stretch.

Cleaning version 13 (stretch passes) derives from a measured v12 clean day. Each
stop-to-stop run of a trip is cut into equal pieces of about 100 m, so the pieces
of one run add up to that run exactly. A stretch is named by its two stops and
its piece, which stays stable across shapes and schedule editions.

The readings are the clean day's vehicle intervals: a vehicle that stayed within
15 m of one place is one interval from its first reading to its last.

This module is pure: :mod:`transit_ops.stretch_day` reads the inputs and writes
the receipts.
"""

from bisect import bisect_right
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from hashlib import sha256
from math import cos, hypot, pi, radians
from typing import NamedTuple
from zoneinfo import ZoneInfo

from transit_ops.lake.table_schema import TableSchema

STRETCH_VERSION = "13"
STRETCH_METRES = 100.0
# A reading farther than this from its trip's shape is off the route (detour, bad fix).
OFF_ROUTE_METRES = 60.0
# Stopped within this distance of one of the trip's stops counts as stopped at the stop.
STOP_RADIUS_METRES = 30.0
# Less progress than this between two readings means the vehicle was stopped.
MOVED_METRES = 10.0
# Fastest plausible progress between readings, generous for express sections.
MAX_SPEED_MPS = 30.0
# GPS jitter can place a later reading a little behind an earlier one.
BACKTRACK_METRES = 30.0
# When this many readings in a row agree the vehicle is behind its last placed
# point (by at most RETRACT_METRES), that point was a fix too far ahead: take it back.
RETRACT_READINGS = 2
RETRACT_METRES = 1_000.0
# Do not time a stretch across a hole in the readings longer than this.
MAX_GAP_SECONDS = 300.0
# The daily summary counts passes timed from readings at most this far apart.
SUMMARY_MAX_GAP_SECONDS = 90
_EARTH_RADIUS_METRES = 6_371_008.8

_TIME = "timestamp with time zone"
_DAY = (
    ("provider", "text", True),
    ("service_date", "date", True),
    ("cleaning_version", "text", True),
)
STRETCHES = TableSchema.from_columns(
    (
        *_DAY,
        ("stretch_key", "bigint", True),
        ("from_stop", "text", True),
        ("to_stop", "text", True),
        ("pieces", "smallint", True),
        ("piece", "smallint", True),
        ("length_m", "double precision", True),
        ("from_lat", "double precision", True),
        ("from_lon", "double precision", True),
        ("to_lat", "double precision", True),
        ("to_lon", "double precision", True),
        ("shape_id", "text", True),
    ),
    ("provider", "service_date", "from_stop", "to_stop", "pieces", "piece"),
)
STRETCH_PASSES = TableSchema.from_columns(
    (
        *_DAY,
        ("trip_id", "text", True),
        ("route_id", "text", False),
        ("direction_id", "integer", False),
        ("vehicle_id", "text", True),
        ("from_stop", "text", True),
        ("to_stop", "text", True),
        ("from_sequence", "bigint", True),
        ("pieces", "smallint", True),
        ("piece", "smallint", True),
        ("entered_at", _TIME, True),
        ("exited_at", _TIME, True),
        ("moving_speed_kmh", "double precision", False),
        ("stopped_at_stop_seconds", "integer", True),
        ("stopped_between_stops_seconds", "integer", True),
        ("gap_seconds", "integer", True),
    ),
    ("provider", "service_date", "trip_id", "vehicle_id", "from_sequence", "piece"),
)
# One row per stretch, vehicle type, local hour, pass time and whole km/h. The
# pass time is whole seconds, as stored on the passes, so quantiles over any
# period of these counts equal the quantiles over the passes themselves.
STRETCH_SUMMARY = TableSchema.from_columns(
    (
        *_DAY,
        ("stretch_key", "bigint", True),
        ("route_type", "smallint", True),
        ("hour", "smallint", True),
        ("pass_seconds", "integer", True),
        ("speed_kmh", "smallint", True),
        ("passes", "integer", True),
        ("stopped_at_stop_seconds", "bigint", True),
        ("stopped_between_stops_seconds", "bigint", True),
    ),
    (
        "provider", "service_date", "stretch_key", "route_type", "hour",
        "pass_seconds", "speed_kmh",
    ),
)  # fmt: skip


class PassRow(NamedTuple):
    """One stretch pass, in STRETCH_PASSES column order."""

    provider: str
    service_date: date
    cleaning_version: str
    trip_id: str
    route_id: str | None
    direction_id: int | None
    vehicle_id: str
    from_stop: str
    to_stop: str
    from_sequence: int
    pieces: int
    piece: int
    entered_at: datetime
    exited_at: datetime
    moving_speed_kmh: float | None
    stopped_at_stop_seconds: int
    stopped_between_stops_seconds: int
    gap_seconds: int


def stretch_key(from_stop: str, to_stop: str, pieces: int, piece: int) -> int:
    """A stable signed 64-bit name for a stretch, the same on every day and host."""
    text = "\x1f".join((from_stop, to_stop, str(pieces), str(piece)))
    return int.from_bytes(sha256(text.encode()).digest()[:8], "big", signed=True)


class PathStop(NamedTuple):
    sequence: int
    stop_id: str
    lat: float | None
    lon: float | None


@dataclass(frozen=True)
class TripPath:
    route_id: str | None
    direction_id: int | None
    shape_id: str
    shape: Sequence[tuple[float, float]]  # (lon, lat)
    stops: Sequence[PathStop]
    route_type: int | None = None


class VehicleInterval(NamedTuple):
    """One clean vehicle interval, times in epoch seconds."""

    trip_id: str
    vehicle_id: str
    observed: float
    captured: float
    last_seen: float
    readings: int
    lat: float
    lon: float


class _Line:
    """A shape in local metres with cumulative distance along it."""

    def __init__(self, coords: Sequence[tuple[float, float]], origin: tuple[float, float]):
        lat0, lon0 = origin
        self.kx = cos(radians(lat0)) * pi / 180 * _EARTH_RADIUS_METRES
        self.ky = pi / 180 * _EARTH_RADIUS_METRES
        self.lat0, self.lon0 = lat0, lon0
        xs: list[float] = []
        ys: list[float] = []
        for lon, lat in coords:
            x, y = self.xy(lat, lon)
            if xs and x == xs[-1] and y == ys[-1]:
                continue
            xs.append(x)
            ys.append(y)
        cum = [0.0]
        for i in range(1, len(xs)):
            cum.append(cum[-1] + hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]))
        self.xs, self.ys, self.cum = xs, ys, cum
        self.length = cum[-1]

    def xy(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def latlon(self, distance: float) -> tuple[float, float]:
        i = min(max(bisect_right(self.cum, distance) - 1, 0), len(self.cum) - 2)
        span = self.cum[i + 1] - self.cum[i]
        f = 0.0 if span <= 0 else min(max((distance - self.cum[i]) / span, 0.0), 1.0)
        x = self.xs[i] + f * (self.xs[i + 1] - self.xs[i])
        y = self.ys[i] + f * (self.ys[i + 1] - self.ys[i])
        return round(y / self.ky + self.lat0, 6), round(x / self.kx + self.lon0, 6)

    def locate(self, x: float, y: float, lo: float, hi: float, near: float) -> float | None:
        """Distance of the closest point in the first run of segments within ``near``.

        Scanning forward from ``lo`` keeps a vehicle on the earliest place it can
        be, so a shape that passes the same street twice is matched in order.
        """
        xs, ys, cum = self.xs, self.ys, self.cum
        last = len(cum) - 1
        i = max(bisect_right(cum, lo) - 1, 0)
        best: tuple[float, float] | None = None
        while i < last and cum[i] <= hi:
            ax, ay = xs[i], ys[i]
            dx, dy = xs[i + 1] - ax, ys[i + 1] - ay
            span2 = dx * dx + dy * dy
            f = 0.0 if span2 == 0 else min(max(((x - ax) * dx + (y - ay) * dy) / span2, 0.0), 1.0)
            lateral = hypot(ax + f * dx - x, ay + f * dy - y)
            if lateral <= near:
                if best is None or lateral < best[1]:
                    best = (cum[i] + f * (cum[i + 1] - cum[i]), lateral)
            elif best is not None:
                break
            i += 1
        return None if best is None else best[0]


class _Vertex(NamedTuple):
    second: float
    distance: float
    hold: bool = False


@dataclass
class StretchFacts:
    intervals: int = 0
    placed: int = 0
    off_route: int = 0
    stale_timestamps: int = 0
    retracted: int = 0
    frozen_holds: int = 0
    unknown_trip: int = 0
    trips_without_shape: int = 0
    trajectories: int = 0
    trajectories_with_passes: int = 0
    passes: int = 0
    skipped_gap_pieces: int = 0
    implausible_speeds: int = 0
    stops_far_from_shape: int = 0
    summary_passes: int = 0


type Row = tuple[object, ...]


@dataclass
class StretchDay:
    provider: str
    date: date
    stretches: dict[tuple[str, str, int, int], Row] = field(default_factory=dict)
    passes: list[PassRow] = field(default_factory=list)
    route_types: dict[str, int] = field(default_factory=dict)  # by trip
    facts: StretchFacts = field(default_factory=StretchFacts)

    def stretch_rows(self) -> Iterator[Row]:
        for key in sorted(self.stretches):
            yield self.stretches[key]

    def pass_rows(self) -> list[PassRow]:
        """Passes sorted by line and direction, so a line reads few row groups."""
        return sorted(
            self.passes,
            key=lambda row: (
                row.route_id or "",
                -1 if row.direction_id is None else row.direction_id,
                row.trip_id,
                row.vehicle_id,
                row.from_sequence,
                row.piece,
            ),
        )

    def summary_rows(self, zone: ZoneInfo) -> list[Row]:
        """Count passes per stretch, vehicle type, local hour, pass time and km/h.

        Only passes timed from readings at most SUMMARY_MAX_GAP_SECONDS apart and
        with a measured speed count, so every row is one the questions would use.
        """
        cells: dict[tuple[int, int, int, int, int], list[int]] = {}
        keys: dict[tuple[str, str, int, int], int] = {}
        for row in self.passes:
            route_type = self.route_types.get(row.trip_id)
            speed = row.moving_speed_kmh
            if speed is None or route_type is None or row.gap_seconds > SUMMARY_MAX_GAP_SECONDS:
                continue
            ident = (row.from_stop, row.to_stop, row.pieces, row.piece)
            if (key := keys.get(ident)) is None:
                key = keys[ident] = stretch_key(*ident)
            cell = (
                key,
                route_type,
                row.entered_at.astimezone(zone).hour,
                int((row.exited_at - row.entered_at).total_seconds()),
                int(speed),
            )
            totals = cells.setdefault(cell, [0, 0, 0])
            totals[0] += 1
            totals[1] += row.stopped_at_stop_seconds
            totals[2] += row.stopped_between_stops_seconds
        self.facts.summary_passes = sum(totals[0] for totals in cells.values())
        return [
            (self.provider, self.date, STRETCH_VERSION, *cell, *cells[cell])
            for cell in sorted(cells)
        ]


@dataclass
class _Path:
    trip: TripPath
    line: _Line
    stops: list[tuple[PathStop, float]]  # stop and its distance along the shape


def _stop_distances(line: _Line, stops: Sequence[PathStop], facts: StretchFacts) -> list[float]:
    distances: list[float] = []
    previous = 0.0
    for stop in stops:
        found = None
        if stop.lat is not None and stop.lon is not None:
            x, y = line.xy(stop.lat, stop.lon)
            found = line.locate(x, y, previous, line.length, OFF_ROUTE_METRES)
            if found is None:
                facts.stops_far_from_shape += 1
                found = line.locate(x, y, previous, line.length, float("inf"))
        distance = previous if found is None else max(found, previous)
        distances.append(distance)
        previous = distance
    return distances


def _trajectory(
    path: _Path, readings: Sequence[VehicleInterval], facts: StretchFacts
) -> list[_Vertex]:
    line = path.line
    vertices: list[_Vertex] = []
    previous: tuple[float, float, float] | None = None  # second, x, y
    behind: list[tuple[VehicleInterval, float, float, float]] = []

    def place(reading: VehicleInterval, found: float, x: float, y: float) -> None:
        nonlocal previous
        second = reading.observed
        facts.placed += 1
        distance = found if not vertices else max(found, vertices[-1].distance)
        if (
            vertices
            and vertices[-1].hold
            and distance - vertices[-1].distance > MAX_SPEED_MPS * (second - vertices[-1].second)
        ):
            # A feed can repeat a frozen position while the vehicle moves on. A
            # hold that leaves no plausible time to cover the next distance is not
            # a stop: drop it, so the pass shows the hole as its reading gap.
            vertices.pop()
            facts.frozen_holds += 1
        vertices.append(_Vertex(second, distance))
        previous = (second, x, y)
        if reading.readings > 1:
            held_until = reading.last_seen - (reading.captured - reading.observed)
            if held_until > second:
                vertices.append(_Vertex(held_until, distance, True))

    for reading in readings:
        x, y = line.xy(reading.lat, reading.lon)
        second = reading.observed
        if vertices and second <= vertices[-1].second:
            # A hold overlapping this reading ends just before it.
            if vertices[-1].hold:
                held = vertices.pop()
                if second > vertices[-1].second + 1e-3:
                    vertices.append(_Vertex(second - 1e-3, held.distance, True))
            if second <= vertices[-1].second:
                facts.stale_timestamps += 1
                continue
        if previous is None:
            found = line.locate(x, y, 0.0, line.length, OFF_ROUTE_METRES)
        else:
            last = vertices[-1].distance
            straight = hypot(x - previous[1], y - previous[2])
            lo = max(last + straight - 2 * OFF_ROUTE_METRES, last) - BACKTRACK_METRES
            hi = last + MAX_SPEED_MPS * (second - previous[0]) + 2 * OFF_ROUTE_METRES
            found = line.locate(x, y, lo, hi, OFF_ROUTE_METRES)
        if found is not None:
            facts.off_route += len(behind)
            behind.clear()
            place(reading, found, x, y)
            continue
        back = (
            line.locate(
                x,
                y,
                max(vertices[-1].distance - RETRACT_METRES, 0.0),
                vertices[-1].distance - BACKTRACK_METRES,
                OFF_ROUTE_METRES,
            )
            if vertices
            else None
        )
        if back is None:
            facts.off_route += 1
            continue
        if behind and back < behind[-1][1] - BACKTRACK_METRES:
            # Readings behind the vehicle must still move forward among themselves.
            facts.off_route += len(behind)
            behind.clear()
        behind.append((reading, back, x, y))
        if len(behind) < RETRACT_READINGS:
            continue
        # Several readings agree the vehicle is behind the last placed point: that
        # point (and any after it) came from a fix too far ahead. Take them back.
        while vertices and vertices[-1].distance > behind[0][1]:
            vertices.pop()
            facts.retracted += 1
        for waiting, distance, wx, wy in behind:
            if not vertices or waiting.observed > vertices[-1].second:
                place(waiting, distance, wx, wy)
            else:
                facts.stale_timestamps += 1
        behind.clear()
    facts.off_route += len(behind)
    return vertices


class _Walker:
    """Reach and leave times of distances along one monotone trajectory."""

    def __init__(self, vertices: Sequence[_Vertex]):
        self.v = vertices
        self.seconds = [vertex.second for vertex in vertices]
        self.distances = [vertex.distance for vertex in vertices]

    def reach(self, distance: float) -> float | None:
        """First time the vehicle is at or beyond ``distance``."""
        d = self.distances
        if not d or d[0] > distance or d[-1] < distance:
            return None
        i = bisect_right(d, distance - 1e-9)  # first index with d >= distance
        if i == 0:
            return self.seconds[0]
        a, b = self.v[i - 1], self.v[i]
        return a.second + (distance - a.distance) / (b.distance - a.distance) * (
            b.second - a.second
        )

    def leave(self, distance: float) -> float | None:
        """Last time the vehicle is at or before ``distance``."""
        d = self.distances
        if not d or d[0] > distance or d[-1] <= distance:
            return None
        i = bisect_right(d, distance)  # first index with d > distance
        a, b = self.v[i - 1], self.v[i]
        return a.second + (distance - a.distance) / (b.distance - a.distance) * (
            b.second - a.second
        )

    def spans(self, start: float, end: float) -> Iterator[tuple[float, float, float, float]]:
        """Trajectory segments overlapping [start, end]: from, to, metres moved, position."""
        s = self.seconds
        i = max(bisect_right(s, start) - 1, 0)
        while i < len(s) - 1 and s[i] < end:
            a, b = self.v[i], self.v[i + 1]
            begin, finish = max(a.second, start), min(b.second, end)
            if finish > begin:
                yield begin, finish, b.distance - a.distance, a.distance
            i += 1

    def gap(self, start: float, end: float) -> float:
        s = self.seconds
        i = max(bisect_right(s, start) - 1, 0)
        widest = 0.0
        while i < len(s) - 1 and s[i] < end:
            widest = max(widest, s[i + 1] - s[i])
            i += 1
        return widest

    def distance_at(self, second: float) -> float:
        s = self.seconds
        i = bisect_right(s, second) - 1
        if i < 0:
            return self.distances[0]
        if i >= len(s) - 1:
            return self.distances[-1]
        a, b = self.v[i], self.v[i + 1]
        return a.distance + (second - a.second) / (b.second - a.second) * (b.distance - a.distance)


def _passes(
    day: StretchDay, trip_id: str, vehicle: str, path: _Path, vertices: Sequence[_Vertex]
) -> int:
    walker = _Walker(vertices)
    stops = path.stops
    origin, terminus = stops[0][1], stops[-1][1]
    count = 0
    for index in range(len(stops) - 1):
        (start_stop, start), (end_stop, end) = stops[index], stops[index + 1]
        if end - start < 1.0:
            continue
        pieces = max(1, round((end - start) / STRETCH_METRES))
        step = (end - start) / pieces
        for piece in range(1, pieces + 1):
            low, high = start + (piece - 1) * step, start + piece * step
            ident = (start_stop.stop_id, end_stop.stop_id, pieces, piece)
            if ident not in day.stretches:
                from_lat, from_lon = path.line.latlon(low)
                to_lat, to_lon = path.line.latlon(high)
                day.stretches[ident] = (
                    day.provider, day.date, STRETCH_VERSION, stretch_key(*ident), *ident,
                    round(step, 1), from_lat, from_lon, to_lat, to_lon, path.trip.shape_id,
                )  # fmt: skip
            # Leave line-end layovers out: time from leaving the first stop's
            # surroundings, and up to reaching the last stop's surroundings.
            entry = (
                walker.leave(min(origin + STOP_RADIUS_METRES, high))
                if index == 0 and piece == 1
                else walker.reach(low)
            )
            last_piece = index == len(stops) - 2 and piece == pieces
            exit_ = (
                walker.reach(max(terminus - STOP_RADIUS_METRES, low)) if last_piece
                else walker.reach(high)
            )  # fmt: skip
            if entry is None or exit_ is None or exit_ <= entry:
                continue
            gap = walker.gap(entry, exit_)
            if gap > MAX_GAP_SECONDS:
                day.facts.skipped_gap_pieces += 1
                continue
            at_stop = between = 0.0
            for begin, finish, moved, where in walker.spans(entry, exit_):
                if moved < MOVED_METRES:
                    if min(abs(where - start), abs(where - end)) <= STOP_RADIUS_METRES:
                        at_stop += finish - begin
                    else:
                        between += finish - begin
            covered = walker.distance_at(exit_) - walker.distance_at(entry)
            moving = exit_ - entry - at_stop - between
            speed = covered / moving if moving >= 1.0 and covered > 0 else None
            if speed is not None and speed > MAX_SPEED_MPS:
                # Faster than any vehicle here can go: the readings around it are
                # wrong. Keep its times, so runs still add up, but not its speed.
                day.facts.implausible_speeds += 1
                speed = None
            entered, exited = round(entry), round(exit_)
            at_stop_s = min(round(at_stop), exited - entered)
            between_s = min(round(between), exited - entered - at_stop_s)
            day.passes.append(
                PassRow(
                    day.provider,
                    day.date,
                    STRETCH_VERSION,
                    trip_id,
                    path.trip.route_id,
                    path.trip.direction_id,
                    vehicle,
                    start_stop.stop_id,
                    end_stop.stop_id,
                    start_stop.sequence,
                    pieces,
                    piece,
                    datetime.fromtimestamp(entered, UTC),
                    datetime.fromtimestamp(exited, UTC),
                    None if speed is None else round(speed * 3.6, 1),
                    at_stop_s,
                    between_s,
                    round(gap),
                )  # fmt: skip
            )
            count += 1
    return count


def build_stretch_day(
    provider: str,
    day: date,
    paths: Mapping[str, TripPath],
    intervals: Iterable[VehicleInterval],
) -> StretchDay:
    """Stretch passes from intervals sorted by trip, vehicle and observed time."""
    result = StretchDay(provider, day)
    result.route_types = {
        trip_id: trip.route_type for trip_id, trip in paths.items() if trip.route_type is not None
    }
    facts = result.facts
    built: dict[str, _Path | None] = {}

    def prepared(trip_id: str) -> _Path | None:
        if trip_id in built:
            return built[trip_id]
        trip = paths.get(trip_id)
        path = None
        if trip is not None and len(trip.shape) >= 2 and len(trip.stops) >= 2:
            lon0, lat0 = trip.shape[0]
            line = _Line(trip.shape, (lat0, lon0))
            if line.length > 0:
                stops = list(trip.stops)
                distances = _stop_distances(line, stops, facts)
                path = _Path(trip, line, list(zip(stops, distances, strict=True)))
        elif trip is not None:
            facts.trips_without_shape += 1
        built[trip_id] = path
        return path

    group: list[VehicleInterval] = []

    def flush() -> None:
        if not group:
            return
        trip_id, vehicle = group[0].trip_id, group[0].vehicle_id
        if trip_id not in paths:
            facts.unknown_trip += len(group)
        elif (path := prepared(trip_id)) is not None:
            facts.trajectories += 1
            vertices = _trajectory(path, group, facts)
            if len(vertices) >= 2:
                made = _passes(result, trip_id, vehicle, path, vertices)
                facts.passes += made
                facts.trajectories_with_passes += made > 0
        group.clear()

    for interval in intervals:
        facts.intervals += 1
        if group and (interval.trip_id, interval.vehicle_id) != (
            group[0].trip_id,
            group[0].vehicle_id,
        ):
            flush()
        group.append(interval)
    flush()
    return result
