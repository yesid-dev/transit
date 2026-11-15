"""Capture-day entity evidence and weekly route/stop problems (LS2.12a-b)."""

import re
from collections.abc import Mapping
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.batch.sanity import Invariant
from transit_ops.gold import rollups
from transit_ops.gold.delay_periods import GHOST_DELAY_ABS_SECONDS
from transit_ops.sql_registry import named_query

_NAMES = ("repeat_offender_daily_spine", "repeated_problem_route_stop")
_KEYS = (
    ("provider_id", "entity_kind", "entity_id", "route_id", "provider_local_date"),
    ("provider_id", "entity_kind", "entity_id", "route_id", "period_grain", "period_start_local"),
)


def _query(name: str, sql: str) -> TextClause:
    return named_query(f"batch.repeat_offenders.{name}", sql)


def _upsert(index: int) -> TextClause:
    source = (
        rollups.UPSERT_REPEAT_OFFENDER_DAILY_SPINE,
        rollups.UPSERT_REPEATED_PROBLEM_ROUTE_STOP,
    )
    sql = str(source[index]).split("\n", 1)[1]
    if index == 0:
        sql = sql.replace(
            f"ABS(f.delay_seconds) <= {GHOST_DELAY_ABS_SECONDS}",
            f"f.delay_seconds BETWEEN -{GHOST_DELAY_ABS_SECONDS} AND {GHOST_DELAY_ABS_SECONDS}",
        )
    else:
        # rollups.py:1151-1155,1180-1184: numeric(12,2) pooled mean.
        # Integer half-away-from-zero avoids DuckDB's DOUBLE decimal division.
        for alias, denominator in (
            ("sp", "SUM((SELECT COALESCE(SUM(x), 0) FROM unnest(sp.delay_histogram) AS u(x)))"),
            ("s", "SUM(s.observation_count)"),
        ):
            total = f"SUM({alias}.sum_delay_seconds)::HUGEINT"
            count = f"NULLIF({denominator}::HUGEINT, 0)"
            cents = (
                f"SIGN({total}) * ((ABS({total}) * 100 // {count}) + "
                f"CASE WHEN (ABS({total}) * 100 % {count}) * 2 >= {count} "
                "THEN 1 ELSE 0 END)"
            )
            sql = re.sub(
                r"ROUND\(\s+SUM\(" + alias + r"\.sum_delay_seconds\).*?\n\s+2\s+\)",
                f"({cents})::DECIMAL(12,0) * 0.01::DECIMAL(3,2)",
                sql,
                count=1,
                flags=re.S,
            )
    return _query(f"{_NAMES[index]}.upsert", sql)


class RepeatOffendersBuilder:
    family_id = "repeat_offenders"
    tables = tuple(f"gold.{name}" for name in _NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}
    # Means and sums may be negative; entities overlap, so kinds are not a partition.
    invariants = (
        Invariant(tables[0], "count", ("observation_count", "severe_delay_count")),
        Invariant(tables[1], "count", ("issue_count",)),
    )

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        zone = ZoneInfo(request.timezone)
        cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
        for day in request.local_dates:
            if datetime.combine(day, time(), zone).astimezone(UTC) < cutoff:
                raise ValueError(f"retention_edge_day {day.isoformat()}")
        # Complete each affected ISO week, including days outside the daily request.
        # Daily spines exist only for closed local days.
        today = request.as_of_utc.astimezone(zone).date()
        days = sorted(
            {
                day - timedelta(days=day.weekday()) + timedelta(days=i)
                for day in request.local_dates
                for i in range(7)
                if day - timedelta(days=day.weekday()) + timedelta(days=i) < today
            }
        )
        return (
            (InputNeed("core.providers", "all"),)
            + tuple(InputNeed("gold.fact_trip_delay_snapshot", day) for day in utc_days(request))
            + tuple(
                InputNeed(f"gold.{kind}_delay_spine", f"local:{day}")
                for kind in ("route", "stop")
                for day in days
            )
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        session.execute(
            _query(
                "provider",
                "CREATE VIEW gold.dim_provider AS SELECT provider_id, timezone FROM core.providers",
            )
        )
        tables = {}
        for index, relation in enumerate(self.tables):
            # Migration 0093:1132-1154; primary keys:1799-1805.
            common = (
                "provider_id TEXT NOT NULL, entity_kind TEXT NOT NULL, "
                "entity_id TEXT NOT NULL, route_id TEXT NOT NULL, "
            )
            columns = (
                "provider_local_date DATE NOT NULL, observation_count INTEGER NOT NULL DEFAULT 0, "
                "severe_delay_count INTEGER NOT NULL DEFAULT 0, "
                "sum_delay_seconds BIGINT NOT NULL DEFAULT 0",
                "period_grain TEXT NOT NULL, period_start_local DATE NOT NULL, "
                "issue_count INTEGER NOT NULL DEFAULT 0, avg_delay_seconds DECIMAL(12,2), "
                "severity_label TEXT",
            )[index]
            key = _KEYS[index]
            session.execute(
                _query(
                    f"{_NAMES[index]}.create",
                    f"CREATE TABLE {relation} "
                    f"({common}{columns}, built_at_utc TIMESTAMPTZ NOT NULL, "
                    f"PRIMARY KEY ({', '.join(key)}))",
                )
            )
            params: dict[str, object] = dict(
                provider_id=request.provider_id, built_at_utc=request.as_of_utc
            )
            statement = _upsert(index)
            if index == 0:
                for day in request.local_dates:
                    session.execute(statement, {**params, "local_date": day})
            else:
                session.execute(statement, params)
            result = session.execute(
                _query(
                    f"{_NAMES[index]}.read", f"SELECT * FROM {relation} ORDER BY {', '.join(key)}"
                )
            )
            tables[relation] = TableRows(relation, result.columns, key, tuple(map(tuple, result)))
        return FamilyOutput(tables, {})


builder = RepeatOffendersBuilder()
