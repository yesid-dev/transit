"""Scheduled clock periods and frequency limits shared by engine measures."""

from typing import NamedTuple

# The ranking and period tests use the same turn-up-and-go headway limit.
FREQUENT_HEADWAY_SECONDS = 600
MIN_OBSERVED_HEADWAYS = 20
BUNCHING_FRACTION = 0.5
LONG_GAP_MULTIPLE = 2
# Two trips per hour correspond to a half-hour headway if evenly spaced.
MIN_TRIPS_PER_HOUR = 2
# These match the cleaner's base freshness and usable-poll spacing limits.
MAX_POLL_AGE_SECONDS = 120
MAX_POLL_SPACING_SECONDS = 120


class Period(NamedTuple):
    id: str
    start_hour: int
    end_hour: int
    en: str
    fr: str


PERIODS = (
    Period("overnight", 0, 5, "Overnight", "Nuit"),
    Period("morning", 5, 9, "Morning", "Matin"),
    Period("midday", 9, 15, "Midday", "Milieu de journée"),
    Period("afternoon", 15, 19, "Afternoon", "Après-midi"),
    Period("evening", 19, 24, "Evening", "Soirée"),
)


def period_sql(hour: str) -> str:
    cases = " ".join(
        f"WHEN {hour} >= {p.start_hour} AND {hour} < {p.end_hour} THEN '{p.id}'" for p in PERIODS
    )
    return f"CASE {cases} END"


def periods_text(language: str) -> str:
    return ", ".join(
        f"{getattr(p, language)} {p.start_hour:02d}:00–{p.end_hour:02d}:00" for p in PERIODS
    )


# Keep failed, empty, stale and repeated publications outside capture coverage.
POLL_COVERAGE_SQL = f"""
    poll_times AS (
        SELECT service_date, feed, captured_at_utc, max(feed_timestamp_utc) AS published
        FROM read_parquet(?, hive_partitioning = false)
        WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
            AND feed IN ('trip_updates', 'vehicle_positions') AND result = 'ok'
            AND entity_count > 0 AND feed_timestamp_utc IS NOT NULL
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
