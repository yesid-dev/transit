from datetime import date
from itertools import pairwise
from typing import Literal

import duckdb

type SeriesGroup = Literal[
    "day", "hour", "day_type", "weekday_hour", "direction", "stop", "departure", "line", "vehicle"
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
    "vehicle": ("vehicle",),
}
DAY_TYPES = ("weekday", "weekday", "weekday", "weekday", "weekday", "saturday", "sunday")
HOUR_GROUPS = ("hour", "weekday_hour")
LOCAL_HOUR = "hour(timezone('America/Toronto', {}))"


def local_hour_sql(conn: duckdb.DuckDBPyConnection, timestamp: str, start: date, end: date) -> str:
    fallback = LOCAL_HOUR.format(timestamp)
    if start < date(2007, 1, 1):
        return fallback
    # Modern Toronto changes its offset at most once per UTC day. Use DuckDB's
    # own timezone rules at the bookends, leaving the transition days to ICU.
    # Include overnight service and keep ICU for timestamps outside the lookup.
    midnights = conn.execute(
        """
        SELECT epoch_us(day),
            epoch_us(timezone('America/Toronto', timezone('UTC', day))) - epoch_us(day)
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
        f"WHEN {epoch} >= {lo} AND {epoch} < {hi} THEN (({epoch} + ({offset})) // 3600000000) % 24"
        for lo, hi, offset in periods
    )
    return f"(CASE {clauses} ELSE {fallback} END)" if clauses else fallback


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
    }[group]


def matches_date(group: SeriesGroup, key: GroupKey, day: str) -> bool:
    if group == "day":
        return day == key[0]
    if group == "day_type":
        return DAY_TYPES[date.fromisoformat(day).weekday()] == key[0]
    if group == "weekday_hour":
        return date.fromisoformat(day).isoweekday() == key[0]
    return True
