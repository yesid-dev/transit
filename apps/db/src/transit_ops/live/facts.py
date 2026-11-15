"""Math-first local realtime facts through one atomic capture application.

The supplied LocalFile owns the transaction. No PostgreSQL read,
serving admission, raw durability claim or wall clock is involved here.
"""

import json
from dataclasses import asdict
from datetime import UTC, date, datetime, time, timedelta
from hashlib import sha256
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.live.captures import FRAME_COLUMNS, Frame, ParsedCapture
from transit_ops.live.edition import EditionMissing, loaded_edition
from transit_ops.live.local_file import LocalFile, LocalFileMismatch

VEHICLE_COLUMNS = (
    ("provider_id", "VARCHAR NOT NULL"),
    ("realtime_snapshot_id", "BIGINT NOT NULL"),
    ("entity_index", "INTEGER NOT NULL"),
    ("snapshot_date_key", "INTEGER NOT NULL"),
    ("snapshot_local_date", "DATE NOT NULL"),
    ("feed_timestamp_utc", "TIMESTAMP NOT NULL"),
    ("captured_at_utc", "TIMESTAMP NOT NULL"),
    ("position_timestamp_utc", "TIMESTAMP"),
    ("entity_id", "VARCHAR"),
    ("vehicle_id", "VARCHAR"),
    ("trip_id", "VARCHAR"),
    ("route_id", "VARCHAR"),
    ("stop_id", "VARCHAR"),
    ("current_stop_sequence", "INTEGER"),
    ("current_status", "INTEGER"),
    ("occupancy_status", "INTEGER"),
    ("latitude", "DOUBLE"),
    ("longitude", "DOUBLE"),
    ("bearing", "DOUBLE"),
    ("speed", "DOUBLE"),
)
TRIP_COLUMNS = VEHICLE_COLUMNS[:7] + tuple(
    (name, kind)
    for name, kind in (
        ("entity_id", "VARCHAR"),
        ("trip_id", "VARCHAR"),
        ("route_id", "VARCHAR"),
        ("direction_id", "INTEGER"),
        ("start_date", "DATE"),
        ("vehicle_id", "VARCHAR"),
        ("trip_schedule_relationship", "INTEGER"),
        ("delay_seconds", "INTEGER"),
        ("stop_time_update_count", "INTEGER NOT NULL CHECK(stop_time_update_count >= 0)"),
        ("delay_stop_id", "VARCHAR"),
        ("delay_stop_sequence", "INTEGER"),
        (
            "skipped_stop_count",
            "INTEGER NOT NULL CHECK(skipped_stop_count >= 0 "
            "AND skipped_stop_count <= stop_time_update_count)",
        ),
        ("occupancy_status", "INTEGER"),
    )
)
_DEFINITIONS = {
    "fact_trip_delay_snapshot": ", ".join(f"{n} {t}" for n, t in TRIP_COLUMNS)
    + ", PRIMARY KEY(provider_id, realtime_snapshot_id, entity_index)",
    "fact_vehicle_snapshot": ", ".join(f"{n} {t}" for n, t in VEHICLE_COLUMNS)
    + ", PRIMARY KEY(provider_id, realtime_snapshot_id, entity_index)",
    "fact_processing": "provider_id VARCHAR NOT NULL, endpoint_key VARCHAR NOT NULL, "
    "capture_row_id BIGINT NOT NULL, content_sha256 VARCHAR NOT NULL, "
    "application_sha256 VARCHAR NOT NULL, captured_at_utc TIMESTAMP NOT NULL, "
    "feed_timestamp_utc TIMESTAMP NOT NULL, row_count BIGINT NOT NULL CHECK(row_count >= 0), "
    "PRIMARY KEY(provider_id, endpoint_key, capture_row_id)",
}


def _utc(value: object) -> object:
    if isinstance(value, datetime):
        if value.utcoffset() is None:
            raise ValueError("fact timestamps must be timezone-aware")
        return value.astimezone(UTC).replace(tzinfo=None)
    if isinstance(value, float) and value == 0:
        return 0.0
    return value


def _json_timestamp(value: object) -> str:
    if isinstance(value, datetime):
        return str(_utc(value))
    if isinstance(value, date):
        return value.isoformat()
    raise TypeError(f"unsupported parsed value: {type(value).__name__}")


def _reject_nul(value: object, field: str) -> None:
    if isinstance(value, str) and "\x00" in value:
        raise ValueError(f"nul_in_text: {field}")
    if isinstance(value, dict):
        for key, item in value.items():
            _reject_nul(key, field)
            _reject_nul(item, f"{field}.{key}")
    elif isinstance(value, (tuple, list)):
        for item in value:
            _reject_nul(item, field)


def _fingerprint(parsed: ParsedCapture, timezone: str) -> str:
    # Include the normalized content and policy context, not just caller's raw hash.
    document = asdict(parsed.capture) | {
        "timezone": timezone,
        "version": parsed.gtfs_realtime_version,
        "incrementality": parsed.incrementality,
        "entity_count": parsed.entity_count,
        "frames": {key: asdict(frame) for key, frame in parsed.frames.items()},
    }
    return sha256(
        json.dumps(
            document,
            default=_json_timestamp,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


def _physical_value(value: object, field: str, low: int, high: int) -> object:
    if value is None:
        return None
    if not isinstance(value, (float, int)):
        raise ValueError(f"invalid_measure_type: {field}")
    return value if low <= value <= high and (field != "bearing" or value < high) else None


def _vehicle_rows(parsed: ParsedCapture, timezone: ZoneInfo) -> list[tuple[object, ...]]:
    capture = parsed.capture
    entities = parsed.frames["rt_entities"]
    vehicles = parsed.frames["rt_vehicle_positions"]
    ids = {r[0]: r[1] for r in entities.rows}
    if len(ids) != len(entities.rows) or len(ids) != parsed.entity_count:
        raise ValueError("parsed entity count or keys differ")
    result = []
    for values in vehicles.rows:
        vp = dict(zip(vehicles.columns, values, strict=True))
        if vp["entity_index"] not in ids:
            raise ValueError("vehicle entity missing")
        if (vp["feed_timestamp_utc"], vp["captured_at_utc"]) != (
            capture.feed_timestamp_utc,
            capture.captured_at_utc,
        ):
            raise ValueError("vehicle timestamps differ from capture")
        day = capture.feed_timestamp_utc.astimezone(timezone).date()
        row = dict(
            provider_id=capture.provider_id,
            realtime_snapshot_id=capture.capture_row_id,
            snapshot_date_key=int(day.strftime("%Y%m%d")),
            snapshot_local_date=day,
            position_timestamp_utc=vp["vehicle_timestamp_utc"],
            entity_id=ids[vp["entity_index"]],
        )
        # Quality labels classify pairs/bboxes; they do not sanitize facts.
        # Retain observations, null only mathematically invalid finite measures.
        for name, low, high in (
            ("latitude", -90, 90),
            ("longitude", -180, 180),
            ("bearing", 0, 360),
        ):
            row[name] = _physical_value(vp[name], name, low, high)
        result.append(tuple(_utc(row[n] if n in row else vp[n]) for n, _ in VEHICLE_COLUMNS))
    return result


def _validate_capture(parsed: ParsedCapture) -> None:
    capture = parsed.capture
    _reject_nul(asdict(capture), "capture")
    _reject_nul((parsed.gtfs_realtime_version, parsed.incrementality), "header")
    if capture.endpoint_key not in ("vehicle_positions", "trip_updates"):
        raise ValueError("unsupported fact endpoint")
    if type(capture.capture_row_id) is not int or not 0 < capture.capture_row_id < 2**63:
        raise ValueError("capture identity must be a positive BIGINT")
    _utc(capture.captured_at_utc)
    _utc(capture.feed_timestamp_utc)
    expected = (
        {"rt_entities", "rt_vehicle_positions"}
        if capture.endpoint_key == "vehicle_positions"
        else {"rt_entities", "rt_trip_updates", "rt_trip_update_stop_times"}
    )
    if set(parsed.frames) != expected:
        raise ValueError(f"{capture.endpoint_key}: parsed frame set differs")
    for name, frame in parsed.frames.items():
        _reject_nul(frame.rows, name)
        columns = FRAME_COLUMNS[name]
        if frame.table != name or frame.columns != columns:
            raise ValueError(f"{name}: parsed frame contract differs")
        if any(len(row) != len(columns) for row in frame.rows):
            raise ValueError(f"{name}: parsed row width differs")
        integers = {
            "entity_index",
            "stop_time_update_index",
            "stop_sequence",
            "direction_id",
            "schedule_relationship",
            "current_stop_sequence",
            "current_status",
            "occupancy_status",
            "congestion_level",
        }
        for row in frame.rows:
            for field, value in zip(columns, row, strict=True):
                if field in integers and value is not None:
                    if type(value) is not int or not -(2**31) <= value < 2**31:
                        raise ValueError(f"{name}.{field}: outside INTEGER")


def apply_capture(local: LocalFile, parsed: ParsedCapture, *, provider_timezone: str) -> int:
    """Apply one parsed realtime capture, returning inserted facts (zero on retry).

    A changed identity or incompatible file refuses before writing. Failures poison
    an enclosing LocalFile transaction even if a caller catches the exception.
    UTC timestamps are stored at microsecond precision without optional TZ drivers.
    Trip updates read the worker's loaded edition and previously committed vehicle facts.
    Older disposable b1 files lack the trip table and must be rebuilt.
    """
    with local.transaction() as conn:
        local.verify_fact_tables(_DEFINITIONS)
        capture = parsed.capture
        _validate_capture(parsed)
        if conn.execute("SELECT provider_id FROM meta").fetchall() != [(capture.provider_id,)]:
            raise LocalFileMismatch("capture provider differs from local file")
        timezone = ZoneInfo(provider_timezone)
        digest = _fingerprint(parsed, provider_timezone)
        identity = [capture.provider_id, capture.endpoint_key, capture.capture_row_id]
        previous = conn.execute(
            "SELECT application_sha256 FROM fact_processing "
            "WHERE provider_id=? AND endpoint_key=? AND capture_row_id=?",
            identity,
        ).fetchall()
        if previous:
            if previous != [(digest,)]:
                raise LocalFileMismatch(
                    "capture identity has different content or projection context"
                )
            return 0
        is_trip = capture.endpoint_key == "trip_updates"
        rows = _trip_rows(local, parsed, timezone) if is_trip else _vehicle_rows(parsed, timezone)
        table = "fact_trip_delay_snapshot" if is_trip else "fact_vehicle_snapshot"
        columns = TRIP_COLUMNS if is_trip else VEHICLE_COLUMNS
        if rows:
            conn.executemany(
                f"INSERT INTO {table} VALUES (" + ", ".join("?" for _ in columns) + ")",
                rows,
            )
        conn.execute(
            "INSERT INTO fact_processing VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                *identity,
                capture.sha256,
                digest,
                _utc(capture.captured_at_utc),
                _utc(capture.feed_timestamp_utc),
                len(rows),
            ],
        )
        return len(rows)


def read_vehicle_facts(local: LocalFile) -> Frame:
    """Detached explicit-column facts in primary-key order, with aware UTC stamps."""
    with local.transaction() as conn:
        local.verify_fact_tables(_DEFINITIONS)
        names = tuple(n for n, _ in VEHICLE_COLUMNS)
        rows = conn.execute(
            "SELECT " + ", ".join(names) + " FROM fact_vehicle_snapshot "
            "ORDER BY provider_id, realtime_snapshot_id, entity_index"
        ).fetchall()
        return Frame(
            "fact_vehicle_snapshot",
            names,
            tuple(
                tuple(v.replace(tzinfo=UTC) if isinstance(v, datetime) else v for v in row)
                for row in rows
            ),
        )


def _trip_rows(
    local: LocalFile, parsed: ParsedCapture, timezone: ZoneInfo
) -> list[tuple[object, ...]]:
    conn = local.connection
    try:
        edition = loaded_edition(conn)
    except Exception as exc:
        raise EditionMissing("trip facts require a loaded edition") from exc
    if edition is None or edition.provider_id != parsed.capture.provider_id:
        raise EditionMissing("trip facts require the provider's loaded edition")
    schedule = {}
    for trip, seq, arrival, departure, stop in conn.execute(
        "SELECT trip_id, stop_sequence, arrival_time, departure_time, stop_id "
        "FROM edition_stop_times"
    ).fetchall():
        _reject_nul((trip, arrival, departure, stop), "edition_stop_times")
        if (trip, seq) in schedule:
            raise ValueError("duplicate edition stop key")
        schedule[trip, seq] = (arrival or departure, stop)
    entities = parsed.frames["rt_entities"]
    ids = {r[0]: r[1] for r in entities.rows}
    if len(ids) != len(entities.rows) or len(ids) != parsed.entity_count:
        raise ValueError("parsed entity count or keys differ")
    stops: dict[object, list[dict[str, Any]]] = {}
    frame = parsed.frames["rt_trip_update_stop_times"]
    for values in frame.rows:
        item = dict(zip(frame.columns, values, strict=True))
        stops.setdefault(item["entity_index"], []).append(item)
    result = []
    frame = parsed.frames["rt_trip_updates"]
    for values in frame.rows:
        trip_row = dict(zip(frame.columns, values, strict=True))
        result.append(_trip_row(conn, parsed, timezone, trip_row, ids, stops, schedule))
    return result


def _trip_row(
    conn: Any,
    parsed: ParsedCapture,
    timezone: ZoneInfo,
    trip: dict[str, Any],
    ids: dict[Any, Any],
    stops: dict[Any, Any],
    schedule: dict[Any, Any],
) -> tuple[object, ...]:
    capture = parsed.capture
    index = trip["entity_index"]
    if index not in ids:
        raise ValueError("trip entity missing")
    if (trip["feed_timestamp_utc"], trip["captured_at_utc"]) != (
        capture.feed_timestamp_utc,
        capture.captured_at_utc,
    ):
        raise ValueError("trip timestamps differ from capture")
    updates = stops.get(index, [])
    candidates = _delay_candidates(trip, updates, schedule, timezone, capture.feed_timestamp_utc)
    chosen = min(candidates) if candidates else None
    vehicle = _matched_vehicle(conn, trip, parsed)
    day = capture.feed_timestamp_utc.astimezone(timezone).date()
    row = dict(
        provider_id=capture.provider_id,
        realtime_snapshot_id=capture.capture_row_id,
        entity_index=index,
        snapshot_date_key=day.year * 10000 + day.month * 100 + day.day,
        snapshot_local_date=day,
        feed_timestamp_utc=capture.feed_timestamp_utc,
        captured_at_utc=capture.captured_at_utc,
        entity_id=ids[index],
        trip_schedule_relationship=trip["schedule_relationship"],
        vehicle_id=vehicle[0] if vehicle else None,
        occupancy_status=vehicle[1] if vehicle else None,
        delay_seconds=chosen[1] if chosen else None,
        delay_stop_id=chosen[2] if chosen else None,
        delay_stop_sequence=chosen[3] if chosen else None,
        stop_time_update_count=len(updates),
        skipped_stop_count=sum(s["schedule_relationship"] == 1 for s in updates),
    )
    return tuple(_utc(row[n] if n in row else trip[n]) for n, _ in TRIP_COLUMNS)


def read_trip_facts(local: LocalFile) -> Frame:
    """Detached trip-delay facts, ordered by primary key with exact UTC stamps."""
    with local.transaction() as conn:
        local.verify_fact_tables(_DEFINITIONS)
        names = tuple(n for n, _ in TRIP_COLUMNS)
        rows = conn.execute(
            "SELECT " + ", ".join(names) + " FROM fact_trip_delay_snapshot "
            "ORDER BY provider_id, realtime_snapshot_id, entity_index"
        ).fetchall()
        return Frame(
            "fact_trip_delay_snapshot",
            names,
            tuple(
                tuple(v.replace(tzinfo=UTC) if isinstance(v, datetime) else v for v in row)
                for row in rows
            ),
        )


def _delay_candidates(
    trip: dict[str, Any],
    updates: list[dict[str, Any]],
    schedule: dict[Any, Any],
    timezone: ZoneInfo,
    feed_timestamp: datetime,
) -> list[Any]:
    candidates = []
    for stop in updates:
        scheduled, schedule_stop = schedule.get(
            (trip["trip_id"], stop["stop_sequence"]), (None, None)
        )
        stamp = stop["arrival_time_utc"] or stop["departure_time_utc"]
        if scheduled is None or stamp is None or trip["start_date"] is None:
            continue
        hours, minutes, seconds = map(int, scheduled.split(":"))
        anchor = datetime.combine(trip["start_date"], time(12), timezone).astimezone(UTC)
        expected = anchor + timedelta(hours=hours - 12, minutes=minutes, seconds=seconds)
        delta = stamp - expected
        # Integer arithmetic preserves seconds exactly, including negative delays.
        delay = delta.days * 86400 + delta.seconds
        if delta.microseconds or not -(2**31) <= delay < 2**31:
            raise ValueError("delay_seconds outside INTEGER or fractional")
        distance = stamp - feed_timestamp
        key = (
            stamp < feed_timestamp,
            abs(distance),
            stop["stop_sequence"] is None,
            stop["stop_sequence"],
            stop["stop_time_update_index"],
        )
        candidates.append((key, delay, stop["stop_id"] or schedule_stop, stop["stop_sequence"]))
    return candidates


def _matched_vehicle(conn: Any, trip: dict[str, Any], parsed: ParsedCapture) -> Any:
    capture = parsed.capture
    return conn.execute(
        "SELECT vehicle_id, occupancy_status FROM fact_vehicle_snapshot "
        "WHERE provider_id=? AND trip_id=? AND vehicle_id IS NOT NULL "
        "AND (? IS NULL OR route_id=?) AND feed_timestamp_utc BETWEEN ? AND ? "
        "ORDER BY abs(epoch(feed_timestamp_utc - ?)), realtime_snapshot_id DESC, "
        "entity_index LIMIT 1",
        [
            capture.provider_id,
            trip["trip_id"],
            trip["route_id"],
            trip["route_id"],
            _utc(capture.feed_timestamp_utc - timedelta(minutes=10)),
            _utc(capture.feed_timestamp_utc + timedelta(minutes=10)),
            _utc(capture.feed_timestamp_utc),
        ],
    ).fetchone()
