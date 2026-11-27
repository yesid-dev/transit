"""Report which clean tables exist for each requested service day."""

import json
from contextlib import nullcontext
from datetime import date, timedelta
from pathlib import Path
from stat import S_ISREG
from typing import Any

import duckdb

from transit_engine.cancellation import check_query, track_connection
from transit_engine.clean_manifest import (
    ALERTS,
    FEED_POLLS,
    PREDICTION_SAMPLES,
    SCHEDULED_STOP_TIMES,
    SEGMENT_RUNS,
    STOP_EVENTS,
    TRIP_DAYS,
    VEHICLE_POSITIONS,
    file_identities,
    source_date,
)
from transit_engine.store import CITY, Store

MAX_DAYS = 400
TABLES = (
    ("stop_events", STOP_EVENTS),
    ("trip_days", TRIP_DAYS),
    ("scheduled_stop_times", SCHEDULED_STOP_TIMES),
    ("vehicle_positions", VEHICLE_POSITIONS),
    ("feed_polls", FEED_POLLS),
    ("alerts", ALERTS),
    ("prediction_samples", PREDICTION_SAMPLES),
    ("segment_runs", SEGMENT_RUNS),
)


def data_health(store: Store, city: str, start: date, end: date) -> dict[str, Any]:
    """Describe each day's manifest and table files without reading Parquet contents."""
    if not CITY.fullmatch(city):
        raise ValueError("invalid city")
    if start > end:
        raise ValueError("provide an ordered service date range")
    if (end - start).days + 1 > MAX_DAYS:
        raise ValueError(f"the range must be at most {MAX_DAYS} days")
    version = str(store.cleaning_version)
    connection = track_connection(store.connect()) if store.s3_endpoint else nullcontext(None)
    with connection as conn:
        days = [
            _day(store, conn, city, version, start + timedelta(days=offset))
            for offset in range((end - start).days + 1)
        ]
    return {
        "city": city,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "cleaning_version": version,
        "days": days,
    }


def _day(
    store: Store,
    conn: duckdb.DuckDBPyConnection | None,
    city: str,
    version: str,
    day: date,
) -> dict[str, Any]:
    check_query()
    directory = f"{store.root.rstrip('/')}/{city}/{day.isoformat()}/v{version}"
    manifest_bytes, sizes = _probe(conn, directory)
    missing = {
        "service_date": day.isoformat(),
        "status": "missing",
        "cleaning_version": version,
        "built_at_utc": None,
        "tables": {key: {"status": "missing"} for key, _ in TABLES},
    }
    if manifest_bytes is None:
        return {**missing, "reason": "no_manifest"}
    identities = file_identities(manifest_bytes, city, day.isoformat(), version)
    if identities is None:
        return {**missing, "reason": "invalid_manifest"}
    # file_identities has validated this payload, so its fields are safe to read.
    manifest = json.loads(manifest_bytes)
    if not identities:
        return {
            "service_date": day.isoformat(),
            "status": "not_measured",
            "reason": manifest["status"],
            "cleaning_version": version,
            "built_at_utc": manifest["built_at_utc"],
            "tables": {key: {"status": "not_measured"} for key, _ in TABLES},
        }
    files = manifest["files"]
    tables: dict[str, Any] = {}
    complete = True
    for key, name in TABLES:
        if name not in identities:
            if name == ALERTS and manifest.get("alerts") == "not_tracked":
                tables[key] = {"status": "not_tracked"}
            else:
                tables[key] = {"status": "missing"}
        elif sizes[name] == identities[name][1]:
            tables[key] = {"status": "present", "rows": files[name]["rows"]}
        elif sizes[name] is None:
            tables[key] = {"status": "missing", "reason": "file_missing"}
            complete = False
        else:
            tables[key] = {"status": "missing", "reason": "size_mismatch"}
            complete = False
    updated = source_date(manifest)
    return {
        "service_date": day.isoformat(),
        "status": "present" if complete else "incomplete",
        "cleaning_version": version,
        "built_at_utc": manifest["built_at_utc"],
        "tables": tables,
        **({"source_date": updated} if complete and updated else {}),
    }


def _probe(
    conn: duckdb.DuckDBPyConnection | None, directory: str
) -> tuple[bytes | None, dict[str, int | None]]:
    """Read the manifest and the size of each table file, never a Parquet body."""
    marker = f"{directory}/manifest.json"
    sizes: dict[str, int | None] = {}
    if conn is None:
        try:
            manifest: bytes | None = Path(marker).read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            manifest = None
        for _, name in TABLES:
            try:
                info = (Path(directory) / name).stat()
            except (FileNotFoundError, IsADirectoryError):
                sizes[name] = None
            else:
                sizes[name] = info.st_size if S_ISREG(info.st_mode) else None
        return manifest, sizes
    present = {
        row[0] for row in conn.execute("SELECT file FROM glob(?)", [f"{directory}/*"]).fetchall()
    }
    manifest = None
    if marker in present:
        row = conn.execute("SELECT content FROM read_blob(?)", [marker]).fetchone()
        manifest = None if row is None else row[0]
    for _, name in TABLES:
        path = f"{directory}/{name}"
        size = None
        if path in present:
            # With only size projected, httpfs uses HEAD and skips the body.
            found = conn.execute("SELECT size FROM read_blob(?)", [path]).fetchone()
            size = int(found[0]) if found is not None else None
        sizes[name] = size
    return manifest, sizes
