from datetime import date
from itertools import pairwise
from typing import Literal

import duckdb

type SeriesGroup = Literal[
    "day",
    "hour",
    "day_type",
    "weekday_hour",
    "direction",
    "stop",
    "departure",
    "line",
    "stop_id",
    "segment",
    "line_stop",
    "stretch",
    "vehicle",
    "effect",
    "cause",
]
type GroupKey = tuple[str | int | None, ...]

GROUP_COLUMNS: dict[SeriesGroup, tuple[str, ...]] = {
    "day": ("day",),
    "hour": ("hour",),
    "day_type": ("day_type",),
    "weekday_hour": ("weekday", "hour"),
    "direction": ("direction",),
    "stop": ("direction", "stop_sequence", "stop"),
    "departure": ("direction", "departure"),
    "line": ("line",),
    "stop_id": ("stop",),
    "segment": ("line", "direction", "from_stop", "to_stop"),
    "line_stop": ("line", "direction", "stop"),
    "stretch": ("from_stop", "to_stop", "pieces", "piece"),
    "vehicle": ("vehicle",),
    "effect": ("effect",),
    "cause": ("cause",),
}
DAY_TYPES = ("weekday", "weekday", "weekday", "weekday", "weekday", "saturday", "sunday")
HOUR_GROUPS = ("hour", "weekday_hour")
LOCAL_HOUR_BUCKET = "time_bucket(INTERVAL '1 hour', {}, getvariable('service_timezone'))"
LOCAL_HOUR = "hour(timezone(getvariable('service_timezone'), {}))"


def local_epoch_us_sql(
    conn: duckdb.DuckDBPyConnection, timestamp: str, start: date, end: date
) -> str:
    fallback = f"epoch_us(timezone(getvariable('service_timezone'), {timestamp}))"
    if start < date(2007, 1, 1):
        return fallback
    # Modern IANA offset transitions are more than a day apart. Use DuckDB's
    # city-specific offsets at the UTC bookends and ICU on transition days.
    # Include overnight service and keep ICU for timestamps outside the lookup.
    midnights = conn.execute(
        """
        SELECT epoch_us(day),
            epoch_us(timezone(getvariable('service_timezone'), timezone('UTC', day)))
                - epoch_us(day)
        FROM generate_series(?::DATE - INTERVAL '2 days', ?::DATE + INTERVAL '3 days',
            INTERVAL '1 day') days(day)
        ORDER BY day
        """,
        [start, end],
    ).fetchall()
    periods: list[tuple[int, int, int]] = []
    for (lo, offset), (hi, next_offset) in pairwise(midnights):
        if offset != next_offset:
            continue
        if periods and periods[-1][1:] == (lo, offset):
            periods[-1] = (periods[-1][0], hi, offset)
        else:
            periods.append((lo, hi, offset))
    epoch = f"epoch_us({timestamp})"
    clauses = " ".join(
        f"WHEN {epoch} >= {lo} AND {epoch} < {hi} THEN {epoch} + ({offset})"
        for lo, hi, offset in periods
    )
    return f"(CASE {clauses} ELSE {fallback} END)" if clauses else fallback


def local_hour_sql(conn: duckdb.DuckDBPyConnection, timestamp: str, start: date, end: date) -> str:
    if start < date(2007, 1, 1):
        return LOCAL_HOUR.format(timestamp)
    local_us = local_epoch_us_sql(conn, timestamp, start, end)
    return f"(({local_us} // 3600000000) % 24)"


def day_type_sql(day: str) -> str:
    return f"CASE isodow({day}) WHEN 6 THEN 'saturday' WHEN 7 THEN 'sunday' ELSE 'weekday' END"


def series_sql(group: SeriesGroup, hour: str, day: str = "service_date") -> str:
    return {
        "day": f"row({day}::VARCHAR)",
        "hour": f"row({hour})",
        "day_type": f"row({day_type_sql(day)})",
        "weekday_hour": f"row(isodow({day}), {hour})",
        "direction": "row(direction_id)",
        "stop": "row(direction_id, stop_sequence, stop_id)",
        "line": "row(route_id)",
        "stop_id": "row(stop_id)",
        "segment": "row(route_id, direction_id, from_stop, to_stop)",
        "line_stop": "row(route_id, direction_id, stop_id)",
        "stretch": "row(from_stop, to_stop, pieces, piece)",
    }[group]


def matches_date(group: SeriesGroup, key: GroupKey, day: str) -> bool:
    if group == "day":
        return day == key[0]
    if group == "day_type":
        return DAY_TYPES[date.fromisoformat(day).weekday()] == key[0]
    if group == "weekday_hour":
        return date.fromisoformat(day).isoweekday() == key[0]
    return True
