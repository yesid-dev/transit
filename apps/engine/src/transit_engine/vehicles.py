"""Observed vehicle service and trip completion over one validated clean day."""

from typing import Any

import duckdb

from transit_engine.capture import MAX_POLL_SPACING_SECONDS, POLL_COVERAGE_SQL
from transit_engine.clean_manifest import FEED_POLLS, STOP_EVENTS, TRIP_DAYS, VEHICLE_POSITIONS

VEHICLE_POLL_SECONDS = 20
VEHICLE_TAIL_CAP_SECONDS = 3 * VEHICLE_POLL_SECONDS
# Allow two missed polls. Longer separations also start a new clean state interval.
VEHICLE_REPORTING_GAP_SECONDS = 3 * VEHICLE_POLL_SECONDS
MIN_STABLE_ID_READINGS = 2
MIN_STABLE_READING_SHARE = 0.5
# One additional gap can move the ranking by at most ten gaps per 100 vehicle-hours.
MIN_VEHICLE_RANKING_HOURS = 10
# One additional unfinished trip moves the ranking by at most five per 100 trips.
MIN_VEHICLE_RANKING_TRIPS = 20
# Same pre-departure coverage margin as the cleaner's missing-trip test.
TRIP_CAPTURE_LEAD_SECONDS = 300


def vehicle_tail_sql(next_start: str, last_seen: str) -> str:
    return (
        f"coalesce(epoch_us({next_start}) - epoch_us({last_seen}), "
        f"{VEHICLE_POLL_SECONDS * 1_000_000})"
    )


def tracked_vehicle_ids(
    conn: duckdb.DuckDBPyConnection, paths: dict[str, list[str]], city: str, version: str
) -> list[str]:
    # Clean positions only contain identified readings. Confirmed trips provide a
    # second check for feeds where the cleaner could not assign a stable ID at all.
    ids, reading_share, trip_share = conn.execute(
        f"""
        WITH positions AS (
            SELECT vehicle_id, readings, service_date, trip_id
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ?
        ), readings AS (
            SELECT vehicle_id, sum(readings) AS n
            FROM positions GROUP BY vehicle_id
        ), identities AS (
            SELECT *, coalesce(trim(vehicle_id) <> '', false)
                AND n >= {MIN_STABLE_ID_READINGS} AS stable
            FROM readings
        ), identified_trips AS (
            SELECT DISTINCT service_date, trip_id
            FROM positions JOIN identities USING (vehicle_id) WHERE stable
        ), confirmed_trips AS (
            SELECT avg((coalesce(i.stable, false) OR p.trip_id IS NOT NULL)::INTEGER) AS share
            FROM read_parquet(?, hive_partitioning = false) t
            LEFT JOIN identities i USING (vehicle_id)
            LEFT JOIN identified_trips p USING (service_date, trip_id)
            WHERE t.provider = ? AND t.cleaning_version = ? AND t.state = 'ran'
        )
        SELECT list(vehicle_id) FILTER (stable), sum(n) FILTER (stable) / sum(n),
            (SELECT share FROM confirmed_trips)
        FROM identities
        """,
        [paths[VEHICLE_POSITIONS], city, version, paths[TRIP_DAYS], city, version],
    ).fetchone() or (None, None, None)
    if reading_share is None or reading_share < MIN_STABLE_READING_SHARE:
        return []
    if trip_share is not None and trip_share < MIN_STABLE_READING_SHARE:
        return []
    return list(ids)


VEHICLE_COUNTS = (
    "days_in_service",
    "service_us",
    "trips_run",
    "reporting_gaps",
    "silent_us",
    "unfinished_trips",
    "completion_sample",
    "completion_capture_gap",
    "completion_unknown",
)


def vehicle_stats(
    conn: duckdb.DuckDBPyConnection,
    paths: dict[str, list[str]],
    scope: list[object],
    tracked_ids: list[str],
    vehicle: str | None,
    by_vehicle: bool,
    completion: bool,
) -> list[tuple[Any, ...]]:
    cap_us = VEHICLE_TAIL_CAP_SECONDS * 1_000_000
    gap_us = VEHICLE_REPORTING_GAP_SECONDS * 1_000_000
    tail = vehicle_tail_sql("next_start", "last_seen_at_utc")
    entity = "vehicle_id" if by_vehicle else "NULL::VARCHAR"
    completion_sql = ""
    completion_counts = "0, 0, 0, 0"
    completion_join = ""
    params: list[object] = [
        paths[VEHICLE_POSITIONS],
        *scope[:2],
        paths[TRIP_DAYS],
        *scope,
        tracked_ids,
        vehicle,
        vehicle,
    ]
    if completion:
        completion_sql = f"""
        , endpoints AS (
            SELECT service_date, trip_id, max(stop_sequence) AS final_stop,
                arg_max_null(coalesce(scheduled_arrival_utc, scheduled_departure_utc),
                    stop_sequence) AS scheduled_end,
                max(stop_sequence) FILTER (observed_at_utc IS NOT NULL) AS observed_stop,
                max(observed_at_utc) AS last_stop_time,
                min(vehicle_id) FILTER (observed_at_utc IS NOT NULL) AS first_stop_id,
                max(vehicle_id) FILTER (observed_at_utc IS NOT NULL) AS last_stop_id
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
            GROUP BY service_date, trip_id
        ), attribution AS (
            SELECT service_date, trip_id, count(DISTINCT vehicle_id) AS assigned_vehicles,
                min(vehicle_id) AS assigned_vehicle
            FROM assignments GROUP BY service_date, trip_id
        ),
        {POLL_COVERAGE_SQL},
        candidates AS (
            SELECT a.entity, a.service_date, a.trip_id,
                t.state = 'ran' AND t.route_has_live_data
                    AND t.scheduled_start_utc IS NOT NULL AND e.scheduled_end IS NOT NULL
                    AND e.observed_stop IS NOT NULL AND v.assigned_vehicles = 1
                    AND coalesce(e.first_stop_id, v.assigned_vehicle) = v.assigned_vehicle
                    AND coalesce(e.last_stop_id, v.assigned_vehicle) = v.assigned_vehicle
                    AS assessable,
                e.observed_stop < e.final_stop AS unfinished,
                t.state_reason IS DISTINCT FROM 'capture_gap' AS no_trip_gap,
                t.scheduled_start_utc - INTERVAL '{TRIP_CAPTURE_LEAD_SECONDS} seconds'
                    AS covered_from,
                greatest(e.scheduled_end, e.last_stop_time, t.last_capture_utc) +
                    INTERVAL '{MAX_POLL_SPACING_SECONDS} seconds' AS covered_to
            FROM trip_entities a
            JOIN attribution v USING (service_date, trip_id)
            LEFT JOIN trips t USING (service_date, trip_id)
            LEFT JOIN endpoints e USING (service_date, trip_id)
        ), assessed AS (
            SELECT *, coalesce(assessable, false) AND no_trip_gap AND EXISTS (
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
            SELECT entity, count(*) FILTER (eligible AND unfinished) AS unfinished,
                count(*) FILTER (eligible) AS sample,
                count(*) FILTER (assessable AND NOT eligible) AS capture_gap,
                count(*) FILTER (assessable IS NOT TRUE) AS unknown
            FROM assessed GROUP BY entity
        )
        """
        completion_counts = ", ".join(
            f"coalesce(c.{name}, 0)" for name in ("unfinished", "sample", "capture_gap", "unknown")
        )
        completion_join = "LEFT JOIN completions c ON k.entity IS NOT DISTINCT FROM c.entity"
        params.extend([paths[STOP_EVENTS], *scope, paths[FEED_POLLS], *scope])
    return conn.execute(
        f"""
        WITH positions AS (
            SELECT vehicle_id, service_date, trip_id, route_id, observed_at_utc,
                last_seen_at_utc, captured_at_utc
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ?
        ), trips AS (
            SELECT * FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
        ), assignments AS (
            SELECT vehicle_id, service_date, trip_id, route_id FROM trips
            WHERE state = 'ran' AND nullif(trim(vehicle_id), '') IS NOT NULL
            UNION
            SELECT p.vehicle_id, p.service_date, p.trip_id, coalesce(p.route_id, t.route_id)
            FROM positions p LEFT JOIN trips t USING (service_date, trip_id)
            WHERE p.service_date IS NOT NULL AND p.trip_id IS NOT NULL
                AND nullif(trim(p.vehicle_id), '') IS NOT NULL
                AND (t.state IS NULL OR t.state IN ('ran', 'unconfirmed', 'added'))
        ), selected AS (
            SELECT vehicle_id FROM unnest(?::VARCHAR[]) AS ids(vehicle_id)
            WHERE ?::VARCHAR IS NULL OR vehicle_id = ?
        ), sequenced AS (
            SELECT p.*, lead(observed_at_utc) OVER observed AS next_start,
                lead(trip_id) OVER captured AS next_trip,
                lead(service_date) OVER captured AS next_service_date,
                epoch_us(lead(captured_at_utc) OVER captured) - epoch_us(last_seen_at_utc)
                    AS gap_us
            FROM positions p JOIN selected USING (vehicle_id)
            WINDOW observed AS (PARTITION BY vehicle_id ORDER BY observed_at_utc, captured_at_utc),
                captured AS (PARTITION BY vehicle_id ORDER BY captured_at_utc)
        ), service AS (
            SELECT {entity} AS entity, count(DISTINCT service_date) AS days,
                sum(greatest(epoch_us(last_seen_at_utc) - epoch_us(observed_at_utc), 0)
                    + greatest(0, least({tail}, {cap_us}))) AS service_us,
                count(*) FILTER (
                    gap_us > {gap_us} AND (service_date, trip_id) = (next_service_date, next_trip)
                ) AS reporting_gaps,
                coalesce(sum(gap_us) FILTER (
                    gap_us > {gap_us} AND (service_date, trip_id) = (next_service_date, next_trip)
                ), 0) AS silent_us
            FROM sequenced WHERE service_date IS NOT NULL AND trip_id IS NOT NULL
            GROUP BY entity
        ), trip_entities AS (
            SELECT DISTINCT {entity} AS entity, service_date, trip_id
            FROM assignments JOIN selected USING (vehicle_id)
        ), trip_counts AS (
            SELECT entity, count(*) AS trips_run FROM trip_entities GROUP BY entity
        ), routes AS (
            SELECT {entity} AS entity, list(DISTINCT route_id) AS lines
            FROM assignments JOIN selected USING (vehicle_id)
            WHERE route_id IS NOT NULL GROUP BY entity
        ), keys AS (SELECT {entity} AS entity FROM selected GROUP BY entity)
        {completion_sql}
        SELECT k.entity, r.lines, coalesce(s.days, 0), coalesce(s.service_us, 0),
            coalesce(t.trips_run, 0), coalesce(s.reporting_gaps, 0), coalesce(s.silent_us, 0),
            {completion_counts}
        FROM keys k
        LEFT JOIN service s ON k.entity IS NOT DISTINCT FROM s.entity
        LEFT JOIN trip_counts t ON k.entity IS NOT DISTINCT FROM t.entity
        LEFT JOIN routes r ON k.entity IS NOT DISTINCT FROM r.entity
        {completion_join}
        """,
        params,
    ).fetchall()
