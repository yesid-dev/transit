"""Pair adjacent scheduled stops and classify each candidate run."""

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
