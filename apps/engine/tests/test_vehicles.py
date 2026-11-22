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

REPORTING_RATE = "vehicle_reporting_gaps_per_100_hours"
UNFINISHED_RATE = "vehicle_unfinished_trips_per_100_trips"


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
    days = (THURSDAY, FRIDAY, SATURDAY, SUNDAY)
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
            fleet = (("101", 20), ("102", 20), ("103", 1)) if day == THURSDAY else (("101", 1),)
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
                    if unfinished:
                        intervals.extend(
                            Interval(
                                vehicle,
                                trip,
                                start + timedelta(seconds=first),
                                start + timedelta(seconds=last),
                                n,
                                line,
                            )
                            for first, last, n in ((0, 600, 31), (680, 1900, 62), (1960, 2100, 8))
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
            for seconds in range(-300, 36 * 60 * max(n for _, n in fleet) + 180, 60):
                stamp = base + timedelta(seconds=seconds)
                for feed in ("vehicle_positions", "trip_updates"):
                    # The other feed still works while trip updates go silent.
                    failed = day == FRIDAY and feed == "trip_updates" and 600 <= seconds < 800
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
            if following.trip == row.trip and gap > 60:
                expected_gaps.append(gap)
        seconds_in_service += len(covered)
    hours = seconds_in_service / 3600
    assert expected_gaps == [80, 80]
    assert result["value"]["vehicle_hours_in_service"] == pytest.approx(hours)
    assert result["value"]["vehicle_reporting_gaps"] == len(expected_gaps)
    assert result["value"]["vehicle_silent_hours"] == pytest.approx(sum(expected_gaps) / 3600)
    assert result["value"][REPORTING_RATE] == pytest.approx(200 / hours)
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


def test_unfinished_trip_requires_continuous_capture(
    vehicle_history: tuple[Store, dict[date, list[Interval]]],
) -> None:
    store, _ = vehicle_history
    result = answer(store, "/measure", THURSDAY, FRIDAY, measure="vehicles", vehicle="101")
    assert result["value"]["vehicle_unfinished_trips"] == 1
    assert result["value"][UNFINISHED_RATE] == 5
    assert result["evidence"]["counts"]["completion_sample"] == 20
    assert result["evidence"]["excluded"]["completion_capture_gap"] == 1
    gap_only = answer(store, "/measure", FRIDAY, FRIDAY, measure=UNFINISHED_RATE, vehicle="101")
    assert gap_only["state"] == "not_measured"
    assert gap_only["value"][UNFINISHED_RATE] is None


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
    for measure in (None, UNFINISHED_RATE):
        filters = {"measure": measure} if measure else {}
        result = answer(store, "/ranking", kind="vehicle", **filters)
        assert result["measure"] == (measure or REPORTING_RATE)
        assert [row["id"] for row in result["rows"]] == ["101", "102"]
        assert result["rows"][0]["value"] > result["rows"][1]["value"] == 0
        (excluded,) = result["excluded"]
        assert (excluded["id"], excluded["reason"]) == ("103", "too_few_to_judge")
        assert excluded["sample"] < result["info"][0]["ranking_minimum_sample"]
    assert result["rows"][0]["sample"] == 20
    assert result["rows"][0]["range"]["lower"] < 5 < result["rows"][0]["range"]["upper"]
    assert request(store, "/ranking", kind="vehicle", measure="on_time")[0] == 400
    status, payload = request(store, "/measure", measure="vehicles", format="csv", lang="fr")
    assert status == 200
    assert "Jours sans suivi des véhicules" in payload.decode()
