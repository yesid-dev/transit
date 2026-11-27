import asyncio
import itertools
import json
from collections import Counter
from dataclasses import replace
from pathlib import Path

import duckdb
import pytest
from test_engine import FRIDAY, SATURDAY, SUNDAY, THURSDAY, Poll, Trip, _build_store, http, query
from test_ranking import _json, _request

from transit_engine import measures
from transit_engine.cities import service_query
from transit_engine.clean_manifest import STOP_EVENTS
from transit_engine.measures import answer_csv
from transit_engine.partials import PartialResults
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


def test_waiting_at_a_stop_groups_lines_without_mixing_their_intervals(tmp_path: Path) -> None:
    trips = (
        *(_trip("A", i, i * 5, 120 if i % 2 else 0) for i in range(25)),
        *(_trip("B", i, 1 + i * 5) for i in range(25)),
        *(_trip("C", i, i * 20) for i in range(8)),
    )
    store = _build_store(tmp_path, 9, {THURSDAY: trips}, {THURSDAY: _polls(0, 14400)})
    by_line = query(store, measure="waiting_and_gaps", stop="first", group="line")["cells"]
    assert [(cell["key"]["line"], cell["state"]) for cell in by_line] == [
        ("A", "measured"),
        ("B", "measured"),
        ("C", "no_frequent_periods"),
    ]
    for cell in by_line:
        answer = query(store, measure="waiting_and_gaps", stop="first", line=cell["key"]["line"])
        assert cell["value"] == answer["value"]
        assert cell["evidence"]["counts"] == answer["evidence"]["counts"]
    assert by_line[0]["value"]["excess_wait_time"] > 0
    assert by_line[1]["value"]["excess_wait_time"] == 0

    cached = replace(store, partial_results=PartialResults())
    layer_cut: dict[str, object] = {
        "measure": "excess_wait_time", "group": "line_stop", "map_view": True, "stop": "first",
    }
    layer = query(cached, **layer_cut)
    assert layer["line"] == ["A", "B", "C"]
    assert layer["direction"] == [0, 0, 0]
    assert layer["stop"] == ["first"] * 3
    assert layer["state"] == [cell["state"] for cell in by_line]
    assert layer["value"] == [cell["value"]["excess_wait_time"] for cell in by_line]
    for index in (0, 1):
        expected = layer["weighted_excess"][index] / layer["wait_weight"][index]
        assert layer["value"][index] == expected
    scoped = query(cached, **layer_cut, lines=("A",), route_type=3, time_band="morning")
    assert scoped["line"] == ["A"] and scoped["value"] == [layer["value"][0]]
    assert not query(cached, **layer_cut, hour_from=19, hour_to=20)["line"]
    unsupported = query(cached, **layer_cut, route_type=0)
    assert unsupported["stop"] == []


def test_waiting_and_rankings_require_sustained_service(tmp_path: Path) -> None:
    trips = (
        *(_trip("S", i, minute) for i, minute in enumerate((57, 60, 62, 65))),
        *(_trip("A", i, i * 5, -270 if i == 3 else 0) for i in range(13)),
        _trip("A", 13, 5, 15),
        _trip("A", 14, 25, 15)._replace(state="added"),
        _trip("A", 15, 6, -30),
    )
    store = _build_store(tmp_path, 9, {THURSDAY: trips}, {THURSDAY: _polls(0, 3900)})
    ranked = _json(store, measure="on_time", **{"class": "all"})
    assert {row["id"]: row["class"] for row in ranked["rows"] + ranked["excluded"]} == {
        "A": "3:frequent",
        "S": "3:regular",
    }
    school = query(store, measure="bunching", line="S")
    assert school["state"] == "no_frequent_periods"
    assert school["evidence"]["counts"]["frequent_headways"] == 0

    # Pairs scheduled at the same time or a minute apart stay in the denominator.
    # The two other short gaps count as bunching, including one with an added trip.
    for cuts, expected in (({}, 15), ({"hour": 7}, 14)):
        result = query(store, measure="bunching", line="A", **cuts)
        counts = result["evidence"]["counts"]
        assert counts["observed_headways"] == expected
        assert counts["bunching"] == 2


def test_waiting_network_fits_the_buffer_without_spilling(tmp_path: Path) -> None:
    trips = tuple(_trip("A", i, -60 + i * 5) for i in range(25))
    store = replace(
        _build_store(tmp_path, 9, {THURSDAY: trips}, {THURSDAY: _polls(-3660, 3660)}),
        memory_mib=192,
    )
    question = measures.Question("waiting_and_gaps", "stm", THURSDAY, THURSDAY)
    family, selected = measures._SELECTIONS[question.measure]
    assert family.query is not None
    with service_query(store, question.city) as conn:
        conn.execute("SET temp_directory = ''")
        window = measures.read_window(conn, store, question, family, selected)
        dense_stops = (tmp_path / "dense-stop-events.parquet").as_posix()
        with duckdb.connect() as fixture:
            fixture.execute(
                """
                COPY (
                    SELECT stops.* REPLACE (
                        'stop-' || n AS stop_id,
                        n + 1 AS stop_sequence,
                        CASE WHEN n < 4000 THEN basis ELSE 'not_observed' END AS basis,
                        CASE WHEN n < 4000 THEN observed_at_utc END AS observed_at_utc
                    )
                    FROM read_parquet(?) stops CROSS JOIN range(12000) copy(n)
                ) TO ? (FORMAT PARQUET)
                """,
                [window.paths[STOP_EVENTS][0], dense_stops],
            )
        window.paths[STOP_EVENTS] = [dense_stops]
        result = family.query(conn, family, window.paths, question, "9", None)[()]
    state, values, evidence, _ = measures.evaluate(family, selected, result, window)
    assert state == "measured"
    assert values["excess_wait_time"] == 0
    assert evidence["counts"]["scheduled_headways"] == 24 * 12000
    assert evidence["counts"]["observed_headways"] == 24 * 4000


@pytest.mark.parametrize(
    ("changes", "metric", "expected_wait"),
    [
        ({1: (None, "cancelled"), 2: (60, "ran")}, "long_gaps", 15.5),
        ({1: (310, "ran")}, "bunching", 174200 / 14400),
    ],
    ids=("cancelled-trip", "overtaking"),
)
def test_waiting_counts_disruptions_in_observed_arrival_order(
    tmp_path: Path,
    changes: dict[int, tuple[int | None, str]],
    metric: str,
    expected_wait: float,
) -> None:
    trips = tuple(
        _trip("A", i, -60 + i * 5, changes.get(i, (0, "ran"))[0])._replace(
            state=changes.get(i, (0, "ran"))[1]
        )
        for i in range(25)
    )
    store = _build_store(tmp_path, 6, {THURSDAY: trips}, {THURSDAY: _polls(-3660, 3660)})
    result = query(store, measure="waiting_and_gaps", stop="first")
    assert result["evidence"]["counts"][metric] == 1
    assert result["evidence"]["counts"]["observed_seconds"] == 7200
    assert result["value"]["excess_wait_time"] == pytest.approx(expected_wait)


def test_waiting_weights_periods_by_covered_scheduled_elapsed_time(tmp_path: Path) -> None:
    # Morning: 20 scheduled headways of 180 seconds, with one trip delayed
    # 120 seconds. Midday: seven scheduled headways of 600 seconds and four
    # past the last usable poll. The eighth headway ends outside the observed window.
    morning = tuple(_trip("A", i, -120 + 3 * i, 120 if i == 1 else 0) for i in range(21))
    midday = tuple(_trip("A", 21 + i, 180 + 10 * i, -300 if i == 8 else 0) for i in range(13))
    polls = (*_polls(-7260, -3540), *_polls(10800, 15600))
    store = _build_store(tmp_path, 6, {THURSDAY: morning + midday}, {THURSDAY: polls})
    result = query(store, measure="waiting_and_gaps", stop="first")
    morning_wait = (300**2 + 60**2 + 18 * 180**2) / (2 * 3600) - 90
    midday_wait = (7 * 600**2 + 300**2) / (2 * 4500) - 300
    assert result["value"]["excess_wait_time"] == pytest.approx(
        (morning_wait * 3600 + midday_wait * 4200) / 7800
    )
    counts = result["evidence"]["counts"]
    assert counts["wait_weight"] == 7800
    assert counts["weighted_excess"] == pytest.approx(morning_wait * 3600 + midday_wait * 4200)
    assert result["evidence"]["excluded"]["capture_gap"] == 4


def test_waiting_keeps_observed_headways_without_a_schedule_match_in_their_window(
    tmp_path: Path,
) -> None:
    # Two windows in the same period. The second observed headway runs from
    # minute 46 to 48, entirely inside the scheduled headway from 45 to 50.
    trips = (
        *(_trip("A", i, -60 + 5 * i) for i in range(21)),
        _trip("A", 21, 45, 60),
        _trip("A", 22, 50, -120),
    )
    polls = (*_polls(-3660, 2460), *_polls(2700, 2940))
    store = _build_store(tmp_path, 11, {THURSDAY: trips}, {THURSDAY: polls})
    result = query(store, measure="waiting_and_gaps", line="A", stop="first")
    assert result["state"] == "measured"
    counts = result["evidence"]["counts"]
    assert counts["observed_headways"] == 21
    assert counts["covered_scheduled_headways"] == 20
    assert counts["wait_weight"] == 6000
    actual_wait = (20 * 300**2 + 120**2) / (2 * (20 * 300 + 120))
    assert result["value"]["excess_wait_time"] == pytest.approx(actual_wait - 150)


@pytest.mark.parametrize("state", ("ran", "unconfirmed"))
def test_waiting_excludes_an_interval_with_an_unobserved_passage(
    tmp_path: Path, state: str
) -> None:
    trips = tuple(
        _trip("A", i, -60 + i * 5, None if i == 1 else 60 if i == 2 else 0)
        for i in range(25)
    )
    trips = (trips[0], trips[1]._replace(state=state), *trips[2:])
    store = _build_store(tmp_path, 6, {THURSDAY: trips}, {THURSDAY: _polls(-3660, 3660)})
    result = query(store, measure="waiting_and_gaps", stop="first")
    counts = result["evidence"]["counts"]
    assert counts["long_gaps"] == 0
    assert counts["observed_headways"] == 22
    assert counts["scheduled_seconds"] == 6300
    assert result["evidence"]["excluded"]["unknown_passage"] == 1


def test_waiting_does_not_assign_a_scheduled_service_break_to_the_next_period(
    tmp_path: Path,
) -> None:
    # Last overnight passage at 01:00, then 24 on-schedule morning headways.
    trips = (_trip("A", 0, -360),) + tuple(_trip("A", i + 1, -60 + i * 5) for i in range(25))
    store = _build_store(tmp_path, 6, {THURSDAY: trips}, {THURSDAY: _polls(-21660, 3660)})
    answer = query(store, measure="waiting_and_gaps", stop="first")
    assert answer["evidence"]["counts"]["observed_headways"] == 24
    assert answer["value"]["long_gaps"] == 0
    assert answer["value"]["excess_wait_time"] == 0


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


def test_waiting_includes_missing_trips_and_all_bases_but_excludes_poll_gaps(
    tmp_path: Path,
) -> None:
    trips = (
        _trip("M", 0, 0),
        _trip("M", 1, 5, None),
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
        # Extend the timetables on the lines used to check capture and passage evidence.
        *(
            _trip(line, 10 + i, minute, None)._replace(state="cancelled")
            for line, minutes in (
                ("M", range(30, 61, 5)),
                ("G", range(55, 106, 5)),
                ("T", range(10, 61, 5)),
                ("O", range(20, 61, 10)),
            )
            for i, minute in enumerate(minutes)
        ),
    )
    polls = tuple(
        p._replace(result="error")
        if p.feed == "vehicle_positions" and 2700 < p.offset_seconds < 3000
        else p
        for p in _polls(-60, 3060)
    )
    store = _build_store(tmp_path, 6, {THURSDAY: trips}, {THURSDAY: polls})
    result = query(store, measure="waiting_and_gaps", line="M")["evidence"]
    assert result["counts"]["observed_headways"] == 4
    assert result["counts"]["long_gaps"] == 1
    assert result["excluded"]["missing_observation"] == 8
    ranked = _json(store, measure="bunching", **{"class": "all"})
    excluded = {row["id"]: row for row in ranked["excluded"]}
    assert {line: row["reason"] for line, row in excluded.items()} == {
        "D": "unknown",
        "G": "not_measured",
        "I": "no_frequent_periods",
        "M": "too_few_to_judge",
        "N": "no_live_data",
        "O": "too_few_to_judge",
        "T": "not_measured",
    }
    assert "No frequent periods" in excluded["I"]["reason_text"]["en"]
    assert excluded["I"]["excluded"]["non_frequent"] == 1
    assert excluded["D"]["excluded"]["unknown_direction"] == 2
    assert excluded["G"]["excluded"]["capture_gap"] == 1
    assert excluded["O"]["counts"]["observed_headways"] == 2
    assert excluded["O"]["excluded"]["capture_gap"] == 0
    assert excluded["T"]["excluded"]["missing_observation"] == 12


def test_waiting_uses_the_realtime_feeds_recorded_for_each_day(tmp_path: Path) -> None:
    trips = tuple(_trip("A", index, index * 5) for index in range(21))
    updates = tuple(Poll("trip_updates", second) for second in range(0, 6061, 60))
    store = _build_store(
        tmp_path,
        6,
        dict.fromkeys((THURSDAY, FRIDAY), trips),
        {
            THURSDAY: (*updates, Poll("alerts", 0, result="error"), Poll("i3_alerts", 0)),
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


def test_waiting_counts_coverage_ending_on_an_hour_boundary(tmp_path: Path) -> None:
    trips = (
        *(_trip("A", i, minute) for i, minute in enumerate(range(-10, 11, 5))),
        *(
            _trip("A", 10 + i, minute, None)._replace(state="cancelled")
            for i, minute in enumerate(range(15, 51, 5))
        ),
    )
    polls = (*_polls(-900, 0), *_polls(300, 600))
    store = _build_store(tmp_path, 9, {THURSDAY: trips}, {THURSDAY: polls})

    evidence = query(store, measure="waiting_and_gaps")["evidence"]

    assert evidence["counts"]["observed_headways"] == 3
    assert evidence["counts"]["observed_seconds"] == 900
    assert evidence["excluded"]["capture_gap"] == 1


def test_waiting_period_summary_preserves_tied_passages_and_live_status(tmp_path: Path) -> None:
    trips = (
        _trip("A", 0, 0),
        _trip("A", 1, 5, None)._replace(state="cancelled"),
        _trip("A", 2, 5),
        _trip("A", 3, 10, None, live=False),
        _trip("A", 4, 15),
        *(_trip("A", 5 + i, minute) for i, minute in enumerate(range(20, 61, 10))),
    )
    store = _build_store(tmp_path, 9, {THURSDAY: trips}, {THURSDAY: _polls(0, 3600)})
    evidence = query(store, measure="waiting_and_gaps")["evidence"]

    assert evidence["counts"]["scheduled_headways"] == 8
    assert evidence["counts"]["frequent_headways"] == 8
    assert evidence["excluded"]["missing_observation"] == 2
    assert evidence["excluded"]["route_without_live_data"] == 1


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
