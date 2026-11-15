"""Service-day span and feed-day skipped stops through the batch seam."""

from collections.abc import Mapping
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.gold import rollups
from transit_ops.sql_registry import named_query

_PREFIX = "batch.span_skipped_stops"
_NAMES = ("route_service_span_daily", "route_skipped_stop_daily")
_KEY = ("provider_id", "provider_local_date", "route_id")
_COLUMNS = (
    "first_trip_start_utc TIMESTAMPTZ, last_trip_start_utc TIMESTAMPTZ, "
    "service_span_min INTEGER, first_trip_delay_seconds INTEGER, "
    "last_trip_delay_seconds INTEGER, trip_count INTEGER DEFAULT 0 NOT NULL",
    "stop_time_update_count BIGINT DEFAULT 0 NOT NULL, "
    "skipped_stop_count BIGINT DEFAULT 0 NOT NULL, skipped_stop_rate_pct DECIMAL(5,2)",
)


def _upsert(index: int) -> TextClause:
    source = (rollups.UPSERT_ROUTE_SERVICE_SPAN_DAILY, rollups.UPSERT_ROUTE_SKIPPED_STOP_DAILY)
    sql = str(source[index]).split("\n", 1)[1]
    # DuckDB's default binary collation is PostgreSQL C; strftime replaces to_char.
    sql = sql.replace(' COLLATE "C"', "")
    sql = sql.replace(
        "to_char((CAST(:local_date AS date) - 1), 'YYYYMMDD')",
        "strftime((CAST(:local_date AS date) - 1), '%Y%m%d')",
    )
    if index == 1:
        # Nonnegative counts: round the percentage's hundredths as integers,
        # then scale exactly. DuckDB decimal division would still produce DOUBLE.
        sql = sql.replace(
            """ROUND(
            100.0 * SUM(f.skipped_stop_count) / NULLIF(SUM(f.stop_time_update_count), 0),
            2
        )""",
            """((SUM(f.skipped_stop_count)::HUGEINT * 20000
                  + SUM(f.stop_time_update_count)::HUGEINT)
                 // NULLIF(SUM(f.stop_time_update_count)::HUGEINT * 2, 0))
                ::DECIMAL(5,0) * 0.01::DECIMAL(3,2)""",
        )
    return named_query(f"{_PREFIX}.{_NAMES[index]}.upsert", sql)


def _span_day_covered(session: BatchSession, request: BuildRequest, run_day: date) -> bool:
    # Match PostgreSQL's observed feed-day calendar (rollups.py:70-105).
    # An offset-1 span is incomplete until its next observation day is closed and present.
    if run_day >= request.as_of_utc.astimezone(ZoneInfo(request.timezone)).date():
        return False
    return bool(
        session.execute(
            named_query(
                f"{_PREFIX}.span_day_covered",
                "SELECT EXISTS (SELECT 1 FROM gold.fact_trip_delay_snapshot "
                "WHERE provider_id = :provider_id AND snapshot_date_key = :date_key)",
            ),
            dict(provider_id=request.provider_id, date_key=int(run_day.strftime("%Y%m%d"))),
        ).scalar_one()
    )


class SpanSkippedStopsBuilder:
    family_id = "span_skipped_stops"
    tables = tuple(f"gold.{name}" for name in _NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
        zone = ZoneInfo(request.timezone)
        for day in request.local_dates:
            first = datetime.combine(day, time(), zone).astimezone(UTC)
            if first - timedelta(days=1) < cutoff:
                raise ValueError(
                    f"retention_edge_day {day.isoformat()}: cutoff={cutoff.isoformat()}"
                )
        # R26/R26a: feed predicates allow late captures through the stamp, plus skew.
        # The span reads feed day D and D+1; utc_days owns local/UTC coverage.
        first_day = date.fromisoformat(utc_days(request, after_days=1)[0]) - timedelta(days=1)
        return tuple(
            InputNeed("gold.fact_trip_delay_snapshot", (first_day + timedelta(days=i)).isoformat())
            for i in range((request.as_of_utc.date() - first_day).days + 1)
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        tables = {}
        for index, relation in enumerate(self.tables):
            # DDL: 0093_alert_publication_provenance.py:1275-1295; PKs:1838-1843.
            session.execute(
                named_query(
                    f"{_PREFIX}.{_NAMES[index]}.create",
                    f"CREATE TABLE {relation} (provider_id TEXT NOT NULL, "
                    "provider_local_date DATE NOT NULL, route_id TEXT NOT NULL, "
                    f"{_COLUMNS[index]}, built_at_utc TIMESTAMPTZ NOT NULL, "
                    f"PRIMARY KEY ({', '.join(_KEY)}))",
                )
            )
            statement = _upsert(index)
            for day in request.local_dates:
                run_day = day + timedelta(days=1 if index == 0 else 0)
                if index == 0 and not _span_day_covered(session, request, run_day):
                    continue
                session.execute(
                    statement,
                    dict(
                        provider_id=request.provider_id,
                        local_date=run_day,
                        date_key=int(run_day.strftime("%Y%m%d")),
                        built_at_utc=request.as_of_utc,
                    ),
                )
            result = session.execute(
                named_query(
                    f"{_PREFIX}.{_NAMES[index]}.read",
                    f"SELECT * FROM {relation} ORDER BY {', '.join(_KEY)}",
                )
            )
            tables[relation] = TableRows(relation, result.columns, _KEY, tuple(map(tuple, result)))
        return FamilyOutput(tables, {})


builder = SpanSkippedStopsBuilder()
