import asyncio
import csv
import io
import json
import sys
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from threading import Event
from typing import Any, NamedTuple, Never, cast
from urllib.parse import parse_qs, urlencode, urlsplit

import duckdb
import pytest
from uvicorn._types import ASGISendEvent, HTTPScope

from transit_engine import timing
from transit_engine.clean_manifest import (
    ALERTS,
    FEED_POLLS,
    PREDICTION_SAMPLES,
    SCHEDULED_STOP_TIMES,
    STOP_EVENTS,
    TRIP_DAYS,
    file_identities,
)
from transit_engine.measures import (
    MIN_CLASSIFIED_STOP_EVENTS,
    MIN_SERVICE_DELIVERED_TRIPS,
    Question,
    ask,
)
from transit_engine.ranking import Ranking, rank
from transit_engine.server import Engine
from transit_engine.store import Store

THURSDAY = date(2026, 11, 19)
FRIDAY = date(2026, 11, 20)
SATURDAY = date(2026, 11, 21)
SUNDAY = date(2026, 11, 22)
FALL_BACK = date(2026, 11, 1)
V4_EXTRA_FILES = (SCHEDULED_STOP_TIMES, "vehicle_positions.parquet", "feed_polls.parquet")


class StopTiming(NamedTuple):
    stop_id: str
    arrival: int | None
    departure: int | None
    event: str = "arrival"
    basis: str = "trip_update_reported"


class Trip(NamedTuple):
    id: str
    line: str
    direction: int | None
    state: str
    reason: str | None
    live: bool
    delays: tuple[int | None, ...]
    offset_minutes: int = 0
    duration_minutes: int = 0
    notice_seconds: int | None = None
    route_type: int = 3
    basis: str = "trip_update_reported"
    stop_times: tuple[StopTiming, ...] = ()
    captured: bool = False
    stop_ids: tuple[str, ...] = ()
    wheelchair: int | None = None
    stop_wheelchair: tuple[int | None, int | None] | None = None


class Poll(NamedTuple):
    feed: str
    offset_seconds: int
    result: str = "ok"
    publication_age: int = 0


TRIPS = (
    Trip("observed", "A", 0, "ran", None, True, (-61, -60, 300, 301) * 8 + (None,)),
    Trip("reverse", "A", 1, "ran", None, True, (28,) * 4),
    Trip("another_line", "B", 0, "ran", None, True, (901,) * 32),
    Trip("cancelled", "A", 0, "cancelled", None, True, (5,)),
    Trip("unconfirmed", "U", 0, "unconfirmed", None, True, (None,)),
    Trip("no_live", "N", 0, "not_measured", "route_without_live_data", False, (None,) * 3),
    Trip("gap", "G", 0, "not_measured", "capture_gap", True, (None,) * 2),
    Trip("added", "A", 0, "added", None, True, (None,)),
    Trip("missing", "A", 0, "missing", None, True, (None,)),
)


@pytest.fixture
def store(tmp_path: Path) -> Store:
    return _build_store(tmp_path, cleaning_version=3)


def _build_store(
    tmp_path: Path,
    cleaning_version: int,
    trips_by_day: dict[date, tuple[Trip, ...]] | None = None,
    polls_by_day: dict[date, tuple[Poll, ...]] | None = None,
    *,
    city: str = "stm",
) -> Store:
    version = str(cleaning_version)
    wheelchair_trip = ", wheelchair_accessible INTEGER" if cleaning_version >= 8 else ""
    wheelchair_schedule = ", wheelchair_boarding INTEGER" if cleaning_version >= 8 else ""
    with duckdb.connect() as conn:
        conn.execute(
            f"""
            CREATE TABLE trips (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR, trip_id VARCHAR,
                route_id VARCHAR, direction_id INTEGER, state VARCHAR, state_reason VARCHAR,
                route_has_live_data BOOLEAN, scheduled_start_utc TIMESTAMPTZ,
                cancellation_notice_utc TIMESTAMPTZ, route_type INTEGER,
                first_capture_utc TIMESTAMPTZ{wheelchair_trip}
            );
            CREATE TABLE stops (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR, trip_id VARCHAR,
                stop_id VARCHAR, stop_sequence BIGINT, delay_seconds BIGINT,
                scheduled_arrival_utc TIMESTAMPTZ, scheduled_departure_utc TIMESTAMPTZ,
                observed_at_utc TIMESTAMPTZ, basis VARCHAR, observed_event VARCHAR
            );
            CREATE TABLE schedule (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR, trip_id VARCHAR,
                route_id VARCHAR, direction_id INTEGER, stop_id VARCHAR,
                scheduled_arrival_utc TIMESTAMPTZ, scheduled_departure_utc TIMESTAMPTZ,
                stop_sequence BIGINT, scheduled_arrival_seconds BIGINT,
                scheduled_departure_seconds BIGINT{wheelchair_schedule}
            );
            CREATE TABLE polls (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR,
                feed VARCHAR, captured_at_utc TIMESTAMPTZ, result VARCHAR,
                feed_timestamp_utc TIMESTAMPTZ, entity_count BIGINT, attempt_id VARCHAR
            );
            """
        )
        for day, trips in (
            trips_by_day or dict.fromkeys((FALL_BACK, THURSDAY, SATURDAY, SUNDAY), TRIPS)
        ).items():
            directory = tmp_path / city / str(day) / f"v{version}"
            directory.mkdir(parents=True)
            start = (
                datetime(2026, 11, 2, 6, 15, tzinfo=UTC)
                if day == FALL_BACK
                else datetime(day.year, day.month, day.day, 12, tzinfo=UTC)
            )
            states: Counter[str] = Counter()
            bases: Counter[str] = Counter()
            polls = (polls_by_day or {}).get(day, ())
            for index, poll in enumerate(polls):
                captured = start + timedelta(seconds=poll.offset_seconds)
                conn.execute(
                    "INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        city,
                        day,
                        version,
                        poll.feed,
                        captured,
                        poll.result,
                        captured - timedelta(seconds=poll.publication_age),
                        1,
                        str(index),
                    ],
                )
            for trip in trips:
                identity = (city, day, version, trip.id)
                start_at = start + timedelta(minutes=trip.offset_minutes)
                notice = (
                    start_at + timedelta(seconds=trip.notice_seconds)
                    if trip.notice_seconds is not None
                    else None
                )
                scheduled = start_at if trip.state != "added" else None
                if scheduled is not None and cleaning_version >= 4:
                    first = (
                        25 * 3600 + 15 * 60 if day == FALL_BACK else 7 * 3600
                    ) + trip.offset_minutes * 60
                    last = first + trip.duration_minutes * 60
                    boarding = trip.stop_wheelchair or (None, None)
                    schedule_rows: list[tuple[object, ...]] = [
                        (
                            *identity,
                            trip.line,
                            trip.direction,
                            "first",
                            start_at - timedelta(minutes=1),
                            start_at,
                            1,
                            first - 60,
                            first,
                        ),
                        (
                            *identity,
                            trip.line,
                            trip.direction,
                            "other",
                            start_at + timedelta(minutes=trip.duration_minutes),
                            start_at + timedelta(minutes=trip.duration_minutes + 1),
                            2,
                            last,
                            last + 60,
                        ),
                    ]
                    if cleaning_version >= 8:
                        schedule_rows = [
                            (*schedule_rows[0], boarding[0]),
                            (*schedule_rows[1], boarding[1]),
                        ]
                    conn.executemany(
                        f"INSERT INTO schedule VALUES ({', '.join('?' for _ in schedule_rows[0])})",
                        schedule_rows,
                    )
                trip_values: list[object] = [
                    *identity,
                    trip.line,
                    trip.direction,
                    trip.state,
                    trip.reason,
                    trip.live,
                    scheduled,
                    notice,
                    trip.route_type,
                    start_at if trip.captured else None,
                ]
                if cleaning_version >= 8:
                    trip_values.append(trip.wheelchair)
                conn.execute(
                    f"INSERT INTO trips VALUES ({', '.join('?' for _ in trip_values)})",
                    trip_values,
                )
                states[trip.state] += 1
                stops = []
                for seq, delay in enumerate(trip.delays, 1):
                    if day == SATURDAY:
                        delay = None
                    elif day == SUNDAY and delay is not None:
                        delay += 10  # A different distribution from Thursday.
                    stop = (
                        trip.stop_ids[seq - 1]
                        if trip.stop_ids
                        else ("first" if seq == 1 else "other")
                    )
                    arrival = scheduled if delay is not None or seq != 33 else None
                    departure = None
                    event, basis, reference = "arrival", trip.basis, start_at
                    if trip.stop_times:
                        timing = trip.stop_times[seq - 1]
                        stop, event, basis = timing.stop_id, timing.event, timing.basis
                        arrival = (
                            start_at + timedelta(seconds=timing.arrival)
                            if timing.arrival is not None
                            else None
                        )
                        departure = (
                            start_at + timedelta(seconds=timing.departure)
                            if timing.departure is not None
                            else None
                        )
                        reference = (departure if event == "departure" else arrival) or start_at
                    observed = reference + timedelta(seconds=delay) if delay is not None else None
                    basis = "not_observed" if delay is None else basis
                    stops.append(
                        (
                            *identity,
                            stop,
                            seq * 10 if trip.stop_times else seq,
                            delay,
                            arrival,
                            departure,
                            observed,
                            basis,
                            event if observed else None,
                        )
                    )
                    bases[basis] += 1
                conn.executemany(
                    "INSERT INTO stops VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", stops
                )
            files = {}
            for table, name, counts in (
                ("stops", STOP_EVENTS, bases),
                ("trips", TRIP_DAYS, states),
            ):
                source = f"SELECT * FROM {table}"
                if table == "stops" and cleaning_version >= 9:
                    source = """
                        SELECT s.*, t.route_id, t.direction_id, t.route_has_live_data,
                            CASE WHEN t.scheduled_start_utc IS NULL THEN 'added'
                                WHEN t.state = 'cancelled' THEN 'cancelled'
                                WHEN NOT t.route_has_live_data THEN 'route_without_live_data'
                                WHEN t.state_reason = 'capture_gap' THEN 'capture_gap'
                            END AS trip_exclusion_reason,
                            (epoch(t.scheduled_start_utc) - epoch(timezone('America/Toronto',
                                s.service_date + INTERVAL '12 hours')) + 43200)::BIGINT
                                AS scheduled_start_seconds,
                            hour(timezone('America/Toronto', coalesce(
                                s.scheduled_departure_utc, s.scheduled_arrival_utc)))::SMALLINT
                                AS scheduled_local_hour,
                            isodow(s.service_date)::SMALLINT AS service_weekday
                        FROM stops s JOIN trips t USING (service_date, trip_id)
                    """
                conn.execute(f"COPY ({source}) TO ? (FORMAT PARQUET)", [str(directory / name)])
                conn.execute(f"DELETE FROM {table}")
                payload = (directory / name).read_bytes()
                files[name] = {
                    "rows": sum(counts.values()),
                    "sha256": sha256(payload).hexdigest(),
                    "byte_size": len(payload),
                }
            if cleaning_version >= 4:
                extra_files = (*V4_EXTRA_FILES, ALERTS) if cleaning_version >= 5 else V4_EXTRA_FILES
                if cleaning_version >= 7:
                    extra_files = (*extra_files, PREDICTION_SAMPLES)
                for name in extra_files:
                    path = directory / name
                    source = "SELECT * FROM trips WHERE FALSE"
                    rows = 0
                    if name == SCHEDULED_STOP_TIMES:
                        source = "SELECT * FROM schedule"
                        rows = 2 * (len(trips) - states["added"])
                    elif name == FEED_POLLS:
                        source = "SELECT * FROM polls"
                        rows = len(polls)
                    conn.execute(
                        f"COPY ({source}) TO ? (FORMAT PARQUET)",
                        [str(path)],
                    )
                    payload = path.read_bytes()
                    files[name] = {
                        "rows": rows,
                        "sha256": sha256(payload).hexdigest(),
                        "byte_size": len(payload),
                    }
                conn.execute("DELETE FROM schedule")
                conn.execute("DELETE FROM polls")
            (directory / "manifest.json").write_text(
                json.dumps(
                    {
                        "provider": city,
                        "service_date": str(day),
                        "cleaning_version": version,
                        "schedule_sha256": "a" * 64,
                        "built_at_utc": f"{day}T00:00:00+00:00",
                        "builder_git_commit": None,
                        "files": files,
                        "row_counts_by_state": states,
                        "row_counts_by_basis": bases,
                    }
                ),
                encoding="utf-8",
            )
    return Store(tmp_path.as_posix(), cleaning_version=cleaning_version)


def test_store_reads_v9_by_default_and_accepts_v3_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _build_store(tmp_path, cleaning_version=9)
    monkeypatch.setenv("ENGINE_CLEAN_ROOT", str(tmp_path))
    monkeypatch.delenv("ENGINE_CLEANING_VERSION", raising=False)
    store = Store.from_env()
    assert Store(tmp_path.as_posix()).cleaning_version == store.cleaning_version == 9
    assert query(store)["evidence"]["cleaning_versions"] == [9]
    monkeypatch.setenv("ENGINE_CLEANING_VERSION", "3")
    assert Store.from_env().cleaning_version == 3


def query(store: Store, **kwargs: Any) -> dict[str, Any]:
    parameters = {"measure": "punctuality", "city": "stm", "start": THURSDAY, "end": THURSDAY}
    return ask(store, Question(**{**parameters, **kwargs}))


DELIVERY_WEEKDAYS = tuple(
    day
    for offset in range(31)
    if (day := THURSDAY + timedelta(days=offset)) != FRIDAY and day.weekday() < 5
)[:20]
DELIVERY_DAYS = (*DELIVERY_WEEKDAYS, date(2026, 12, 19))


@pytest.fixture
def delivery(tmp_path: Path) -> tuple[Store, dict[date, tuple[Trip, ...]]]:
    trips_by_day: dict[date, tuple[Trip, ...]] = {}
    for index, day in enumerate(DELIVERY_DAYS):
        trips_by_day[day] = (
            Trip(
                "first", "A", 0, "missing" if index == 1 else "ran", None, True, (None, None), 0, 30
            ),
            Trip(
                "mid",
                "A",
                0,
                "cancelled" if index == 2 else "unconfirmed",
                None,
                True,
                (None, None),
                60,
                45,
                -1800 if index == 2 else None,
            ),
            Trip("reverse", "A", 1, "ran", None, True, (0, None), 120, 15, -480),
            Trip(
                "end",
                "A",
                0,
                "cancelled" if index == 0 else "ran",
                None,
                True,
                (None, None),
                1095,
                90,
                30 if index == 0 else None,
            ),
            Trip("gap", "A", 0, "not_measured", "capture_gap", True, (None, None), 90, 120),
            Trip(
                "no_live",
                "N",
                0,
                "not_measured",
                "route_without_live_data",
                False,
                (None, None),
                0,
                60,
            ),
            Trip("added", "A", 0, "added", None, True, (None,)),
        )
        if index == 0:
            # Two trips with unknown outcomes tie the day's scheduled boundaries.
            trips_by_day[day] += (
                Trip("first_tie", "A", 0, "unconfirmed", None, True, (None, None), 0, 60),
                Trip("last_tie", "A", 0, "unconfirmed", None, True, (None, None), 1095, 60),
            )
    return _build_store(tmp_path, 5, trips_by_day), trips_by_day


def test_service_delivered_matches_python_across_batches(
    delivery: tuple[Store, dict[date, tuple[Trip, ...]]], monkeypatch: pytest.MonkeyPatch
) -> None:
    store, trips_by_day = delivery
    monkeypatch.setattr("transit_engine.measures.DAYS_PER_QUERY_BATCH", 7)
    answer = query(store, measure="service_delivered", end=DELIVERY_DAYS[-1], line="A")
    evidence = answer["evidence"]
    assert answer["state"] == "measured"
    assert evidence["cleaning_versions"] == [5]
    assert str(FRIDAY) in evidence["days_not_measured"]
    assert evidence["days_included"] == list(map(str, DELIVERY_DAYS))
    assert answer["coverage_note"]["en"] == "Only measured days are included."
    line = [trip for trips in trips_by_day.values() for trip in trips if trip.line == "A"]
    scheduled = [trip for trip in line if trip.state != "added"]
    eligible = [trip for trip in scheduled if trip.state in {"ran", "cancelled", "missing"}]
    ran = [trip for trip in eligible if trip.state == "ran"]
    counts = evidence["counts"]
    assert (
        counts["scheduled"]
        == len(scheduled)
        == sum(
            counts[state]
            for state in ("ran", "cancelled", "missing", "unconfirmed", "not_measured")
        )
    )
    assert counts["eligible"] == len(eligible)
    assert evidence["excluded"] == {
        "added": len(DELIVERY_DAYS),
        "route_without_live_data": 0,
        "capture_gap": len(DELIVERY_DAYS),
        "unconfirmed": 22,
    }
    assert counts["unconfirmed"] == 22
    assert evidence["share_unconfirmed"] == 22 / len(scheduled)
    expected = Counter(trip.state for trip in eligible)
    for measure, state in (
        ("trips_run", "ran"),
        ("missing_trips", "missing"),
        ("cancelled_trips", "cancelled"),
    ):
        assert counts[state] == expected[state]
        assert answer["value"][measure] == expected[state] / len(eligible)
    assert counts["cancellation_notices"] == 2
    assert counts["cancellations_announced_after_departure"] == 1
    assert evidence["median_cancellation_lead_seconds"] is None
    assert evidence["cancellation_lead_state"] == "too_few_to_judge"
    late_day = query(store, measure="cancelled_trips")["evidence"]
    assert late_day["median_cancellation_lead_seconds"] is None
    assert late_day["counts"]["cancellations_announced_after_departure"] == 1
    expected_scheduled = sum(trip.duration_minutes for trip in eligible)
    expected_ran = sum(trip.duration_minutes for trip in ran)
    assert counts["scheduled_hours"] == expected_scheduled / 60
    assert counts["ran_hours"] == expected_ran / 60
    assert answer["value"]["service_hours"] == expected_ran / expected_scheduled

    network = query(store, measure="service_delivered", end=DELIVERY_DAYS[-1])
    assert network["value"] == answer["value"]
    assert network["evidence"]["counts"]["scheduled"] == len(scheduled) + len(DELIVERY_DAYS)
    assert network["evidence"]["excluded"]["route_without_live_data"] == len(DELIVERY_DAYS)


def test_service_delivered_boundaries_and_trip_cuts(
    delivery: tuple[Store, dict[date, tuple[Trip, ...]]],
) -> None:
    store, _ = delivery
    weekday = {"line": "A", "day_type": "weekday", "end": DELIVERY_DAYS[-1]}
    answer = query(store, measure="service_delivered", **weekday)
    assert answer["value"]["first_trip"] == answer["value"]["last_trip"] == 19 / 20
    assert answer["evidence"]["days_included"] == list(map(str, DELIVERY_WEEKDAYS))
    edges = answer["evidence"]["boundary_departures"]
    assert len(edges) == 40
    assert edges[:2] == [
        {
            "measure": measure,
            "service_date": str(THURSDAY),
            "scheduled_departure": departure,
            "scheduled": 2,
            "eligible": 1,
            "ran": ran,
            "unconfirmed": 1,
            "route_without_live_data": 0,
            "capture_gap": 0,
        }
        for measure, departure, ran in (("first_trip", "07:00:00", 1), ("last_trip", "25:15:00", 0))
    ]
    only_departure = query(
        store, measure="trips_run", direction=0, departure="25:15:00", hour=1, **weekday
    )
    assert only_departure["value"]["trips_run"] == 19 / 20
    assert only_departure["evidence"]["counts"]["eligible"] == MIN_SERVICE_DELIVERED_TRIPS == 20
    assert only_departure["evidence"]["counts"]["scheduled"] == 21
    below_floor = query(
        store, measure="first_trip", line="A", day_type="weekday", end=DELIVERY_WEEKDAYS[-2]
    )
    assert below_floor["state"] == "too_few_to_judge"
    assert below_floor["value"] == {"first_trip": None}
    daily = query(store, measure="service_delivered", group="day", **weekday)
    assert daily["cells"][0]["evidence"]["measure_states"]["first_trip"] == "not_measured"
    assert daily["cells"][0]["evidence"]["boundary_departures"] == edges[:2]
    hourly = query(store, measure="last_trip", group="hour", **weekday)
    assert hourly["cells"][1]["value"]["last_trip"] == 19 / 20
    assert hourly["cells"][7]["value"]["last_trip"] is None
    assert query(store, measure="trips_run", line="N")["state"] == "no_live_data"
    assert (
        query(store, measure="trips_run", line="A", hour=8, direction=0, departure="08:30:00")[
            "state"
        ]
        == "not_measured"
    )
    assert query(store, measure="trips_run", line="U")["state"] == "unknown"


@pytest.mark.parametrize("damage", ["missing", "wrong_size"])
def test_service_hours_checks_the_schedule_file(
    delivery: tuple[Store, dict[date, tuple[Trip, ...]]], damage: str
) -> None:
    store, _ = delivery
    path = Path(store.root) / "stm" / str(THURSDAY) / "v5" / SCHEDULED_STOP_TIMES
    if damage == "missing":
        path.unlink()
    else:
        path.write_bytes(path.read_bytes()[:-1])
    answer = query(store, measure="service_hours")
    assert answer["state"] == "not_measured"
    assert answer["evidence"]["days_not_measured"] == [str(THURSDAY)]
    assert query(store, measure="trips_run", end=DELIVERY_DAYS[-1])["state"] == "measured"


def test_service_delivered_trip_queries_use_v3(store: Store) -> None:
    answer = query(store, measure="missing_trips", start=FALL_BACK, end=SUNDAY)
    assert answer["state"] == "measured"
    assert answer["value"] == {"missing_trips": 4 / 20}
    assert answer["evidence"]["cleaning_versions"] == [3]
    assert answer["evidence"]["counts"]["scheduled_hours"] is None
    unknown = query(store, measure="trips_run", line="U")
    assert unknown["state"] == "not_measured"
    assert unknown["value"] == {"trips_run": None}
    assert unknown["evidence"]["share_unconfirmed"] == 1


def test_v4_manifest_requires_all_five_file_entries(store: Store) -> None:
    directory = Path(store.root) / "stm" / THURSDAY.isoformat() / "v3"
    manifest = json.loads((directory / "manifest.json").read_bytes())
    manifest["cleaning_version"] = "4"
    files = manifest["files"]
    for name in V4_EXTRA_FILES:
        files[name] = {"rows": 0, "byte_size": 128, "sha256": "a" * 64}

    def validate() -> dict[str, tuple[str, int]] | None:
        return file_identities(json.dumps(manifest).encode(), "stm", THURSDAY.isoformat(), "4")

    assert validate() == {
        name: (entry["sha256"], entry["byte_size"]) for name, entry in files.items()
    }
    entry = files.pop("feed_polls.parquet")
    assert validate() is None
    files["feed_polls.parquet"] = {**entry, "rows": -1}
    assert validate() is None


def test_v5_requires_an_alert_receipt_or_not_tracked(tmp_path: Path) -> None:
    store = _build_store(tmp_path, cleaning_version=5)
    directory = tmp_path / "stm" / THURSDAY.isoformat() / "v5"
    marker = directory / "manifest.json"
    manifest = json.loads(marker.read_bytes())

    with store.connect() as conn:
        assert store.verify(conn, "stm", THURSDAY)
        (directory / ALERTS).unlink()
        assert store.files(conn, "stm", THURSDAY) is None
        assert query(store, measure="service_hours")["state"] == "not_measured"
        manifest["alerts"] = "not_tracked"
        marker.write_text(json.dumps(manifest), encoding="utf-8")
        assert store.files(conn, "stm", THURSDAY) is None  # Conflicting receipt and status.
        del manifest["files"][ALERTS]
        marker.write_text(json.dumps(manifest), encoding="utf-8")
        assert store.verify(conn, "stm", THURSDAY)
        assert query(store, measure="service_hours")["evidence"]["days_included"] == [str(THURSDAY)]
        del manifest["alerts"]
        marker.write_text(json.dumps(manifest), encoding="utf-8")
        assert store.files(conn, "stm", THURSDAY) is None


@pytest.mark.parametrize("cleaning_version", [3, 4, 5, 7, 8])
def test_bands_use_exact_thresholds(tmp_path: Path, cleaning_version: int) -> None:
    store = _build_store(tmp_path, cleaning_version)
    result = query(store, line="A", direction=0)
    evidence = result["evidence"]
    assert result["state"] == "measured"
    assert evidence["counts"] == {
        "scheduled": 34,
        "classified": 32,
        "early": 8,
        "on_time": 16,
        "late": 8,
        "vehicle_stopped": 0,
        "vehicle_nearby": 0,
        "trip_update_reported": 32,
        "trip_update_passed": 0,
    }
    assert [result["value"][key] for key in ("early", "on_time", "late")] == [0.25, 0.5, 0.25]
    assert evidence["excluded"] == {
        "added": 1,
        "cancelled": 1,
        "route_without_live_data": 0,
        "capture_gap": 0,
        "unclassified": 2,
    }
    assert evidence["cleaning_versions"] == [cleaning_version]
    assert evidence["query_ms"] >= 0


def test_multi_day_line_agrees_with_independent_recomputation(
    store: Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("transit_engine.measures.DAYS_PER_QUERY_BATCH", 2)
    answer = query(store, measure="punctuality", line="A", end=SUNDAY)
    evidence = answer["evidence"]
    assert evidence["days_measured"] == list(map(str, (THURSDAY, SATURDAY, SUNDAY)))
    assert evidence["days_not_measured"] == [str(FRIDAY)]
    assert answer["coverage_note"] == {
        "en": "Only measured days are included.",
        "fr": "Seuls les jours mesurés sont inclus.",
    }
    scheduled: list[int | None] = []
    for day in (THURSDAY, SATURDAY, SUNDAY):
        for trip in TRIPS:
            if trip.line != "A" or trip.state in {"cancelled", "added"}:
                continue
            for delay in trip.delays:
                if day == SATURDAY or delay is None:
                    scheduled.append(None)
                else:
                    scheduled.append(delay + (10 if day == SUNDAY else 0))
    observed = sorted(delay for delay in scheduled if delay is not None)
    bands = Counter(
        "early" if delay < -60 else "late" if delay > 300 else "on_time" for delay in observed
    )
    assert evidence["counts"] == {
        "scheduled": len(scheduled), "classified": len(observed), **bands,
        "vehicle_stopped": 0, "vehicle_nearby": 0,
        "trip_update_reported": len(observed), "trip_update_passed": 0,
    }
    assert sum(bands.values()) == len(observed) <= len(scheduled)
    assert evidence["share_observed"] == len(observed) / len(scheduled)
    for band, count in bands.items():
        assert answer["value"][band] == count / len(observed)
    assert answer["value"]["median_delay"] == 29.5
    # Exact continuous percentiles are computed independently on the small fixture.
    for key, fraction in (("median_delay", 0.5), ("p90_delay", 0.9)):
        rank = (len(observed) - 1) * fraction
        lo = int(rank)
        exact = observed[lo] + (observed[lo + 1] - observed[lo]) * (rank - lo)
        assert abs(exact - answer["value"][key]) <= 7


def test_stop_departure_hour_and_day_type_cuts(store: Store) -> None:
    assert query(store, line="A", stop="other")["evidence"]["counts"]["classified"] == 34
    assert query(store, line="A", stop="first")["evidence"]["counts"]["classified"] == 2
    result = query(
        store,
        start=FALL_BACK,
        end=FALL_BACK,
        line="A",
        direction=0,
        departure="25:15:00",
        hour=1,
        day_type="sunday",
    )
    assert result["evidence"]["counts"]["classified"] == 32
    assert (
        query(store, start=FALL_BACK, end=FALL_BACK, line="A", direction=0, departure="01:15:00")[
            "state"
        ]
        == "unknown"
    )
    for day_type, count in (("weekday", 36), ("saturday", 0), ("sunday", 36)):
        assert (
            query(store, line="A", end=SUNDAY, day_type=day_type)["evidence"]["counts"][
                "classified"
            ]
            == count
        )
    missing_weekday = query(store, start=FRIDAY, end=SUNDAY, day_type="weekday")
    assert missing_weekday["state"] == "not_measured"
    assert missing_weekday["evidence"]["days_included"] == []


def test_gaps_and_real_zero_have_distinct_meanings(store: Store) -> None:
    no_days = query(store, start=FRIDAY, end=FRIDAY)
    assert no_days["evidence"]["counts"]["scheduled"] is None
    assert no_days["evidence"]["cleaning_versions"] == []
    too_few = query(store, line="A", direction=1)
    assert 0 < too_few["evidence"]["counts"]["classified"] < MIN_CLASSIFIED_STOP_EVENTS
    for result, state in (
        (no_days, "not_measured"),
        (query(store, line="G"), "not_measured"),
        (query(store, line="N"), "no_live_data"),
        (query(store, line="U"), "not_measured"),
        (query(store, line="absent"), "unknown"),
        (too_few, "too_few_to_judge"),
    ):
        assert result["state"] == state
        assert result["state_text"]["en"] and result["state_text"]["fr"]
        assert set(result["value"].values()) == {None}
    network = query(store)["evidence"]
    assert network["excluded"]["route_without_live_data"] == 3
    assert network["excluded"]["capture_gap"] == 2
    assert network["counts"]["scheduled"] == 34 + 4 + 32 + 1 + 2
    assert network["share_observed"] == (32 + 4 + 32) / 73
    assert query(store, measure="on_time", line="B")["value"] == {"on_time": 0}


@pytest.mark.parametrize("damage", ["no_manifest", "invalid_json", "wrong_day", "missing", "size"])
def test_incomplete_clean_day_is_not_measured(store: Store, damage: str) -> None:
    directory = Path(store.root) / "stm" / str(THURSDAY) / "v3"
    marker = directory / "manifest.json"
    if damage == "no_manifest":
        marker.unlink()
    elif damage == "invalid_json":
        marker.write_bytes(b"{")
    elif damage == "wrong_day":
        value = json.loads(marker.read_bytes())
        value["service_date"] = "2026-11-17"
        marker.write_text(json.dumps(value), encoding="utf-8")
    elif damage == "missing":
        (directory / TRIP_DAYS).unlink()
    else:
        path = directory / STOP_EVENTS
        path.write_bytes(path.read_bytes()[:-1])
    result = query(store)
    assert result["state"] == "not_measured"
    assert result["evidence"]["days_not_measured"] == [str(THURSDAY)]
    assert result["evidence"]["days_measured"] == []
    assert result["evidence"]["counts"]["classified"] is None
    (cell,) = query(store, group="day")["cells"]
    assert cell["state"] == "not_measured"
    assert cell["evidence"]["counts"]["classified"] is None


@pytest.mark.parametrize("reason", ["no_raw_captures", "no_schedule_edition"])
def test_unmeasured_receipt_settles_day(tmp_path: Path, reason: str) -> None:
    store = Store(tmp_path.as_posix(), cleaning_version=8)
    directory = tmp_path / "stm" / str(THURSDAY) / "v8"
    directory.mkdir(parents=True)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "status": reason,
                "provider": "stm",
                "service_date": str(THURSDAY),
                "cleaning_version": "8",
                "built_at_utc": f"{THURSDAY}T00:00:00+00:00",
                "builder_git_commit": None,
            }
        ),
        encoding="utf-8",
    )
    for measure in ("punctuality", "accessibility", "open_data_scorecard"):
        result = query(store, measure=measure, end=FRIDAY)
        assert result["state"] == "not_measured"
        assert result["evidence"]["days_not_measured"] == [str(THURSDAY), str(FRIDAY)]
        assert result["evidence"]["days_not_measured_reasons"] == {str(THURSDAY): reason}
        assert result["evidence"]["days_pending"] == [str(FRIDAY)]
        assert result["evidence"]["days_measured"] == []
    assert query(store)["evidence"]["counts"]["classified"] is None


def test_blob_discovery_checks_both_files(store: Store) -> None:
    # Exercise httpfs's glob/read_blob query path against local files.
    remote = Store(store.root, store.cleaning_version, s3_endpoint="example.invalid")
    with store.connect() as conn:
        assert remote.files(conn, "stm", THURSDAY) is not None
        path = Path(store.root) / "stm" / str(THURSDAY) / "v3" / TRIP_DAYS
        path.write_bytes(path.read_bytes()[:-1])
        assert remote.files(conn, "stm", THURSDAY) is None


@pytest.mark.parametrize("remote", [False, True])
def test_explicit_audit_detects_same_size_corruption(store: Store, remote: bool) -> None:
    target = (
        Store(store.root, store.cleaning_version, s3_endpoint="example.invalid")
        if remote
        else store
    )
    with store.connect() as conn:
        assert target.verify(conn, "stm", THURSDAY)
        path = Path(store.root) / "stm" / str(THURSDAY) / "v3" / STOP_EVENTS
        path.write_bytes(b"XXXX" + path.read_bytes()[4:])
        assert target.files(conn, "stm", THURSDAY) is not None
        assert not target.verify(conn, "stm", THURSDAY)


async def http(
    app: Engine,
    path: str,
    query_string: str = "",
    *,
    authorization: tuple[bytes, ...] = (),
) -> tuple[int, dict[bytes, bytes], bytes]:
    scope = cast(
        HTTPScope,
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "query_string": query_string.encode(),
            "headers": [(b"authorization", value) for value in authorization],
        },
    )
    messages: list[ASGISendEvent] = []

    async def receive() -> Never:
        raise AssertionError("GET has no request body")

    async def send(message: ASGISendEvent) -> None:
        messages.append(message)

    await app(scope, receive, send)
    start, body = messages
    assert start["type"] == "http.response.start" and body["type"] == "http.response.body"
    return start["status"], dict(start["headers"]), body.get("body", b"")


@pytest.mark.parametrize(
    ("path", "query"),
    [("/healthz", ""), ("/cities", ""), ("/schedule-index", "city=stm")],
)
def test_private_engine_requires_bearer(store: Store, path: str, query: str) -> None:
    app = Engine(store, 1, 0, 50, access_token=b"test-engine-token")

    async def run() -> None:
        good = b"Bearer test-engine-token"
        for values in ((), (b"Bearer wrong",), (good, good)):
            status, headers, _ = await http(app, path, query, authorization=values)
            assert status == 401
            assert headers[b"www-authenticate"] == b"Bearer"
        status, _, _ = await http(app, path, query, authorization=(good,))
        assert status == 200

    asyncio.run(run())


@pytest.mark.parametrize("family", ["punctuality", "service_delivered"])
def test_http_and_bilingual_csv_come_from_same_registry(
    store: Store, delivery: tuple[Store, dict[date, tuple[Trip, ...]]], family: str
) -> None:
    if family == "service_delivered":
        store, _ = delivery
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = urlencode({"measure": family, "city": "stm", "from": THURSDAY, "to": THURSDAY})

    async def run() -> None:
        status, _, catalog = await http(app, "/how-we-measure")
        assert status == 200
        status, headers, answer = await http(app, "/measure", params)
        assert status == 200
        assert headers[b"x-transit-cleaning-version"] == str(store.cleaning_version).encode()
        info = [item for item in json.loads(catalog) if item["family"] == family]
        assert [
            {key: value for key, value in entry.items() if key != "family_text"} for entry in info
        ] == json.loads(answer)["info"]
        if family == "service_delivered":
            status, _, error = await http(app, "/measure", params + "&stop=first")
            assert status == 400
            assert "stop does not apply" in json.loads(error)["message"]
        for lang in ("en", "fr"):
            status, headers, payload = await http(
                app, "/measure", params + f"&format=csv&lang={lang}"
            )
            assert status == 200
            assert headers[b"content-type"] == b"text/csv; charset=utf-8"
            assert headers[b"x-transit-cleaning-version"] == str(store.cleaning_version).encode()
            reader = csv.reader(io.StringIO(payload.decode()))
            assert next(reader) == info[0]["csv_columns"][lang]
            assert [row[0] for row in reader] == [measure["id"] for measure in info]

    asyncio.run(run())


@pytest.mark.parametrize("reason", ["no_raw_captures", "no_schedule_edition"])
def test_pending_days_distinguish_incomplete_days_from_permanent_receipts(
    tmp_path: Path, reason: str
) -> None:
    store = _build_store(tmp_path, 8)
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    window = urlencode({"city": "stm", "from": THURSDAY, "to": SATURDAY})
    predictions = tmp_path / "stm" / str(SATURDAY) / "v8" / PREDICTION_SAMPLES
    original = predictions.read_bytes()
    predictions.write_bytes(b"")

    async def run() -> None:
        status, headers, body = await http(app, "/measure", window + "&measure=on_time")
        assert status == 200
        assert headers[b"x-transit-days-pending"] == b"2"
        evidence = json.loads(body)["evidence"]
        assert evidence["days_pending"] == [str(FRIDAY), str(SATURDAY)]
        assert evidence["days_measured"] == [str(THURSDAY), str(SATURDAY)]

        receipt = tmp_path / "stm" / str(FRIDAY) / "v8" / "manifest.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(
            json.dumps(
                {
                    "provider": "stm",
                    "service_date": str(FRIDAY),
                    "cleaning_version": "8",
                    "built_at_utc": "2026-11-22T00:00:00Z",
                    "status": reason,
                }
            ),
            encoding="utf-8",
        )

        status, headers, body = await http(app, "/measure", window + "&measure=on_time&group=day")
        assert status == 200
        assert headers[b"x-transit-days-pending"] == b"1"
        evidence = json.loads(body)["evidence"]
        assert evidence["days_pending"] == [str(SATURDAY)]
        assert evidence["days_not_measured"] == [str(FRIDAY)]
        assert evidence["days_not_measured_reasons"] == {str(FRIDAY): reason}

        status, headers, _ = await http(app, "/ranking", window + "&kind=line&format=csv")
        assert status == 200
        assert headers[b"x-transit-days-pending"] == b"1"

        predictions.write_bytes(original)
        status, headers, body = await http(app, "/data-health", window)
        assert status == 200
        assert headers[b"x-transit-days-pending"] == b"0"
        days = json.loads(body)["days"]
        assert days[1]["reason"] == reason
        assert [day["status"] for day in days] == [
            "present",
            "not_measured",
            "present",
        ]

    asyncio.run(run())


@pytest.mark.parametrize(
    "parameters",
    [
        "&line=",
        "&city=stm",
        "&surprise=x",
        "&direction=2",
        "&departure=07:30:00",
        "&hour=24",
        "&day_type=weekend",
        "&group=week",
        "&group=",
        "&group=day&group=hour",
        "&group=direction",
        "&group=day&to=2028-01-01",
        "&format=yaml",
        "&lang=es",
        "&stop=%00",
        "&stop=%ff",
        "&stop=%xx",
        "&from=20261119",
        "&to=2026-11-18",
    ],
)
def test_invalid_parameters_fail_before_admission(store: Store, parameters: str) -> None:
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    params = {"measure": "punctuality", "city": "stm", "from": THURSDAY, "to": THURSDAY}
    for key in ("to", "from"):
        if f"&{key}=" in parameters:
            params.pop(key)
    status, _, _ = asyncio.run(http(app, "/measure", urlencode(params) + parameters))
    assert status == 400


def test_timing_over_two_clean_days(
    store: Store, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    out = tmp_path / "timing.json"

    def request(url: str, *, timeout: float) -> tuple[int, bool, dict[str, Any]]:
        assert timeout >= 30
        parts = urlsplit(url)
        assert parts.path == "/measure"
        assert parse_qs(parts.query)["measure"] == ["punctuality"]
        status, headers, body = asyncio.run(http(app, parts.path, parts.query))
        return status, headers[b"x-engine-queued"] == b"true", json.loads(body)

    monkeypatch.setattr("transit_engine.timing.request", request)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "timing",
            "--city",
            "stm",
            "--end-date",
            str(SUNDAY),
            "--spans",
            "1",
            "2",
            "--out",
            str(out),
        ],
    )
    timing.main()
    report = json.loads(out.read_text(encoding="utf-8"))
    assert [entry["days"] for entry in report["timings"]] == [1, 2]
    runs = report["timings"][1]["runs"]
    assert len(runs) == 3
    assert all(run["counts"]["classified"] == 68 and not run["days_not_measured"] for run in runs)


def _long_range_answers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: int = 7
) -> dict[str, Any]:
    start = date(2026, 10, 18)
    end = start + timedelta(days=34)
    trips_by_day: dict[date, tuple[Trip, ...]] = {
        start + timedelta(days=offset): TRIPS if offset % 7 < 5 else TRIPS[1:]
        for offset in range(35)
        if offset != 33
    }
    if version >= 8:
        trips_by_day[FALL_BACK] += (
            Trip(
                "overnight", "A", 0, "ran", None, True, (0, 301),
                stop_times=(
                    StopTiming("first", -16 * 60, 0, "departure"),
                    StopTiming("other", 0, 3_600, "departure"),
                ),
            ),
            Trip("cancelled_no_live", "N", 0, "cancelled", None, False, (0,)),
        )
    store = _build_store(tmp_path, cleaning_version=version, trips_by_day=trips_by_day)
    wide_store = Store(store.root, cleaning_version=version, memory_mib=2048, threads=4)
    # Wall time is telemetry. Fix the clock so the entire public response can be compared.
    monkeypatch.setattr("transit_engine.measures.perf_counter", lambda: 1.0)
    monkeypatch.setattr("transit_engine.ranking.perf_counter", lambda: 1.0)
    answers = {
        "network": ask(store, Question("punctuality", "stm", start, end)),
        "line": ask(store, Question("punctuality", "stm", start, end, line="A")),
        "grid": ask(
            store if version < 8 else wide_store,
            Question("punctuality", "stm", start, end, group="weekday_hour"),
        ),
        "delivery": ask(store, Question("service_delivered", "stm", start, end)),
        "line_rank": rank(store, Ranking(Question("on_time", "stm", start, end), "line")),
        "stop_rank": rank(store, Ranking(Question("on_time", "stm", start, end), "stop")),
        "departure_rank": rank(
            wide_store, Ranking(Question("on_time", "stm", start, end), "departure")
        ),
    }
    if version >= 8:
        answers.update(
            {
                "hour": ask(store, Question("punctuality", "stm", start, end, group="hour")),
                "day_type": ask(
                    store, Question("punctuality", "stm", start, end, group="day_type")
                ),
                "day": ask(store, Question("punctuality", "stm", start, end, group="day")),
                "departure_cut": ask(
                    store,
                    Question(
                        "punctuality", "stm", start, end, line="A", direction=0,
                        departure="07:00:00", hour=7,
                    ),
                ),
                "stop_series": ask(
                    store, Question("punctuality", "stm", start, end, line="A", group="stop")
                ),
                "stop_percentile": rank(
                    store, Ranking(Question("median_delay", "stm", start, end), "stop")
                ),
            }
        )
    return answers


def test_long_range_matches_baseline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Canonical JSON digests with the revised statistics and v11 basis and method text.
    # The fixture spans two query batches, a DST transition, and one missing day.
    expected = {
        "network": "ac977cb6a6f1e87262a0f718f843e1dda277e6c2f22bd65aa5b2309a6d2c131e",
        "line": "f2e32cf4de38bbdeb4e32c748f3ac424ea0c5f77a76fbb897ca1e64389dea67a",
        "grid": "f4aee9d539ccab0b32bedfac1bdabd55541410ada1992f85b9da3c5c40bca1d4",
        "delivery": "c0585d214d9f18d8760df1ddf5353865b073cede0f1077ab72b93a6efecf57ad",
        "line_rank": "cdca9252102f588ae33cc6d01adb85fe6d5a01ba86bdc8c43af8c7f302305122",
        "stop_rank": "a6dbd3c760292cc78e37ff9335c024eed56ff030514f7e61b99d46cea731854a",
        "departure_rank": "6197f7211a721a412fb8e671278340b2b4e8861e3aec3bd0def3fc03e3a7f170",
    }
    answers = _long_range_answers(tmp_path, monkeypatch)
    assert {
        name: sha256(json.dumps(answer, sort_keys=True).encode()).hexdigest()
        for name, answer in answers.items()
    } == expected


@pytest.mark.parametrize("version", [9, 10])
def test_long_range_one_scan_matches_v8(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: int
) -> None:
    old = _long_range_answers(tmp_path, monkeypatch, 8)
    new = _long_range_answers(tmp_path, monkeypatch, version)
    for answer in old.values():
        assert answer["evidence"].pop("cleaning_versions") == [8]
    for answer in new.values():
        assert answer["evidence"].pop("cleaning_versions") == [version]
    assert new == old


def test_bounded_wait_queue(store: Store, monkeypatch: pytest.MonkeyPatch) -> None:
    answer = query(store)
    release = Event()

    def blocking_query(store: Store, question: Question) -> dict[str, Any]:
        assert release.wait(5)
        return answer

    monkeypatch.setattr("transit_engine.server.ask", blocking_query)

    async def run() -> None:
        app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)

        def request(day: date) -> Any:
            return http(
                app,
                "/measure",
                urlencode(
                    {
                        "measure": "punctuality",
                        "city": "stm",
                        "from": day,
                        "to": day,
                    }
                ),
            )

        active = asyncio.create_task(request(THURSDAY))
        await asyncio.sleep(0)
        waiting = asyncio.create_task(request(SATURDAY))
        await asyncio.sleep(0)
        try:
            full_status, full_headers, _ = await request(FRIDAY)
            wait_status, wait_headers, _ = await waiting
            assert full_status == wait_status == 503
            assert full_headers[b"retry-after"] == wait_headers[b"retry-after"] == b"1"
            assert wait_headers[b"x-engine-queued"] == b"true"
            assert full_headers[b"x-engine-queued"] == b"false"
        finally:
            release.set()
        status, _, _ = await active
        assert status == 200

    asyncio.run(run())


def _accessibility_trips() -> tuple[Trip, ...]:
    return (
        *(
            Trip(
                f"acc_{index}", "A", 0, "ran", None, True, (0,),
                wheelchair=1, stop_wheelchair=(1, 2),
            )
            for index in range(4)
        ),
        *(
            Trip(
                f"not_{index}", "A", 0, "ran", None, True, (0,),
                wheelchair=2, stop_wheelchair=(1, 2),
            )
            for index in range(3)
        ),
        *(
            Trip(
                f"info_{index}", "A", 0, "ran", None, True, (0,),
                wheelchair=0, stop_wheelchair=(1, 2),
            )
            for index in range(2)
        ),
        Trip("null", "A", 0, "ran", None, True, (0,), wheelchair=None, stop_wheelchair=(1, 2)),
        Trip("added", "A", 0, "added", None, True, (0,)),
    )


def test_accessibility_matches_python_recomputation(tmp_path: Path) -> None:
    trips = _accessibility_trips()
    store = _build_store(tmp_path, 8, {THURSDAY: trips})
    answer = query(store, measure="accessible_trips")
    evidence = answer["evidence"]
    assert answer["state"] == "measured"
    assert evidence["cleaning_versions"] == [8]

    scheduled = [trip for trip in trips if trip.state != "added"]
    by_value = Counter(trip.wheelchair for trip in scheduled)
    declared = sum(count for value, count in by_value.items() if value is not None)
    assert evidence["counts"]["trips_accessible"] == by_value[1]
    assert evidence["counts"]["trips_not_accessible"] == by_value[2]
    assert evidence["counts"]["trips_no_information"] == by_value[0]
    assert (
        evidence["counts"]["trips_accessible"]
        + evidence["counts"]["trips_not_accessible"]
        + evidence["counts"]["trips_no_information"]
        == declared
    )
    assert evidence["counts"]["trips_not_published"] == len(scheduled) - declared
    value = answer["value"]["accessible_trips"]
    assert value == pytest.approx(by_value[1] / declared)
    assert 0 <= value <= 1

    # The stop cut means "trips serving that stop" for trip measures.
    served = query(store, measure="accessible_trips", stop="first")
    assert served["state"] == "measured"
    assert served["value"]["accessible_trips"] == value

    stops = query(store, measure="accessible_stops")
    assert stops["state"] == "measured"
    # Distinct stops: "first" declared accessible, "other" declared not accessible.
    assert stops["evidence"]["counts"]["stops_accessible"] == 1
    assert stops["evidence"]["counts"]["stops_not_accessible"] == 1
    assert stops["evidence"]["counts"]["stops_no_information"] == 0
    assert stops["value"]["accessible_stops"] == pytest.approx(1 / 2)

    family = query(store, measure="accessibility")
    assert family["value"]["accessible_trips"] == value
    assert family["value"]["accessible_stops"] == pytest.approx(1 / 2)
    assert family["evidence"]["measure_states"] == {
        "accessible_trips": "measured",
        "accessible_stops": "measured",
    }


@pytest.mark.parametrize("latest", [2, None])
def test_accessible_stops_use_latest_service_date(tmp_path: Path, latest: int | None) -> None:
    trip = Trip("a", "A", 0, "ran", None, True, (0,), stop_wheelchair=(1, 0))
    store = _build_store(
        tmp_path, 8, {THURSDAY: (trip,), FRIDAY: (trip._replace(stop_wheelchair=(latest, 0)),)}
    )

    answer = query(store, measure="accessible_stops", end=FRIDAY)
    counts = answer["evidence"]["counts"]
    assert counts["stops_accessible"] == 0
    assert counts["stops_not_accessible"] == int(latest == 2)
    assert counts["stops_no_information"] == 1
    assert counts["stops_not_published"] == int(latest is None)
    assert sum(counts[f"stops_{part}"] for part in (
        "accessible", "not_accessible", "no_information"
    )) == 2 - counts["stops_not_published"]
    assert answer["value"]["accessible_stops"] == 0

    first_day = query(store, measure="accessible_stops", stop="first")
    assert first_day["value"]["accessible_stops"] == 1


def test_accessibility_not_published_when_column_absent(tmp_path: Path) -> None:
    trips = tuple(Trip(f"t{index}", "A", 0, "ran", None, True, (0,)) for index in range(3))
    store = _build_store(tmp_path, 8, {THURSDAY: trips})
    answer = query(store, measure="accessible_trips")
    assert answer["state"] == "not_published"
    assert answer["state_text"]["en"] == "Not published"
    assert answer["value"] == {"accessible_trips": None}
    assert answer["evidence"]["counts"]["trips_accessible"] == 0
    assert query(store, measure="accessible_stops")["state"] == "not_published"


def test_accessibility_before_v8_is_not_measured(tmp_path: Path) -> None:
    trips = tuple(Trip(f"t{index}", "A", 0, "ran", None, True, (0,)) for index in range(3))
    store = _build_store(tmp_path, 7, {THURSDAY: trips})
    answer = query(store, measure="accessible_trips")
    assert answer["state"] == "not_measured"
    assert answer["value"] == {"accessible_trips": None}
    assert answer["evidence"]["days_not_measured"] == [str(THURSDAY)]
    # Other families still read the v7 day normally.
    assert query(store, measure="punctuality")["evidence"]["days_measured"] == [str(THURSDAY)]


def test_accessibility_rejects_series_grouping(store: Store) -> None:
    with pytest.raises(ValueError, match="series grouping"):
        Question("accessible_trips", "stm", THURSDAY, THURSDAY, group="day")
