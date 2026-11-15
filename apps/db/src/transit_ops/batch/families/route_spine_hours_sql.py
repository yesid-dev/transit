"""DuckDB rewrites of the route-delay statements; PostgreSQL owns the predicates."""

import re

from sqlalchemy.sql.elements import TextClause

from transit_ops.gold import delay_cohorts, delay_hours, delay_periods, rollups
from transit_ops.sql_registry import named_query

PREFIX = "batch.route_spine_hours"
NAMES = ("trip_delay_summary_5m", "route_delay_hourly", "route_delay_spine")
KEYS = (
    ("provider_id", "period_start_utc", "route_id"),
    ("provider_id", "period_start_utc", "route_id"),
    ("provider_id", "route_id", "provider_local_date", "hour_of_day_local", "direction_id"),
)
# Migration 0093:1376-1394,1044-1059,1193-1207; PKs:1814-1822,1870-1873.
DDL = (
    "provider_id TEXT NOT NULL, period_start_utc TIMESTAMPTZ NOT NULL, route_id TEXT NOT NULL, "
    "trip_count INTEGER NOT NULL, observation_count INTEGER NOT NULL, "
    "delay_observation_count INTEGER NOT NULL, avg_delay_seconds DECIMAL(10,2), "
    "avg_delay_seconds_capped DECIMAL(10,2), max_delay_seconds INTEGER, min_delay_seconds INTEGER, "
    "delayed_trip_count INTEGER NOT NULL, outlier_count INTEGER NOT NULL, "
    "built_at_utc TIMESTAMPTZ NOT NULL, on_time_observation_count INTEGER, "
    "max_delay_seconds_capped INTEGER, severe_delay_observation_count INTEGER DEFAULT 0 NOT NULL, "
    "usable_delay_sum_seconds BIGINT",
    "provider_id TEXT NOT NULL, period_start_utc TIMESTAMPTZ NOT NULL, route_id TEXT NOT NULL, "
    "trip_count INTEGER DEFAULT 0 NOT NULL, observation_count INTEGER DEFAULT 0 NOT NULL, "
    "avg_delay_seconds DECIMAL(12,2), max_delay_seconds INTEGER, "
    "delayed_trip_count INTEGER DEFAULT 0 NOT NULL, severe_delay_count INTEGER DEFAULT 0 NOT NULL, "
    "built_at_utc TIMESTAMPTZ NOT NULL, delay_observation_count INTEGER DEFAULT 0 NOT NULL, "
    "on_time_observation_count INTEGER, usable_delay_observation_count BIGINT, "
    "usable_delay_sum_seconds BIGINT",
    "provider_id TEXT NOT NULL, route_id TEXT NOT NULL, provider_local_date DATE NOT NULL, "
    "hour_of_day_local SMALLINT NOT NULL, direction_id INTEGER NOT NULL, "
    "observation_count INTEGER DEFAULT 0 NOT NULL, "
    "delay_observation_count INTEGER DEFAULT 0 NOT NULL, "
    "on_time_observation_count INTEGER, severe_delay_count INTEGER DEFAULT 0 NOT NULL, "
    "sum_delay_seconds BIGINT DEFAULT 0 NOT NULL, delay_histogram SMALLINT[], "
    "built_at_utc TIMESTAMPTZ NOT NULL, delayed_trip_count INTEGER DEFAULT 0 NOT NULL",
)


def query(name: str, sql: str) -> TextClause:
    return named_query(f"{PREFIX}.{name}", sql)


def port(name: str, source: TextClause) -> TextClause:
    sql = str(source).split("\n", 1)[1]
    sql = re.sub(r"DATE_BIN\(\s*'5 minutes'", "time_bucket(INTERVAL '5 minutes'", sql)
    sql = sql.replace(
        "make_interval(days => :open_window_days)", "(:open_window_days * INTERVAL '1 day')"
    )
    return query(name, sql)


def summary() -> TextClause:
    sql = str(port("summary_source", delay_periods.UPSERT_TRIP_DELAY_SUMMARY_5M))
    # Round integer sums/counts at the target column scale, without a float AVG.
    sql = sql.replace(
        "AVG(delay_seconds::numeric) FILTER (WHERE ABS(delay_seconds) <= 3600)",
        "delay_mean(SUM(delay_seconds::HUGEINT) FILTER (WHERE ABS(delay_seconds) <= 3600) * 100, "
        "COUNT(delay_seconds) FILTER (WHERE ABS(delay_seconds) <= 3600))",
    ).replace(
        "AVG(delay_seconds::numeric)",
        "delay_mean(SUM(delay_seconds::HUGEINT) * 100, COUNT(delay_seconds))",
    )
    return query("summary", sql.split("\n", 1)[1])


def spine() -> TextClause:
    sql = str(port("spine_source", rollups.UPSERT_ROUTE_DELAY_SPINE))
    edges = "ARRAY[" + ",".join(map(str, rollups.DELAY_HISTOGRAM_EDGES)) + "]"
    # width_bucket(anyelement, thresholds): number of thresholds <= the operand.
    sql = sql.replace(
        f"width_bucket(f.delay_seconds, {edges})",
        f"list_count(list_filter({edges}, lambda edge: edge <= f.delay_seconds))",
    )
    sql = sql.replace(
        "(CAST(:local_date AS date) + 1)::timestamp",
        "(CAST(:local_date AS date) + INTERVAL '1 day')::timestamp",
    )
    return query("spine", sql.split("\n", 1)[1])


def hourly() -> TextClause:
    sql = str(port("hourly_source", delay_hours._REPLACE_HOUR))
    # `summary` is also a DuckDB dynamic SQL function, refused by the clock guard.
    sql = re.sub(r"\bsummary\b", "hour_totals", sql)
    start = sql.index("            ROUND(")
    end = sql.index(" AS avg_delay_seconds", start)
    sql = (
        sql[:start]
        + """            delay_mean(
                CAST(SUM(avg_delay_seconds_capped * 100 *
                    NULLIF(delay_observation_count - outlier_count, 0)) AS HUGEINT),
                SUM(delay_observation_count - outlier_count)
            )"""
        + sql[end:]
    )
    return query("hourly", sql.split("\n", 1)[1])


def cohort() -> TextClause:
    sql = delay_cohorts._COHORT_SQL.replace(
        "s.manifest_json @> jsonb_build_object('entity_count', c.entity_count)",
        "(json_type(s.manifest_json, '$.entity_count') IN ('BIGINT','UBIGINT','DOUBLE') "
        "AND CAST(json_extract(s.manifest_json, '$.entity_count') AS DOUBLE) = c.entity_count)",
    )
    return query("cohort", sql)


MEAN = query(
    "mean_macro",
    """
    CREATE MACRO delay_mean(cents, n) AS CASE WHEN n > 0 THEN
      CAST((sign(cents) * (abs(cents)::HUGEINT // n::HUGEINT +
          CASE WHEN (abs(cents)::HUGEINT % n::HUGEINT) * 2 >= n THEN 1 ELSE 0 END))
          / 100.0 AS DECIMAL(38,2)) END
""",
)
