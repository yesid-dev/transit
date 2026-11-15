"""Scheduled and observed service days using the caller's explicit schedule edition."""

from collections.abc import Mapping
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.gold import rollups
from transit_ops.sql_registry import named_query

_PREFIX = "batch.cancellations_service_states"
_KEY = ("provider_id", "provider_local_date", "route_id")
_NAMES = ("route_scheduled_trips_daily", "route_cancellation_daily")


def _upsert(scheduled: bool) -> TextClause:
    # Preserve rollups.py:226-396's calendar, service-day filters and full join.
    source = (
        rollups.UPSERT_ROUTE_SCHEDULED_TRIPS_DAILY
        if scheduled
        else rollups.UPSERT_ROUTE_CANCELLATION_DAILY
    )
    sql = str(source).split("\n", 1)[1]
    if scheduled:
        sql = sql.replace("AND is_current = true", "AND dataset_version_id = :edition_id")
    else:
        sql = sql.replace(
            "to_char((CAST(:local_date AS date) + 1), 'YYYYMMDD')",
            "strftime((CAST(:local_date AS date) + 1), '%Y%m%d')",
        )
        # Exact rational rounding to hundredths of a percent; DuckDB / yields DOUBLE.
        # For nonnegative counts, floor((2 * 10000*n + d)/(2*d)) is half-up cents.
        sql = sql.replace(
            "ROUND(100.0 * COUNT(*) FILTER (WHERE was_canceled = 1) / NULLIF(COUNT(*), 0), 2)",
            "CAST(((20000::HUGEINT * COUNT(*) FILTER (WHERE was_canceled = 1) "
            "+ COUNT(*)) // (2::HUGEINT * COUNT(*))) * 0.01 AS DECIMAL(5,2))",
        )
    return named_query(f"{_PREFIX}.{_NAMES[0 if scheduled else 1]}.upsert", sql)


def _create(scheduled: bool) -> TextClause:
    # DDL: 0093:1162-1173,1267-1275; PKs:1807-1809,1835-1837.
    columns = (
        "scheduled_trip_count INTEGER DEFAULT 0 NOT NULL, "
        "dataset_version_id BIGINT NOT NULL, built_at_utc TIMESTAMPTZ NOT NULL"
        if scheduled
        else "total_trip_days INTEGER NOT NULL, canceled_trip_days INTEGER NOT NULL, "
        "cancellation_rate_pct DECIMAL(5,2), built_at_utc TIMESTAMPTZ NOT NULL, "
        "scheduled_trip_days INTEGER, delivered_trip_days INTEGER, silent_trip_days INTEGER"
    )
    name = _NAMES[0 if scheduled else 1]
    return named_query(
        f"{_PREFIX}.{name}.create",
        f"CREATE TABLE gold.{name} (provider_id TEXT NOT NULL, provider_local_date DATE NOT NULL, "
        f"route_id TEXT NOT NULL, {columns}, PRIMARY KEY ({', '.join(_KEY)}))",
    )


class CancellationsServiceStatesBuilder:
    family_id = "cancellations_service_states"
    tables = tuple(f"gold.{name}" for name in _NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        editions = request.edition_by_day or {}
        cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
        for day in request.local_dates:
            if type(editions.get(day)) is not int or editions[day] <= 0:
                raise ValueError(f"edition_unresolved {day.isoformat()}")
            start = datetime.combine(day, time(), ZoneInfo(request.timezone)).astimezone(UTC)
            if start - timedelta(days=1) < cutoff:
                raise ValueError(
                    f"retention_edge_day {day.isoformat()}: cutoff={cutoff.isoformat()}"
                )
        first = date.fromisoformat(utc_days(request)[0]) - timedelta(days=1)
        days = (request.as_of_utc.date() - first).days + 1
        return (
            (InputNeed("core.dataset_versions", "all"),)
            + tuple(
                InputNeed(relation, f"edition:{edition}")
                for relation in ("silver.trips", "silver.calendar", "silver.calendar_dates")
                for edition in sorted({editions[day] for day in request.local_dates})
            )
            + tuple(
                InputNeed("gold.fact_trip_delay_snapshot", (first + timedelta(days=i)).isoformat())
                for i in range(days)
            )
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        tables = {}
        for scheduled, relation in zip((True, False), self.tables, strict=True):
            session.execute(_create(scheduled))
            for day in request.local_dates:
                session.execute(
                    _upsert(scheduled),
                    dict(
                        provider_id=request.provider_id,
                        local_date=day,
                        date_key=int(day.strftime("%Y%m%d")),
                        built_at_utc=request.as_of_utc,
                        edition_id=(request.edition_by_day or {})[day],
                    ),
                )
            result = session.execute(
                named_query(
                    f"{_PREFIX}.{relation.split('.')[1]}.read",
                    f"SELECT * FROM {relation} ORDER BY {', '.join(_KEY)}",
                )
            )
            tables[relation] = TableRows(relation, result.columns, _KEY, tuple(map(tuple, result)))
        return FamilyOutput(tables, {})


builder = CancellationsServiceStatesBuilder()
