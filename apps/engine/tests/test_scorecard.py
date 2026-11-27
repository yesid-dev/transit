import asyncio
import csv
import io
import json
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from random import Random
from statistics import median, quantiles
from typing import NamedTuple

import duckdb
import pytest
from test_engine import FRIDAY, SATURDAY, THURSDAY, Trip, _build_store, http
from test_historical_measures import _write_table, utc

from transit_engine import measures, scorecard
from transit_engine.clean_manifest import FEED_POLLS, PREDICTION_SAMPLES, VEHICLE_POSITIONS
from transit_engine.measures import Question, answer_csv, ask, methods
from transit_engine.server import Engine
from transit_engine.store import Store

CITY = "fixture_city"
FAMILY = "open_data_scorecard"


class Poll(NamedTuple):
    feed: str
    captured: datetime
    ident: str
    result: str
    published: datetime | None


class Vehicle(NamedTuple):
    ident: str
    start: datetime
    last: datetime
    trip: str | None
    route: str | None
    stop: str | None
    status: int | None
    occupancy_status: int | None
    occupancy_percentage: int | None
    latitude: float | None
    longitude: float | None


def _trip(
    ident: str,
    line: str,
    state: str = "ran",
    *,
    captured: bool = True,
    live: bool = True,
    reason: str | None = None,
) -> Trip:
    return Trip(ident, line, 0, state, reason, live, (0,), captured=captured)


@pytest.fixture(autouse=True)
def declare_fixture_city(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / f"{CITY}.yaml").write_text(
        "stage: public\ntimezone: Asia/Kolkata\n", encoding="utf-8"
    )
    monkeypatch.setenv("ENGINE_PROVIDER_DECLARATIONS", str(tmp_path))


@pytest.fixture
def sample(
    tmp_path: Path,
) -> tuple[Store, list[Poll], dict[date, list[Vehicle]], list[int]]:
    trips = {
        THURSDAY: (
            _trip("a", "A"),
            _trip("n", "N", "not_measured", captured=False, live=False),
            _trip("added", "A", "added"),
        ),
        FRIDAY: (
            _trip("a", "A", "not_measured", captured=False, live=False),
            _trip("b", "B"),
        ),
        SATURDAY: (
            _trip("a", "A"),
            _trip("gap", "A", "not_measured", captured=False, reason="capture_gap"),
            _trip("n", "N", "not_measured", captured=False, live=False),
        ),
    }
    stores = {
        day: _build_store(
            tmp_path, 6 if day == FRIDAY else 11, {day: rows}, city=CITY
        )
        for day, rows in trips.items()
    }
    start = utc(THURSDAY, 12)
    polls = [
        Poll(
            "trip_updates",
            start + timedelta(seconds=capture),
            str(index),
            outcome,
            start + timedelta(seconds=published) if published is not None else None,
        )
        for index, (capture, published, outcome) in enumerate(
            (
                (5, 0, "ok"),
                (12, 7, "ok"),
                (20, 7, "ok"),
                (23, None, "error"),
                (26, 22, "ok"),
                (149, 22, "ok"),
                (155, 100, "ok"),
                (158, 95, "ok"),
                (161, 795, "ok"),
                (165, None, "ok"),
                (170, 795, "duplicate"),
            )
        )
    ]
    polls.extend(
        (
            Poll("vehicle_positions", start, "v", "ok", start - timedelta(seconds=700)),
            Poll("service_alerts", start, "a", "ok", start - timedelta(seconds=5)),
            Poll("i3_alerts", start, "b", "duplicate", None),
        )
    )
    first = utc(THURSDAY, 12, 29, 50)
    vehicles = {
        THURSDAY: [
            Vehicle(
                "x",
                first,
                first + timedelta(seconds=20),
                "a",
                "A",
                "first",
                0,
                None,
                12,
                42,
                -72,
            ),
            Vehicle(
                "x",
                first + timedelta(seconds=200),
                first + timedelta(seconds=200),
                None,
                "A",
                None,
                None,
                None,
                None,
                42,
                -72,
            ),
            Vehicle("y", first, first, None, None, None, 1, 0, None, None, None),
        ],
        FRIDAY: [
            Vehicle(
                "x",
                utc(FRIDAY, 12),
                utc(FRIDAY, 12),
                None,
                "A",
                "first",
                None,
                None,
                None,
                None,
                None,
            )
        ],
        SATURDAY: [],
    }
    rng = Random(20261122)
    errors = [-60, 60, -61, 61, *(rng.randint(-190, 220) for _ in range(36))]
    # The vehicle feed publishes every 20 seconds, which sets the vehicle reporting interval.
    cadence = {
        day: [
            Poll("vehicle_positions", stamp, f"c{i}", "ok", stamp)
            for i in range(2)
            if (stamp := utc(day, 12, 0, 20 * (i + 1)))
        ]
        for day in (THURSDAY, FRIDAY)
    }
    with duckdb.connect() as conn:
        for day, store in stores.items():
            _write_table(
                conn,
                store,
                day,
                FEED_POLLS,
                "feed VARCHAR, captured_at_utc TIMESTAMPTZ, attempt_id VARCHAR, "
                "result VARCHAR, feed_timestamp_utc TIMESTAMPTZ",
                [
                    *(polls if day == THURSDAY else [polls[1]] if day == FRIDAY else []),
                    *cadence.get(day, []),
                ],
                city=CITY,
            )
            _write_table(
                conn,
                store,
                day,
                VEHICLE_POSITIONS,
                "vehicle_id VARCHAR, observed_at_utc TIMESTAMPTZ, last_seen_at_utc TIMESTAMPTZ, "
                "trip_id VARCHAR, route_id VARCHAR, stop_id VARCHAR, current_status INTEGER, "
                "occupancy_status INTEGER, occupancy_percentage BIGINT, "
                "latitude DOUBLE, longitude DOUBLE, captured_at_utc TIMESTAMPTZ",
                [(*row, row.start) for row in vehicles[day]],
                city=CITY,
            )
            if store.cleaning_version == 11:
                samples = (
                    [
                        (
                            f"trip{i}",
                            "A",
                            0,
                            "first",
                            basis,
                            horizon,
                            start,
                            600,
                            error,
                        )
                        for horizon, basis, data in (
                            (1, "vehicle_stopped", errors),
                            (3, "vehicle_stopped", errors[:-11]),
                            (1, "trip_update_reported", [999] * 3),
                            (1, "trip_update_passed", [999] * 2),
                            (1, "vehicle_nearby", [999] * 4),
                        )
                        for i, error in enumerate(data)
                    ]
                    if day == THURSDAY
                    else []
                )
                _write_table(
                    conn,
                    store,
                    day,
                    PREDICTION_SAMPLES,
                    "trip_id VARCHAR, route_id VARCHAR, direction_id INTEGER, stop_id VARCHAR, "
                    "basis VARCHAR, horizon_minutes INTEGER, published_at_utc TIMESTAMPTZ, "
                    "actual_lead_seconds BIGINT, error_seconds BIGINT",
                    samples,
                    city=CITY,
                )
            marker = Path(store.root) / CITY / str(day) / f"v{store.cleaning_version}/manifest.json"
            receipt = json.loads(marker.read_text(encoding="utf-8"))
            receipt["scorecard_declaration"] = {
                "timezone": "Asia/Kolkata",
                "feeds": ["trip_updates", "vehicle_positions", "alerts"],
                "unpublished_vehicle_fields": ["stop"] if day == SATURDAY else ["stop", "position"],
            }
            marker.write_text(json.dumps(receipt), encoding="utf-8")
    return Store(tmp_path.as_posix(), cleaning_version=11), polls, vehicles, errors


@pytest.mark.parametrize("measure", ["poll_success", "feed_age_at_capture", "feed_update_interval"])
def test_feed_attempts_include_unchanged_and_empty_payloads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, measure: str
) -> None:
    monkeypatch.setattr(scorecard, "POLL_BATCH_SECONDS", 30)
    store = _build_store(tmp_path, 7, {THURSDAY: (_trip("a", "A"),)}, city=CITY)
    start = utc(THURSDAY, 12)
    rows = [
        Poll(
            "trip_updates",
            start + timedelta(seconds=captured),
            str(index),
            result,
            start + timedelta(seconds=published) if published is not None else None,
        )
        for index, (captured, published, result) in enumerate(
            (
                (5, 0, "ok"),
                (80, 0, "duplicate"),
                (170, 999, "error"),
                (245, 0, "duplicate"),
                (265, 260, "empty"),
                (275, 260, "duplicate"),
                (295, 290, "ok"),
                (450, None, "error"),
                (460, 290, "duplicate"),
                (480, 475, "ok"),
            )
        )
    ]
    # Repeat the pattern in separate capture windows to clear the display floors.
    copies = 10
    rows = [
        row._replace(
            captured=row.captured + timedelta(seconds=1000 * i),
            ident=f"{i}-{row.ident}",
            published=row.published + timedelta(seconds=1000 * i)
            if row.published is not None else None,
        )
        for i in range(copies) for row in rows
    ]
    with duckdb.connect() as conn:
        _write_table(
            conn,
            store,
            THURSDAY,
            FEED_POLLS,
            "feed VARCHAR, captured_at_utc TIMESTAMPTZ, attempt_id VARCHAR, "
            "result VARCHAR, feed_timestamp_utc TIMESTAMPTZ",
            rows,
            city=CITY,
        )

    answer = ask(store, Question(measure, CITY, THURSDAY, THURSDAY))
    value = answer["value"][measure]["trip_updates"]
    evidence = answer["evidence"]
    counts = evidence["counts"][measure]["trip_updates"]
    if measure == "poll_success":
        assert value == 0.8
        assert counts["empty_share"] == 0.1
        assert counts["by_result"] == {
            "ok": 3 * copies, "empty": copies, "duplicate": 4 * copies, "error": 2 * copies,
        }
    elif measure == "feed_age_at_capture":
        assert value == {
            "median_seconds": 10.5,
            "p90_seconds": pytest.approx(245.5),
        }
        assert counts["samples"] == 8 * copies
    else:
        # Ordinary attempts bridge the 260-second stale interval. The later
        # 155-second break in attempts crosses a batch and excludes one update.
        assert value == {"median_seconds": 145, "p90_seconds": 260}
        assert counts["samples"] == 2 * copies
        assert evidence["excluded"][measure]["trip_updates"]["capture_gap"] == 2 * copies - 1


def test_scorecard_matches_plain_python(
    sample: tuple[Store, list[Poll], dict[date, list[Vehicle]], list[int]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    monkeypatch.setattr(scorecard, "POLL_BATCH_SECONDS", 30)
    store, polls, vehicles, errors = sample
    answer = ask(store, Question(FAMILY, CITY, THURSDAY, SATURDAY))
    values, evidence = answer["value"], answer["evidence"]
    counts, excluded = evidence["counts"], evidence["excluded"]

    outcomes = Counter(poll.result for poll in polls if poll.feed == "trip_updates")
    outcomes["empty"] = 0
    assert counts["poll_success"]["trip_updates"]["by_result"] == outcomes
    assert counts["poll_success"]["trip_updates"]["successful"] == (
        outcomes.total() - outcomes["error"]
    )
    assert values["poll_success"]["trip_updates"] is None
    assert values["poll_success"]["alerts"] is None
    assert counts["poll_success"]["alerts"]["attempts"] == 2
    assert counts["feed_age_at_capture"]["alerts"]["timestamped_successes"] == 1
    previous_poll = previous_update = None
    gap = False
    intervals: list[float] = []
    ages: list[float] = []
    for poll in polls:
        if poll.feed != "trip_updates":
            continue
        if previous_poll is not None:
            gap |= (poll.captured - previous_poll).total_seconds() > 120
        previous_poll = poll.captured
        if poll.result == "error" or poll.published is None:
            continue
        ages.append((poll.captured - poll.published).total_seconds())
        if poll.published != previous_update:
            if previous_update is not None and not gap and poll.published > previous_update:
                intervals.append((poll.published - previous_update).total_seconds())
            previous_update, gap = poll.published, False
    assert intervals and min(intervals) > 0
    for measure, expected in (
        ("feed_update_interval", intervals),
        ("feed_age_at_capture", [age for age in ages if age >= 0]),
    ):
        assert values[measure]["trip_updates"] == {"median_seconds": None, "p90_seconds": None}
        assert counts[measure]["trip_updates"]["samples"] == len(expected)
        assert evidence["dimension_states"][measure]["trip_updates"] == "too_few_to_judge"
    assert counts["feed_update_interval"]["trip_updates"]["overflow"] == 1
    assert counts["feed_age_at_capture"]["vehicle_positions"]["overflow"] == 1
    assert excluded["feed_update_interval"]["trip_updates"] == {
        "capture_gap": 1,
        "backwards_timestamp": 1,
        "missing_timestamp": 1,
    }
    assert counts["feed_update_interval"]["trip_updates"]["backwards_timestamps"] == 1
    skew = sum(age < 0 for age in ages)
    assert excluded["feed_age_at_capture"]["trip_updates"]["clock_skew"] == skew
    assert counts["feed_age_at_capture"]["trip_updates"]["samples"] + skew == len(ages)

    total = without = with_occupancy = 0.0
    ids = set()
    for observations in vehicles.values():
        for reading in observations:
            later = [
                r.start
                for r in observations
                if r.ident == reading.ident and r.start > reading.start
            ]
            tail = min(60, (min(later) - reading.last).total_seconds()) if later else 20
            seconds = (reading.last - reading.start).total_seconds() + tail
            total += seconds
            if reading.trip is None:
                without += seconds
                ids.add(reading.ident)
            if reading.occupancy_status is not None or reading.occupancy_percentage is not None:
                with_occupancy += seconds
    assert values["vehicles_without_trip"] is None
    assert counts["vehicles_without_trip"]["without_trip_us"] == without * 1_000_000
    assert counts["vehicles_without_trip"]["distinct_vehicles_without_trip"] == len(ids)
    assert counts["vehicles_without_trip"]["reporting_us"] == total * 1_000_000
    fields = values["vehicle_field_completeness"]
    assert fields["trip"] is None
    assert counts["vehicle_field_completeness"]["trip"]["present_us"] == (
        total - without
    ) * 1_000_000
    assert fields["occupancy"] is None
    assert counts["vehicle_field_completeness"]["occupancy"]["present_us"] == (
        with_occupancy * 1_000_000
    )
    assert fields["stop"] is None
    assert evidence["dimension_states"]["vehicle_field_completeness"]["stop"] == "not_published"

    coverage = counts["live_trip_coverage"]
    assert values["live_trip_coverage"] is None
    assert (coverage["appeared"], coverage["eligible"]) == (2, 3)
    assert coverage["never_seen_share"] == 2 / 7
    assert (
        coverage["scheduled"]
        == coverage["eligible"]
        + coverage["never_seen"]
        + (excluded["live_trip_coverage"]["capture_gap"])
    )
    # The same two readings over the days without a capture gap share one base.
    assert (
        coverage["scheduled_on_measured_days"]
        == coverage["eligible"] + coverage["never_seen_on_measured_days"]
    )
    assert coverage["never_seen_on_measured_days"] <= coverage["never_seen"]
    assert coverage["scheduled_on_measured_days"] == (
        coverage["scheduled"] - excluded["live_trip_coverage"]["capture_gap"]
        - (coverage["never_seen"] - coverage["never_seen_on_measured_days"])
    )
    assert evidence["measure_days"]["live_trip_coverage"]["days_not_measured"] == [str(SATURDAY)]
    assert evidence["measure_days"]["prediction_error"]["days_not_measured"] == [str(FRIDAY)]
    assert evidence["cleaning_versions"] == [6, 11]

    prediction = values["prediction_error"]["1"]
    assert prediction["sample_count"] == len(errors)
    assert prediction["median_signed_seconds"] == pytest.approx(median(errors), abs=7.5)
    assert prediction["p90_absolute_seconds"] == pytest.approx(
        quantiles(list(map(abs, errors)), n=10, method="inclusive")[8], abs=7.5
    )
    assert prediction["within_60_seconds_share"] == sum(-60 <= x <= 60 for x in errors) / len(
        errors
    )
    assert counts["prediction_error"]["1"]["by_basis"] == {
        "vehicle_stopped": 40,
        "vehicle_nearby": 4,
        "trip_update_reported": 3,
        "trip_update_passed": 2,
    }
    assert excluded["prediction_error"]["1"]["reason"] == "observed time is itself a prediction"
    assert evidence["dimension_states"]["prediction_error"]["3"] == "too_few_to_judge"
    assert values["prediction_error"]["3"]["median_signed_seconds"] is None
    assert values["prediction_error"]["3"]["sample_count"] == 29
    shares = [
        values["live_trip_coverage"],
        values["vehicles_without_trip"],
        coverage["never_seen_share"],
        prediction["within_60_seconds_share"],
        *values["poll_success"].values(),
        *fields.values(),
    ]
    assert all(0 <= share <= 1 for share in shares if share is not None)


def test_scorecard_cuts_missing_tables_and_csv(
    sample: tuple[Store, list[Poll], dict[date, list[Vehicle]], list[int]],
) -> None:
    store, _, _, _ = sample
    vehicle = ask(
        store,
        Question(
            "vehicles_without_trip",
            CITY,
            THURSDAY,
            THURSDAY,
            line="A",
            hour=18,
        ),
    )
    assert vehicle["value"]["vehicles_without_trip"] is None
    vehicle_counts = vehicle["evidence"]["counts"]["vehicles_without_trip"]
    assert vehicle_counts["without_trip_us"] / vehicle_counts["reporting_us"] == 20 / 90
    coverage = ask(
        store,
        Question(
            "live_trip_coverage",
            CITY,
            THURSDAY,
            SATURDAY,
            line="A",
            direction=0,
            stop="first",
            hour=17,
            day_type="weekday",
        ),
    )
    assert coverage["value"]["live_trip_coverage"] is None
    assert coverage["evidence"]["counts"]["live_trip_coverage"]["eligible"] == 2
    prediction = ask(
        store,
        Question(
            "prediction_error",
            CITY,
            THURSDAY,
            THURSDAY,
            line="A",
            direction=0,
            stop="first",
            hour=17,
        ),
    )
    assert prediction["value"]["prediction_error"]["1"]["sample_count"] == 40
    older = ask(store, Question(FAMILY, CITY, FRIDAY, FRIDAY))
    assert older["evidence"]["measure_states"]["prediction_error"] == "not_measured"
    assert older["evidence"]["measure_states"]["live_trip_coverage"] == "too_few_to_judge"
    assert older["value"]["prediction_error"]["1"]["sample_count"] is None
    assert older["value"]["live_trip_coverage"] is None
    assert older["evidence"]["dimension_states"]["poll_success"]["alerts"] == "not_measured"
    assert (
        older["evidence"]["counts"]["poll_success"]["alerts"]["reason"] == "no_alert_attempt_rows"
    )
    for lang in ("en", "fr"):
        rows = list(csv.reader(io.StringIO(answer_csv(older, lang))))
        definitions = [method for method in methods() if method["family"] == FAMILY]
        assert len(rows) == len(definitions) + 1 == 8
        assert rows[0] == definitions[0]["csv_columns"][lang]
        assert all(len(row) == len(rows[0]) for row in rows)
        assert rows[-1][3] == ("Not measured" if lang == "en" else "Non mesuré")
    engine = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=100)
    status, headers, body = asyncio.run(
        http(
            engine,
            "/measure",
            f"city={CITY}&from={FRIDAY}&to={FRIDAY}&measure=live_trip_coverage",
        )
    )
    assert status == 200
    assert headers[b"x-transit-days-pending"] == b"1"
    assert json.loads(body)["evidence"]["days_pending"] == [str(FRIDAY)]
    status, _, body = asyncio.run(
        http(
            engine,
            "/measure",
            f"city={CITY}&from={THURSDAY}&to={THURSDAY}&measure={FAMILY}&group=day",
        )
    )
    assert status == 400
    assert b"scorecard measures do not support group" in body
    for measure in ("poll_success", "feed_age_at_capture", "feed_update_interval"):
        status, _, body = asyncio.run(
            http(
                engine,
                "/measure",
                f"city={CITY}&from={THURSDAY}&to={THURSDAY}&measure={measure}&stop=first",
            )
        )
        assert status == 400
        assert b"supports only day_type" in body
