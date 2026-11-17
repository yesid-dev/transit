"""Selected computations on already loaded, frozen replay inputs.

The caller owns the disposable database and rolls this transaction back after
reading outputs. Native Gold statements retain their PostgreSQL arithmetic.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import cast
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, text
from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest
from transit_ops.gold import delay_hours, delay_periods, rollups
from transit_ops.gold.delay_cohorts import delay_period_is_complete


def build_reference(conn: Connection, request: BuildRequest, tables: tuple[str, ...]) -> None:
    """Build only selected outputs; input/output overlap carries existing rows."""
    params = dict(
        provider_id=request.provider_id,
        built_at_utc=request.as_of_utc,
        as_of_utc=request.as_of_utc,
        fact_retention_days=request.fact_retention_days,
        open_window_days=request.open_window_days,
        materialized_at_utc=request.as_of_utc,
    )
    selected = {relation.removeprefix("gold.") for relation in tables}
    if "trip_delay_summary_5m" in selected:
        _route_periods_and_hours(conn, request)
    for name in rollups.DAILY_BUILD_ORDER:
        kind = rollups.REBUILDABLE_KINDS[name]
        if kind.table not in selected:
            continue
        for day in request.local_dates:
            run_day = day + timedelta(days=kind.service_day_offset)
            binds = dict(params, local_date=run_day, date_key=int(run_day.strftime("%Y%m%d")))
            if kind.service_day_offset and not _span_covered(conn, request, run_day):
                continue
            conn.execute(cast(TextClause, kind.upsert), binds)
    for name, statement in rollups.REPORTING_AGGREGATE_UPSERTS.items():
        if name not in selected or name == "route_delay_hourly":
            continue
        if name == "stop_delay_hourly":
            conn.execute(rollups.DROP_STOP_DELAY_HOURLY_SOURCE_SUMMARY)
            conn.execute(rollups.CREATE_STOP_DELAY_HOURLY_SOURCE_SUMMARY, params)
            conn.execute(rollups.DELETE_REPORTING_AGGREGATES[name], params)
        conn.execute(statement, params)


def _span_covered(conn: Connection, request: BuildRequest, day: date) -> bool:
    if day >= request.as_of_utc.astimezone(ZoneInfo(request.timezone)).date():
        return False
    return bool(
        conn.execute(
            text(
                "SELECT EXISTS (SELECT 1 FROM gold.fact_trip_delay_snapshot "
                "WHERE provider_id=:provider_id AND snapshot_date_key=:date_key)"
            ),
            dict(provider_id=request.provider_id, date_key=int(day.strftime("%Y%m%d"))),
        ).scalar_one()
    )


def _route_periods_and_hours(conn: Connection, request: BuildRequest) -> None:
    for day in request.local_dates:
        zone = ZoneInfo(request.timezone)
        start = datetime.combine(day, time(), zone).astimezone(UTC)
        end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
        params = dict(
            provider_id=request.provider_id,
            since_utc=start,
            closed_before=end,
            repair_premature=False,
        )
        periods = conn.execute(delay_periods.SELECT_MISSING_TRIP_DELAY_PERIODS, params).scalars()
        for period in periods.all():
            binds = dict(
                provider_id=request.provider_id,
                period_start_utc=period,
                built_at_utc=request.as_of_utc,
            )
            if conn.execute(delay_periods._REPLACEMENT_NEEDS_PROOF, binds).scalar_one():
                if not delay_period_is_complete(conn, request.provider_id, period):
                    raise ValueError(f"Retained capture evidence is incomplete: {period}")
            conn.execute(delay_periods._DELETE_PERIOD_SUMMARIES, binds)
            conn.execute(delay_periods.UPSERT_TRIP_DELAY_SUMMARY_5M, binds)
            conn.execute(
                delay_periods.UPSERT_WARM_ROLLUP_PERIOD,
                dict(binds, rollup_kind="trip_delay_summary_5m"),
            )
        _route_hours(conn, request, start, end)


def _route_hours(conn: Connection, request: BuildRequest, start: datetime, end: datetime) -> None:
    params = dict(provider_id=request.provider_id, from_utc=start, until_utc=end)
    dirty = conn.execute(delay_hours._DIRTY_HOURS, params).scalars().all()
    cutoff = request.as_of_utc.replace(minute=0, second=0, microsecond=0) - timedelta(
        days=request.open_window_days
    )
    hours = (
        conn.execute(
            text("""
        SELECT DISTINCT date_trunc('hour', period_start_utc) FROM (
          SELECT period_start_utc FROM gold.trip_delay_summary_5m WHERE provider_id=:provider_id
          UNION ALL SELECT period_start_utc FROM gold.route_delay_hourly
          WHERE provider_id=:provider_id
        ) AS inputs WHERE period_start_utc >= :from_utc AND period_start_utc < :until_utc
          AND period_start_utc >= :cutoff ORDER BY 1
    """),
            dict(params, cutoff=cutoff),
        )
        .scalars()
        .all()
    )
    for hour in sorted(set(dirty) | set(hours)):
        binds = dict(
            provider_id=request.provider_id,
            hour=hour,
            built_at_utc=request.as_of_utc,
            materialized_at_utc=request.as_of_utc,
        )
        latest = conn.execute(
            text("""
            SELECT MAX(built_at_utc) FROM gold.warm_rollup_periods WHERE provider_id=:provider_id
              AND rollup_kind='trip_delay_summary_5m' AND invalidated_at_utc IS NULL
              AND period_start_utc >= :hour AND period_start_utc < :hour + INTERVAL '1 hour'
        """),
            binds,
        ).scalar_one()
        if latest is not None and latest > request.as_of_utc:
            raise ValueError(f"child period built after as_of_utc: {hour}")
        conn.execute(delay_hours._DELETE_HOUR, binds)
        conn.execute(delay_hours._REPLACE_HOUR, binds)
