"""Single-day reference arithmetic over v11 clean rows, independent of the engine."""

import json
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from itertools import pairwise
from pathlib import Path
from statistics import median, quantiles
from typing import Any, cast
from zoneinfo import ZoneInfo

import duckdb

DAY = date(2026, 11, 20)
ZONE = ZoneInfo("America/Toronto")
VALID_ATTEMPTS = {"ok", "empty", "duplicate"}
OCCUPANCY = ("empty", "many_seats", "few_seats", "standing", "crushed", "full")
Row = dict[str, Any]


@dataclass
class Sample:
    values: Row
    counts: Row
    state: str = "measured"


def read(
    conn: duckdb.DuckDBPyConnection, day: Path, table: str, line: str | None = None
) -> list[Row]:
    path = str(day / f"{table}.parquet")
    if line is None:
        result = conn.execute("SELECT to_json(r) FROM read_parquet(?) r", [path])
    else:
        result = conn.execute(
            "SELECT to_json(r) FROM read_parquet(?) r WHERE route_id = ?", [path, line]
        )
    return [json.loads(row, object_hook=decode_times) for (row,) in result.fetchall()]


def decode_times(row: Row) -> Row:
    # JSON preserves the timestamp offset without needing DuckDB's optional pytz adapter.
    for key, value in row.items():
        if value is not None and key.endswith("_utc"):
            row[key] = datetime.fromisoformat(value)
        if value is not None and key == "service_date":
            row[key] = date.fromisoformat(value)
    return row


def seconds(start: datetime, end: datetime) -> float:
    return (end - start).total_seconds()


def delivery(trips: list[Row], schedule: list[Row]) -> Sample:
    scheduled = [t for t in trips if t["state"] != "added"]
    eligible = {
        t["trip_id"]: t["state"]
        for t in scheduled
        if t["route_has_live_data"] and t["state"] in {"ran", "cancelled", "missing"}
    }
    states = Counter(eligible.values())
    assert sum(states.values()) == len(eligible) <= len(scheduled)
    stops: dict[str, list[Row]] = defaultdict(list)
    for row in schedule:
        if row["scheduled_arrival_utc"] or row["scheduled_departure_utc"]:
            stops[row["trip_id"]].append(row)
    durations = []
    for trip, state in eligible.items():
        ordered = sorted(stops[trip], key=lambda row: row["stop_sequence"])
        if ordered:
            first, last = ordered[0], ordered[-1]
            start = first["scheduled_departure_utc"] or first["scheduled_arrival_utc"]
            end = last["scheduled_arrival_utc"] or last["scheduled_departure_utc"]
            if end > start:
                durations.append((state, seconds(start, end)))
    total = sum(duration for _, duration in durations)
    ran = sum(duration for state, duration in durations if state == "ran")
    assert 0 <= ran <= total
    assert len(eligible) >= 20
    assert 2 * len(eligible) >= sum(t["route_has_live_data"] for t in scheduled)
    return Sample(
        {
            name: states[state] / len(eligible)
            for name, state in (
                ("trips_run", "ran"),
                ("cancelled_trips", "cancelled"),
                ("missing_trips", "missing"),
            )
        }
        | {"service_hours": ran / total if len(durations) >= 20 else None},
        dict(
            scheduled=len(scheduled),
            eligible=len(eligible),
            ran=states["ran"],
            cancelled=states["cancelled"],
            missing=states["missing"],
            trips_with_duration=len(durations),
            scheduled_hours=total / 3600,
            ran_hours=ran / 3600,
        ),
    )


def access(trips: list[Row], schedule: list[Row]) -> Sample:
    scheduled = {t["trip_id"]: t["wheelchair_accessible"] for t in trips if t["state"] != "added"}
    served: dict[str, set[int | None]] = defaultdict(set)
    for row in schedule:
        if row["trip_id"] in scheduled:
            served[row["stop_id"]].add(row["wheelchair_boarding"])
    values, counts = {}, {}
    for kind, flags in (
        ("trips", list(scheduled.values())),
        ("stops", [next(iter(flags)) for flags in served.values() if len(flags) == 1]),
    ):
        count = Counter(flags)
        assert set(count) <= {0, 1, 2, None}
        assert len(flags) == (len(scheduled) if kind == "trips" else len(served))
        published = len(flags) - count[None]
        values[f"accessible_{kind}"] = count[1] / published if published else None
        for key, flag in (
            ("accessible", 1),
            ("not_accessible", 2),
            ("no_information", 0),
            ("not_published", None),
        ):
            counts[f"{kind}_{key}"] = count[flag]
    return Sample(values, counts)


def alerts(rows: list[Row] | None, line: str) -> Sample:
    if rows is None:
        return Sample(
            dict(alerts=None, alert_versions=None, alert_hours=None),
            dict(alerts=None, alert_versions=None, alert_seconds=None),
            "not_tracked",
        )
    start = datetime.combine(DAY, time.min, ZONE)
    end = start + timedelta(days=1)
    intervals: dict[tuple[str, str], list[tuple[datetime, datetime]]] = defaultdict(list)
    versions = set()
    for row in rows:
        if line not in (row["route_ids"] or []):
            continue
        key = (row["source"], row["alert_id"])
        first, last = row["first_seen_at_utc"], row["last_seen_at_utc"]
        for period in row["active_periods"] or [{"start_utc": None, "end_utc": None}]:
            lo = max(start, period["start_utc"] or first)
            hi = min(end, period["end_utc"] or last)
            sighting = not any(period.values()) and start <= first == last < end
            if lo < hi or sighting:
                intervals[key].append((lo, hi))
                versions.add((*key, row["version"]))
    total = 0.0
    for spans in intervals.values():
        active_until = start
        for lo, hi in sorted(spans):
            if hi > active_until:
                total += seconds(max(lo, active_until), hi)
                active_until = hi
    assert len(intervals) <= len(versions)
    assert 0 <= total <= len(intervals) * seconds(start, end)
    counts = dict(alerts=len(intervals), alert_versions=len(versions), alert_seconds=total)
    return Sample(
        dict(alerts=len(intervals), alert_versions=len(versions), alert_hours=total / 3600), counts
    )


def position_seconds(rows: list[Row]) -> list[tuple[Row, float]]:
    ordered = sorted(rows, key=lambda r: (r["vehicle_id"], r["captured_at_utc"]))
    spans = []
    for row, following in pairwise([*ordered, None]):
        assert row is not None
        first = row["captured_at_utc"]
        last = row["last_seen_at_utc"]
        assert first <= last
        if following is None or following["vehicle_id"] != row["vehicle_id"]:
            end = last + timedelta(seconds=20)
        else:
            end = min(last + timedelta(seconds=60), following["captured_at_utc"])
        spans.append((row, seconds(first, end)))
    return spans


def crowding(spans: list[tuple[Row, float]], line: str) -> Sample:
    by_level: dict[str, float] = defaultdict(float)
    readings = usable = intervals = 0
    total = 0.0
    for row, duration in spans:
        if row["route_id"] != line:
            continue
        readings += row["readings"]
        intervals += 1
        status, percent = row["occupancy_status"], row["occupancy_percentage"]
        if status in range(6):
            level = OCCUPANCY[status]
        elif percent is not None and percent >= 0:
            level = "full" if percent >= 100 else "percentage_only"
        else:
            continue
        usable += row["readings"]
        by_level[level] += duration
        total += duration
    assert 0 <= usable <= readings
    assert all(duration >= 0 for duration in by_level.values())
    return Sample(
        {
            f"crowding_{level}": by_level[level] / total if total >= 3600 else None
            for level in OCCUPANCY
        },
        dict(
            intervals=intervals,
            readings=readings,
            occupancy_readings=usable,
            occupancy_vehicle_seconds=total if usable else None,
        ),
        "not_tracked" if not usable else "measured" if total >= 3600 else "insufficient_sample",
    )


def vehicle(
    spans: list[tuple[Row, float]], trips: list[Row], vehicle_id: str, tracking: list[Row]
) -> Sample:
    readings: Counter[str] = Counter()
    for row in tracking:
        readings[row["vehicle_id"]] += row["readings"]
    stable = {ident for ident, n in readings.items() if ident and ident.strip() and n >= 2}
    linked = {
        r["trip_id"]
        for r in tracking
        if r["vehicle_id"] in stable and r["service_date"] == DAY and r["trip_id"] is not None
    }
    ran = [r for r in trips if r["state"] == "ran"]
    assert 2 * sum(readings[i] for i in stable) >= sum(readings.values())
    assert 2 * sum(r["vehicle_id"] in stable or r["trip_id"] in linked for r in ran) >= len(ran)
    assert vehicle_id in stable
    in_service = [
        (row, duration)
        for row, duration in spans
        if row["vehicle_id"] == vehicle_id
        and row["service_date"] == DAY
        and row["trip_id"] is not None
    ]
    dated_trips = {row["trip_id"] for row, _ in in_service}
    dated_trips.update(row["trip_id"] for row in ran if row["vehicle_id"] == vehicle_id)
    hours = sum(duration for _, duration in in_service) / 3600
    assert 0 < hours <= 24
    return Sample(
        dict(vehicle_hours_in_service=hours, vehicle_trips_run=len(dated_trips)),
        dict(hours_in_service=hours, trips_run=len(dated_trips)),
    )


def feed_name(feed: str) -> str:
    return "alerts" if feed in {"i3_alerts", "service_alerts"} else feed


def poll_success(polls: list[Row]) -> Sample:
    attempts = {(feed_name(row["feed"]), row["attempt_id"]): row["result"] for row in polls}
    outcomes: dict[str, Counter[str]] = defaultdict(Counter)
    for (feed, _), result in attempts.items():
        outcomes[feed][result] += 1
    values, counts = {}, {}
    for feed, results in outcomes.items():
        assert set(results) <= VALID_ATTEMPTS | {"error"}
        n = sum(results.values())
        valid = sum(results[result] for result in VALID_ATTEMPTS)
        assert valid + results["error"] == n
        values[feed] = valid / n if n >= 20 else None
        counts[feed] = dict(
            attempts=n,
            successful=valid,
            empty_share=results["empty"] / n,
            by_result={key: results[key] for key in VALID_ATTEMPTS | {"error"}},
        )
    return Sample({"poll_success": values}, {"poll_success": counts})


class Coverage:
    """Usable consecutive polls establish closed intervals in each recorded live feed."""

    def __init__(self, polls: list[Row], source_lag: int) -> None:
        fresh: dict[str, dict[datetime, datetime]] = defaultdict(dict)
        for row in polls:
            feed = row["feed"]
            if feed not in {"trip_updates", "vehicle_positions"}:
                continue
            captured, published = row["captured_at_utc"], row["feed_timestamp_utc"]
            times = fresh[feed]
            if (
                row["result"] == "ok"
                and row["entity_count"] > 0
                and published
                and published <= captured
            ):
                times[captured] = max(published, times.get(captured, published))
        self.runs: list[tuple[list[datetime], list[datetime]]] = []
        for times in fresh.values():
            latest = None
            usable = []
            for captured, published in sorted(times.items()):
                if latest is not None and published <= latest:
                    continue
                latest = published
                if seconds(published, captured) <= 120 + source_lag:
                    usable.append(captured)
            starts: list[datetime] = []
            ends: list[datetime] = []
            for left, right in pairwise(usable):
                if seconds(left, right) <= 120:
                    if ends and left == ends[-1]:
                        ends[-1] = right
                    else:
                        starts.append(left)
                        ends.append(right)
            self.runs.append((starts, ends))

    def covers(self, start: datetime, end: datetime) -> bool:
        for starts, ends in self.runs:
            i = bisect_right(starts, start) - 1
            if i < 0 or ends[i] < end:
                return False
        return bool(self.runs)


def local_period(event: datetime) -> tuple[date, int]:
    local = event.astimezone(ZONE)
    return local.date(), bisect_right((5, 9, 15, 19), local.hour)


def waiting(trips: list[Row], events: list[Row], coverage: Coverage) -> Sample:
    trips_by_id = {row["trip_id"]: row for row in trips}
    scheduled: dict[tuple[Any, ...], set[datetime]] = defaultdict(set)
    observed: dict[tuple[Any, ...], list[tuple[datetime, str, int]]] = defaultdict(list)
    unknown: dict[tuple[Any, ...], list[datetime]] = defaultdict(list)
    for row in events:
        trip = trips_by_id[row["trip_id"]]
        if not trip["route_has_live_data"] or trip["direction_id"] is None:
            continue
        key = (row["stop_id"], trip["direction_id"])
        actual = row["observed_at_utc"]
        planned = row["scheduled_arrival_utc"] or row["scheduled_departure_utc"]
        if actual:
            observed[(*key, *local_period(actual))].append(
                (actual, row["trip_id"], row["stop_sequence"])
            )
        if planned and trip["state"] != "added":
            period = (*key, *local_period(planned))
            scheduled[period].add(planned)
            if actual is None and trip["state"] in {"ran", "unconfirmed"}:
                unknown[period].append(planned)

    frequent = observed_count = bunched = long = covered_count = 0
    observed_sum = planned_sum = weighted_excess = 0.0
    for period, times in scheduled.items():
        plan = list(pairwise(sorted(times)))
        if not plan:
            continue
        reference = seconds(plan[0][0], plan[-1][1]) / len(plan)
        if reference > 600:
            continue
        frequent += len(plan)
        withheld = sorted(unknown[period])
        intervals = []
        windows: list[tuple[datetime, datetime]] = []
        for (left, _, _), (right, _, _) in pairwise(sorted(observed[period])):
            unseen_trip_between = left < right and (
                bisect_right(withheld, left) < bisect_left(withheld, right)
            )
            if unseen_trip_between or not coverage.covers(left, right):
                continue
            intervals.append(seconds(left, right))
            if windows and windows[-1][1] == left:
                windows[-1] = (windows[-1][0], right)
            else:
                windows.append((left, right))
        matched = [seconds(a, b) for a, b in plan if any(lo <= a < b <= hi for lo, hi in windows)]
        observed_count += len(intervals)
        observed_sum += sum(intervals)
        bunched += sum(h < reference / 2 for h in intervals)
        long += sum(h > 2 * reference for h in intervals)
        covered_count += len(matched)
        planned_sum += sum(matched)
        if sum(intervals) > 0 and matched:
            observed_wait = sum(h**2 for h in intervals) / (2 * sum(intervals))
            planned_wait = sum(h**2 for h in matched) / (2 * sum(matched))
            weighted_excess += (observed_wait - planned_wait) * sum(matched)
    assert 0 <= covered_count <= frequent
    assert bunched + long <= observed_count
    assert observed_count >= 20 and observed_count / frequent >= 0.25
    return Sample(
        dict(
            observed_headway=observed_sum / observed_count,
            scheduled_headway=planned_sum / covered_count,
            bunching=bunched / observed_count,
            long_gaps=long / observed_count,
            excess_wait_time=weighted_excess / planned_sum,
        ),
        dict(
            frequent_headways=frequent,
            covered_scheduled_headways=covered_count,
            observed_headways=observed_count,
            scheduled_seconds=planned_sum,
            observed_seconds=observed_sum,
            bunching=bunched,
            long_gaps=long,
        ),
    )


def corresponding_time(row: Row) -> datetime | None:
    if row["observed_event"] == "arrival":
        return cast(datetime | None, row["scheduled_arrival_utc"] or row["scheduled_departure_utc"])
    if row["observed_event"] == "departure":
        return cast(datetime | None, row["scheduled_departure_utc"])
    return None


def corridors(trips: list[Row], events: list[Row], coverage: Coverage) -> Sample:
    by_trip: dict[str, list[Row]] = defaultdict(list)
    for row in events:
        by_trip[row["trip_id"]].append(row)
    scheduled = 0
    costs = []
    scheduled_time = observed_time = 0.0
    basis: Counter[str] = Counter()
    for trip in trips:
        if trip["state"] == "added":
            continue
        stops = sorted(by_trip[trip["trip_id"]], key=lambda r: r["stop_sequence"])
        for a, b in pairwise(stops):
            scheduled += 1
            if trip["state"] != "ran" or not trip["route_has_live_data"]:
                continue
            x, y = a["observed_at_utc"], b["observed_at_utc"]
            p, q = corresponding_time(a), corresponding_time(b)
            if x is None or y is None or p is None or q is None or a["basis"] != b["basis"]:
                continue
            expected, actual = seconds(p, q), seconds(x, y)
            if expected <= 0 or not 0 <= actual <= 5 * expected or not coverage.covers(x, y):
                continue
            costs.append(actual - expected)
            scheduled_time += expected
            observed_time += actual
            basis[a["basis"]] += 1
    assert sum(basis.values()) == len(costs) <= scheduled
    assert abs(sum(costs) - (observed_time - scheduled_time)) < 1e-6
    assert len(costs) >= 20 and len(costs) / scheduled >= 0.25
    # Take percentiles of the bin centres and check them against the exact sample.
    assert all(cost.is_integer() for cost in costs)
    midpoints = [cost // 5 * 5 + 2 for cost in costs]
    p50 = median(midpoints)
    p90 = quantiles(midpoints, n=10, method="inclusive")[8]
    assert abs(p50 - median(costs)) <= 2.5
    assert abs(p90 - quantiles(costs, n=10, method="inclusive")[8]) <= 2.5
    return Sample(
        dict(
            median_time_lost=p50,
            p90_time_lost=p90,
            mean_time_lost=sum(costs) / len(costs),
            total_vehicle_minutes_lost=sum(costs) / 60,
        ),
        dict(
            scheduled_runs=scheduled,
            observed_runs=len(costs),
            scheduled_seconds=scheduled_time,
            observed_seconds=observed_time,
            **basis,
        ),
    )


def recompute(
    conn: duckdb.DuckDBPyConnection, day: Path, line: str, vehicle_id: str
) -> dict[str, Sample]:
    receipt = json.loads((day / "manifest.json").read_text(encoding="utf-8"))
    assert receipt["service_date"] == str(DAY) and receipt["cleaning_version"] == "11"
    trips = read(conn, day, "trip_days")
    line_trips = [row for row in trips if row["route_id"] == line]
    schedule = read(conn, day, "scheduled_stop_times", line)
    events = read(conn, day, "stop_events", line)
    polls = read(conn, day, "feed_polls")
    alert_rows = None if receipt.get("alerts") == "not_tracked" else read(conn, day, "alerts")
    # Keep all rows for the citywide tracking gate, but only expand relevant timelines.
    position_path = str(day / "vehicle_positions.parquet")
    tracking_rows = conn.execute(
        """SELECT vehicle_id, trip_id, service_date, sum(readings) FROM read_parquet(?)
           GROUP BY vehicle_id, trip_id, service_date""",
        [position_path],
    ).fetchall()
    tracking = [
        dict(zip(("vehicle_id", "trip_id", "service_date", "readings"), row, strict=True))
        for row in tracking_rows
    ]
    result = conn.execute(
        """SELECT to_json(r) FROM read_parquet(?) r
           WHERE vehicle_id = ? OR vehicle_id IN (
               SELECT vehicle_id FROM read_parquet(?) WHERE route_id = ?
           )""",
        [position_path, vehicle_id, position_path, line],
    )
    spans = position_seconds(
        [json.loads(row, object_hook=decode_times) for (row,) in result.fetchall()]
    )
    coverage = Coverage(polls, receipt["scorecard_declaration"]["live_source_lag_seconds"])
    return {
        "service_delivered": delivery(line_trips, schedule),
        "waiting_and_gaps": waiting(line_trips, events, coverage),
        "crowding": crowding(spans, line),
        "alert_counts": alerts(alert_rows, line),
        "vehicle_hours_in_service": vehicle(spans, trips, vehicle_id, tracking),
        "corridors": corridors(line_trips, events, coverage),
        "accessibility": access(line_trips, schedule),
        "poll_success": poll_success(polls),
    }
