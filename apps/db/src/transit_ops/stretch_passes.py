"""Place each vehicle reading along its trip's shape and time every ~100 m stretch.

Prototype for cleaning version 13 (stretch passes). Nothing in the scheduled
cleaner calls it: the ``stretch-passes`` command builds one day into a scratch
root, beside (never inside) the published v12 clean day.

Each stop-to-stop run of a trip is cut into equal pieces of about 100 m, so the
pieces of one run add up to that run exactly. A stretch is named by its two
stops and its piece, which stays stable across shapes and schedule editions.

The readings are the clean day's vehicle intervals: a vehicle that stayed
within 15 m of one place is one interval from its first reading to its last.
"""

import csv
import json
from bisect import bisect_right
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime
from math import cos, hypot, pi, radians
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import NamedTuple

from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.parquet_verify import Expected, check_window_files
from transit_ops.lake.table_schema import TableSchema
from transit_ops.providers.schedule_archive import ArchiveScheduleContext, _shape_coordinates

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
# Do not time a stretch across a hole in the readings longer than this.
MAX_GAP_SECONDS = 300.0
_EARTH_RADIUS_METRES = 6_371_008.8

_TIME = "timestamp with time zone"
STRETCHES = TableSchema.from_columns(
    (
        ("provider", "text", True),
        ("service_date", "date", True),
        ("cleaning_version", "text", True),
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
        ("provider", "text", True),
        ("service_date", "date", True),
        ("cleaning_version", "text", True),
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
    frozen_holds: int = 0
    unknown_trip: int = 0
    trips_without_shape: int = 0
    trajectories: int = 0
    trajectories_with_passes: int = 0
    passes: int = 0
    skipped_gap_pieces: int = 0
    implausible_speeds: int = 0
    stops_far_from_shape: int = 0


@dataclass
class StretchDay:
    provider: str
    date: date
    stretches: dict[tuple[str, str, int, int], tuple[object, ...]] = field(default_factory=dict)
    passes: list[tuple[object, ...]] = field(default_factory=list)
    facts: StretchFacts = field(default_factory=StretchFacts)

    def stretch_rows(self) -> Iterator[tuple[object, ...]]:
        for key in sorted(self.stretches):
            yield self.stretches[key]


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


def trip_paths(
    schedule: ArchiveScheduleContext, archive: bytes, provider: str, day: date
) -> dict[str, TripPath]:
    """Each scheduled trip of the day with its shape and ordered stops."""
    trips = {}
    for trip_id in schedule.days[day].trip_ids:
        trip = schedule.trip(day, trip_id)
        if trip is not None:
            trips[trip_id] = trip
    shapes = _shape_coordinates(
        archive, provider, 0, {trip.shape_id for trip in trips.values() if trip.shape_id}
    )
    paths = {}
    for trip_id, trip in trips.items():
        coords = shapes.get(trip.shape_id or "", [])
        stops = []
        for time in schedule.stop_times(day, trip_id):
            point = schedule.stop(day, time.stop_id)
            lat = point.lat if point is not None else None
            lon = point.lon if point is not None else None
            stops.append(PathStop(time.stop_sequence, time.stop_id, lat, lon))
        paths[trip_id] = TripPath(
            trip.route_id, trip.direction_id, trip.shape_id or "", coords, stops
        )
    return paths


def _trajectory(
    path: _Path, readings: Sequence[VehicleInterval], facts: StretchFacts
) -> list[_Vertex]:
    line = path.line
    vertices: list[_Vertex] = []
    previous: tuple[float, float, float] | None = None  # second, x, y
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
                continue
        if previous is None:
            found = line.locate(x, y, 0.0, line.length, OFF_ROUTE_METRES)
        else:
            last = vertices[-1].distance
            straight = hypot(x - previous[1], y - previous[2])
            lo = max(last + straight - 2 * OFF_ROUTE_METRES, last) - BACKTRACK_METRES
            hi = last + MAX_SPEED_MPS * (second - previous[0]) + 2 * OFF_ROUTE_METRES
            found = line.locate(x, y, lo, hi, OFF_ROUTE_METRES)
        if found is None:
            facts.off_route += 1
            continue
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
        key_base = (start_stop.stop_id, end_stop.stop_id, pieces)
        for piece in range(pieces):
            low, high = start + piece * step, start + (piece + 1) * step
            key = (*key_base, piece + 1)
            if key not in day.stretches:
                from_lat, from_lon = path.line.latlon(low)
                to_lat, to_lon = path.line.latlon(high)
                day.stretches[key] = (
                    day.provider, day.date, STRETCH_VERSION, start_stop.stop_id,
                    end_stop.stop_id, pieces, piece + 1, round(step, 1),
                    from_lat, from_lon, to_lat, to_lon, path.trip.shape_id,
                )  # fmt: skip
            # Leave line-end layovers out: time from leaving the first stop's
            # surroundings, and up to reaching the last stop's surroundings.
            entry = (
                walker.leave(min(origin + STOP_RADIUS_METRES, high))
                if index == 0 and piece == 0
                else walker.reach(low)
            )
            last_piece = index == len(stops) - 2 and piece == pieces - 1
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
                if finish > begin and moved < MOVED_METRES:
                    if min(abs(where - start), abs(where - end)) <= STOP_RADIUS_METRES:
                        at_stop += finish - begin
                    else:
                        between += finish - begin
            covered = _distance_at(walker, exit_) - _distance_at(walker, entry)
            moving = exit_ - entry - at_stop - between
            speed = covered / moving if moving >= 1.0 and covered > 0 else None
            if speed is not None and speed > MAX_SPEED_MPS:
                # Faster than any vehicle here can go: the readings around it are
                # wrong. Keep its times, so runs still add up, but not its speed.
                day.facts.implausible_speeds += 1
                speed = None
            speed = None if speed is None else round(speed * 3.6, 1)
            entered, exited = round(entry), round(exit_)
            at_stop_s = min(round(at_stop), exited - entered)
            between_s = min(round(between), exited - entered - at_stop_s)
            day.passes.append(
                (
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
                    piece + 1,
                    datetime.fromtimestamp(entered, UTC),
                    datetime.fromtimestamp(exited, UTC),
                    speed,
                    at_stop_s,
                    between_s,
                    round(gap),
                )  # fmt: skip
            )
            count += 1
    return count


def _distance_at(walker: _Walker, second: float) -> float:
    s = walker.seconds
    i = bisect_right(s, second) - 1
    if i < 0:
        return walker.distances[0]
    if i >= len(s) - 1:
        return walker.distances[-1]
    a, b = walker.v[i], walker.v[i + 1]
    return a.distance + (second - a.second) / (b.second - a.second) * (b.distance - a.distance)


def build_stretch_day(
    provider: str,
    day: date,
    paths: Mapping[str, TripPath],
    intervals: Iterable[VehicleInterval],
) -> StretchDay:
    """Stretch passes from intervals sorted by trip, vehicle and observed time."""
    result = StretchDay(provider, day)
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


_INTERVAL_SQL = """
    SELECT trip_id, vehicle_id, epoch(observed_at_utc), epoch(captured_at_utc),
        epoch(last_seen_at_utc), readings, latitude, longitude
    FROM read_parquet(?, hive_partitioning = false)
    WHERE service_date = ? AND trip_id IS NOT NULL
        AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY trip_id, vehicle_id, observed_at_utc, captured_at_utc
"""


def intervals_from_parquet(path: Path, day: date, temp_dir: Path) -> Iterator[VehicleInterval]:
    from transit_ops.lake.parquet_codec import connect

    with connect(temp_dir) as connection:
        cursor = connection.execute(_INTERVAL_SQL, [str(path), day])
        while rows := cursor.fetchmany(50_000):
            for row in rows:
                yield VehicleInterval(*row)


def write_stretch_day(
    day: StretchDay, root: Path, metadata: Mapping[str, str]
) -> tuple[Path, dict[str, dict[str, int | str]]]:
    """Write both tables and a receipt create-only under ``root``."""
    destination = root / day.provider / day.date.isoformat() / f"v{STRETCH_VERSION}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(f"Stretch day already exists: {destination}")
    files: dict[str, dict[str, int | str]] = {}
    with TemporaryDirectory(prefix=".stretch-day-", dir=destination.parent) as directory:
        temporary = Path(directory)
        staged = temporary / "version"
        staged.mkdir()
        for name, schema, rows in (
            ("stretches", STRETCHES, day.stretch_rows()),
            ("stretch_passes", STRETCH_PASSES, iter(day.passes)),
        ):
            source = temporary / f"{name}.csv"
            with source.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream, lineterminator="\n")
                writer.writerow(column.name for column in schema.columns)
                writer.writerows(rows)
            target = staged / f"{name}.parquet"
            window = write_window(
                source, schema, target, metadata=dict(metadata), temp_dir=temporary,
                validate_csv_input=False,
            )  # fmt: skip
            check_window_files(
                source, target, schema,
                expect=Expected(window.content_sha256, window.rows, window.sha256),
                temp_dir=temporary, validate_csv_input=False,
            )  # fmt: skip
            files[target.name] = {
                "sha256": window.sha256,
                "byte_size": target.stat().st_size,
                "rows": window.rows,
            }
            source.unlink()
        receipt = {**metadata, "files": files, "facts": asdict(day.facts)}
        (staged / "manifest.json").write_text(json.dumps(receipt, sort_keys=True) + "\n", "utf-8")
        staged.rename(destination)
    return destination, files
