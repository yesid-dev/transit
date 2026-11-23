import asyncio
import itertools
import json
from collections import Counter
from pathlib import Path

import pytest
from test_engine import FRIDAY, SATURDAY, SUNDAY, THURSDAY, Poll, Trip, _build_store, http, query
from test_ranking import _json, _request

from transit_engine import measures
from transit_engine.measures import answer_csv
from transit_engine.server import Engine


def _trip(line: str, index: int, minute: int, delay: int | None = 0, *, live: bool = True) -> Trip:
    return Trip(
        f"{line}-{index:02}",
        line,
        0,
        "ran" if delay is not None else "missing",
        None,
        live,
        (delay,),
        minute,
        duration_minutes=10,
    )


def _polls(start: int, end: int) -> tuple[Poll, ...]:
    return tuple(
        Poll(feed, seconds)
        for feed in ("trip_updates", "vehicle_positions")
        for seconds in range(start, end + 1, 60)
    )


def test_waiting_measures_match_known_pattern_and_independent_recomputation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    actual_pattern = (100, 150, 600, 650, 200, 100)
    offsets = list(itertools.accumulate(actual_pattern * 4, initial=0))
    trips = tuple(_trip("A", i, -60 + i * 5, offset - i * 300) for i, offset in enumerate(offsets))
    store = _build_store(
        tmp_path,
        6,
        dict.fromkeys((THURSDAY, FRIDAY), trips),
        dict.fromkeys((THURSDAY, FRIDAY), _polls(-3660, 3660)),
    )
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    result = query(
        store, measure="waiting_and_gaps", line="A", direction=0, stop="first", end=FRIDAY
    )
    assert result["state"] == "measured"
    values = result["value"]
    assert values == pytest.approx(
        {
            "observed_headway": 300,
            "scheduled_headway": 300,
            "bunching": 1 / 3,
            "long_gaps": 1 / 6,
            "excess_wait_time": 865000 / 3600 - 150,
        }
    )
    # Integrate one rider's remaining wait at the midpoint of each one-second interval
    # in the two independently reconstructed timetables.
    scheduled = [trip.offset_minutes * 60 for trip in trips]
    observed = [t + (trip.delays[0] or 0) for t, trip in zip(scheduled, trips, strict=True)]
    waits = [
        [
            right - rider - 0.5
            for left, right in itertools.pairwise(times)
            for rider in range(left, right)
        ]
        for times in (observed, scheduled)
    ]
    assert values["excess_wait_time"] == pytest.approx(
        sum(waits[0]) / len(waits[0]) - sum(waits[1]) / len(waits[1])
    )
    assert result["evidence"]["counts"]["observed_headways"] == 48
    assert result["evidence"]["counts"]["bunching"] == 16
    assert result["evidence"]["counts"]["long_gaps"] == 8
    daily = query(
        store, measure="excess_wait_time", line="A", stop="first", end=FRIDAY, group="day"
    )
    for cell in daily["cells"]:
        assert cell["value"]["excess_wait_time"] == pytest.approx(values["excess_wait_time"])
        assert cell["evidence"]["counts"]["observed_headways"] == 24
    cut = query(
        store,
        measure="bunching",
        line="A",
        direction=0,
        stop="first",
        hour=7,
        end=FRIDAY,
        day_type="weekday",
    )
    assert cut["evidence"]["counts"]["observed_headways"] == 24
    depart = query(store, measure="long_gaps", line="A", direction=0, departure="06:20:00")
    assert depart["evidence"]["counts"]["long_gaps"] == 1
    assert depart["state"] == "too_few_to_judge"
    ranking = _json(store, measure="excess_wait_time")
    assert ranking["rows"] == []
    assert ranking["excluded"][0]["reason"] == "too_few_to_judge"
    bunching = _json(store, measure="bunching")
    assert bunching["excluded"][0]["counts"]["observed_headways"] == 48
    assert _request(store, measure="bunching", kind="stop")[0] == 400


def test_waiting_excludes_unobserved_trips_capture_gaps_and_infrequent_periods(
    tmp_path: Path,
) -> None:
    trips = (
        _trip("M", 0, 0),
        _trip("M", 1, 5, None),  # Seeing the vehicles on either side is insufficient.
        _trip("M", 2, 10, 120),
        _trip("M", 3, 15, 120)._replace(basis="trip_update_passed"),
        _trip("M", 4, 20, 120),
        _trip("M", 5, 25, 120),
        _trip("I", 0, 0),
        _trip("I", 1, 11),
        _trip("D", 0, 0)._replace(direction=None),
        _trip("D", 1, 5)._replace(direction=None),
        _trip("N", 0, 0, None, live=False),
        _trip("N", 1, 5, None, live=False),
        _trip("G", 0, 45),
        _trip("G", 1, 50),
        _trip("T", 0, 0),
        _trip("T", 1, 5, None)._replace(state="not_measured", reason="capture_gap"),
        _trip("O", 0, 0),
        _trip("O", 1, 5, 600),
        _trip("O", 2, 10, 60),
    )
    polls = tuple(
        p._replace(result="error")
        if p.feed == "vehicle_positions" and 2700 < p.offset_seconds < 3000
        else p
        for p in _polls(-60, 3060)
    )
    store = _build_store(tmp_path, 6, {THURSDAY: trips}, {THURSDAY: polls})
    result = query(store, measure="waiting_and_gaps", line="M")["evidence"]
    assert result["counts"]["observed_headways"] == 1
    assert result["counts"]["long_gaps"] == 0
    assert result["excluded"]["missing_observation"] == 4
    ranked = _json(store, measure="bunching", **{"class": "all"})
    excluded = {row["id"]: row for row in ranked["excluded"]}
    assert {line: row["reason"] for line, row in excluded.items()} == {
        "D": "unknown",
        "G": "not_measured",
        "I": "no_frequent_periods",
        "M": "not_measured",
        "N": "no_live_data",
        "O": "not_measured",
        "T": "not_measured",
    }
    assert "No frequent periods" in excluded["I"]["reason_text"]["en"]
    assert excluded["I"]["excluded"]["non_frequent"] == 1
    assert excluded["D"]["excluded"]["unknown_direction"] == 2
    assert excluded["G"]["excluded"]["capture_gap"] == 1
    assert excluded["O"]["excluded"]["not_consecutive"] == 1
    assert excluded["O"]["excluded"]["overtaking_pairs"] == 1
    assert excluded["O"]["counts"]["observed_headways"] == 0
    assert excluded["O"]["excluded"]["capture_gap"] == 0
    assert excluded["T"]["excluded"]["capture_gap"] == 1


def test_waiting_uses_the_realtime_feeds_recorded_for_each_day(tmp_path: Path) -> None:
    trips = tuple(_trip("A", index, index * 5) for index in range(21))
    updates = tuple(Poll("trip_updates", second) for second in range(0, 6061, 60))
    store = _build_store(
        tmp_path,
        6,
        dict.fromkeys((THURSDAY, FRIDAY), trips),
        {
            THURSDAY: (*updates, Poll("alerts", 0, result="error")),
            FRIDAY: (*updates, Poll("vehicle_positions", 0, result="error")),
        },
    )
    measured = query(store, measure="waiting_and_gaps", line="A")
    assert measured["state"] == "measured"
    assert measured["evidence"]["counts"]["observed_headways"] == 20
    assert measured["value"]["excess_wait_time"] == 0
    missing_feed = query(store, measure="bunching", line="A", start=FRIDAY, end=FRIDAY)
    assert missing_feed["state"] == "not_measured"
    assert missing_feed["evidence"]["excluded"]["capture_gap"] == 20
    combined = query(store, measure="bunching", line="A", end=FRIDAY)
    assert combined["evidence"]["counts"]["observed_headways"] == 20
    assert combined["evidence"]["excluded"]["capture_gap"] == 20


def test_service_offered_matches_schedule_only_recomputation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    routes = {
        THURSDAY: tuple(_trip("A", i, 720 + 30 * i, None, live=False) for i in range(10)),
        SATURDAY: (
            _trip("A", 0, 110, None, live=False),
            _trip("A", 1, 720, None, live=False)._replace(direction=1),
            _trip("A", 2, 19 * 60, None, live=False),
        ),
        SUNDAY: (_trip("B", 0, 0, None, live=False),),
    }
    store = _build_store(tmp_path, 6, routes)
    # The offered family can use its schedule even when a live table is unavailable.
    (tmp_path / "stm" / str(THURSDAY) / "v6" / "stop_events.parquet").unlink()
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    options = {"measure": "service_offered", "line": "A", "direction": 0, "end": SUNDAY}
    answer = query(store, **options)
    assert answer["state"] == "measured"
    assert answer["evidence"]["days_not_measured"] == [str(FRIDAY)]
    expected_trips = Counter(
        (day, (7 + trip.offset_minutes // 60) % 24)
        for day, trips in routes.items()
        for trip in trips
        if trip.line == "A" and trip.direction == 0
    )
    total_under = 0
    for period in answer["evidence"]["periods"]:
        day = next(
            day
            for day in routes
            if day.strftime("%A").lower()
            == ("thursday" if period["day_type"] == "weekday" else period["day_type"])
        )
        hours = range(period["start_hour"], period["end_hour"])
        total = sum(expected_trips[day, hour] for hour in hours)
        assert period["scheduled_trips"] == total
        assert period["scheduled_frequency"] == total / len(hours)
        below = int(
            day != SUNDAY and (day.weekday() >= 5 or 19 in hours) and total / len(hours) < 2
        )
        assert period["below_minimum_service"] == below
        total_under += below
    assert total_under == 5  # The weekday evening meets the threshold exactly.
    assert answer["value"] == {
        "scheduled_trips": 12,
        "scheduled_frequency": 12 / 72,
        "below_minimum_service": 5,
    }
    at_stop = query(store, **options, stop="other", hour=9, day_type="saturday")
    assert at_stop["value"]["scheduled_frequency"] == 1
    assert at_stop["evidence"]["counts"]["scheduled_clock_hours"] == 1
    (period,) = at_stop["evidence"]["periods"]
    assert (period["start_hour"], period["day_type"], period["below_minimum_service"]) == (
        9,
        "saturday",
        1,
    )
    assert query(store, **options, hour=7, day_type="weekday")["value"]["scheduled_trips"] == 0
    sunday = query(store, **options, day_type="sunday")
    assert sunday["value"] == {
        "scheduled_trips": 0,
        "scheduled_frequency": 0,
        "below_minimum_service": None,
    }
    grid = query(store, **options, stop="other", group="weekday_hour")["cells"]
    assert grid[5 * 24 + 9]["value"] == at_stop["value"]
    assert grid[6 * 24 + 9]["value"]["scheduled_trips"] == 0
    assert grid[4 * 24 + 9]["state"] == "not_measured"
    assert sum(cell["value"]["scheduled_trips"] or 0 for cell in grid) == 12
    assert (
        query(store, **options, hour=7, day_type="weekday")["evidence"]["measure_states"][
            "below_minimum_service"
        ]
        == "no_evening_or_weekend_periods"
    )
    assert query(store, measure="scheduled_trips", line="unknown")["state"] == "unknown"
    assert _request(store, measure="scheduled_frequency")[0] == 400
    assert "Horaire par période et type de jour" in answer_csv(answer, "fr")

    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    status, _, body = asyncio.run(
        http(
            app,
            "/measure",
            f"measure=service_offered&city=stm&from={THURSDAY}&to={SUNDAY}&line=A&direction=0",
        )
    )
    assert status == 200
    assert json.loads(body)["value"] == answer["value"]
