from datetime import date
from typing import Literal

type SeriesGroup = Literal[
    "day", "hour", "day_type", "weekday_hour", "direction", "stop", "departure", "line"
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
}
DAY_TYPES = ("weekday", "weekday", "weekday", "weekday", "weekday", "saturday", "sunday")
HOUR_GROUPS = ("hour", "weekday_hour")
LOCAL_HOUR = "hour(timezone('America/Toronto', {}))"


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
