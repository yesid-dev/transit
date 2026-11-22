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
from transit_engine.server import Engine
from transit_engine.store import Store

THURSDAY = date(2026, 11, 19)
FRIDAY = date(2026, 11, 20)
SATURDAY = date(2026, 11, 21)
SUNDAY = date(2026, 11, 22)
FALL_BACK = date(2026, 11, 1)
V4_EXTRA_FILES = (SCHEDULED_STOP_TIMES, "vehicle_positions.parquet", "feed_polls.parquet")


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
) -> Store:
    version = str(cleaning_version)
    with duckdb.connect() as conn:
        conn.execute("""
            CREATE TABLE trips (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR, trip_id VARCHAR,
                route_id VARCHAR, direction_id INTEGER, state VARCHAR, state_reason VARCHAR,
                route_has_live_data BOOLEAN, scheduled_start_utc TIMESTAMPTZ,
                cancellation_notice_utc TIMESTAMPTZ, route_type INTEGER
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
                scheduled_departure_seconds BIGINT
            );
            CREATE TABLE polls (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR,
                feed VARCHAR, captured_at_utc TIMESTAMPTZ, result VARCHAR,
                feed_timestamp_utc TIMESTAMPTZ, entity_count BIGINT
            );
            """)
        for day, trips in (
            trips_by_day or dict.fromkeys((FALL_BACK, THURSDAY, SATURDAY, SUNDAY), TRIPS)
        ).items():
            directory = tmp_path / "stm" / str(day) / f"v{version}"
            directory.mkdir(parents=True)
            start = (
                datetime(2026, 11, 2, 6, 15, tzinfo=UTC)
                if day == FALL_BACK
                else datetime(day.year, day.month, day.day, 12, tzinfo=UTC)
            )
            states: Counter[str] = Counter()
            bases: Counter[str] = Counter()
            polls = (polls_by_day or {}).get(day, ())
            for poll in polls:
                captured = start + timedelta(seconds=poll.offset_seconds)
                conn.execute(
                    "INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        "stm",
                        day,
                        version,
                        poll.feed,
                        captured,
                        poll.result,
                        captured - timedelta(seconds=poll.publication_age),
                        1,
                    ],
                )
            for trip in trips:
                identity = ("stm", day, version, trip.id)
                start_at = start + timedelta(minutes=trip.offset_minutes)
                notice = (
                    start_at + timedelta(seconds=trip.notice_seconds)
                    if trip.notice_seconds is not None
                    else None
                )
                scheduled = start_at if trip.state != "added" else None
                if scheduled is not None and cleaning_version in {4, 5, 6}:
                    first = (
                        25 * 3600 + 15 * 60 if day == FALL_BACK else 7 * 3600
                    ) + trip.offset_minutes * 60
                    last = first + trip.duration_minutes * 60
                    conn.executemany(
                        "INSERT INTO schedule VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [
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
                        ],
                    )
                conn.execute(
                    "INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        *identity,
                        trip.line,
                        trip.direction,
                        trip.state,
                        trip.reason,
                        trip.live,
                        scheduled,
                        notice,
                        trip.route_type,
                    ],
                )
                states[trip.state] += 1
                stops = []
                for seq, delay in enumerate(trip.delays, 1):
                    if day == SATURDAY:
                        delay = None
                    elif day == SUNDAY and delay is not None:
                        delay += 10  # A different distribution from Thursday.
                    stop = "first" if seq == 1 else "other"
                    arrival = scheduled if delay is not None or seq != 33 else None
                    observed = start_at + timedelta(seconds=delay) if delay is not None else None
                    basis = "not_observed" if delay is None else trip.basis
                    stops.append(
                        (
                            *identity,
                            stop,
                            seq,
                            delay,
                            arrival,
                            None,
                            observed,
                            basis,
                            "arrival" if observed else None,
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
                conn.execute(f"COPY {table} TO ? (FORMAT PARQUET)", [str(directory / name)])
                conn.execute(f"DELETE FROM {table}")
                payload = (directory / name).read_bytes()
                files[name] = {
                    "rows": sum(counts.values()),
                    "sha256": sha256(payload).hexdigest(),
                    "byte_size": len(payload),
                }
            if cleaning_version in {4, 5, 6}:
                extra_files = (*V4_EXTRA_FILES, ALERTS) if cleaning_version >= 5 else V4_EXTRA_FILES
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
                        "provider": "stm",
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


def test_store_defaults_to_v6_and_accepts_v3_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENGINE_CLEAN_ROOT", str(tmp_path))
    monkeypatch.delenv("ENGINE_CLEANING_VERSION", raising=False)
    assert Store(tmp_path.as_posix()).cleaning_version == Store.from_env().cleaning_version == 6
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
    assert evidence["median_cancellation_lead_seconds"] == pytest.approx((1800 - 30) / 2, abs=7.5)
    late_day = query(store, measure="cancelled_trips")["evidence"]
    assert late_day["median_cancellation_lead_seconds"] == pytest.approx(-30, abs=7.5)
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
    assert daily["cells"][0]["evidence"]["measure_states"]["first_trip"] == "too_few_to_judge"
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
    assert unknown["state"] == "unknown"
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


@pytest.mark.parametrize("cleaning_version", [3, 4, 5])
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
    assert evidence["counts"] == {"scheduled": len(scheduled), "classified": len(observed), **bands}
    assert sum(bands.values()) == len(observed) <= len(scheduled)
    assert evidence["share_observed"] == len(observed) / len(scheduled)
    for band, count in bands.items():
        assert answer["value"][band] == count / len(observed)
    assert answer["value"]["median_delay"] == 30
    # Exact continuous percentiles are computed independently on the small fixture.
    for key, fraction in (("median_delay", 0.5), ("p90_delay", 0.9)):
        rank = (len(observed) - 1) * fraction
        lo = int(rank)
        exact = observed[lo] + (observed[lo + 1] - observed[lo]) * (rank - lo)
        assert abs(exact - answer["value"][key]) <= 7.5


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
        (query(store, line="U"), "unknown"),
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


def test_no_raw_captures_receipt_is_not_measured(store: Store) -> None:
    directory = Path(store.root) / "stm" / str(THURSDAY) / "v3"
    for path in directory.glob("*.parquet"):
        path.unlink()
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "status": "no_raw_captures",
                "provider": "stm",
                "service_date": str(THURSDAY),
                "cleaning_version": "3",
                "built_at_utc": f"{THURSDAY}T00:00:00+00:00",
                "builder_git_commit": None,
            }
        ),
        encoding="utf-8",
    )
    result = query(store)
    assert result["state"] == "not_measured"
    assert result["evidence"]["days_not_measured"] == [str(THURSDAY)]
    assert result["evidence"]["days_measured"] == []
    assert result["evidence"]["counts"]["classified"] is None


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
    app: Engine, path: str, query_string: str = ""
) -> tuple[int, dict[bytes, bytes], bytes]:
    scope = cast(
        HTTPScope,
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "query_string": query_string.encode(),
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
        status, _, answer = await http(app, "/measure", params)
        assert status == 200
        info = [item for item in json.loads(catalog) if item["family"] == family]
        assert info == json.loads(answer)["info"]
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
            reader = csv.reader(io.StringIO(payload.decode()))
            assert next(reader) == info[0]["csv_columns"][lang]
            assert [row[0] for row in reader] == [measure["id"] for measure in info]

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

    def request(url: str) -> tuple[int, bool, dict[str, Any]]:
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
