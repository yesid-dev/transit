"""Compute corrected scheduled headways without publishing them."""

from collections import defaultdict
from collections.abc import Sequence

from sqlalchemy import Connection
from sqlalchemy.engine import RowMapping

from transit_ops.snapshots.builders._helpers import (
    _SHIFT_ORDER,
    _SHIFT_WINDOWS,
    StaticScheduleContext,
    _gtfs_min,
    _infer_shift,
    _median_headway,
    _shift_sort_min,
)
from transit_ops.snapshots.contract_static_r3 import StaticHeadwayPeriod, StaticRouteR3
from transit_ops.sql_registry import named_query

_HEADWAYS_SQL = named_query(
    "static.r3_headways",
    """
    SELECT t.route_id, t.direction_id,
           (t.service_id = ANY(:weekday_services)) AS is_weekday,
           first_stop.departure_time
    FROM silver.trips t
    LEFT JOIN LATERAL (
        -- NULL departures must not promote a later stop to first.
        SELECT st.departure_time
        FROM silver.stop_times st
        WHERE st.provider_id = t.provider_id
          AND st.dataset_version_id = t.dataset_version_id
          AND st.trip_id = t.trip_id
        ORDER BY st.stop_sequence
        LIMIT 1
    ) first_stop ON true
    WHERE t.provider_id = :provider_id
      AND t.dataset_version_id = :dataset_version_id
      AND (CAST(:route_id AS text) IS NULL OR t.route_id = :route_id)
      AND (t.service_id = ANY(:weekday_services) OR t.service_id = ANY(:weekend_services))
    """,
)


def _periods(rows: Sequence[RowMapping]) -> list[StaticHeadwayPeriod] | None:
    weekday: dict[int, list[str]] = defaultdict(list)
    weekend: list[str] = []
    for row in rows:
        if row["departure_time"] is None:
            continue
        departure = str(row["departure_time"])
        if row["is_weekday"]:
            weekday[int(str(row["direction_id"] or 0))].append(departure)
        else:
            weekend.append(departure)
    periods = []
    if weekday:
        direction = min(weekday, key=lambda d: (-len(set(weekday[d])), d))
        shifts: dict[str, list[str]] = defaultdict(list)
        for departure in set(weekday[direction]):
            shifts[_infer_shift((_gtfs_min(departure) // 60) % 24)].append(departure)
        for shift in _SHIFT_ORDER:
            if bucket := shifts.get(shift):
                periods.append(
                    StaticHeadwayPeriod(
                        shift=shift,
                        window=_SHIFT_WINDOWS[shift],
                        headway_min=_median_headway([_shift_sort_min(t, shift) for t in bucket]),
                    )
                )
    if weekend:
        periods.append(
            StaticHeadwayPeriod(
                shift="weekend",
                headway_min=_median_headway([_gtfs_min(t) % 1440 for t in set(weekend)]),
            )
        )
    return periods or None


def build_route_headways_r3(
    conn: Connection,
    *,
    provider_id: str,
    static_context: StaticScheduleContext,
    route_id: str | None = None,
) -> dict[str, StaticRouteR3]:
    """Read one edition in one SELECT; absent bulk routes are omitted.

    A requested route always has a value, with null headway when unusable.
    The caller owns the connection and transaction.
    """
    grouped: dict[str, list[RowMapping]] = defaultdict(list)
    if route_id is not None:
        grouped[route_id] = []
    if static_context.dataset_version_id is not None:
        rows = conn.execute(
            _HEADWAYS_SQL,
            {
                "provider_id": provider_id,
                "dataset_version_id": static_context.dataset_version_id,
                "route_id": route_id,
                "weekday_services": list(static_context.weekday_services),
                "weekend_services": list(static_context.weekend_services),
            },
        ).mappings()
        for row in rows:
            grouped[str(row["route_id"])].append(row)
    return {key: StaticRouteR3(headway=_periods(rows)) for key, rows in sorted(grouped.items())}
