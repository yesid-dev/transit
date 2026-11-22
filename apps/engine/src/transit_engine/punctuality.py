import os
import re
from dataclasses import dataclass
from datetime import date
from hashlib import file_digest
from pathlib import Path
from time import perf_counter
from typing import Self, TypedDict

import duckdb

from transit_engine.clean_manifest import STOP_EVENTS, TRIP_DAYS, file_identities

METHOD_VERSION = "network-punctuality-v1"
CITY = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")

# Source: Transit's on-demand analytics roadmap, "What on time counts",
# confirmed by Yesito on 2026-11-20. Count each scheduled trip stop once.
# Routes without live data are outside every rate. Capture-gap stops still count as scheduled.
_WITHOUT_LIVE_DATA = """(t.state = 'not_measured'
    AND t.state_reason IS NOT DISTINCT FROM 'route_without_live_data')"""
BANDS = f"""
    count(*) FILTER (NOT {_WITHOUT_LIVE_DATA}) AS scheduled,
    count(delay_seconds) FILTER (NOT {_WITHOUT_LIVE_DATA}) AS classified,
    count(*) FILTER (NOT {_WITHOUT_LIVE_DATA} AND delay_seconds < -60) AS early,
    count(*) FILTER (NOT {_WITHOUT_LIVE_DATA} AND delay_seconds BETWEEN -60 AND 300) AS on_time,
    count(*) FILTER (NOT {_WITHOUT_LIVE_DATA} AND delay_seconds > 300) AS late,
    count(*) FILTER ({_WITHOUT_LIVE_DATA}) AS not_measured_route_without_live_data,
    count(*) FILTER (t.state = 'not_measured' AND t.state_reason = 'capture_gap')
        AS not_measured_capture_gap
"""

# PR #1180 writes one trip row per provider, date and trip ID.
# Added trips have no scheduled start. Scheduled trips can have untimed stops.
SCHEDULED_EVENTS = """
    FROM read_parquet($1, hive_partitioning = false) s
    JOIN read_parquet($2, hive_partitioning = false) t
      ON (s.provider, s.service_date, s.cleaning_version, s.trip_id) =
         (t.provider, t.service_date, t.cleaning_version, t.trip_id)
      AND t.scheduled_start_utc IS NOT NULL
      AND t.state IS DISTINCT FROM 'cancelled'
    WHERE s.provider = $3 AND s.cleaning_version = $4
      AND s.service_date BETWEEN $5 AND $6
"""


def env_int(name: str, default: int, *, minimum: int = 1) -> int:
    value = int(os.environ.get(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


@dataclass(frozen=True)
class Store:
    root: str
    cleaning_version: int = 3
    memory_mib: int = 256
    threads: int = 1
    s3_endpoint: str | None = None

    @classmethod
    def from_env(cls) -> Self:
        root = os.environ.get("ENGINE_CLEAN_ROOT", "./clean-days")
        endpoint = os.environ.get("ENGINE_S3_ENDPOINT")
        if root.startswith("s3://"):
            if not re.fullmatch(r"s3://[a-z0-9][a-z0-9.-]*(/[a-zA-Z0-9._/-]+)?/?", root):
                raise ValueError("ENGINE_CLEAN_ROOT must be an s3://bucket[/prefix] URL")
            if not endpoint or not re.fullmatch(r"[a-zA-Z0-9.-]+(?::[0-9]+)?", endpoint):
                raise ValueError("ENGINE_S3_ENDPOINT must be an HTTPS host without a scheme")
            if not all(
                os.environ.get(key) for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
            ):
                raise ValueError("S3 requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
        else:
            root = Path(root).resolve().as_posix()
            endpoint = None
        return cls(
            root,
            env_int("ENGINE_CLEANING_VERSION", 3),
            env_int("ENGINE_QUERY_MEMORY_MIB", 256),
            env_int("ENGINE_QUERY_THREADS", 1),
            endpoint,
        )

    def connect(self) -> duckdb.DuckDBPyConnection:
        conn = duckdb.connect(
            config={
                "threads": self.threads,
                "memory_limit": f"{self.memory_mib} MiB",
                "max_temp_directory_size": "0 bytes",
                "autoload_known_extensions": False,
                "autoinstall_known_extensions": False,
            },
        )
        if self.s3_endpoint:
            try:
                conn.execute("LOAD httpfs")
                conn.execute(
                    """
                    CREATE SECRET clean_days (
                        TYPE s3, KEY_ID ?, SECRET ?, SESSION_TOKEN ?,
                        ENDPOINT ?, REGION 'auto', URL_STYLE 'path', USE_SSL true, SCOPE ?
                    )
                    """,
                    [
                        os.environ["AWS_ACCESS_KEY_ID"],
                        os.environ["AWS_SECRET_ACCESS_KEY"],
                        os.environ.get("AWS_SESSION_TOKEN", ""),
                        self.s3_endpoint,
                        f"{self.root.rstrip('/')}/",
                    ],
                )
            except Exception:
                conn.close()
                raise
        return conn

    def files(
        self, conn: duckdb.DuckDBPyConnection, city: str, day: date
    ) -> tuple[str, str] | None:
        directory = f"{self.root.rstrip('/')}/{city}/{day.isoformat()}/v{self.cleaning_version}"
        marker = f"{directory}/manifest.json"
        stops, trips = f"{directory}/{STOP_EVENTS}", f"{directory}/{TRIP_DAYS}"
        if self.s3_endpoint:
            # A signed list distinguishes absent data from an access failure.
            present = {
                row[0]
                for row in conn.execute("SELECT file FROM glob(?)", [f"{directory}/*"]).fetchall()
            }
            if not {marker, stops, trips} <= present:
                return None
            manifest = conn.execute("SELECT content FROM read_blob(?)", [marker]).fetchone()
            if manifest is None:
                return None
            payload: bytes = manifest[0]
        else:
            try:
                payload = Path(marker).read_bytes()
            except (FileNotFoundError, IsADirectoryError):
                return None
        identities = file_identities(payload, city, day.isoformat(), str(self.cleaning_version))
        if identities is None:
            return None
        for name, path in ((STOP_EVENTS, stops), (TRIP_DAYS, trips)):
            digest, size = identities[name]
            if self.s3_endpoint:
                actual = conn.execute(
                    "SELECT sha256(content), size FROM read_blob(?) WHERE size = ?",
                    [path, size],
                ).fetchone()
                if actual != (digest, size):
                    return None
            else:
                try:
                    with Path(path).open("rb") as stream:
                        if os.fstat(stream.fileno()).st_size != size:
                            return None
                        if file_digest(stream, "sha256").hexdigest() != digest:
                            return None
                except (FileNotFoundError, IsADirectoryError):
                    return None
        return stops, trips


class Evidence(TypedDict):
    status: str
    message: str | None
    city: str
    start_date: str
    end_date: str
    early: int | None
    on_time: int | None
    late: int | None
    classified: int | None
    scheduled: int | None
    not_measured_route_without_live_data: int | None
    not_measured_capture_gap: int | None
    share_observed: float | None
    share_on_time: float | None
    cleaning_versions: list[int]
    method_version: str
    query_ms: float


def network_day(store: Store, city: str, day: date) -> Evidence:
    if not CITY.fullmatch(city):
        raise ValueError("Invalid city")
    started = perf_counter()
    scheduled = classified = early = on_time = late = None
    without_live_data = capture_gap = None
    versions: list[int] = []
    with store.connect() as conn:
        files = store.files(conn, city, day)
        if files:
            row = conn.execute(
                f"SELECT {BANDS} {SCHEDULED_EVENTS}",
                [*files, city, str(store.cleaning_version), day, day],
            ).fetchone()
            assert row is not None  # An ungrouped aggregate always returns one row.
            scheduled, classified, early, on_time, late, without_live_data, capture_gap = row
            versions.append(store.cleaning_version)
    return {
        "status": "measured" if classified else "not_measured",
        "message": None if classified else "not measured",
        "city": city,
        "start_date": day.isoformat(),
        "end_date": day.isoformat(),
        "early": early,
        "on_time": on_time,
        "late": late,
        "classified": classified,
        "scheduled": scheduled,
        "not_measured_route_without_live_data": without_live_data,
        "not_measured_capture_gap": capture_gap,
        "share_observed": classified / scheduled if scheduled and classified is not None else None,
        "share_on_time": on_time / classified if classified and on_time is not None else None,
        "cleaning_versions": versions,
        "method_version": METHOD_VERSION,
        "query_ms": (perf_counter() - started) * 1000,
    }
