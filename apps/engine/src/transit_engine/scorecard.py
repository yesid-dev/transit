"""On-demand evidence for the open-data scorecard."""

from collections import Counter, defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import duckdb

from transit_engine.capture import MAX_POLL_SPACING_SECONDS
from transit_engine.clean_manifest import STOP_EVENTS, TRIP_DAYS
from transit_engine.histogram import DELAY_BIN_SECONDS, percentile
from transit_engine.series import LOCAL_HOUR, LOCAL_HOUR_BUCKET
from transit_engine.vehicles import (
    vehicle_cadence_join,
    vehicle_cadence_sql,
    vehicle_end_sql,
    vehicle_hour_weight_sql,
    vehicle_tail_sql,
)

SCORECARD = "open_data_scorecard"
FEED_MEASURES = ("poll_success", "feed_update_interval", "feed_age_at_capture")
FEEDS = ("trip_updates", "vehicle_positions", "alerts")
VEHICLE_FIELDS = {
    "trip": "trip_id IS NOT NULL",
    "route": "route_id IS NOT NULL",
    "stop": "stop_id IS NOT NULL",
    "current_status": "current_status IS NOT NULL",
    "occupancy": "occupancy_status IS NOT NULL OR occupancy_percentage IS NOT NULL",
    "position": "latitude IS NOT NULL AND longitude IS NOT NULL",
}
HORIZONS = (1, 3, 5, 10, 15, 20, 30)
MIN_SCORECARD_SAMPLES = 20
MIN_PREDICTION_SAMPLES = 30
MAX_FEED_SECONDS = 600
_OVERFLOW = MAX_FEED_SECONDS + 1
_PREDICTION_BASES = (
    "vehicle_stopped", "vehicle_nearby", "trip_update_reported", "trip_update_passed",
)
_VALID_POLL_RESULTS = ("ok", "empty", "duplicate")
_VALID_POLL_RESULTS_SQL = ", ".join(f"'{result}'" for result in _VALID_POLL_RESULTS)
POLL_BATCH_SECONDS = 14 * 86_400
_MICROSECONDS = 1_000_000
_POLL_SCOPE = """
    provider = ? AND cleaning_version = ANY(?)
    AND feed IN ('trip_updates', 'vehicle_positions', 'alerts', 'i3_alerts', 'service_alerts')
"""
# Clean windows can overlap around midnight. Time batches keep each attempt and all
# its copies together, even when those copies come from different cleaning versions.
_POLLS = f"""
    SELECT DISTINCT ON (feed, captured_at_utc, attempt_id)
        CASE WHEN feed IN ('i3_alerts', 'service_alerts') THEN 'alerts' ELSE feed END AS feed,
        epoch_us(captured_at_utc) AS captured, attempt_id, result,
        epoch_us(feed_timestamp_utc) AS published
    FROM read_parquet(?, hive_partitioning = false)
    WHERE {_POLL_SCOPE} AND captured_at_utc >= ? AND captured_at_utc < ?
    ORDER BY feed, captured_at_utc, attempt_id,
        CASE result WHEN 'ok' THEN 0 WHEN 'empty' THEN 1 WHEN 'duplicate' THEN 2 ELSE 3 END,
        service_date
"""


def _poll_batches(
    conn: duckdb.DuckDBPyConnection, paths: list[str], city: str, versions: list[str]
) -> Iterator[list[object]]:
    if not paths:
        return
    batch_us = POLL_BATCH_SECONDS * _MICROSECONDS
    files: defaultdict[int, list[str]] = defaultdict(list)
    for path, first, last in conn.execute(
        f"""
        SELECT filename, epoch_us(min(captured_at_utc)), epoch_us(max(captured_at_utc))
        FROM read_parquet(?, hive_partitioning = false)
        WHERE {_POLL_SCOPE} GROUP BY filename
        """,
        [paths, city, versions],
    ).fetchall():
        for batch in range(first // batch_us, last // batch_us + 1):
            files[batch].append(path)
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    for batch, inputs in sorted(files.items()):
        lower = epoch + timedelta(seconds=batch * POLL_BATCH_SECONDS)
        yield [inputs, city, versions, lower, lower + timedelta(seconds=POLL_BATCH_SECONDS)]


def _timing_rows(
    conn: duckdb.DuckDBPyConnection,
    scope: list[object],
    interval: bool,
    previous: list[dict[str, object]],
) -> list[tuple[Any, ...]]:
    # Carry the last attempt time, last valid publication and outstanding gap
    # since the last update across batches. Seed rows participate in windows only.
    sequence = f"""
        , entries AS (
            SELECT feed, captured, attempt_id, published, false AS prior_gap
            FROM timed
            UNION ALL
            SELECT feed, captured, '' AS attempt_id, published, prior_gap
            FROM (SELECT unnest(?::STRUCT(
                feed VARCHAR, captured BIGINT, published BIGINT, prior_gap BOOLEAN
            )[], recursive := true))
        ), steps AS (
            SELECT *, captured - lag(captured) OVER captures AS spacing
            FROM entries WINDOW captures AS (PARTITION BY feed ORDER BY captured, attempt_id)
        ), runs AS (
            SELECT *, count(*) FILTER (spacing > {MAX_POLL_SPACING_SECONDS * _MICROSECONDS})
                OVER (PARTITION BY feed ORDER BY captured, attempt_id
                      ROWS UNBOUNDED PRECEDING) - prior_gap::INTEGER AS run
            FROM steps
        ), timestamped AS (
            SELECT *, lag(published) OVER (
                PARTITION BY feed ORDER BY captured, attempt_id
            ) AS previous
            FROM runs WHERE published IS NOT NULL
        ), changes AS (
            SELECT * FROM timestamped WHERE published IS DISTINCT FROM previous
        ), updates AS (
            SELECT feed, (published - previous) / {_MICROSECONDS} AS seconds,
                run <> lag(run) OVER (PARTITION BY feed ORDER BY captured, attempt_id)
                    AS capture_gap
            FROM changes
        ), last_update AS (
            SELECT feed, max(run) AS update_run FROM changes GROUP BY feed
        ), checkpoint AS (
            SELECT feed, arg_max(captured, row(captured, attempt_id)) AS captured,
                arg_max(published, row(captured, attempt_id)) AS published,
                coalesce(max(run + runs.prior_gap::INTEGER) > update_run, false) AS prior_gap
            FROM runs LEFT JOIN last_update USING (feed)
            GROUP BY feed, update_run
        ), samples AS (SELECT * FROM updates)
    """
    ages = f"""
        , samples AS (
            SELECT feed, (captured - published) / {_MICROSECONDS} AS seconds,
                false AS capture_gap FROM timed
        )
    """
    negative = "backwards_timestamp" if interval else "clock_skew"
    rows, checkpoint = conn.execute(
        f"""
        WITH timed AS (
            SELECT feed, captured, attempt_id,
                CASE WHEN result IN ({_VALID_POLL_RESULTS_SQL}) THEN published END AS published
            FROM ({_POLLS})
        )
        {sequence if interval else ages}
        , classified AS (
            SELECT feed, seconds, CASE WHEN capture_gap THEN 'capture_gap'
                          WHEN seconds < 0 THEN '{negative}' END AS reason
            FROM samples WHERE seconds IS NOT NULL
        ), bins AS (
            SELECT feed, reason, CASE WHEN reason IS NULL THEN
                    CASE WHEN seconds > {MAX_FEED_SECONDS} THEN {_OVERFLOW}
                         ELSE floor(seconds)::BIGINT END
                END AS edge, count(*) AS occurrences, count(*) FILTER (seconds < 0) AS negatives
            FROM classified GROUP BY feed, reason, edge
        )
        SELECT (SELECT list(row(feed, reason, edge, occurrences, negatives)) FROM bins),
            {"(SELECT list(checkpoint) FROM checkpoint)" if interval else "NULL"}
        """,
        [*scope, previous] if interval else scope,
    ).fetchone() or (None, None)
    if interval:
        previous[:] = checkpoint or []
    return rows or []


@dataclass
class Result:
    value: Any = None
    state: str = "not_measured"
    counts: dict[str, Any] = field(default_factory=dict)
    excluded: dict[str, Any] = field(default_factory=dict)
    states: dict[str, str] = field(default_factory=dict)
    gap_days: list[str] = field(default_factory=list)


def _state(states: dict[str, str], fallback: str) -> str:
    return next(
        (
            state
            for state in (
                "measured",
                "too_few_to_judge",
                "unknown",
                "no_live_data",
                "not_tracked",
                "not_published",
                "not_measured",
            )
            if state in states.values()
        ),
        fallback,
    )


def _feed_percentile(
    bins: Counter[int], count: int, percent: int, *, continuous: bool
) -> float | str:
    rank, remainder = divmod((count - 1) * percent, 100)
    if rank + bool(remainder) >= count - bins[_OVERFLOW]:
        return "over_10_minutes"
    return percentile(
        sorted(bins.items()), count, percent, width=1, ceiling=MAX_FEED_SECONDS,
        continuous=continuous,
    )


def feed_results(
    conn: duckdb.DuckDBPyConnection,
    paths: list[str],
    city: str,
    versions: list[str],
    selected: set[str],
    declared_feeds: set[str],
) -> dict[str, Result]:
    batches = list(_poll_batches(conn, paths, city, versions))
    by_result: dict[str, Counter[str]] = {feed: Counter() for feed in FEEDS}
    dated = Counter[str]()
    for scope in batches:
        rows = conn.execute(
            f"SELECT feed, result, count(*), count(published) FROM ({_POLLS}) "
            "GROUP BY feed, result",
            scope,
        ).fetchall()
        for feed, result, count, timestamps in rows:
            by_result[feed][result] += count
            if result in _VALID_POLL_RESULTS:
                dated[feed] += timestamps
    present = {
        feed for feed in FEEDS if by_result[feed] or feed in declared_feeds or feed != "alerts"
    }
    results = {}
    for measure in FEED_MEASURES:
        if measure not in selected:
            continue
        bins: dict[str, Counter[int]] = {feed: Counter() for feed in present}
        exclusions: dict[str, Counter[str]] = {feed: Counter() for feed in present}
        backwards = Counter[str]()
        if measure != "poll_success":
            interval = measure == "feed_update_interval"
            previous: list[dict[str, object]] = []
            for scope in batches:
                for feed, reason, edge, count, negatives in _timing_rows(
                    conn, scope, interval, previous
                ):
                    backwards[feed] += negatives
                    if reason is None:
                        bins[feed][edge] += count
                    else:
                        exclusions[feed][reason] += count
        states = {}
        counts = {}
        values: dict[str, Any] = {}
        for feed in FEEDS:
            if feed not in present:
                continue
            outcomes = by_result[feed]
            attempts = outcomes.total()
            successes = sum(outcomes[result] for result in _VALID_POLL_RESULTS)
            count = bins[feed].total()
            counts[feed] = {
                "attempts": attempts,
                "successful": successes,
                "by_result": {
                    result: outcomes[result] for result in (*_VALID_POLL_RESULTS, "error")
                },
            }
            if feed == "alerts" and not attempts:
                counts[feed]["reason"] = "no_alert_attempt_rows"
            if measure != "poll_success":
                counts[feed].update(
                    timestamped_successes=dated[feed],
                    samples=count,
                    overflow=bins[feed][_OVERFLOW],
                )
                exclusions[feed]["missing_timestamp"] = successes - dated[feed]
            if measure == "feed_update_interval":
                counts[feed]["backwards_timestamps"] = backwards[feed]
            sample = attempts if measure == "poll_success" else count
            has_value = sample >= MIN_SCORECARD_SAMPLES
            states[feed] = (
                "measured" if has_value else "too_few_to_judge" if sample
                else "unknown" if attempts else "not_measured"
            )
            if measure == "poll_success":
                counts[feed]["empty_share"] = outcomes["empty"] / attempts if has_value else None
                values[feed] = successes / attempts if has_value else None
            else:
                values[feed] = {
                    f"{label}_seconds": _feed_percentile(
                        bins[feed], count, percent, continuous=measure == "feed_age_at_capture"
                    ) if has_value else None
                    for label, percent in (("median", 50), ("p90", 90))
                }
        results[measure] = Result(
            values, _state(states, "not_measured"), counts, exclusions, states
        )
    return results


def vehicle_counts(
    conn: duckdb.DuckDBPyConnection,
    paths: list[str],
    polls: list[str],
    trips: list[str] | None,
    city: str,
    versions: list[str],
    filters: str,
    arguments: list[object],
    hour: int | None,
) -> tuple[dict[str, int], list[str]]:
    direction = "t.direction_id" if trips else "NULL::INTEGER"
    join = (
        """
        LEFT JOIN read_parquet(?, hive_partitioning = false) t
        ON (v.provider, v.cleaning_version, v.service_date, v.trip_id) =
           (t.provider, t.cleaning_version, t.service_date, t.trip_id)
    """
        if trips
        else ""
    )
    tail = vehicle_tail_sql("v.next_start", "v.last_seen_at_utc", "cadence.cadence_us")
    weight = "epoch_us(ends_at) - epoch_us(captured_at_utc)"
    reading = "true"
    hour_args: list[object] = []
    if hour is not None:
        weight = vehicle_hour_weight_sql(
            LOCAL_HOUR.format("hour_start"),
            LOCAL_HOUR_BUCKET.format("captured_at_utc"),
        )
        reading = f"(weight > 0 OR {LOCAL_HOUR.format('captured_at_utc')} = ?)"
        hour_args = [hour, hour]
    fields = ", ".join(
        f"coalesce(sum(weight) FILTER ({published}), 0)" for published in VEHICLE_FIELDS.values()
    )
    row = conn.execute(
        f"""
        WITH sequenced AS (
            SELECT *, lead(captured_at_utc) OVER (
                PARTITION BY vehicle_id ORDER BY captured_at_utc, filename
            ) AS next_start
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ANY(?)
        ), cadence AS ({vehicle_cadence_sql("cleaning_version = ANY(?)")}
        ), vehicles AS (
            SELECT v.*, {direction} AS direction_id,
                {vehicle_end_sql(
                    "v.captured_at_utc", "v.last_seen_at_utc", tail, "cadence.cadence_us"
                )} AS ends_at,
                {tail} AS tail_us
            FROM sequenced v {vehicle_cadence_join("v.last_seen_at_utc")} {join}
        ), weighted AS (
            SELECT *, {weight} AS weight FROM vehicles WHERE {filters}
        ), selected AS (
            SELECT * FROM weighted WHERE {reading}
        )
        SELECT coalesce(sum(weight), 0), count(*), {fields},
            list(DISTINCT vehicle_id) FILTER (trip_id IS NULL)
        FROM selected
        """,
        [
            paths,
            city,
            versions,
            polls,
            city,
            versions,
            *([trips] if trips else []),
            *hour_args[:1],
            *arguments,
            *hour_args[1:],
        ],
    ).fetchone()
    assert row is not None
    return dict(zip(("reporting_us", "intervals", *VEHICLE_FIELDS), row[:-1], strict=True)), (
        row[-1] or []
    )


def coverage_counts(
    conn: duckdb.DuckDBPyConnection,
    batches: list[dict[str, list[str]]],
    city: str,
    versions: list[str],
    filters: str,
    arguments: list[object],
    stop: str | None,
) -> Result:
    stop_filter = (
        """
        AND EXISTS (
            SELECT 1 FROM read_parquet(?, hive_partitioning = false) s
            WHERE (t.provider, t.cleaning_version, t.service_date, t.trip_id) =
                  (s.provider, s.cleaning_version, s.service_date, s.trip_id) AND s.stop_id = ?
        )
    """
        if stop is not None
        else ""
    )
    if not batches:
        return Result()
    gap_days: list[str] = []
    covered_routes: set[str] = set()
    scheduled_by_route: Counter[str | None] = Counter()
    eligible_by_route: Counter[str | None] = Counter()
    appeared_by_route: Counter[str | None] = Counter()
    added = 0
    for paths in batches:
        days, routes, rows = conn.execute(
            f"""
            WITH trips AS (
                SELECT * FROM read_parquet(?, hive_partitioning = false)
                WHERE provider = ? AND cleaning_version = ANY(?)
            ), gap_days AS (
                SELECT DISTINCT service_date FROM trips WHERE state_reason = 'capture_gap'
            ), selected AS (
                SELECT route_id, state = 'added' AS added, first_capture_utc IS NOT NULL AS seen,
                    service_date IN (SELECT service_date FROM gap_days) AS capture_gap
                FROM trips t WHERE {filters} {stop_filter}
            ), by_route AS (
                SELECT route_id, count(*) FILTER (added) AS added,
                    count(*) FILTER (NOT added) AS scheduled,
                    count(*) FILTER (NOT added AND NOT capture_gap) AS eligible,
                    count(*) FILTER (NOT added AND NOT capture_gap AND seen) AS appeared
                FROM selected GROUP BY route_id
            )
            SELECT (SELECT list(service_date::VARCHAR) FROM gap_days),
                (SELECT list(DISTINCT route_id) FROM trips
                    WHERE route_has_live_data AND route_id IS NOT NULL),
                (SELECT list(by_route) FROM by_route)
            """,
            [
                paths[TRIP_DAYS],
                city,
                versions,
                *arguments,
                *([paths[STOP_EVENTS], stop] if stop is not None else []),
            ],
        ).fetchone() or (None, None, None)
        gap_days.extend(days or [])
        covered_routes.update(routes or [])
        for row in rows or []:
            route = row["route_id"]
            added += row["added"]
            scheduled_by_route[route] += row["scheduled"]
            eligible_by_route[route] += row["eligible"]
            appeared_by_route[route] += row["appeared"]
    scheduled = scheduled_by_route.total()
    never_seen = sum(n for route, n in scheduled_by_route.items() if route not in covered_routes)
    eligible = sum(eligible_by_route[route] for route in covered_routes)
    appeared = sum(appeared_by_route[route] for route in covered_routes)
    covered_gap = scheduled - never_seen - eligible
    state = (
        "measured"
        if eligible >= MIN_SCORECARD_SAMPLES
        else "too_few_to_judge"
        if eligible
        else "not_measured"
        if covered_gap
        else "no_live_data"
        if never_seen
        else "unknown"
    )
    return Result(
        appeared / eligible if state == "measured" else None,
        state,
        {
            "scheduled": scheduled,
            "eligible": eligible,
            "appeared": appeared,
            "never_seen": never_seen,
            "never_seen_share": never_seen / scheduled if scheduled else None,
        },
        {"added": added, "capture_gap": covered_gap},
        gap_days=sorted(gap_days),
    )


def prediction_result(
    conn: duckdb.DuckDBPyConnection,
    batches: list[list[str]],
    city: str,
    versions: list[str],
    filters: str,
    arguments: list[object],
) -> Result:
    bases = {horizon: Counter[str]() for horizon in HORIZONS}
    signed = {horizon: Counter[int]() for horizon in HORIZONS}
    absolute = {horizon: Counter[int]() for horizon in HORIZONS}
    within = Counter[int]()
    for paths in batches:
        rows = conn.execute(
            f"""
            WITH samples AS (
                SELECT horizon_minutes, basis, error_seconds
                FROM read_parquet(?, hive_partitioning = false)
                WHERE provider = ? AND cleaning_version = ANY(?) AND {filters}
            )
            SELECT horizon_minutes, basis,
                CASE WHEN basis = 'vehicle_stopped' THEN
                    floor(error_seconds::DOUBLE / {DELAY_BIN_SECONDS})::BIGINT * {DELAY_BIN_SECONDS}
                END AS signed,
                CASE WHEN basis = 'vehicle_stopped' THEN
                    floor(abs(error_seconds)::DOUBLE / {DELAY_BIN_SECONDS})::BIGINT
                        * {DELAY_BIN_SECONDS}
                END AS absolute,
                count(*), count(*) FILTER (basis = 'vehicle_stopped' AND abs(error_seconds) <= 60)
            FROM samples GROUP BY horizon_minutes, basis, signed, absolute
            """,
            [paths, city, versions, *arguments],
        ).fetchall()
        for horizon, basis, signed_edge, absolute_edge, count, in_band in rows:
            bases[horizon][basis] += count
            if basis == "vehicle_stopped":
                signed[horizon][signed_edge] += count
                absolute[horizon][absolute_edge] += count
                within[horizon] += in_band
    values = {}
    counts = {}
    exclusions = {}
    states = {}
    for horizon in HORIZONS:
        key = str(horizon)
        count = bases[horizon]["vehicle_stopped"]
        measured = count >= MIN_PREDICTION_SAMPLES
        values[key] = {
            "sample_count": count if batches else None,
            "median_signed_seconds": percentile(sorted(signed[horizon].items()), count, 50)
            if measured
            else None,
            "p90_absolute_seconds": percentile(sorted(absolute[horizon].items()), count, 90)
            if measured
            else None,
            "within_60_seconds_share": within[horizon] / count if measured else None,
        }
        counts[key] = {
            "by_basis": {basis: bases[horizon][basis] for basis in _PREDICTION_BASES}
            if batches
            else {},
            "within_60_seconds": within[horizon] if batches else None,
        }
        exclusions[key] = {
            "trip_update_passed": bases[horizon]["trip_update_passed"],
            "reason": "observed time is itself a prediction",
            "reason_fr": "L’heure observée est elle-même une prédiction",
        }
        states[key] = "measured" if measured else "too_few_to_judge" if batches else "not_measured"
    return Result(values, _state(states, "not_measured"), counts, exclusions, states)
