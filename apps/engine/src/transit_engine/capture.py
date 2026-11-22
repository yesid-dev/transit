"""Continuous capture evidence from usable realtime feed polls."""

# Match the cleaner's base freshness and usable-poll spacing limits.
MAX_POLL_AGE_SECONDS = 120
MAX_POLL_SPACING_SECONDS = 120


# Failed attempts still identify feeds that require coverage.
POLL_COVERAGE_SQL = f"""
    realtime_polls AS (
        SELECT service_date, feed, captured_at_utc, feed_timestamp_utc, result, entity_count
        FROM read_parquet(?, hive_partitioning = false)
        WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
            AND feed <> 'alerts'
    ), realtime_feed_counts AS (
        SELECT service_date, count(DISTINCT feed) AS required_feeds
        FROM realtime_polls GROUP BY service_date
    ), poll_times AS (
        SELECT service_date, feed, captured_at_utc, max(feed_timestamp_utc) AS published
        FROM realtime_polls
        WHERE result = 'ok' AND entity_count > 0 AND feed_timestamp_utc IS NOT NULL
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
            AND epoch(captured_at_utc - published) <= {MAX_POLL_AGE_SECONDS}
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
