"""Math-first local vehicle facts; trip-delay projection belongs to LS3.5b2.

The supplied LocalFile owns the transaction. No edition or PostgreSQL read,
serving admission, raw durability claim or wall clock is involved here.
"""

import json
from dataclasses import asdict
from datetime import UTC, date, datetime
from hashlib import sha256
from zoneinfo import ZoneInfo

from transit_ops.live.captures import FRAME_COLUMNS, Frame, ParsedCapture
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
_DEFINITIONS = {
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
    if capture.endpoint_key != "vehicle_positions":
        raise ValueError("only vehicle_positions fact projection is implemented")
    if type(capture.capture_row_id) is not int or not 0 < capture.capture_row_id < 2**63:
        raise ValueError("capture identity must be a positive BIGINT")
    _utc(capture.captured_at_utc)
    _utc(capture.feed_timestamp_utc)
    if set(parsed.frames) != {"rt_entities", "rt_vehicle_positions"}:
        raise ValueError("vehicle capture requires entity and vehicle frames")
    for name, frame in parsed.frames.items():
        _reject_nul(frame.rows, name)
        columns = FRAME_COLUMNS[name]
        if frame.table != name or frame.columns != columns:
            raise ValueError(f"{name}: parsed frame contract differs")
        if any(len(row) != len(columns) for row in frame.rows):
            raise ValueError(f"{name}: parsed row width differs")


def apply_capture(local: LocalFile, parsed: ParsedCapture, *, provider_timezone: str) -> int:
    """Apply one parsed vehicle capture, returning inserted facts (zero on retry).

    A changed identity or incompatible file refuses before writing. Failures poison
    an enclosing LocalFile transaction even if a caller catches the exception.
    UTC timestamps are stored at microsecond precision without optional TZ drivers.
    Trip updates refuse until their projection is implemented in LS3.5b2.
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
        rows = _vehicle_rows(parsed, timezone)
        if rows:
            conn.executemany(
                "INSERT INTO fact_vehicle_snapshot VALUES ("
                + ", ".join("?" for _ in VEHICLE_COLUMNS)
                + ")",
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
