"""Read adjacent scheduled stop runs and apply capture coverage."""

from transit_engine.capture import POLL_COVERAGE_SQL

# A five-second bin bounds midpoint error to 2.5 seconds on short segments.
SEGMENT_BIN_SECONDS = 5
# Even the upper decile represents at least two runs at the display floor.
MIN_SEGMENT_RUNS = 20
# Keep genuine slowdowns while rejecting observations that may describe a different run.
MAX_SEGMENT_RUN_MULTIPLE = 5


CORRIDOR_RUNS_SQL = f"""
    events AS (
        SELECT t.service_date, t.trip_id, t.route_id, t.direction_id, t.state,
            t.state_reason, t.route_has_live_data, s.stop_sequence, s.stop_id, s.basis,
            s.observed_at_utc, s.observed_event,
            coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc) AS departure_at,
            CASE s.observed_event
                WHEN 'arrival' THEN coalesce(s.scheduled_arrival_utc, s.scheduled_departure_utc)
                WHEN 'departure' THEN s.scheduled_departure_utc
            END AS scheduled_event_at
        FROM (SELECT * FROM read_parquet(?, hive_partitioning = false) s
            WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
            {{stop_filter}}) s
        JOIN (SELECT * FROM read_parquet(?, hive_partitioning = false) t
            WHERE t.provider = ? AND t.cleaning_version = ? AND t.service_date BETWEEN ? AND ?
                AND t.state <> 'added' AND t.route_id IS NOT NULL {{trip_filter}}) t
            USING (provider, cleaning_version, service_date, trip_id)
    ), pairs AS (
        SELECT service_date, route_id, direction_id, state, state_reason, route_has_live_data,
            stop_id AS from_stop, lead(stop_id) OVER trip AS to_stop, departure_at, basis,
            lead(basis) OVER trip AS to_basis,
            observed_at_utc AS observed_from, lead(observed_at_utc) OVER trip AS observed_to,
            epoch(lead(observed_at_utc) OVER trip - observed_at_utc)::BIGINT AS observed_seconds,
            epoch(lead(scheduled_event_at) OVER trip - scheduled_event_at)::BIGINT
                AS scheduled_seconds
        FROM events
        WINDOW trip AS (PARTITION BY service_date, trip_id ORDER BY stop_sequence)
    ),
    {POLL_COVERAGE_SQL},
    runs AS (
        SELECT p.*, observed_seconds - scheduled_seconds AS lost_seconds,
            CASE
                WHEN NOT route_has_live_data THEN 'route_without_live_data'
                WHEN state = 'cancelled' THEN 'cancelled'
                WHEN state_reason = 'capture_gap' THEN 'capture_gap'
                WHEN state <> 'ran' OR observed_from IS NULL OR observed_to IS NULL
                    OR basis = 'not_observed' OR to_basis = 'not_observed'
                    THEN 'missing_observation'
                WHEN basis <> to_basis
                    OR basis NOT IN (
                        'vehicle_stopped', 'vehicle_nearby',
                        'trip_update_reported', 'trip_update_passed'
                    )
                    THEN 'incomparable_basis'
                WHEN scheduled_seconds IS NULL OR scheduled_seconds <= 0
                    THEN 'invalid_scheduled_run'
                WHEN observed_seconds < 0 THEN 'negative_observed_run'
                WHEN observed_seconds > {MAX_SEGMENT_RUN_MULTIPLE} * scheduled_seconds
                    THEN 'excessive_observed_run'
                WHEN f.required_feeds IS NULL OR f.required_feeds <> (
                    SELECT count(DISTINCT c.feed) FROM coverage c
                    WHERE c.service_date = p.service_date
                        AND c.covered_from <= p.observed_from AND c.covered_to >= p.observed_to
                ) THEN 'capture_gap'
            END AS exclusion
        FROM pairs p LEFT JOIN realtime_feed_counts f USING (service_date)
        WHERE to_stop IS NOT NULL AND ({{cut}})
    )
"""


# Bucket only the poll intervals so the join can stream segments through a small
# hash table. The timestamp bounds still decide coverage, and the intervals are
# disjoint within a service day, so a run can match at most once.
_COVERAGE_BUCKET_MS = 15 * 60 * 1000
SEGMENT_RUNS_SQL = f"""
    {POLL_COVERAGE_SQL},
    continuous_coverage AS (
        SELECT c.service_date, c.covered_from, c.covered_to
        FROM coverage c JOIN realtime_feed_counts f USING (service_date)
        WHERE f.required_feeds = 1
        UNION ALL
        SELECT t.service_date, greatest(t.covered_from, v.covered_from),
            least(t.covered_to, v.covered_to)
        FROM coverage t JOIN coverage v USING (service_date)
        WHERE t.feed = 'trip_updates' AND v.feed = 'vehicle_positions'
            AND t.covered_from <= v.covered_to AND v.covered_from <= t.covered_to
    ), coverage_buckets AS (
        SELECT service_date, covered_from, covered_to, unnest(range(
            epoch_ms(covered_from) // {_COVERAGE_BUCKET_MS},
            epoch_ms(covered_to) // {_COVERAGE_BUCKET_MS} + 1
        )) AS bucket
        FROM continuous_coverage
    ), segments AS (
        SELECT service_date, {{trip_identity}} route_id, direction_id, from_stop, to_stop,
            scheduled_departure_at AS departure_at, from_basis AS basis,
            observed_departure_at, observed_arrival_at,
            observed_run_seconds AS observed_seconds, scheduled_run_seconds AS scheduled_seconds,
            exclusion
        FROM read_parquet(?, hive_partitioning = false) s
        WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
            AND ({{cut}})
    ), runs AS (
        SELECT s.* EXCLUDE (exclusion), observed_seconds - scheduled_seconds AS lost_seconds,
            CASE WHEN exclusion IS NOT NULL THEN exclusion
                WHEN c.covered_to IS NULL THEN 'capture_gap'
            END AS exclusion
        FROM segments s LEFT JOIN coverage_buckets c
            ON s.service_date = c.service_date
            AND epoch_ms(s.observed_departure_at) // {_COVERAGE_BUCKET_MS} = c.bucket
            AND s.exclusion IS NULL
            AND s.observed_departure_at >= c.covered_from AND s.observed_arrival_at <= c.covered_to
    )
"""


def clear_run_times(histogram: dict[int, int], runs: int) -> tuple[int, float]:
    """Return the real run at the first-decile boundary and the exact median."""
    targets = iter(((runs + 9) // 10, (runs + 1) // 2, (runs + 2) // 2))
    target = next(targets, None)
    readings = []
    count = 0
    for seconds, frequency in sorted(histogram.items()):
        count += frequency
        while target is not None and target <= count:
            readings.append(seconds)
            target = next(targets, None)
        if target is None:
            break
    clear_run, lower, upper = readings
    return clear_run, (lower + upper) / 2
