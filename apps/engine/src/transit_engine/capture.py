"""Continuous capture evidence from usable realtime feed polls."""

import json
import os
from pathlib import Path

import duckdb
import yaml  # type: ignore[import-untyped]

# Match the cleaner's base freshness and usable-poll spacing limits.
MAX_POLL_AGE_SECONDS = 120
MAX_POLL_SPACING_SECONDS = 120


def _declared_lag(provider: str) -> int:
    directory = Path(
        os.environ.get("ENGINE_PROVIDER_DECLARATIONS")
        or Path(__file__).resolve().parents[3] / "db" / "config" / "providers"
    )
    declaration = directory / f"{provider}.yaml"
    if not declaration.is_file():
        return 0
    data = yaml.safe_load(declaration.read_text(encoding="utf-8"))
    # Both declaration formats are in use. The legacy format nests provider fields.
    return _lag(data.get("provider", data).get("live_source_lag_seconds", 0))


def _lag(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("live_source_lag_seconds must be a nonnegative integer")
    return value


def set_poll_age_limits(
    conn: duckdb.DuckDBPyConnection, provider: str, receipts: dict[str, bytes], days: list[str]
) -> None:
    limits = []
    fallback = None
    for day in days:
        receipt = json.loads(receipts[day])
        declaration = receipt.get("scorecard_declaration") or {}
        lag = declaration.get("live_source_lag_seconds", receipt.get("live_source_lag_seconds"))
        if lag is None:
            if fallback is None:
                fallback = _declared_lag(provider)
            lag = fallback
        limits.append(MAX_POLL_AGE_SECONDS + _lag(lag))
    conn.execute("SET VARIABLE poll_age_limits = map(?::VARCHAR[], ?::BIGINT[])", [days, limits])


# Failed attempts still identify feeds that require coverage.
POLL_COVERAGE_SQL = f"""
    realtime_polls AS (
        SELECT service_date, feed, captured_at_utc, feed_timestamp_utc, result, entity_count
        FROM read_parquet(?, hive_partitioning = false)
        WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
            AND feed IN ('trip_updates', 'vehicle_positions')
    ), realtime_feed_counts AS (
        SELECT service_date, count(DISTINCT feed) AS required_feeds
        FROM realtime_polls GROUP BY service_date
    ), poll_times AS (
        SELECT service_date, feed, captured_at_utc, max(feed_timestamp_utc) AS published
        FROM realtime_polls
        WHERE result = 'ok' AND entity_count > 0 AND feed_timestamp_utc <= captured_at_utc
        GROUP BY service_date, feed, captured_at_utc
    ), poll_history AS (
        SELECT *, max(published) OVER (
            PARTITION BY service_date, feed ORDER BY captured_at_utc
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS earlier_publication
        FROM poll_times
    ), usable_polls AS (
        SELECT *, epoch(captured_at_utc - lag(captured_at_utc) OVER (
            PARTITION BY service_date, feed ORDER BY captured_at_utc
        )) > {MAX_POLL_SPACING_SECONDS} AS starts_after_gap
        FROM poll_history
        WHERE (earlier_publication IS NULL OR published > earlier_publication)
            AND epoch(captured_at_utc - published) <= coalesce(
                map_extract_value(getvariable('poll_age_limits'), service_date::VARCHAR),
                {MAX_POLL_AGE_SECONDS}
            )
    ), poll_runs AS (
        SELECT *, count(*) FILTER (starts_after_gap) OVER (
            PARTITION BY service_date, feed ORDER BY captured_at_utc
        ) AS run
        FROM usable_polls
    ), coverage AS (
        SELECT service_date, feed, min(captured_at_utc) AS covered_from,
            max(captured_at_utc) AS covered_to
        FROM poll_runs GROUP BY service_date, feed, run HAVING count(*) >= 2
    )
"""
