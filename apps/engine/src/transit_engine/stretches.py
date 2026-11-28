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
import os
import re
import zlib
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from importlib.metadata import distribution
from pathlib import Path
from stat import S_ISREG
from threading import Lock
from typing import Any

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


MONTH_TABLES = ("stretches", "stretch_summary")


def months_directory(store: Store, city: str) -> str:
    if not CITY.fullmatch(city):
        raise ValueError("Invalid city")
    return f"{store.root.rstrip('/')}/stretch/v{STRETCH_VERSION}/{city}/months"


def month_receipt(
    payload: bytes, city: str, month: str
) -> tuple[dict[str, tuple[str, int]], tuple[date, ...]] | None:
    """A month rollup's table files and the days it adds up, or None."""
    try:
        receipt = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(receipt, dict) or (
        receipt.get("provider"),
        receipt.get("month"),
        receipt.get("cleaning_version"),
    ) != (city, month, STRETCH_VERSION):
        return None
    tables, files, days = receipt.get("tables"), receipt.get("files"), receipt.get("days")
    if (
        not isinstance(tables, dict)
        or set(tables) != set(MONTH_TABLES)
        or not isinstance(files, dict)
        or not isinstance(days, dict)
        or not days
    ):
        return None
    try:
        listed = tuple(sorted(date.fromisoformat(day) for day in days))
    except (TypeError, ValueError):
        return None
    if any(day.strftime("%Y-%m") != month for day in listed):
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
    return named, listed


def _size(conn: duckdb.DuckDBPyConnection, store: Store, path: str) -> int | None:
    if store.s3_endpoint:
        row = conn.execute("SELECT size FROM read_blob(?)", [path]).fetchone()
        return None if row is None else int(row[0])
    try:
        info = Path(path).stat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    return info.st_size if S_ISREG(info.st_mode) else None


def month_rollup(
    conn: duckdb.DuckDBPyConnection, store: Store, city: str, month: str
) -> tuple[dict[str, str], tuple[date, ...]] | None:
    """The month's rollup that adds up the most days, if its receipt and sizes check out.

    The nightly cleaning publishes a new rollup next to the old one when a month
    gains or changes a day, under ``months/<YYYY-MM>-<key>/``.
    """
    check_query()
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}", month):
        raise ValueError("Invalid month")
    pattern = f"{months_directory(store, city)}/{month}-*/manifest.json"
    if store.s3_endpoint:
        markers = [row[0] for row in conn.execute("SELECT file FROM glob(?)", [pattern]).fetchall()]
    else:
        base = Path(months_directory(store, city))
        markers = [path.as_posix() for path in base.glob(f"{month}-*/manifest.json")]
    best: tuple[int, str, dict[str, str], tuple[date, ...]] | None = None
    for marker in markers:
        if store.s3_endpoint:
            row = conn.execute("SELECT content FROM read_blob(?)", [marker]).fetchone()
            payload = None if row is None else bytes(row[0])
        else:
            try:
                payload = Path(marker).read_bytes()
            except (FileNotFoundError, IsADirectoryError):
                payload = None
        parsed = None if payload is None else month_receipt(payload, city, month)
        if parsed is None:
            continue
        named, days = parsed
        directory = marker.rsplit("/", 1)[0]
        paths = {table: f"{directory}/{name}" for table, (name, _) in named.items()}
        if any(_size(conn, store, paths[table]) != size for table, (_, size) in named.items()):
            continue
        candidate = (len(days), marker, paths, days)
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    return None if best is None else (best[2], best[3])


def stretch_stamp(store: Store, city: str) -> tuple[str, str, str]:
    """What a cached stretch answer depends on: the day, and the local stretch and v12 copies."""

    def changed(path: Path) -> str:
        try:
            return str(path.stat().st_mtime_ns)
        except (FileNotFoundError, NotADirectoryError):
            return "-"

    today = datetime.now(UTC).date().isoformat()
    if store.s3_endpoint:
        return today, "-", "-"
    return (
        today,
        changed(Path(stretch_directory(store, city, date.min).rsplit("/", 1)[0])),
        (changed(store.mirror_stamp())),
    )


class AnswerCache:
    """A small, bounded, per-process cache of finished stretch answers, kept compressed."""

    def __init__(self, max_bytes: int = 64 * 1024 * 1024, max_entries: int = 32) -> None:
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._data: OrderedDict[tuple[str, ...], bytes] = OrderedDict()
        self._bytes = 0
        self._lock = Lock()

    def get(self, key: tuple[str, ...]) -> dict[str, Any] | None:
        with self._lock:
            payload = self._data.get(key)
            if payload is not None:
                self._data.move_to_end(key)
        if payload is None:
            return None
        answer: dict[str, Any] = json.loads(zlib.decompress(payload))
        return answer

    def put(self, key: tuple[str, ...], answer: dict[str, Any]) -> None:
        payload = zlib.compress(json.dumps(answer).encode(), level=1)
        if len(payload) > self._max_bytes:
            return
        with self._lock:
            self._bytes += len(payload) - len(self._data.pop(key, b""))
            self._data[key] = payload
            while self._bytes > self._max_bytes or len(self._data) > self._max_entries:
                _, oldest = self._data.popitem(last=False)
                self._bytes -= len(oldest)


def remote_stretches(conn: duckdb.DuckDBPyConnection) -> Store | None:
    """R2 as a second source for stretch days a local mirror no longer keeps.

    The engine host keeps the latest 30 days. With ``ENGINE_STRETCH_R2_ROOT`` and the
    R2 read key, older days are read from R2 with the same receipt checks.
    """
    root = os.environ.get("ENGINE_STRETCH_R2_ROOT", "")
    if not root:
        return None
    endpoint = os.environ.get("TRANSIT1_R2_ENDPOINT", "").removeprefix("https://").rstrip("/")
    key = os.environ.get("TRANSIT1_R2_READ_ACCESS_KEY_ID", "")
    secret = os.environ.get("TRANSIT1_R2_READ_SECRET_ACCESS_KEY", "")
    if not re.fullmatch(r"s3://[a-z0-9][a-z0-9.-]*", root.rstrip("/")) or not (
        re.fullmatch(r"[a-z0-9-]+\.r2\.cloudflarestorage\.com", endpoint) and key and secret
    ):
        raise ValueError("ENGINE_STRETCH_R2_ROOT needs an s3:// bucket and the R2 read key")
    try:
        conn.execute("LOAD httpfs")
    except duckdb.Error:
        # Local engines do not install extensions; load the locked wheel's binary.
        wheel = distribution("duckdb-core-ext-httpfs")
        binary = next(file for file in wheel.files or () if file.name == "httpfs.duckdb_extension")
        conn.load_extension(str(wheel.locate_file(binary)))
    conn.execute(
        """CREATE OR REPLACE SECRET stretch_r2 (
            TYPE s3, KEY_ID ?, SECRET ?, ENDPOINT ?, REGION 'auto', URL_STYLE 'path',
            USE_SSL true, SCOPE ?
        )""",
        [key, secret, endpoint, f"{root.rstrip('/')}/stretch/"],
    )
    return Store(root.rstrip("/"), s3_endpoint=endpoint)


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

    @property
    def hour_sql(self) -> str:
        # A start after the end runs across midnight, as the other map readings do.
        start, end = self.hours
        return f"(hour >= ? {'AND' if start < end else 'OR'} hour < ?)"


def _listed(files: Sequence[str]) -> str:
    return "[" + ", ".join(["?"] * len(files)) + "]"


def _cells_sql(
    cut: Cut,
    days: Sequence[dict[str, str]],
    months: Sequence[dict[str, str]],
    trip_days: Sequence[str],
    day_type: str | None,
) -> tuple[str, list[object]]:
    """One row per stretch key, pass seconds and km/h with its pass count, and its inputs."""
    if not cut.by_line:
        type_cut = "AND route_type = ?" if cut.route_type is not None else ""
        typed: list[object] = [
            *cut.hours,
            *([cut.route_type] if cut.route_type is not None else []),
        ]
        parts: list[str] = []
        summary: list[object] = []
        for sources, kind in ((days, None), (months, day_type)):
            if not sources:
                continue
            # A month counts its passes by day type; read_window already chose the days.
            files = [paths["stretch_summary"] for paths in sources]
            parts.append(f"""
                SELECT stretch_key, pass_seconds, speed_kmh, passes
                FROM read_parquet({_listed(files)}, hive_partitioning = false)
                WHERE {cut.hour_sql} {type_cut} {"AND day_type = ?" if kind else ""}
            """)
            summary += [*files, *typed, *([kind] if kind else [])]
        union = " UNION ALL ".join(parts)
        sql = f"""SELECT stretch_key, pass_seconds, speed_kmh, sum(passes) AS n
            FROM ({union}) GROUP BY ALL"""
        return sql, summary
    passes = [paths["stretch_passes"] for paths in days]
    parameters: list[object] = [*passes]
    join = ""
    if cut.route_type is not None:
        trips = _listed(trip_days)
        join = f"""JOIN (SELECT DISTINCT service_date, trip_id FROM read_parquet({trips},
            hive_partitioning = false) WHERE route_type = ?) t USING (service_date, trip_id)"""
        parameters += [*trip_days, cut.route_type]
    filters = ["p.gap_seconds <= ?", "p.moving_speed_kmh IS NOT NULL", cut.hour_sql]
    parameters += [MAX_GAP_SECONDS, *cut.hours]
    if cut.lines:
        filters.append("p.route_id = ANY(?)")
        parameters.append(list(cut.lines))
    if cut.direction is not None:
        filters.append("p.direction_id = ?")
        parameters.append(cut.direction)
    sql = f"""
        SELECT s.stretch_key, p.pass_seconds, p.speed_kmh, count(*) AS n
        FROM (
            SELECT *, (epoch(exited_at) - epoch(entered_at))::INTEGER AS pass_seconds,
                floor(moving_speed_kmh)::INTEGER AS speed_kmh,
                hour(timezone(getvariable('service_timezone'), entered_at)) AS hour
            FROM read_parquet({_listed(passes)}, hive_partitioning = false)
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
    months: Sequence[dict[str, str]] = (),
    day_type: str | None = None,
) -> list[StretchReading]:
    """Clear-run time, median, time lost and clear-run speed for every stretch seen.

    ``months`` are month rollups of the daily summaries. They serve only questions
    without a line or direction cut, and never repeat a day given in ``days``.
    """
    if not days and not months:
        return []
    if months and cut.by_line:
        raise ValueError("Month rollups hold no line or direction")
    check_query()
    stretch_files = [paths["stretches"] for paths in (*days, *months)]
    # The latest day names each stretch's geometry; keys are the same on every day.
    conn.execute(
        """CREATE OR REPLACE TEMP TABLE stretch_keys AS
        SELECT * EXCLUDE (rank) FROM (
            SELECT stretch_key, from_stop, to_stop, pieces, piece, length_m,
                from_lat, from_lon, to_lat, to_lon,
                row_number() OVER (PARTITION BY stretch_key ORDER BY service_date DESC) AS rank
            FROM read_parquet(?, hive_partitioning = false, union_by_name = true)
        ) WHERE rank = 1""",
        [stretch_files],
    )
    cells, parameters = _cells_sql(cut, days, months, trip_days, day_type)
    rows = conn.execute(
        f"""
        WITH cells AS ({cells}),
        times AS (
            SELECT stretch_key, pass_seconds, sum(n) AS n FROM cells GROUP BY ALL
        ), timed AS (
            SELECT *, sum(n) OVER up AS upto, sum(n * pass_seconds) OVER up AS upto_seconds,
                sum(n) OVER whole AS total, sum(n * pass_seconds) OVER whole AS total_seconds
            FROM times
            WINDOW up AS (PARTITION BY stretch_key ORDER BY pass_seconds),
                whole AS (PARTITION BY stretch_key)
        ), clear AS (
            -- At the clear-run row, the slower passes are the rows after it: their time
            -- above the clear run is what they add beyond that row's running totals.
            SELECT stretch_key, max(total) AS passes,
                min(pass_seconds) FILTER (upto >= (total + 9) // 10) AS clear_run,
                arg_min(
                    total_seconds - upto_seconds - pass_seconds * (total - upto), pass_seconds
                ) FILTER (upto >= (total + 9) // 10) AS total_lost,
                min(pass_seconds) FILTER (upto >= (total + 1) // 2) AS lower_median,
                min(pass_seconds) FILTER (upto >= (total + 2) // 2) AS upper_median
            FROM timed GROUP BY stretch_key
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
            c.passes, c.clear_run, c.lower_median, c.upper_median, c.total_lost, f.clear_speed
        FROM clear c JOIN fast f USING (stretch_key)
        JOIN stretch_keys k USING (stretch_key)
        ORDER BY k.from_stop, k.to_stop, k.pieces, k.piece
        """,
        parameters,
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
