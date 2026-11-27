"""Read stretch timing days and answer clear-run time and speed by stretch.

The cleaner publishes each day under ``stretch/v13/<city>/<date>/`` with a receipt
that names its three tables (``stretches``, ``stretch_passes``, ``stretch_summary``).
Only files the receipt names are data, and each must match the receipt's size.

One question reads every day of its window in a single statement. Without a line
or direction cut it reads the daily summary (counts per stretch, vehicle type,
local hour, whole pass seconds and whole km/h). With one it reads the passes,
which are sorted by line. Both count the same passes: timed from readings at most
90 s apart, with a measured speed.

Per stretch, as for the stop-to-stop clear run, the clear-run time is the pass
time at the fastest tenth's boundary (the ceil(n/10)-th fastest pass), the median
is exact, and time lost is the median minus the clear run. Total time lost adds,
over every pass slower than the clear run, how much slower it was. The clear-run
speed is the speed at the same boundary from the fast end, in whole km/h.
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from stat import S_ISREG

import duckdb

from transit_engine.cancellation import check_query
from transit_engine.store import CITY, Store

STRETCH_VERSION = "13"
TABLES = ("stretches", "stretch_passes", "stretch_summary")
MIN_PASSES = 20
MAX_GAP_SECONDS = 90
_SHA256 = re.compile(r"[0-9a-f]{64}")


def stretch_directory(store: Store, city: str, day: date) -> str:
    if not CITY.fullmatch(city):
        raise ValueError("Invalid city")
    return f"{store.root.rstrip('/')}/stretch/v{STRETCH_VERSION}/{city}/{day.isoformat()}"


def receipt_tables(payload: bytes, city: str, day: date) -> dict[str, tuple[str, int]] | None:
    """Each table's file name and size from a valid receipt, or None."""
    try:
        receipt = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(receipt, dict) or (
        receipt.get("provider"),
        receipt.get("service_date"),
        receipt.get("cleaning_version"),
    ) != (city, day.isoformat(), STRETCH_VERSION):
        return None
    tables, files = receipt.get("tables"), receipt.get("files")
    if not isinstance(tables, dict) or not isinstance(files, dict) or set(tables) != set(TABLES):
        return None
    named = {}
    for table, name in tables.items():
        entry = files.get(name) if isinstance(name, str) else None
        if not isinstance(entry, dict):
            return None
        digest, size = entry.get("sha256"), entry.get("byte_size")
        if (
            not isinstance(digest, str)
            or not _SHA256.fullmatch(digest)
            or type(size) is not int
            or size <= 0
            or name != f"{table}-{digest[:16]}.parquet"
        ):
            return None
        named[table] = (name, size)
    return named


def stretch_day(
    conn: duckdb.DuckDBPyConnection, store: Store, city: str, day: date
) -> dict[str, str] | None:
    """Paths of the day's three tables when its receipt and file sizes check out."""
    check_query()
    directory = stretch_directory(store, city, day)
    marker = f"{directory}/manifest.json"
    if store.s3_endpoint:
        present = {
            row[0]
            for row in conn.execute("SELECT file FROM glob(?)", [f"{directory}/*"]).fetchall()
        }
        if marker not in present:
            return None
        row = conn.execute("SELECT content FROM read_blob(?)", [marker]).fetchone()
        if row is None:
            return None
        payload: bytes = row[0]
    else:
        try:
            payload = Path(marker).read_bytes()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            return None
    named = receipt_tables(payload, city, day)
    if named is None:
        return None
    paths = {}
    for table, (name, size) in named.items():
        path = f"{directory}/{name}"
        if store.s3_endpoint:
            if path not in present:
                return None
            actual = conn.execute("SELECT size FROM read_blob(?)", [path]).fetchone()
            if actual != (size,):
                return None
        else:
            try:
                info = Path(path).stat()
            except (FileNotFoundError, NotADirectoryError):
                return None
            if not S_ISREG(info.st_mode) or info.st_size != size:
                return None
        paths[table] = path
    return paths


@dataclass(frozen=True)
class StretchReading:
    from_stop: str
    to_stop: str
    pieces: int
    piece: int
    length_m: float
    from_lat: float
    from_lon: float
    to_lat: float
    to_lon: float
    passes: int
    clear_run_seconds: int | None
    median_seconds: float | None
    time_lost_seconds: float | None
    total_time_lost_seconds: int | None
    clear_run_speed_kmh: int | None


@dataclass(frozen=True)
class Cut:
    hours: tuple[int, int]
    route_type: int | None = None
    lines: tuple[str, ...] = ()
    direction: int | None = None

    @property
    def by_line(self) -> bool:
        return bool(self.lines) or self.direction is not None


def _cells_sql(cut: Cut, days: int, trip_days: bool) -> tuple[str, list[object]]:
    """One row per stretch key, pass seconds and km/h with its pass count."""
    many = "[" + ", ".join(["?"] * days) + "]"
    if not cut.by_line:
        type_cut = "AND route_type = ?" if cut.route_type is not None else ""
        sql = f"""
            SELECT stretch_key, pass_seconds, speed_kmh, sum(passes) AS n
            FROM read_parquet({many}, hive_partitioning = false)
            WHERE hour >= ? AND hour < ? {type_cut}
            GROUP BY ALL
        """
        return sql, [*cut.hours, *([cut.route_type] if cut.route_type is not None else [])]
    filters = ["p.gap_seconds <= ?", "p.moving_speed_kmh IS NOT NULL", "hour >= ?", "hour < ?"]
    parameters: list[object] = [MAX_GAP_SECONDS, *cut.hours]
    if cut.lines:
        filters.append("p.route_id = ANY(?)")
        parameters.append(list(cut.lines))
    if cut.direction is not None:
        filters.append("p.direction_id = ?")
        parameters.append(cut.direction)
    join = ""
    if cut.route_type is not None:
        assert trip_days
        join = f"""JOIN (SELECT DISTINCT service_date, trip_id FROM read_parquet({many},
            hive_partitioning = false) WHERE route_type = ?) t USING (service_date, trip_id)"""
        filters.append("true")
    sql = f"""
        SELECT s.stretch_key, p.pass_seconds, p.speed_kmh, count(*) AS n
        FROM (
            SELECT *, (epoch(exited_at) - epoch(entered_at))::INTEGER AS pass_seconds,
                floor(moving_speed_kmh)::INTEGER AS speed_kmh,
                hour(timezone(getvariable('service_timezone'), entered_at)) AS hour
            FROM read_parquet({many}, hive_partitioning = false)
        ) p {join}
        JOIN stretch_keys s USING (from_stop, to_stop, pieces, piece)
        WHERE {" AND ".join(filters)}
        GROUP BY ALL
    """
    return sql, parameters


def stretch_readings(
    conn: duckdb.DuckDBPyConnection,
    days: Sequence[dict[str, str]],
    cut: Cut,
    trip_days: Sequence[str] = (),
) -> list[StretchReading]:
    """Clear-run time, median, time lost and clear-run speed for every stretch seen."""
    if not days:
        return []
    check_query()
    stretch_files = [paths["stretches"] for paths in days]
    # The latest day names each stretch's geometry; keys are the same on every day.
    conn.execute(
        """CREATE OR REPLACE TEMP TABLE stretch_keys AS
        SELECT * EXCLUDE (rank) FROM (
            SELECT stretch_key, from_stop, to_stop, pieces, piece, length_m,
                from_lat, from_lon, to_lat, to_lon,
                row_number() OVER (PARTITION BY stretch_key ORDER BY service_date DESC) AS rank
            FROM read_parquet(?, hive_partitioning = false)
        ) WHERE rank = 1""",
        [stretch_files],
    )
    table = "stretch_passes" if cut.by_line else "stretch_summary"
    cells, parameters = _cells_sql(cut, len(days), bool(trip_days))
    sources: list[object] = [paths[table] for paths in days]
    if cut.by_line and cut.route_type is not None:
        sources += [*trip_days, cut.route_type]
    rows = conn.execute(
        f"""
        WITH cells AS ({cells}),
        times AS (
            SELECT stretch_key, pass_seconds, sum(n) AS n FROM cells GROUP BY ALL
        ), timed AS (
            SELECT *, sum(n) OVER (PARTITION BY stretch_key ORDER BY pass_seconds) AS upto,
                sum(n) OVER (PARTITION BY stretch_key) AS total
            FROM times
        ), clear AS (
            SELECT stretch_key, max(total) AS passes,
                min(pass_seconds) FILTER (upto >= (total + 9) // 10) AS clear_run,
                min(pass_seconds) FILTER (upto >= (total + 1) // 2) AS lower_median,
                min(pass_seconds) FILTER (upto >= (total + 2) // 2) AS upper_median
            FROM timed GROUP BY stretch_key
        ), lost AS (
            SELECT t.stretch_key,
                sum(t.n * greatest(t.pass_seconds - c.clear_run, 0))::BIGINT AS total_lost
            FROM times t JOIN clear c USING (stretch_key) GROUP BY t.stretch_key
        ), speeds AS (
            SELECT stretch_key, speed_kmh, sum(n) AS n FROM cells GROUP BY ALL
        ), fast AS (
            SELECT stretch_key, max(speed_kmh) FILTER (upto >= (total + 9) // 10) AS clear_speed
            FROM (
                SELECT *, sum(n) OVER (PARTITION BY stretch_key ORDER BY speed_kmh DESC) AS upto,
                    sum(n) OVER (PARTITION BY stretch_key) AS total
                FROM speeds
            ) GROUP BY stretch_key
        )
        SELECT k.from_stop, k.to_stop, k.pieces, k.piece, k.length_m,
            k.from_lat, k.from_lon, k.to_lat, k.to_lon,
            c.passes, c.clear_run, c.lower_median, c.upper_median, l.total_lost, f.clear_speed
        FROM clear c JOIN lost l USING (stretch_key) JOIN fast f USING (stretch_key)
        JOIN stretch_keys k USING (stretch_key)
        ORDER BY k.from_stop, k.to_stop, k.pieces, k.piece
        """,
        [*sources, *parameters],
    ).fetchall()
    readings = []
    for (from_stop, to_stop, pieces, piece, length, from_lat, from_lon, to_lat, to_lon, passes,
         clear, lower, upper, lost, speed) in rows:  # fmt: skip
        check_query()
        measured = passes >= MIN_PASSES
        median = (lower + upper) / 2 if measured else None
        readings.append(
            StretchReading(
                from_stop,
                to_stop,
                pieces,
                piece,
                length,
                from_lat,
                from_lon,
                to_lat,
                to_lon,
                int(passes),
                clear if measured else None,
                median,
                median - clear if median is not None else None,
                int(lost) if measured else None,
                int(speed) if measured else None,
            )  # fmt: skip
        )
    return readings
