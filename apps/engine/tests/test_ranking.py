import asyncio
import csv
import json
from collections import Counter, defaultdict
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import pytest
from test_engine import FRIDAY, THURSDAY, Trip, _build_store, http

from transit_engine.measures import Question, ask, methods
from transit_engine.ranking import Ranking, rank, wilson_interval
from transit_engine.server import Engine
from transit_engine.store import Store


def _service(
    line: str,
    trips: int,
    delays: tuple[int | None, ...],
    *,
    start: int = 0,
    step: int = 10,
    route_type: int = 3,
    reason: str | None = None,
) -> tuple[Trip, ...]:
    return tuple(
        Trip(
            f"{line}-{index}",
            line,
            0,
            "not_measured" if reason else "ran",
            reason,
            reason != "route_without_live_data",
            delays,
            start + index * step,
            duration_minutes=35 + index % 2,
            route_type=route_type,
        )
        for index in range(trips)
    )


@pytest.fixture
def network(tmp_path: Path) -> tuple[Store, tuple[Trip, ...]]:
    half = (-60, 300, -61, 301) * 2
    trips = (
        *_service("B", 24, half),
        *_service("A", 24, half),
        *_service("C", 20, half),
        *_service("W", 20, (601,) * 8),
        *_service("S", 7, (0,) * 8),
        *_service("X", 7, (None,) * 8, reason="route_without_live_data"),
        *_service("G", 7, (None,) * 8, reason="capture_gap"),
        *_service("N", 20, (0,) * 32, start=19 * 60),
        *_service("R", 20, (0,) * 16, route_type=1),
    )
    return _build_store(
        tmp_path, 9, {THURSDAY: trips, **{
            THURSDAY + timedelta(days=i): (
                _service("N", 2, (0,) * 32, start=19 * 60) if i != 2 else
                _service("N", 3, (0,) * 32, start=19 * 60)
            )
            for i in (2, 3, 4, 5, 6)
        }}
    ), trips


def _request(store: Store, **options: str) -> tuple[int, dict[bytes, bytes], bytes]:
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = {"city": "stm", "kind": "line", "from": str(THURSDAY), "to": str(FRIDAY)}
    return asyncio.run(http(app, "/ranking", urlencode({**params, **options})))


def _json(store: Store, **options: str) -> dict[str, Any]:
    status, _, body = _request(store, **options)
    assert status == 200, body
    result: dict[str, Any] = json.loads(body)
    return result


def test_lines_match_independent_calculation_and_show_every_exclusion(
    network: tuple[Store, tuple[Trip, ...]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture, trips = network
    monkeypatch.setenv("ENGINE_CLEAN_ROOT", fixture.root)
    monkeypatch.delenv("ENGINE_CLEANING_VERSION", raising=False)
    store = Store.from_env()
    answer = _json(store)
    samples: dict[str, list[int]] = defaultdict(list)
    observed_trips: Counter[str] = Counter()
    for trip in trips:
        # Select the line class with the morning peak start pattern.
        if trip.live and trip.line not in {"N", "R"}:
            if any(delay is not None for delay in trip.delays):
                observed_trips[trip.line] += 1
            for delay in trip.delays:
                if delay is not None:
                    samples[trip.line].append(delay)
    expected = [
        (line, sum(-60 <= delay <= 300 for delay in delays) / len(delays), len(delays))
        for line, delays in samples.items()
        if len(delays) >= 100 and observed_trips[line] >= 20
    ]
    expected.sort(key=lambda row: (wilson_interval(row[1], row[2])[1], -row[2], row[0]))
    assert expected == [("W", 0.0, 160), ("A", 0.5, 192), ("B", 0.5, 192), ("C", 0.5, 160)]
    assert [(r["id"], r["value"], r["sample"]) for r in answer["rows"]] == expected
    assert [r["rank"] for r in answer["rows"]] == [1, 2, 3, 4]
    assert answer["rows"][1]["counts"]["on_time"] == 96
    assert answer["rows"][1]["range"]["lower"] < 0.5 < answer["rows"][1]["range"]["upper"]
    assert answer["class"] == "3:frequent"
    assert answer["available_classes"] == ["1:frequent", "3:frequent", "3:night"]
    assert {row["id"]: row["reason"] for row in answer["excluded"]} == {
        "G": "not_measured",
        "S": "too_few_to_judge",
        "X": "no_live_data",
    }
    evidence = answer["evidence"]
    assert evidence["days_measured"] == [str(THURSDAY)]
    assert evidence["days_not_measured"] == [str(FRIDAY)]
    assert evidence["days_included"] == [str(THURSDAY)]
    assert evidence["cleaning_versions"] == [9]
    assert evidence["query_ms"] >= 0
    assert answer["coverage_note"]["en"] == "Only measured days are included."
    assert [r["id"] for r in _json(store, **{"class": "3:night"})["rows"]] == ["N"]
    all_lines = _json(store, **{"class": "all", "limit": "1"})
    assert all_lines["ranked_count"] == 6
    assert set(row["id"] for row in all_lines["excluded"]) == {"G", "S", "X"}
    assert [row["id"] for row in all_lines["rows"]] == ["W"]


def test_ranked_stop_and_departure_keep_registry_cuts(
    network: tuple[Store, tuple[Trip, ...]],
) -> None:
    store, _ = network
    stops = _json(store, kind="stop", hour="7", measure="late", day_type="weekday")
    assert stops["rows"][0]["id"] == "other"
    assert stops["rows"][0]["classes"] == ["1:frequent", "3:frequent"]
    assert stops["evidence"]["cuts"] == {"day_type": "weekday", "hour": 7}

    last = str(THURSDAY + timedelta(days=6))
    departures = _json(store, kind="departure", hour="2", to=last)
    assert all(row["reason"] == "too_few_to_judge" for row in departures["excluded"])
    assert {row["counts"]["observed_service_dates"] for row in departures["excluded"]} == {1}
    first, second = departures["rows"]
    assert [(r["line"], r["direction"], r["departure"], r["class"]) for r in (first, second)] == [
        ("N", 0, "26:00:00", "3:night"),
        ("N", 0, "26:10:00", "3:night"),
    ]
    limited = _json(store, kind="departure", hour="2", limit="1", to=last)
    assert limited["ranked_count"] == 2
    assert limited["rows"] == [first]
    assert limited["excluded"] == departures["excluded"]
    measured = _json(store, measure="p90_delay", **{"class": "all"})
    assert measured["rows"][0]["id"] == "W"
    top = measured["rows"][0]
    assert top["range"] == {
        "lower": top["value"] - 7,
        "upper": top["value"] + 7,
        "method": "histogram_half_bin",
    }


def test_delivery_values_and_boundary_use_registry(tmp_path: Path) -> None:
    trips = list(_service("D", 30, (0,), step=0))
    trips[:10] = [row._replace(state="cancelled", notice_seconds=-120) for row in trips[:10]]
    store = _build_store(tmp_path, 6, {THURSDAY: tuple(trips)})
    for measure, kind in (
        ("trips_run", "departure"),
        ("cancelled_trips", "line"),
        ("first_trip", "line"),
        ("last_trip", "line"),
        ("service_hours", "line"),
    ):
        answer = _json(store, measure=measure, kind=kind, day_type="weekday")
        (row,) = answer["rows"]
        reference = ask(
            store, Question(measure, "stm", THURSDAY, FRIDAY, line="D", day_type="weekday")
        )
        assert row["value"] == reference["value"][measure]
        assert row["sample"] == 30
        assert row["range"]["lower"] < row["value"] < row["range"]["upper"]
        if measure == "first_trip":
            assert row["boundary_departures"][0]["ran"] == 20
        elif measure == "cancelled_trips":
            assert row["median_cancellation_lead_seconds"] == 127.5
            assert row["range"]["method"] == "wilson_95"
        elif measure == "service_hours":
            assert row["range"]["method"] == "duration_weighted_wilson_95"


def test_wilson_and_registry_csv(network: tuple[Store, tuple[Trip, ...]]) -> None:
    assert wilson_interval(0.5, 30) == pytest.approx((0.3315413, 0.6684587))
    assert wilson_interval(0, 30)[0] == 0
    assert wilson_interval(1, 30)[1] == 1
    store, _ = network
    status, headers, body = _request(store, format="csv", lang="fr")
    assert status == 200
    assert headers[b"content-type"] == b"text/csv; charset=utf-8"
    records = list(csv.reader(body.decode().splitlines()))
    registry = next(item for item in methods() if item["id"] == "on_time")
    assert records[0][-len(registry["csv_columns"]["fr"]) :] == registry["csv_columns"]["fr"]
    assert any("Aucune donnée en direct" in row for row in records[1:])


def test_invalid_ranking_selection_is_rejected(network: tuple[Store, tuple[Trip, ...]]) -> None:
    store, _ = network
    for options in (
        {"limit": "0"},
        {"limit": "501"},
        {"kind": "bus"},
        {"kind": "stop", "measure": "trips_run"},
        {"kind": "departure", "measure": "first_trip", "day_type": "weekday"},
        {"kind": "line", "measure": "punctuality"},
    ):
        assert _request(store, **options)[0] == 400


def test_legacy_cleaning_marks_route_type_unknown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    trips = _service("A", 20, (0,) * 16)
    fixture = _build_store(tmp_path, 5, {THURSDAY: trips})
    monkeypatch.setenv("ENGINE_CLEAN_ROOT", fixture.root)
    monkeypatch.setenv("ENGINE_CLEANING_VERSION", "5")
    store = Store.from_env()
    request = Ranking(Question("on_time", "stm", THURSDAY, THURSDAY), "line")
    assert rank(store, request)["rows"][0]["class"] == "unknown:frequent"


def test_low_coverage_lines_are_excluded_and_unrankable_classes_are_not_offered(
    tmp_path: Path,
) -> None:
    # 3 of 8 scheduled stops observed (37.5%): above the 25% minimum, under the 50% limit.
    sparse = (0, 0, 0, None, None, None, None, None)
    trips = (
        *_service("A", 24, (0, 0, 0, 301) * 2),
        *_service("L", 40, sparse),
        *_service("M", 20, (None,) * 8, route_type=1, reason="route_without_live_data"),
    )
    store = _build_store(tmp_path, 9, {THURSDAY: trips})
    answer = _json(store, **{"class": "all"})
    assert [row["id"] for row in answer["rows"]] == ["A"]
    assert answer["ranked_count"] == 1
    excluded = {row["id"]: row for row in answer["excluded"]}
    assert excluded["L"]["reason"] == "low_coverage"
    assert excluded["L"]["reason_text"] == {"en": "Low coverage", "fr": "Faible couverture"}
    assert excluded["L"]["share_observed"] == pytest.approx(3 / 8)
    assert excluded["L"]["counts"]["scheduled"] == 320
    assert excluded["L"]["low_coverage"] is True
    assert "value" not in excluded["L"]
    assert excluded["M"]["reason"] == "no_live_data"
    # The métro-like class has no line with live data, so it is never offered.
    assert answer["available_classes"] == ["3:frequent"]
    # Stops follow the same rule: no ranked stop is under the limit.
    stops = _json(store, kind="stop")
    assert stops["rows"]
    assert all(row["share_observed"] >= 0.5 for row in stops["rows"])
