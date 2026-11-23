import csv
import io
import json
from collections import Counter
from pathlib import Path

import pytest
from test_engine import FRIDAY, SATURDAY, THURSDAY, Poll, Trip, _build_store, query
from test_ranking import _json
from test_schedule_measures import _trip

from transit_engine import measures
from transit_engine.histogram import percentile
from transit_engine.measures import Batch, ReadWindow, answer_csv, evaluate


@pytest.mark.parametrize("latest", [2, None])
def test_accessibility_counts_a_stop_once_across_batches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, latest: int | None
) -> None:
    trip = _trip("A", 0, 0)._replace(delays=(0, 0), stop_wheelchair=(1, 1))
    store = _build_store(
        tmp_path,
        8,
        {
            THURSDAY: (trip,),
            FRIDAY: (trip._replace(stop_wheelchair=(latest, latest)),),
        },
    )
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    answer = query(store, measure="accessible_stops", end=FRIDAY)
    counts = answer["evidence"]["counts"]
    assert sum(value for key, value in counts.items() if key.startswith("stops_")) == 2
    assert counts["stops_accessible"] == 0
    assert answer["state"] == ("not_published" if latest is None else "measured")


@pytest.mark.parametrize("version", [8, 9])
def test_punctuality_basis_in_evidence_and_csv(tmp_path: Path, version: int) -> None:
    trips = tuple(
        Trip(str(i), "A", 0, "ran", None, True, (0,) * 12, basis=basis)
        for i, basis in enumerate(("vehicle_stopped", "trip_update_reported", "trip_update_passed"))
    )
    store = _build_store(tmp_path, version, {THURSDAY: trips})
    answer = query(store, measure="on_time")
    counts = answer["evidence"]["counts"]
    assert [counts[trip.basis] for trip in trips] == [12, 12, 12]
    (row,) = csv.DictReader(io.StringIO(answer_csv(answer, "en")))
    assert [
        row[label] for label in ("Vehicle stopped", "Trip update reported", "Trip update passed")
    ] == ["12", "12", "12"]


@pytest.mark.parametrize(
    "name,denominator,numerator,minimum,warning",
    [
        ("on_time", "scheduled", "classified", 200, 100),
        ("median_time_lost", "scheduled_runs", "observed_runs", 200, 100),
        ("bunching", "frequent_headways", "observed_headways", 200, 100),
        ("trips_run", "scheduled", "eligible", 100, 62),
    ],
)
def test_answer_coverage_thresholds(
    name: str, denominator: str, numerator: str, minimum: int, warning: int
) -> None:
    family, selected = measures._SELECTIONS[name]
    window = ReadWindow({}, measured=[str(THURSDAY)], included=[str(THURSDAY)])
    sample = 50
    for total, expected_state, low in [
        (minimum + 1, "not_measured", True),
        (minimum, "measured", True),
        (warning, "measured", False),
    ]:
        counts = Counter({denominator: total, numerator: sample, "on_time": sample, "ran": sample})
        state, values, evidence, _ = evaluate(
            family, selected, Batch(counts=counts, histogram=Counter({0: sample})), window
        )
        assert state == expected_state
        assert (values[name] is not None) == (state == "measured")
        assert evidence.get("low_coverage", False) is low
        assert evidence["share_eligible" if name == "trips_run" else "share_observed"] == (
            sample / total
        )
        if state == "not_measured":
            assert evidence["coverage_reason"] == "insufficient_coverage"


def test_delivery_coverage_excludes_lines_without_live_data(tmp_path: Path) -> None:
    trips = (
        *(_trip("A", i, i) for i in range(20)),
        *(
            _trip("N", i, i, None, live=False)._replace(
                state="not_measured", reason="route_without_live_data"
            )
            for i in range(50)
        ),
        _trip("A", 25, 25, None)._replace(state="unconfirmed"),
    )
    store = _build_store(tmp_path, 8, {THURSDAY: trips})
    answer = query(store, measure="service_delivered")
    evidence = answer["evidence"]
    assert evidence["share_eligible"] == 20 / 21
    assert evidence["share_unconfirmed"] == 1 / 21
    assert "Eligible share" in answer_csv(answer, "en").splitlines()[0]


def test_corridor_coverage_excludes_cancelled_and_lines_without_live_data() -> None:
    family, selected = measures._SELECTIONS["median_time_lost"]
    window = ReadWindow({}, measured=[str(THURSDAY)], included=[str(THURSDAY)])
    counts = Counter(scheduled_runs=30, route_without_live_data=4, cancelled=6, capture_gap=20)
    state, values, evidence, _ = evaluate(family, selected, Batch(counts=counts), window)
    assert state == "not_measured"
    assert values["median_time_lost"] is None
    assert evidence["share_observed"] == 0
    counts.update(observed_runs=20, capture_gap=-20)
    _, _, evidence, _ = evaluate(
        family, selected, Batch(counts=counts, histogram=Counter({0: 20})), window
    )
    assert evidence["share_observed"] == 1


@pytest.mark.parametrize("version", [8, 10])
def test_poll_coverage_accepts_declared_lag_and_rejects_future_headers(
    tmp_path: Path, version: int
) -> None:
    trips = tuple(_trip("A", index, index * 5) for index in range(21))
    genuine = tuple(
        Poll("trip_updates", second, publication_age=150) for second in range(0, 6061, 60)
    )
    # A future timestamp between valid polls must not suppress subsequent genuine publications.
    future = Poll("trip_updates", 120, publication_age=-3600)
    store = _build_store(
        tmp_path,
        version,
        dict.fromkeys((THURSDAY, FRIDAY), trips),
        {
            THURSDAY: (*genuine, future),
            FRIDAY: tuple(p._replace(publication_age=-30) for p in genuine),
        },
    )
    for day in (THURSDAY, FRIDAY):
        manifest = tmp_path / "stm" / str(day) / f"v{version}" / "manifest.json"
        receipt = json.loads(manifest.read_text())
        receipt["scorecard_declaration"] = {"live_source_lag_seconds": 60}
        manifest.write_text(json.dumps(receipt))
    assert query(store, measure="bunching")["evidence"]["counts"]["observed_headways"] == 20
    assert query(store, measure="bunching", start=FRIDAY, end=FRIDAY)["state"] == "not_measured"


def test_legacy_poll_coverage_reads_the_provider_declaration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    declarations = tmp_path / "declarations"
    declarations.mkdir()
    (declarations / "demo.yaml").write_text(
        "provider:\n  provider_id: demo\n  live_source_lag_seconds: 60\n"
    )
    monkeypatch.setenv("ENGINE_PROVIDER_DECLARATIONS", str(declarations))
    trips = tuple(_trip("A", index, index * 5) for index in range(21))
    polls = tuple(
        Poll("trip_updates", second, publication_age=150) for second in range(0, 6061, 60)
    )
    store = _build_store(tmp_path, 8, {THURSDAY: trips}, {THURSDAY: polls}, city="demo")
    answer = query(store, measure="bunching", city="demo")
    assert answer["state"] == "measured"
    assert answer["evidence"]["counts"]["observed_headways"] == 20


def test_future_publications_cannot_create_a_capture_window(tmp_path: Path) -> None:
    trips = tuple(_trip("A", index, index * 5) for index in range(21))
    polls = tuple(
        Poll("trip_updates", second, publication_age=-30) for second in range(0, 6061, 60)
    )
    store = _build_store(tmp_path, 8, {THURSDAY: trips}, {THURSDAY: polls})
    answer = query(store, measure="bunching")
    assert answer["state"] == "not_measured"
    assert answer["evidence"]["counts"]["observed_headways"] == 0


def test_ranking_orders_on_time_by_upper_bound_and_keeps_exact_rate(tmp_path: Path) -> None:
    def line(name: str, trip_count: int, on_time_trips: int) -> tuple[Trip, ...]:
        return tuple(
            Trip(
                f"{name}{i}",
                name,
                0,
                "ran",
                None,
                True,
                (0 if i < on_time_trips else 600,) * 5,
                offset_minutes=i,
            )
            for i in range(trip_count)
        )

    store = _build_store(
        tmp_path,
        9,
        {
            THURSDAY: (
                *line("A", 20, 10),
                *line("B", 200, 105),
                *(trip._replace(delays=(600,) * 6) for trip in line("few_trips", 19, 0)),
                *(trip._replace(delays=(600,) * 4) for trip in line("few_stops", 20, 0)),
            )
        },
    )
    answer = _json(store, measure="on_time", **{"class": "all", "limit": "1"})
    (row,) = answer["rows"]
    assert (row["id"], row["value"]) == ("B", 0.525)
    assert row["ranking_bound"] == row["range"]["upper"]
    assert {item["id"]: item["reason"] for item in answer["excluded"]} == {
        "few_trips": "too_few_to_judge",
        "few_stops": "too_few_to_judge",
    }
    late = _json(store, measure="late", **{"class": "all", "limit": "1"})["rows"][0]
    assert (late["id"], late["value"], late["ranking_bound"]) == (
        "B",
        0.475,
        late["range"]["lower"],
    )


def test_waiting_ranking_needs_distinct_trip_pairs(tmp_path: Path) -> None:
    def trips(line: str, count: int, n_stops: int) -> tuple[Trip, ...]:
        return tuple(
            _trip(line, index, index * 4)._replace(
                delays=(0,) * n_stops, stop_ids=tuple(map(str, range(n_stops)))
            )
            for index in range(count)
        )

    store = _build_store(
        tmp_path,
        8,
        {THURSDAY: (*trips("A", 20, 4), *trips("B", 21, 4))},
        {THURSDAY: tuple(Poll("trip_updates", second) for second in range(-120, 6001, 60))},
    )
    ranked = _json(store, measure="bunching", **{"class": "all"})
    (row,) = ranked["rows"]
    assert (row["id"], row["counts"]["observed_trip_pairs"], row["sample"]) == ("B", 20, 80)
    (excluded,) = ranked["excluded"]
    assert excluded["id"] == "A"
    assert excluded["counts"]["observed_headways"] == 76
    assert excluded["reason"] == "too_few_to_judge"


def test_stop_and_delivery_ranking_floor_edges(tmp_path: Path) -> None:
    trips = tuple(
        _trip("A" if index < 29 else "B", index, index)._replace(
            stop_ids=("fewer" if index < 49 else "enough",)
        )
        for index in range(99)
    )
    store = _build_store(tmp_path, 8, {THURSDAY: trips})
    stops = _json(store, measure="on_time", kind="stop")
    assert [row["id"] for row in stops["rows"]] == ["enough"]
    assert stops["excluded"][0]["sample"] == 49
    delivery = _json(store, measure="cancelled_trips", **{"class": "all"})
    assert [row["id"] for row in delivery["rows"]] == ["B"]
    assert delivery["excluded"][0]["sample"] == 29


def test_ranking_peak_uses_weekdays(tmp_path: Path) -> None:
    store = _build_store(
        tmp_path,
        8,
        {
            THURSDAY: tuple(_trip("A", i, i * 2) for i in range(5)),
            SATURDAY: tuple(_trip("A", i, i * 110) for i in range(2)),
        },
    )
    answer = _json(store, measure="on_time", to=str(SATURDAY), **{"class": "all"})
    assert answer["available_classes"] == ["3:frequent"]


def test_sparse_service_for_a_date_is_independent_of_adjacent_days(tmp_path: Path) -> None:
    store = _build_store(
        tmp_path,
        8,
        {
            THURSDAY: (_trip("A", 0, 0), _trip("A", 1, 2)._replace(direction=1)),
            SATURDAY: (_trip("A", 0, 0),),
        },
    )
    options = dict(measure="below_minimum_service", day_type="saturday", end=SATURDAY)
    assert query(store, start=SATURDAY, **options)["value"] == query(store, **options)["value"]


def test_integer_second_histogram_has_an_exact_one_second_bin() -> None:
    assert percentile([(20, 20)], 20, 50, width=1) == 20


def test_scorecard_sample_floor_and_prediction_wording(tmp_path: Path) -> None:
    polls = tuple(Poll("trip_updates", i * 20) for i in range(19))
    store = _build_store(tmp_path, 8, {THURSDAY: (_trip("A", 0, 0),)}, {THURSDAY: polls})
    answer = query(store, measure="poll_success")
    assert answer["evidence"]["counts"]["poll_success"]["trip_updates"]["attempts"] == 19
    assert answer["value"]["poll_success"]["trip_updates"] is None
    assert answer["state"] == "too_few_to_judge"


def test_prediction_method_describes_observed_stop_events() -> None:
    (method,) = [item for item in measures.methods() if item["id"] == "prediction_error"]
    assert "30 observed stop events" in method["text"]["en"]["limits"]


def test_cancellation_notice_display_floor(tmp_path: Path) -> None:
    trips = tuple(
        _trip("A", i, i, None)._replace(state="cancelled", notice_seconds=60) for i in range(9)
    )
    store = _build_store(tmp_path, 8, {THURSDAY: trips})
    evidence = query(store, measure="service_delivered")["evidence"]
    assert evidence["counts"]["cancellation_notices"] == 9
    assert evidence["median_cancellation_lead_seconds"] is None
    assert evidence["measure_states"]["median_cancellation_lead_seconds"] == "too_few_to_judge"


def test_vehicle_reporting_display_floor() -> None:
    window = ReadWindow({}, measured=[str(THURSDAY)], included=[str(THURSDAY)])
    name = "vehicle_reporting_gaps_per_100_hours"
    family, selected = measures._SELECTIONS[name]
    counts = Counter(tracked_vehicle_days=1, service_us=3_600_000_000, reporting_gaps=1)
    state, values, evidence, _ = evaluate(family, selected, Batch(counts=counts), window)
    assert state == "too_few_to_judge"
    assert values[name] is None
    assert evidence["counts"]["hours_in_service"] == 1
