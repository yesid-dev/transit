"""Observed vehicle service and trip completion over one validated clean day."""

from transit_engine.capture import MAX_POLL_SPACING_SECONDS, POLL_COVERAGE_SQL
from transit_engine.clean_manifest import FEED_POLLS, STOP_EVENTS, TRIP_DAYS, VEHICLE_POSITIONS
from transit_engine.series import LOCAL_HOUR, LOCAL_HOUR_BUCKET

# Each feed publishes at its own cadence, so silences are measured in reporting intervals.
# Allow two missed reports: a gap or a carried-forward tail spans at most three intervals.
VEHICLE_REPORTING_GAP_INTERVALS = 3
_DAY_US = 86_400_000_000
MIN_STABLE_ID_READINGS = 2
MIN_STABLE_READING_SHARE = 0.5
MIN_VEHICLE_TERMINUS_SHARE = 0.5
# One additional gap can move the ranking by at most ten gaps per 100 vehicle-hours.
MIN_VEHICLE_RANKING_HOURS = 10
# Same pre-departure coverage margin as the cleaner's missing-trip test.
TRIP_CAPTURE_LEAD_SECONDS = 300


def vehicle_cadence_sql(version: str = "cleaning_version = ?") -> str:
    # The reporting interval is the median spacing between fresh vehicle-position
    # publications on each UTC day, rounded to whole seconds. Parameters: feed polls,
    # provider and cleaning version.
    return f"""
        SELECT day, nullif(round(quantile_disc(spacing_us, 0.5) / 1000000), 0)::BIGINT
            * 1000000 AS cadence_us
        FROM (
            SELECT instant // {_DAY_US} AS day,
                instant - lag(instant) OVER (ORDER BY instant) AS spacing_us
            FROM (
                SELECT DISTINCT epoch_us(captured_at_utc) AS instant
                FROM read_parquet(?, hive_partitioning = false)
                WHERE provider = ? AND {version} AND feed = 'vehicle_positions'
                    AND result = 'ok'
            )
        )
        WHERE spacing_us IS NOT NULL
        GROUP BY day
    """


def vehicle_cadence_join(last_seen: str, cadence: str = "cadence") -> str:
    return f"LEFT JOIN {cadence} ON {cadence}.day = epoch_us({last_seen}) // {_DAY_US}"


def vehicle_gap_us_sql(cadence_us: str) -> str:
    # An unknown cadence carries nothing forward and leaves every silence unmeasured.
    return f"coalesce({VEHICLE_REPORTING_GAP_INTERVALS} * {cadence_us}, 0)"


def vehicle_tail_sql(next_start: str, last_seen: str, cadence_us: str) -> str:
    # With no next reading, assume one reporting interval.
    return f"coalesce(epoch_us({next_start}) - epoch_us({last_seen}), {cadence_us}, 0)"


def vehicle_end_sql(start: str, last_seen: str, tail: str, cadence_us: str) -> str:
    return (
        f"greatest({start}, {last_seen} + "
        f"least({tail}, {vehicle_gap_us_sql(cadence_us)}) * INTERVAL '1 microsecond')"
    )


def vehicle_hour_weight_sql(
    hour: str, bucket: str = LOCAL_HOUR_BUCKET.format("captured_at_utc")
) -> str:
    # Intersect elapsed-hour segments with the local clock hour, including a repeated hour.
    return f"""
        (SELECT coalesce(sum(
            least(epoch_us(ends_at), epoch_us(hour_start) + 3600000000)
            - greatest(epoch_us(captured_at_utc), epoch_us(hour_start))
        ), 0)::BIGINT
        FROM generate_series({bucket}, ends_at, INTERVAL '1 hour') AS hours(hour_start)
        WHERE {hour} = ?)
    """


# Clean positions only contain identified readings. Confirmed trips provide a
# second check for feeds where the cleaner could not assign a stable ID at all.
TRACKED_VEHICLES_SQL = f"""
        WITH positions AS NOT MATERIALIZED (
            SELECT vehicle_id, readings, service_date, trip_id
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ?
        ), readings AS (
            SELECT vehicle_id, sum(readings) AS n,
                bool_or(service_date IS NOT NULL AND trip_id IS NOT NULL) AS in_service
            FROM positions GROUP BY vehicle_id
        ), identities AS (
            SELECT *, coalesce(trim(vehicle_id) <> '', false)
                AND n >= {MIN_STABLE_ID_READINGS} AS stable
            FROM readings
        ), ran_trips AS (
            SELECT t.service_date, t.trip_id, coalesce(i.stable, false) AS stable
            FROM read_parquet(?, hive_partitioning = false) t
            LEFT JOIN identities i USING (vehicle_id)
            WHERE t.provider = ? AND t.cleaning_version = ? AND t.state = 'ran'
        ), identified_trips AS (
            -- Positions can corroborate a trip whose recorded vehicle ID is unstable.
            SELECT DISTINCT service_date, trip_id
            FROM positions JOIN identities USING (vehicle_id)
            SEMI JOIN (SELECT service_date, trip_id FROM ran_trips WHERE NOT stable) t
                USING (service_date, trip_id)
            WHERE stable
        ), confirmed_trips AS (
            SELECT avg((t.stable OR p.trip_id IS NOT NULL)::INTEGER) AS share
            FROM ran_trips t LEFT JOIN identified_trips p USING (service_date, trip_id)
        )
        SELECT CASE WHEN sum(n) FILTER (stable) / sum(n) >= {MIN_STABLE_READING_SHARE}
            AND coalesce((SELECT share FROM confirmed_trips), 1) >= {MIN_STABLE_READING_SHARE}
            THEN list(vehicle_id) FILTER (stable) END AS ids,
            list(vehicle_id) FILTER (stable AND in_service) AS in_service_ids
        FROM identities
"""


VEHICLE_COUNTS = (
    "days_in_service",
    "service_us",
    "trips_run",
    "reporting_gaps",
    "silent_us",
    "reporting_gaps_capture_gap",
    "reporting_gaps_capture_gap_us",
    "unfinished_trips",
    "completion_sample",
    "completion_capture_gap",
    "completion_unknown",
    "completion_ran_trips",
    "completion_observed_termini",
    "completion_days_below_threshold",
)


def vehicle_stats_query(
    paths: dict[str, list[str]],
    scope: list[object],
    by_vehicle: bool,
    reporting: bool,
    completion: bool,
    *,
    by_hour: bool = False,
    by_line: bool = False,
    vehicle: str | None = None,
) -> tuple[str, list[object]]:
    tail = vehicle_tail_sql("next_capture", "last_seen_at_utc", "cadence_us")
    end = vehicle_end_sql("captured_at_utc", "last_seen_at_utc", tail, "cadence_us")
    entity = "vehicle_id" if by_vehicle else "NULL::VARCHAR"
    silence_entity = entity
    service_entity = entity
    service_weight = f"epoch_us({end}) - epoch_us(captured_at_utc)"
    service_days = "count(DISTINCT service_date)"
    service_segments = ""
    trip_starts = ""
    trip_start_join = ""
    keys = f"SELECT {entity} AS entity FROM selected GROUP BY entity"
    if by_line:
        entity = service_entity = "route_id"
        keys = "SELECT entity FROM routes"
    if by_hour:
        # Attribute a trip once, using the scheduled start or its first position when unscheduled.
        trip_starts = """
            , observed_starts AS (
                SELECT service_date, trip_id, min(observed_at_utc) AS first_position
                FROM positions
                WHERE service_date IS NOT NULL AND trip_id IS NOT NULL
                GROUP BY service_date, trip_id
            ), trip_starts AS (
                SELECT service_date, trip_id, coalesce(scheduled_start_utc, first_position) AS start
                FROM trips FULL JOIN observed_starts USING (service_date, trip_id)
            )
        """
        trip_start_join = "LEFT JOIN trip_starts USING (service_date, trip_id)"
        entity = LOCAL_HOUR.format("trip_starts.start")
        silence_entity = LOCAL_HOUR.format("last_seen_at_utc")
        service_entity = LOCAL_HOUR.format("hour_start")
        service_segments = f"""
            CROSS JOIN LATERAL (
                SELECT {end} AS ends_at
            )
            CROSS JOIN LATERAL generate_series({LOCAL_HOUR_BUCKET.format('captured_at_utc')},
                ends_at, INTERVAL '1 hour') AS hours(hour_start)
        """
        service_weight = """
            least(epoch_us(ends_at), epoch_us(hour_start + INTERVAL '1 hour'))
                - greatest(epoch_us(captured_at_utc), epoch_us(hour_start))
        """
        service_days += f" FILTER ({service_weight} > 0)"
        keys = "SELECT range AS entity FROM range(24) WHERE EXISTS (SELECT 1 FROM selected)"
    coverage_sql = f", {POLL_COVERAGE_SQL}" if reporting or completion else ""
    reporting_sql = ""
    reporting_counts = "0, 0, 0, 0"
    reporting_join = ""
    completion_sql = ""
    completion_counts = "0, 0, 0, 0, 0, 0, 0"
    completion_join = ""
    params: list[object] = [
        paths[VEHICLE_POSITIONS],
        *scope[:2],
        paths[FEED_POLLS],
        *scope[:2],
    ]
    position_vehicle_filter = ""
    if vehicle is not None and not by_hour:
        position_vehicle_filter = "WHERE vehicle_id = ?"
        params.append(vehicle)
    params.extend([
        paths[TRIP_DAYS],
        *scope,
    ])
    assignment_filter = ""
    trip_vehicle_filter = ""
    assignment_positions = "positions"
    if vehicle is not None and not by_hour:
        if completion:
            # Other vehicles can make a selected trip's assignment ambiguous.
            assignment_positions = "all_positions"
            assignment_filter = "SEMI JOIN selected_trip_keys USING (service_date, trip_id)"
        else:
            trip_vehicle_filter = "AND vehicle_id = ?"
            params.append(vehicle)
    if coverage_sql:
        params.extend([paths[FEED_POLLS], *scope])
    if reporting:
        reporting_sql = f"""
        , silences AS (
            SELECT {silence_entity} AS entity,
                epoch_us(next_capture) - epoch_us(last_seen_at_utc) AS gap_us,
                cadence_us IS NOT NULL AND EXISTS (
                    SELECT 1 FROM coverage c
                    WHERE c.service_date = s.service_date AND c.feed = 'vehicle_positions'
                        AND c.covered_from <= s.last_seen_at_utc
                        AND c.covered_to >= s.next_capture
                ) AS covered
            FROM sequenced s
            WHERE service_date IS NOT NULL AND trip_id IS NOT NULL
                AND (service_date, trip_id) = (next_service_date, next_trip)
                AND gap_us > {vehicle_gap_us_sql("cadence_us")}
        ), reporting AS (
            SELECT entity, count(*) FILTER (covered) AS gaps,
                sum(gap_us) FILTER (covered) AS silent_us,
                count(*) FILTER (NOT covered) AS capture_gap,
                sum(gap_us) FILTER (NOT covered) AS capture_gap_us
            FROM silences GROUP BY entity
        )
        """
        reporting_counts = ", ".join(
            f"coalesce(g.{name}, 0)"
            for name in ("gaps", "silent_us", "capture_gap", "capture_gap_us")
        )
        reporting_join = "LEFT JOIN reporting g ON k.entity IS NOT DISTINCT FROM g.entity"
    if completion:
        gps_terminus = int(str(scope[1])) >= 10
        terminus = "NULL::TIMESTAMPTZ"
        if gps_terminus:
            terminus = """CASE WHEN t.terminus_vehicle_id = v.assigned_vehicle
                THEN t.terminus_reached_at_utc END"""
        terminus_observed = "t.terminus_reached_at_utc IS NOT NULL" if gps_terminus else "false"
        # The coverage gate needs every trip's final stop. The other endpoints
        # only describe selected trips, except origins used to confirm a handoff.
        candidate_join = ""
        position_scope = ""
        candidate = "true"
        observed_candidate = "observed_at_utc IS NOT NULL"
        if vehicle is not None and not by_hour:
            candidate_join = """
                LEFT JOIN (
                    SELECT service_date, trip_id, true AS selected_trip FROM selected_trip_keys
                ) USING (service_date, trip_id)
            """
            position_scope = """
                JOIN selected USING (vehicle_id)
                SEMI JOIN trip_entities USING (service_date, trip_id)
            """
            candidate = "selected_trip"
            observed_candidate += " AND selected_trip"
        completion_sql = f"""
        , endpoints AS (
            SELECT s.service_date, s.trip_id, max(stop_sequence) AS final_stop,
                arg_max_null(coalesce(scheduled_arrival_utc, scheduled_departure_utc),
                    stop_sequence) FILTER ({candidate}) AS scheduled_end,
                arg_max(stop_id, stop_sequence) FILTER ({candidate}) AS final_stop_id,
                max(stop_sequence) FILTER (observed_at_utc IS NOT NULL) AS observed_stop,
                max(observed_at_utc) FILTER ({candidate}) AS last_stop_time,
                arg_max(stop_id, stop_sequence) FILTER ({observed_candidate})
                    AS last_observed_stop_id,
                arg_max(basis, stop_sequence) FILTER ({observed_candidate})
                    AS last_observed_basis,
                min(vehicle_id) FILTER ({observed_candidate}) AS first_stop_id,
                max(vehicle_id) FILTER ({observed_candidate}) AS last_stop_id,
                arg_max_null(vehicle_id, stop_sequence) FILTER ({observed_candidate})
                    AS last_observed_vehicle_id,
                arg_min(stop_id, stop_sequence) AS origin_id,
                arg_min_null(vehicle_id, stop_sequence) AS origin_vehicle_id,
                arg_min_null(observed_at_utc, stop_sequence) AS origin_seen_at,
                arg_min_null(basis, stop_sequence) AS origin_basis
            FROM read_parquet(?, hive_partitioning = false) s {candidate_join}
            WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
            GROUP BY s.service_date, s.trip_id
        ), terminus_counts AS (
            SELECT t.service_date, count(*) AS ran_trips,
                count(*) FILTER (e.observed_stop = e.final_stop OR {terminus_observed})
                    AS observed_termini
            FROM trips t LEFT JOIN endpoints e USING (service_date, trip_id)
            WHERE t.state = 'ran'
            GROUP BY t.service_date
        ), terminus_summary AS (
            SELECT coalesce(sum(ran_trips), 0) AS ran_trips,
                coalesce(sum(observed_termini), 0) AS observed_termini,
                count(*) FILTER (observed_termini < {MIN_VEHICLE_TERMINUS_SHARE} * ran_trips)
                    AS days_below_threshold
            FROM terminus_counts
        ), attribution AS (
            SELECT service_date, trip_id, count(DISTINCT vehicle_id) AS assigned_vehicles,
                min(vehicle_id) AS assigned_vehicle
            FROM assignments GROUP BY service_date, trip_id
        ), last_position AS (
            SELECT service_date, trip_id, vehicle_id, max(observed_at_utc) AS seen_at
            FROM positions {position_scope}
            WHERE service_date IS NOT NULL AND trip_id IS NOT NULL
            GROUP BY service_date, trip_id, vehicle_id
        ), candidates AS (
            SELECT a.entity, a.service_date, a.trip_id,
                t.state = 'ran' AND t.route_has_live_data
                    AND t.scheduled_start_utc IS NOT NULL AND e.scheduled_end IS NOT NULL
                    AND e.observed_stop IS NOT NULL AND v.assigned_vehicles = 1
                    AND coalesce(e.first_stop_id, v.assigned_vehicle) = v.assigned_vehicle
                    AND coalesce(e.last_stop_id, v.assigned_vehicle) = v.assigned_vehicle
                    AS assessable,
                coalesce(e.observed_stop = e.final_stop OR ({terminus}) IS NOT NULL, false)
                    AS completed,
                -- Two nearby stopped observations at the same upstream stop corroborate
                -- the reassignment. A different ID alone says nothing about completion.
                EXISTS (
                    SELECT 1 FROM endpoints following
                    JOIN trips next_trip USING (service_date, trip_id)
                    WHERE following.service_date = e.service_date
                        AND following.trip_id <> e.trip_id
                        AND next_trip.state = 'ran'
                        AND e.observed_stop < e.final_stop
                        AND e.last_observed_stop_id <> e.final_stop_id
                        AND e.last_observed_basis = 'vehicle_stopped'
                        AND e.last_observed_vehicle_id = v.assigned_vehicle
                        AND following.origin_basis = 'vehicle_stopped'
                        AND following.origin_vehicle_id = v.assigned_vehicle
                        AND following.origin_id = e.last_observed_stop_id
                        AND following.origin_seen_at > e.last_stop_time
                        AND following.origin_seen_at >= coalesce(lp.seen_at, e.last_stop_time)
                        AND following.origin_seen_at <= e.last_stop_time
                            + INTERVAL '{MAX_POLL_SPACING_SECONDS} seconds'
                        AND following.origin_seen_at < e.scheduled_end
                ) AS reassigned_upstream,
                t.state_reason IS DISTINCT FROM 'capture_gap' AS no_trip_gap,
                t.scheduled_start_utc - INTERVAL '{TRIP_CAPTURE_LEAD_SECONDS} seconds'
                    AS covered_from,
                greatest(e.scheduled_end, e.last_stop_time, t.last_capture_utc, ({terminus})) +
                    INTERVAL '{MAX_POLL_SPACING_SECONDS} seconds' AS covered_to
            FROM trip_entities a
            JOIN attribution v USING (service_date, trip_id)
            LEFT JOIN trips t USING (service_date, trip_id)
            LEFT JOIN endpoints e USING (service_date, trip_id)
            LEFT JOIN last_position lp ON lp.service_date = a.service_date
                AND lp.trip_id = a.trip_id AND lp.vehicle_id = v.assigned_vehicle
        ), assessed AS (
            SELECT c.*, coalesce(assessable, false) AND no_trip_gap AND EXISTS (
                SELECT 1 FROM realtime_feed_counts f
                WHERE f.service_date = c.service_date AND f.required_feeds = (
                    SELECT count(DISTINCT coverage.feed) FROM coverage
                    WHERE coverage.service_date = c.service_date
                        AND coverage.covered_from <= c.covered_from
                        AND coverage.covered_to >= c.covered_to
                )
            ) AS eligible
            FROM candidates c
        ), completions AS (
            SELECT entity,
                count(*) FILTER (eligible AND NOT completed AND reassigned_upstream)
                    AS unfinished,
                count(*) FILTER (eligible AND (completed OR reassigned_upstream))
                    AS sample,
                count(*) FILTER (assessable AND NOT eligible) AS capture_gap,
                count(*) FILTER (assessable IS NOT TRUE
                    OR (eligible AND NOT completed AND NOT reassigned_upstream)) AS unknown
            FROM assessed GROUP BY entity
        )
        """
        completion_counts = ", ".join(
            f"coalesce(c.{name}, 0)" for name in ("unfinished", "sample", "capture_gap", "unknown")
        )
        completion_counts += ", tc.ran_trips, tc.observed_termini, tc.days_below_threshold"
        completion_join = """LEFT JOIN completions c ON k.entity IS NOT DISTINCT FROM c.entity
            CROSS JOIN terminus_summary tc"""
        params.extend([paths[STOP_EVENTS], *scope])
    return (
        f"""
        WITH all_positions AS NOT MATERIALIZED (
            SELECT vehicle_id, service_date, trip_id, route_id, observed_at_utc,
                last_seen_at_utc, captured_at_utc
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ?
        ), cadence AS ({vehicle_cadence_sql()}
        ), positions AS (
            SELECT * FROM all_positions {position_vehicle_filter}
        ), trips AS (
            SELECT * FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
        ), selected AS (
            SELECT vehicle_id FROM selected_vehicles
        ), selected_trip_keys AS (
            SELECT service_date, trip_id FROM positions JOIN selected USING (vehicle_id)
            WHERE service_date IS NOT NULL AND trip_id IS NOT NULL
            UNION
            SELECT service_date, trip_id FROM trips JOIN selected USING (vehicle_id)
            WHERE state = 'ran'
        ), assignments AS (
            SELECT vehicle_id, service_date, trip_id, route_id FROM trips
            {assignment_filter}
            WHERE state = 'ran' AND nullif(trim(vehicle_id), '') IS NOT NULL
                {trip_vehicle_filter}
            UNION
            SELECT p.vehicle_id, p.service_date, p.trip_id, coalesce(p.route_id, t.route_id)
            FROM {assignment_positions} p {assignment_filter}
            LEFT JOIN trips t USING (service_date, trip_id)
            WHERE p.service_date IS NOT NULL AND p.trip_id IS NOT NULL
                AND nullif(trim(p.vehicle_id), '') IS NOT NULL
                AND (t.state IS NULL OR t.state IN ('ran', 'unconfirmed', 'added'))
        ), sequenced AS (
            SELECT p.*, cadence.cadence_us, lead(trip_id) OVER captured AS next_trip,
                lead(service_date) OVER captured AS next_service_date,
                lead(captured_at_utc) OVER captured AS next_capture
            FROM positions p JOIN selected USING (vehicle_id)
            {vehicle_cadence_join("p.last_seen_at_utc")}
            WINDOW captured AS (
                PARTITION BY vehicle_id ORDER BY captured_at_utc, service_date, trip_id
            )
        )
        {trip_starts}
        , service AS (
            SELECT {service_entity} AS entity,
                {service_days} AS days,
                sum({service_weight}) AS service_us
            FROM sequenced {service_segments}
            WHERE service_date IS NOT NULL AND trip_id IS NOT NULL
            GROUP BY entity
        ), trip_entities AS (
            SELECT DISTINCT {entity} AS entity, service_date, trip_id
            FROM assignments JOIN selected USING (vehicle_id) {trip_start_join}
        ), trip_counts AS (
            SELECT entity, count(*) AS trips_run FROM trip_entities GROUP BY entity
        ), routes AS (
            SELECT {entity} AS entity, list(DISTINCT route_id) AS lines
            FROM assignments JOIN selected USING (vehicle_id) {trip_start_join}
            WHERE route_id IS NOT NULL GROUP BY entity
        ), keys AS ({keys})
        {coverage_sql}
        {reporting_sql}
        {completion_sql}
        SELECT k.entity, r.lines, coalesce(s.days, 0), coalesce(s.service_us, 0),
            coalesce(t.trips_run, 0), {reporting_counts}, {completion_counts}
        FROM keys k
        LEFT JOIN service s ON k.entity IS NOT DISTINCT FROM s.entity
        LEFT JOIN trip_counts t ON k.entity IS NOT DISTINCT FROM t.entity
        LEFT JOIN routes r ON k.entity IS NOT DISTINCT FROM r.entity
        {reporting_join}
        {completion_join}
        """,
        params,
    )
