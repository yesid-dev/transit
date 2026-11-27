import asyncio
import json
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlencode

import pytest
from test_engine import FRIDAY, SATURDAY, SUNDAY, THURSDAY, Trip, _build_store, http
from test_historical_measures import _write_table, utc

from transit_engine.clean_manifest import FEED_POLLS, STOP_EVENTS, TRIP_DAYS, VEHICLE_POSITIONS
from transit_engine.server import Engine
from transit_engine.store import Store
from transit_engine.vehicles import TRACKED_VEHICLES_SQL, VEHICLE_COUNTS, vehicle_stats_query

REPORTING_RATE = "vehicle_reporting_gaps_per_100_hours"
UNFINISHED_RATE = "vehicle_unfinished_trips_per_100_trips"
UNFINISHED_COUNT = "vehicle_unfinished_trips"
OUTAGE_DAY = SUNDAY + timedelta(days=1)


@pytest.mark.parametrize(
    "reassigned, resumed, covered, after_midnight",
    [
        (False, False, True, False),
        (True, False, True, False),
        (True, True, True, False),
        (True, False, False, False),
        (True, False, True, True),
    ],
)
def test_capture_clock_and_same_vehicle_terminus_evidence(
    tmp_path: Path, reassigned: bool, resumed: bool, covered: bool, after_midnight: bool
) -> None:
    day = THURSDAY
    store = _build_store(
        tmp_path, 10, {day: (Trip("placeholder", "A", 0, "ran", None, True, (0,)),)}
    )
    start = utc(day + timedelta(days=int(after_midnight)), 6)
    end = start + timedelta(seconds=20)
    trips: list[tuple[object, ...]] = [
        (trip, "A", trip, "ran", None, True, start, end, end, "v1") for trip in ("v1", "v2")
    ]
    stops = [
        row
        for trip in ("v1", "v2")
        for row in (
            (trip, 1, trip, start, start, start, "upstream", "vehicle_stopped"),
            (trip, 2, None, end, end, None, "terminal", "not_observed"),
        )
    ]
    if reassigned:
        handoff = start + timedelta(seconds=10)
        finish = end + timedelta(seconds=10)
        trips.append(("next", "A", "v2", "ran", None, True, handoff, finish, None, None))
        stops.extend(
            (
                ("next", 1, "v2", handoff, handoff, handoff, "upstream", "vehicle_stopped"),
                ("next", 2, "v2", finish, finish, finish, "other_terminal", "vehicle_stopped"),
            )
        )
    positions = [
        ("v1", "v1", "A", stamp - timedelta(seconds=60), stamp, stamp) for stamp in (start, end)
    ] + [
        ("v2", "v2", "A", start - timedelta(seconds=60), start, start),
        ("v2", "next" if reassigned and not resumed else "v2", "A", end, end, end),
    ]
    with store.connect() as conn:
        _write_table(
            conn,
            store,
            day,
            TRIP_DAYS,
            "trip_id VARCHAR, route_id VARCHAR, vehicle_id VARCHAR, state VARCHAR, "
            "state_reason VARCHAR, route_has_live_data BOOLEAN, scheduled_start_utc TIMESTAMPTZ, "
            "last_capture_utc TIMESTAMPTZ, terminus_reached_at_utc TIMESTAMPTZ, "
            "terminus_vehicle_id VARCHAR",
            trips,
        )
        _write_table(
            conn,
            store,
            day,
            STOP_EVENTS,
            "trip_id VARCHAR, stop_sequence BIGINT, vehicle_id VARCHAR, "
            "scheduled_arrival_utc TIMESTAMPTZ, scheduled_departure_utc TIMESTAMPTZ, "
            "observed_at_utc TIMESTAMPTZ, stop_id VARCHAR, basis VARCHAR",
            stops,
        )
        _write_table(
            conn,
            store,
            day,
            VEHICLE_POSITIONS,
            "vehicle_id VARCHAR, trip_id VARCHAR, route_id VARCHAR, "
            "observed_at_utc TIMESTAMPTZ, captured_at_utc TIMESTAMPTZ, "
            "last_seen_at_utc TIMESTAMPTZ",
            positions,
        )
        _write_table(
            conn,
            store,
            day,
            FEED_POLLS,
            "feed VARCHAR, captured_at_utc TIMESTAMPTZ, feed_timestamp_utc TIMESTAMPTZ, "
            "result VARCHAR, entity_count BIGINT",
            [
                ("i3_alerts", start, None, "ok", 1),
                *[
                    ("vehicle_positions", stamp, stamp, "ok", 1)
                    for seconds in range(-300, 181, 20)
                    if (covered or not -180 < seconds < 0)
                    and (stamp := start + timedelta(seconds=seconds))
                ],
            ],
        )
        conn.execute("CREATE TABLE selected_vehicles (vehicle_id VARCHAR)")
        conn.execute("INSERT INTO selected_vehicles VALUES ('v1'), ('v2')")
        directory = tmp_path / "stm" / day.isoformat() / "v10"
        paths = {
            name: [str(directory / name)]
            for name in (VEHICLE_POSITIONS, TRIP_DAYS, STOP_EVENTS, FEED_POLLS)
        }
        sql, params = vehicle_stats_query(paths, ["stm", "10", day, day], True, False, True)
        results = {
            row[0]: dict(zip(VEHICLE_COUNTS, row[2:], strict=True))
            for row in conn.execute(sql, params).fetchall()
        }
        conn.execute("DELETE FROM selected_vehicles WHERE vehicle_id = 'v1'")
        sql, params = vehicle_stats_query(
            paths, ["stm", "10", day, day], True, False, True, vehicle="v2"
        )
        scoped = conn.execute(sql, params).fetchall()
        assert len(scoped) == 1
        assert dict(zip(VEHICLE_COUNTS, scoped[0][2:], strict=True)) == results["v2"]
    assert [results[v]["service_us"] for v in ("v1", "v2")] == [40_000_000, 40_000_000]
    unfinished = reassigned and not resumed and covered
    assert [results[v]["completion_sample"] for v in ("v1", "v2")] == [
        int(covered),
        int(reassigned and covered) + int(unfinished),
    ]
    assert [results[v]["unfinished_trips"] for v in ("v1", "v2")] == [0, int(unfinished)]
    assert results["v2"]["completion_unknown"] == int(covered and not unfinished)
    assert results["v2"]["completion_capture_gap"] == (0 if covered else 2)


@pytest.mark.parametrize("corroborated", [False, True])
def test_stable_position_identifies_a_trip_without_a_stable_trip_vehicle(
    tmp_path: Path, corroborated: bool
) -> None:
    day = THURSDAY
    store = _build_store(
        tmp_path, 10, {day: (Trip("placeholder", "A", 0, "ran", None, True, (0,)),)}
    )
    with store.connect() as conn:
        _write_table(
            conn,
            store,
            day,
            TRIP_DAYS,
            "trip_id VARCHAR, vehicle_id VARCHAR, state VARCHAR",
            [("a", None, "ran"), ("b", "unstable", "ran")],
        )
        _write_table(
            conn,
            store,
            day,
            VEHICLE_POSITIONS,
            "vehicle_id VARCHAR, trip_id VARCHAR, readings BIGINT",
            [("known", "b" if corroborated else "elsewhere", 3), ("unstable", "a", 1)],
        )
        directory = tmp_path / "stm" / day.isoformat() / "v10"
        row = conn.execute(
            TRACKED_VEHICLES_SQL,
            [
                [str(directory / VEHICLE_POSITIONS)], "stm", "10",
                [str(directory / TRIP_DAYS)], "stm", "10",
            ],
        ).fetchone()
    assert row == (["known"] if corroborated else None, ["known"])


class Interval(NamedTuple):
    vehicle: str | None
    trip: str | None
    start: datetime
    last: datetime
    readings: int
    line: str | None = "A"


@pytest.fixture(scope="module")
def vehicle_history(
    tmp_path_factory: pytest.TempPathFactory,
) -> tuple[Store, dict[date, list[Interval]]]:
    days = (THURSDAY, FRIDAY, SATURDAY, SUNDAY, OUTAGE_DAY)
    store = _build_store(
        tmp_path_factory.mktemp("vehicles"),
        6,
        dict.fromkeys(days, (Trip("placeholder", "A", 0, "ran", None, True, (0,)),)),
    )
    all_intervals: dict[date, list[Interval]] = {}
    with store.connect() as conn:
        for day in days:
            base = utc(day, 6)
            intervals: list[Interval] = []
            trips: list[tuple[object, ...]] = []
            stops: list[tuple[object, ...]] = []
            fleet = {
                THURSDAY: (("101", 20), ("102", 20), ("103", 1)),
                OUTAGE_DAY: (("101", 1), ("102", 1)),
            }.get(day, (("101", 1),))
            for vehicle, count in fleet:
                for index in range(count):
                    start = base + timedelta(minutes=36 * index)
                    end = start + timedelta(minutes=35)
                    trip = f"{vehicle}-{index}"
                    unfinished = vehicle == "101" and index == 0
                    line = "B" if vehicle == "102" else "A"
                    trips.append((trip, line, vehicle, "ran", None, True, start, end, 0))
                    for seq in range(1, 3):
                        scheduled = start if seq == 1 else end
                        observed = None if unfinished and seq == 2 else scheduled
                        delay = None if observed is None else (301 if vehicle == "102" else 0)
                        basis = "not_observed" if observed is None else "vehicle_stopped"
                        stops.append(
                            (
                                trip,
                                seq,
                                vehicle if observed else None,
                                scheduled,
                                observed,
                                delay,
                                basis,
                            )
                        )
                    if day == OUTAGE_DAY or unfinished:
                        spans = (
                            ((0, 600, 31), (960, 2100, 58))
                            if day == OUTAGE_DAY
                            else ((0, 600, 31), (920, 1900, 50), (1970, 2100, 7))
                        )
                        intervals.extend(
                            Interval(
                                vehicle,
                                trip,
                                start + timedelta(seconds=first),
                                start + timedelta(seconds=last),
                                n,
                                line,
                            )
                            for first, last, n in spans
                        )
                    else:
                        intervals.append(Interval(vehicle, trip, start, end, 106, line))
                if vehicle != "102":
                    after_service = base + timedelta(minutes=36 * count + 15)
                    intervals.append(Interval(vehicle, None, after_service, after_service, 1, None))
            if day == SATURDAY:
                # A changing identifier on each reading yields no stable vehicle number.
                intervals = [
                    Interval(
                        str(i),
                        "101-0",
                        base + timedelta(seconds=i * 20),
                        base + timedelta(seconds=i * 20),
                        1,
                    )
                    for i in range(4)
                ]
            if day == SUNDAY:
                # One stable ID is available, but most confirmed trips lack one.
                trips.extend(
                    (f"unassigned-{i}", "A", None, "ran", None, True, base, base, 0)
                    for i in range(2)
                )
            all_intervals[day] = intervals
            _write_table(
                conn,
                store,
                day,
                TRIP_DAYS,
                "trip_id VARCHAR, route_id VARCHAR, vehicle_id VARCHAR, state VARCHAR, "
                "state_reason VARCHAR, route_has_live_data BOOLEAN, scheduled_start_utc "
                "TIMESTAMPTZ, last_capture_utc TIMESTAMPTZ, direction_id INTEGER",
                trips,
            )
            _write_table(
                conn,
                store,
                day,
                STOP_EVENTS,
                "trip_id VARCHAR, stop_sequence BIGINT, vehicle_id VARCHAR, "
                "scheduled_arrival_utc TIMESTAMPTZ, observed_at_utc TIMESTAMPTZ, "
                "delay_seconds BIGINT, basis VARCHAR, scheduled_departure_utc TIMESTAMPTZ, "
                "stop_id VARCHAR, direction_id INTEGER",
                [(*record, None, "stop", 0) for record in stops],
            )
            _write_table(
                conn,
                store,
                day,
                VEHICLE_POSITIONS,
                "vehicle_id VARCHAR, trip_id VARCHAR, route_id VARCHAR, "
                "observed_at_utc TIMESTAMPTZ, captured_at_utc TIMESTAMPTZ, "
                "last_seen_at_utc TIMESTAMPTZ, readings BIGINT",
                [
                    (v, trip, line, start, start, last, n)
                    for v, trip, start, last, n, line in intervals
                ],
            )
            polls: list[tuple[object, ...]] = []
            for seconds in range(-300, 36 * 60 * max(n for _, n in fleet) + 180, 20):
                stamp = base + timedelta(seconds=seconds)
                for feed in ("vehicle_positions", "trip_updates"):
                    # Only the affected endpoint has failed polls on each outage day.
                    failed = (
                        day == FRIDAY and feed == "trip_updates" and 600 <= seconds < 800
                    ) or (day == OUTAGE_DAY and feed == "vehicle_positions" and 600 < seconds < 960)
                    polls.append(
                        (feed, stamp, stamp, "error" if failed else "ok", None if failed else 3)
                    )
            _write_table(
                conn,
                store,
                day,
                FEED_POLLS,
                "feed VARCHAR, captured_at_utc TIMESTAMPTZ, feed_timestamp_utc TIMESTAMPTZ, "
                "result VARCHAR, entity_count BIGINT",
                polls,
            )
            marker = Path(store.root) / "stm" / str(day) / "v6" / "manifest.json"
            manifest = json.loads(marker.read_text(encoding="utf-8"))
            manifest["row_counts_by_state"] = {"ran": len(trips)}
            manifest["row_counts_by_basis"] = Counter(str(record[-1]) for record in stops)
            marker.write_text(json.dumps(manifest), encoding="utf-8")
    return store, all_intervals


def request(
    store: Store, path: str, start: date = THURSDAY, end: date = THURSDAY, **fields: object
) -> tuple[int, bytes]:
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    query = urlencode({"city": "stm", "from": start, "to": end, **fields})
    status, _, payload = asyncio.run(http(app, path, query))
    return status, payload


def answer(
    store: Store, path: str, start: date = THURSDAY, end: date = THURSDAY, /, **fields: object
) -> dict[str, Any]:
    status, payload = request(store, path, start, end, **fields)
    assert status == 200, payload
    result: dict[str, Any] = json.loads(payload)
    return result


def test_vehicle_service_and_reporting_match_independent_recomputation(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, intervals = vehicle_history
    result = answer(store, "/measure", THURSDAY, SATURDAY, measure="vehicles", vehicle="101")
    assert result["state"] == "measured", result["evidence"]
    # Independently expand the observed spans and tails into sets of elapsed seconds.
    seconds_in_service = 0
    expected_gaps = []
    for day in (THURSDAY, FRIDAY):
        rows = [row for row in intervals[day] if row.vehicle == "101"]
        clock = rows[0].start
        covered: set[int] = set()
        for row, following in zip(rows, rows[1:], strict=False):
            if row.trip is None:
                continue
            gap = int((following.start - row.last).total_seconds())
            start = int((row.start - clock).total_seconds())
            end = int((row.last - clock).total_seconds()) + min(gap, 60)
            covered.update(range(start, end))
            if following.trip == row.trip and gap > 300:
                expected_gaps.append(gap)
        seconds_in_service += len(covered)
    hours = seconds_in_service / 3600
    assert expected_gaps == [320, 320]
    assert result["value"]["vehicle_hours_in_service"] == pytest.approx(hours)
    assert result["value"]["vehicle_reporting_gaps"] == len(expected_gaps)
    assert result["value"]["vehicle_silent_hours"] == pytest.approx(sum(expected_gaps) / 3600)
    assert result["value"][REPORTING_RATE] == pytest.approx(200 / hours)
    assert result["evidence"]["excluded"]["reporting_gaps_capture_gap"] == 0
    assert result["value"]["vehicle_lines_run"] == 1
    assert result["value"]["vehicle_trips_run"] == 21
    assert result["value"]["vehicle_days_in_service"] == 2
    assert result["evidence"]["days_not_tracked"] == [str(SATURDAY)]
    assert result["value"]["vehicle_on_time"] == 1.0
    info = next(info for info in result["info"] if info["id"] == "vehicle_on_time")
    assert "lines and hours" in info["text"]["en"]["limits"]
    assert "lignes et les heures" in info["text"]["fr"]["limits"]
    city = answer(store, "/measure", measure="vehicles")
    assert city["value"]["vehicle_days_in_service"] == 1
    assert city["value"]["vehicle_lines_run"] == 2
    assert city["value"]["vehicle_trips_run"] == 41
    assert city["value"]["vehicle_on_time"] == 41 / 81
    final_tail = answer(store, "/measure", measure="vehicle_hours_in_service", vehicle="102")
    assert final_tail["value"]["vehicle_hours_in_service"] == (19 * 2160 + 2100 + 20) / 3600
    for group in ("day", "hour", "weekday_hour"):
        series = answer(
            store, "/measure", THURSDAY, SATURDAY, measure="vehicles", vehicle="101", group=group
        )
        cells = series["cells"]
        for metric in ("vehicle_hours_in_service", "vehicle_trips_run", "vehicle_reporting_gaps"):
            assert sum(cell["value"][metric] or 0 for cell in cells) == pytest.approx(
                result["value"][metric]
            )
        if group == "day":
            assert cells[2]["state"] == "not_tracked"


def test_fleet_days_and_vehicle_trips_by_line(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    fleet = answer(
        store, "/measure", THURSDAY, SATURDAY, measure="vehicle_days_in_service", group="vehicle"
    )
    assert fleet["state"] == "measured"
    fleet_days = {
        cell["key"]["vehicle"]: cell["value"]["vehicle_days_in_service"] for cell in fleet["cells"]
    }
    assert fleet_days["101"] == 2
    assert "102" in fleet_days
    assert fleet["evidence"]["days_not_tracked"] == [str(SATURDAY)]

    lines = answer(
        store,
        "/measure",
        THURSDAY,
        FRIDAY,
        measure="vehicle_trips_run",
        group="line",
        vehicle="101",
    )
    individual = answer(
        store, "/measure", THURSDAY, FRIDAY, measure="vehicle_trips_run", vehicle="101"
    )
    assert lines["cells"]
    assert all(cell["key"]["line"] for cell in lines["cells"])
    assert (
        sum(cell["value"]["vehicle_trips_run"] for cell in lines["cells"])
        == (individual["value"]["vehicle_trips_run"])
    )
    none = answer(
        store, "/measure", SATURDAY, SATURDAY, measure="vehicle_days_in_service", group="vehicle"
    )
    assert none["state"] == "not_tracked"
    assert none["cells"] == []
    status, payload = request(
        store,
        "/measure",
        measure="vehicle_days_in_service",
        group="vehicle",
        format="csv",
        lang="fr",
    )
    assert status == 200
    assert payload.decode().startswith("Numéro de véhicule,")


def test_daily_vehicle_reading_can_include_the_overall_answer(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    cut = {"measure": "vehicles", "vehicle": "101"}
    daily = answer(store, "/measure", THURSDAY, SATURDAY, group="day", **cut)
    overall = answer(store, "/measure", THURSDAY, SATURDAY, **cut)
    bundled = answer(
        store, "/measure", THURSDAY, SATURDAY, group="day", include_overall="1", **cut
    )
    for result in (daily, overall, bundled, bundled["overall"]):
        del result["evidence"]["query_ms"]
    assert bundled.pop("overall") == overall
    assert bundled == daily


def test_completion_diagnostics_are_retained_without_publishing_a_rate(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    result = answer(store, "/measure", THURSDAY, FRIDAY, measure="vehicles", vehicle="101")
    assert result["value"][UNFINISHED_COUNT] is None
    assert result["value"][UNFINISHED_RATE] is None
    assert result["evidence"]["counts"]["completion_sample"] == 19
    assert result["evidence"]["counts"]["completion_confirmed_upstream_reassignments"] == 0
    assert result["evidence"]["excluded"]["completion_unknown"] == 1
    assert result["evidence"]["excluded"]["completion_capture_gap"] == 1
    gap_only = answer(store, "/measure", FRIDAY, FRIDAY, measure=UNFINISHED_RATE, vehicle="101")
    assert gap_only["state"] == "not_tracked"
    assert gap_only["value"][UNFINISHED_RATE] is None


def test_unobservable_trip_ends_only_suppress_completion(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    result = answer(store, "/measure", FRIDAY, FRIDAY, measure="vehicles", vehicle="101")
    assert result["value"]["vehicle_hours_in_service"] > 0
    assert result["evidence"]["measure_states"][UNFINISHED_COUNT] == "not_tracked"
    assert result["value"][UNFINISHED_COUNT] is None
    assert result["evidence"]["completion_coverage"] == {
        "ran_trips": 1,
        "observed_termini": 0,
        "observed_terminus_share": 0,
        "minimum_share": 0.5,
        "days_below_threshold": 1,
        "reason": "trip_end_not_observable",
    }
    count = answer(
        store, "/measure", FRIDAY, FRIDAY, measure="vehicle_unfinished_trips", vehicle="101"
    )
    assert count["state"] == "not_tracked"
    assert count["evidence"]["days_included"] == []
    assert count["evidence"]["days_not_tracked_reasons"] == {str(FRIDAY): "trip_end_not_observable"}
    ranking = answer(store, "/ranking", FRIDAY, FRIDAY, kind="vehicle", measure=UNFINISHED_RATE)
    assert ranking["state"] == "not_tracked"
    assert ranking["rows"] == []
    assert ranking["evidence"]["days_not_tracked_reasons"] == {
        str(FRIDAY): "trip_end_not_observable"
    }

    exact_floor = answer(store, "/measure", OUTAGE_DAY, OUTAGE_DAY, measure="vehicles")
    coverage = exact_floor["evidence"]["completion_coverage"]
    assert (coverage["observed_termini"], coverage["ran_trips"]) == (1, 2)
    assert coverage["observed_terminus_share"] == 0.5
    assert coverage["days_below_threshold"] == 0
    assert exact_floor["evidence"]["measure_states"][UNFINISHED_COUNT] == "not_tracked"
    series = answer(
        store, "/measure", THURSDAY, FRIDAY, measure=UNFINISHED_RATE, vehicle="101", group="day"
    )
    assert series["state"] == "not_tracked"
    assert [cell["state"] for cell in series["cells"]] == ["not_tracked", "not_tracked"]
    assert all(cell["evidence"]["days_included"] == [] for cell in series["cells"])


@pytest.mark.parametrize("day", [THURSDAY, SATURDAY, OUTAGE_DAY + timedelta(days=1)])
@pytest.mark.parametrize("measure", [UNFINISHED_COUNT, UNFINISHED_RATE])
def test_completion_is_not_tracked_even_with_good_coverage_or_no_rows(
    vehicle_history: tuple[Store, dict[date, list[Interval]]], day: date, measure: str
) -> None:
    store, _ = vehicle_history
    result = answer(store, "/measure", day, day, measure=measure)
    assert result["state"] == "not_tracked"
    assert result["value"][measure] is None
    assert result["evidence"]["completion_coverage"]["reason"] == "trip_end_not_observable"
    assert result["evidence"]["days_not_tracked_reasons"] == {str(day): "trip_end_not_observable"}


def test_reporting_outage_is_excluded_from_vehicle_measures_and_ranking(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    city = answer(store, "/measure", OUTAGE_DAY, OUTAGE_DAY, measure="vehicles")
    assert city["value"]["vehicle_reporting_gaps"] == city["value"]["vehicle_silent_hours"] == 0
    assert city["value"][REPORTING_RATE] is None
    assert city["evidence"]["measure_states"][REPORTING_RATE] == "too_few_to_judge"
    assert city["evidence"]["excluded"]["reporting_gaps_capture_gap"] == 2
    assert city["evidence"]["excluded"]["reporting_gaps_capture_gap_hours"] == pytest.approx(
        2 * 360 / 3600
    )

    ranking = answer(store, "/ranking", THURSDAY, OUTAGE_DAY, kind="vehicle")
    first, second = ranking["rows"]
    assert (first["id"], first["counts"]["reporting_gaps"]) == ("101", 2)
    assert (second["id"], second["value"]) == ("102", 0)
    for row in (first, second):
        assert row["excluded"]["reporting_gaps_capture_gap"] == 1
        assert row["excluded"]["reporting_gaps_capture_gap_hours"] == pytest.approx(360 / 3600)


@pytest.mark.parametrize("day", (SATURDAY, SUNDAY))
def test_unstable_or_missing_ids_are_not_tracked(
    vehicle_history: tuple[Store, dict[date, list[Interval]]], day: date
) -> None:
    store, _ = vehicle_history
    for path, fields in (("/measure", {"measure": "vehicles"}), ("/ranking", {"kind": "vehicle"})):
        result = answer(store, path, day, day, **fields)
        assert result["state"] == "not_tracked"
        assert result["evidence"]["days_not_tracked"] == [str(day)]


def test_vehicle_ranking_default_floors_and_exports(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    result = answer(store, "/ranking", kind="vehicle")
    reference = result["reference"]
    separate = answer(store, "/measure", measure=REPORTING_RATE)
    reference["evidence"].pop("query_ms")
    separate["evidence"].pop("query_ms")
    assert reference == separate
    assert result["measure"] == REPORTING_RATE
    assert [row["id"] for row in result["rows"]] == ["101", "102"]
    assert result["rows"][0]["value"] > result["rows"][1]["value"] == 0
    (excluded,) = result["excluded"]
    assert (excluded["id"], excluded["reason"]) == ("103", "too_few_to_judge")
    assert excluded["sample"] < result["info"][0]["ranking_minimum_sample"]
    for measure in (UNFINISHED_COUNT, UNFINISHED_RATE):
        completion = answer(store, "/ranking", kind="vehicle", measure=measure)
        assert completion["state"] == "not_tracked"
        assert completion["rows"] == []
        assert completion["evidence"]["days_not_tracked_reasons"] == {
            str(THURSDAY): "trip_end_not_observable"
        }
    assert request(store, "/ranking", kind="vehicle", measure="on_time")[0] == 400
    status, payload = request(store, "/measure", measure="vehicles", format="csv", lang="fr")
    assert status == 200
    assert "Jours sans suivi des véhicules" in payload.decode()


def _cadence_stats(tmp_path: Path, cadence: int, missed: list[int]) -> dict[str, Any]:
    """One trip reporting every `cadence` seconds, skipping `missed[k]` reports in a row."""
    day = THURSDAY
    store = _build_store(
        tmp_path, 10, {day: (Trip("placeholder", "A", 0, "ran", None, True, (0,)),)}
    )
    start = utc(day, 6)
    slots: list[int] = []
    slot = 0
    for skip in [*missed, 0]:
        slots.extend(range(slot, slot + 5))
        slot += 5 + skip
    end_slot = slot
    stamps = [start + timedelta(seconds=cadence * k) for k in slots]
    with store.connect() as conn:
        _write_table(
            conn,
            store,
            day,
            TRIP_DAYS,
            "trip_id VARCHAR, route_id VARCHAR, vehicle_id VARCHAR, state VARCHAR, "
            "state_reason VARCHAR, route_has_live_data BOOLEAN, scheduled_start_utc TIMESTAMPTZ, "
            "last_capture_utc TIMESTAMPTZ",
            [("t1", "A", "v1", "ran", None, True, start, stamps[-1])],
        )
        _write_table(
            conn,
            store,
            day,
            VEHICLE_POSITIONS,
            "vehicle_id VARCHAR, trip_id VARCHAR, route_id VARCHAR, "
            "observed_at_utc TIMESTAMPTZ, captured_at_utc TIMESTAMPTZ, "
            "last_seen_at_utc TIMESTAMPTZ",
            [("v1", "t1", "A", stamp, stamp, stamp) for stamp in stamps],
        )
        # The feed itself keeps publishing on cadence while the vehicle is silent.
        _write_table(
            conn,
            store,
            day,
            FEED_POLLS,
            "feed VARCHAR, captured_at_utc TIMESTAMPTZ, feed_timestamp_utc TIMESTAMPTZ, "
            "result VARCHAR, entity_count BIGINT",
            [
                ("vehicle_positions", stamp, stamp, result, 1)
                for k in range(-3, end_slot + 3)
                if (stamp := start + timedelta(seconds=cadence * k))
                # Unchanged publications between fresh ones do not set the cadence.
                for result in ("ok", "duplicate")
            ],
        )
        conn.execute("CREATE TABLE selected_vehicles (vehicle_id VARCHAR)")
        conn.execute("INSERT INTO selected_vehicles VALUES ('v1')")
        directory = Path(store.root) / "stm" / day.isoformat() / "v10"
        paths = {
            name: [str(directory / name)] for name in (VEHICLE_POSITIONS, TRIP_DAYS, FEED_POLLS)
        }
        sql, params = vehicle_stats_query(paths, ["stm", "10", day, day], True, True, False)
        ((_, _, *counts),) = conn.execute(sql, params).fetchall()
    result = dict(zip(VEHICLE_COUNTS, counts, strict=True))
    # Independent recomputation: carry each report to the next, at most three intervals,
    # and one interval after the final report.
    spacings = [cadence * (b - a) for a, b in zip(slots, slots[1:], strict=False)]
    assert result["service_us"] == 1_000_000 * (
        sum(min(s, 3 * cadence) for s in spacings) + cadence
    )
    assert result["silent_us"] == 1_000_000 * sum(
        s for s in spacings if s > 3 * cadence and s > 300
    )
    return result


@pytest.mark.parametrize(
    "cadence, missed_reports, expected_silences",
    [(20, [2, 3, 14, 15], [320]), (120, [1, 2, 3, 5], [480, 720])],
)
def test_reporting_gaps_need_both_cadence_and_five_minutes(
    tmp_path: Path, cadence: int, missed_reports: list[int], expected_silences: list[int]
) -> None:
    on_cadence = _cadence_stats(tmp_path / "steady", cadence, [])
    assert on_cadence["reporting_gaps"] == on_cadence["silent_us"] == 0
    missed = _cadence_stats(tmp_path / "missed", cadence, missed_reports)
    assert missed["reporting_gaps"] == len(expected_silences)
    assert missed["reporting_gaps_capture_gap"] == 0
    assert missed["silent_us"] == 1_000_000 * sum(expected_silences)
