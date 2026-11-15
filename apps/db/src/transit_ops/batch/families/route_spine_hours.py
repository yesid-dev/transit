"""Route summaries, reporting hours and closed-day spine from declared evidence."""

from collections.abc import Mapping
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from typing import cast
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.batch.families.route_spine_hours_sql import (
    DDL,
    KEYS,
    MEAN,
    NAMES,
    cohort,
    cohort_bad_counts,
    hourly,
    port,
    query,
    spine,
    summary,
)
from transit_ops.gold import delay_hours, delay_periods

_STATE = (
    "core.providers",
    "core.feed_endpoints",
    "raw.ingestion_runs",
    "raw.ingestion_objects",
    "silver.rt_feed_snapshots",
    "silver.rt_entities",
    "silver.rt_trip_updates",
)


def _bounds(request: BuildRequest, day: date) -> tuple[datetime, datetime]:
    zone = ZoneInfo(request.timezone)
    start = datetime.combine(day, time(), zone)
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


@lru_cache(maxsize=256)
def _check_hour_offsets(timezone: str, day: date) -> None:
    zone = ZoneInfo(timezone)
    start = datetime.combine(day, time(), zone).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
    # TZif transitions have whole-second resolution. Include transitions within the day,
    # even when both local midnights would otherwise appear to have supported offsets.
    for second in range(int((end - start).total_seconds())):
        instant = start + timedelta(seconds=second)
        offset = cast(timedelta, instant.astimezone(zone).utcoffset())
        if offset % timedelta(hours=1):
            raise ValueError(f"fractional_utc_offset {timezone} {day}")


def _complete_period(session: BatchSession, request: BuildRequest, period: datetime) -> bool:
    params = dict(
        provider_id=request.provider_id, from_utc=period, until_utc=period + timedelta(minutes=5)
    )
    if session.execute(cohort_bad_counts(), params).scalar_one():
        raise ValueError(
            "Retained capture evidence is incomplete: entity_count must be "
            f"an exact JSON integer for {period.isoformat()}"
        )
    return bool(session.execute(cohort(), params).scalar_one())


def _prepare(session: BatchSession, provider_id: str) -> None:
    session.execute(
        query(
            "provider",
            "CREATE VIEW gold.dim_provider AS SELECT provider_id, timezone FROM core.providers",
        )
    )
    session.execute(MEAN)
    for index, name in enumerate((*NAMES[:2], "warm_rollup_periods")):
        relation = f"gold.{name}"
        session.execute(
            query(
                f"{name}.prior",
                f"CREATE TEMP TABLE prior_{name} AS "
                f"SELECT * FROM {relation} WHERE provider_id = :provider_id",
            ),
            {"provider_id": provider_id},
        )
        session.execute(query(f"{name}.drop", f"DROP VIEW {relation}"))
        ddl = (
            DDL[index]
            if index < 2
            else (
                "provider_id TEXT NOT NULL, rollup_kind TEXT NOT NULL, "
                "period_start_utc TIMESTAMPTZ NOT NULL, built_at_utc TIMESTAMPTZ NOT NULL, "
                "invalidated_at_utc TIMESTAMPTZ"
            )
        )
        key = KEYS[index] if index < 2 else ("provider_id", "rollup_kind", "period_start_utc")
        session.execute(
            query(
                f"{name}.create", f"CREATE TABLE {relation} ({ddl}, PRIMARY KEY ({', '.join(key)}))"
            )
        )
        session.execute(query(f"{name}.copy", f"INSERT INTO {relation} SELECT * FROM prior_{name}"))
    session.execute(
        query(
            "spine.create",
            f"CREATE TABLE gold.route_delay_spine ({DDL[2]}, PRIMARY KEY ({', '.join(KEYS[2])}))",
        )
    )


def _periods(session: BatchSession, request: BuildRequest, start: datetime, end: datetime) -> None:
    params = dict(
        provider_id=request.provider_id,
        since_utc=start,
        closed_before=end,
        repair_premature=False,
    )
    periods = (
        session.execute(port("missing", delay_periods.SELECT_MISSING_TRIP_DELAY_PERIODS), params)
        .scalars()
        .all()
    )
    incomplete = []
    for value in periods:
        period = cast(datetime, value)
        binds = dict(
            provider_id=request.provider_id, period_start_utc=period, built_at_utc=request.as_of_utc
        )
        needs_proof = session.execute(
            port("needs_proof", delay_periods._REPLACEMENT_NEEDS_PROOF), binds
        ).scalar_one()
        if needs_proof and not _complete_period(session, request, period):
            incomplete.append(period.isoformat())
            continue
        session.execute(port("delete_period", delay_periods._DELETE_PERIOD_SUMMARIES), binds)
        session.execute(summary(), binds)
        session.execute(
            port("watermark", delay_periods.UPSERT_WARM_ROLLUP_PERIOD),
            {**binds, "rollup_kind": "trip_delay_summary_5m"},
        )
    if incomplete:
        raise ValueError(
            "Retained capture evidence is incomplete for delay periods: "
            + ", ".join(incomplete)
            + "; previous summaries were preserved"
        )


def _hours(session: BatchSession, request: BuildRequest, start: datetime, end: datetime) -> None:
    params = dict(provider_id=request.provider_id, from_utc=start, until_utc=end)
    dirty = session.execute(port("dirty_hours", delay_hours._DIRTY_HOURS), params).scalars().all()
    cutoff = request.as_of_utc.replace(minute=0, second=0, microsecond=0) - timedelta(
        days=request.open_window_days
    )
    hours = (
        session.execute(
            query(
                "open_hours",
                """
        SELECT DISTINCT date_trunc('hour', period_start_utc) FROM (
          SELECT period_start_utc FROM gold.trip_delay_summary_5m WHERE provider_id=:provider_id
          UNION ALL SELECT period_start_utc FROM gold.route_delay_hourly
          WHERE provider_id=:provider_id
        ) WHERE period_start_utc >= :from_utc AND period_start_utc < :until_utc
          AND period_start_utc >= :cutoff ORDER BY 1
    """,
            ),
            {**params, "cutoff": cutoff},
        )
        .scalars()
        .all()
    )
    for hour in sorted({cast(datetime, value) for value in dirty + hours}):
        binds = dict(
            provider_id=request.provider_id,
            hour=hour,
            built_at_utc=request.as_of_utc,
            materialized_at_utc=request.as_of_utc,
        )
        latest = session.execute(
            query(
                "child_clock",
                """
            SELECT MAX(built_at_utc) FROM gold.warm_rollup_periods WHERE provider_id=:provider_id
              AND rollup_kind='trip_delay_summary_5m' AND invalidated_at_utc IS NULL
              AND period_start_utc >= :hour AND period_start_utc < :hour + INTERVAL '1 hour'
        """,
            ),
            binds,
        ).scalar_one()
        if latest is not None and cast(datetime, latest) > request.as_of_utc:
            raise ValueError(f"child period built after as_of_utc: {hour}")
        session.execute(port("delete_hour", delay_hours._DELETE_HOUR), binds)
        session.execute(hourly(), binds)


class RouteSpineHoursBuilder:
    family_id = "route_spine_hours"
    tables = tuple(f"gold.{name}" for name in NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        # All fact predicates in this family use capture time, never feed-day keys.
        cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
        for day in request.local_dates:
            _check_hour_offsets(request.timezone, day)
            if _bounds(request, day)[0] < cutoff:
                raise ValueError(f"retention_edge_day {day}: cutoff={cutoff.isoformat()}")
        days = utc_days(request)
        return (
            tuple(InputNeed(name, "all") for name in _STATE)
            + tuple(
                InputNeed(name, day)
                for name in (
                    "gold.fact_trip_delay_snapshot",
                    "raw.realtime_snapshot_index",
                    "gold.warm_rollup_periods",
                )
                for day in days
            )
            + tuple(
                InputNeed(name, f"local:{day}")
                for name in self.tables[:2]
                for day in request.local_dates
            )
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        _prepare(session, request.provider_id)
        for day in request.local_dates:
            start, end = _bounds(request, day)
            _periods(session, request, start, end)
            _hours(session, request, start, end)
            session.execute(
                spine(),
                dict(
                    provider_id=request.provider_id, local_date=day, built_at_utc=request.as_of_utc
                ),
            )
        tables = {}
        for index, relation in enumerate(self.tables):
            # LS2.2 reads PostgreSQL arrays as their exact array-output text.
            projection = (
                "* REPLACE (CASE WHEN delay_histogram IS NULL THEN NULL ELSE "
                "'{' || array_to_string(delay_histogram, ',') || '}' END AS "
                "delay_histogram)"
                if index == 2
                else "*"
            )
            result = session.execute(
                query(
                    f"{NAMES[index]}.read",
                    f"SELECT {projection} FROM {relation} ORDER BY {', '.join(KEYS[index])}",
                )
            )
            rows = tuple(map(tuple, result))
            for row in rows:
                for column, value in zip(result.columns, row, strict=True):
                    if isinstance(value, str) and "\0" in value:
                        raise ValueError(f"NUL in {relation}.{column}")
            tables[relation] = TableRows(relation, result.columns, KEYS[index], rows)
        return FamilyOutput(tables, {})


builder = RouteSpineHoursBuilder()
