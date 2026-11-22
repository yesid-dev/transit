import asyncio
import json
import sys
from datetime import date
from pathlib import Path
from threading import Event
from typing import Never, cast

import duckdb
import pytest
from uvicorn._types import ASGISendEvent, HTTPScope

from transit_engine import timing
from transit_engine.punctuality import METHOD_VERSION, Evidence, Store, network_day
from transit_engine.server import Engine

DAY = date(2026, 11, 19)
TRIPS = [
    ("scheduled", True, "ran", None),
    ("cancelled", True, "cancelled", None),
    ("unconfirmed", True, "unconfirmed", None),
    ("without_live", True, "not_measured", "route_without_live_data"),
    ("gap", True, "not_measured", "capture_gap"),
    ("added", False, "added", None),
    ("missing", True, "missing", None),
]
STOPS = [
    ("scheduled", 1, -61),
    ("scheduled", 2, -60),
    ("scheduled", 3, 300),
    ("scheduled", 4, 301),
    ("scheduled", 5, None),
    ("cancelled", 1, 5),
    ("unconfirmed", 1, None),
    ("without_live", 1, None),
    ("without_live", 2, None),
    ("without_live", 3, None),
    ("gap", 1, None),
    ("gap", 2, None),
    ("added", 1, None),
    ("missing", 1, None),
]


@pytest.fixture
def store(tmp_path: Path) -> Store:
    with duckdb.connect() as conn:
        conn.execute("""
            CREATE TABLE trips (
                trip_id VARCHAR, scheduled BOOLEAN, state VARCHAR NOT NULL, state_reason VARCHAR
            );
            CREATE TABLE stops (trip_id VARCHAR, stop_sequence BIGINT, delay_seconds BIGINT);
            """)
        conn.executemany("INSERT INTO trips VALUES (?, ?, ?, ?)", TRIPS)
        conn.executemany("INSERT INTO stops VALUES (?, ?, ?)", STOPS)
        for day, omitted in (
            ("2026-11-18", ["without_live"]),
            ("2026-11-19", []),
            ("2026-11-20", []),
            ("2026-11-21", ["without_live", "gap"]),
        ):
            directory = tmp_path / "stm" / day / "v1"
            directory.mkdir(parents=True)
            identity = f"'stm' AS provider, DATE '{day}' AS service_date, '1' AS cleaning_version"
            conn.execute(
                f"""COPY (SELECT {identity}, trip_id, state, state_reason,
                       CASE WHEN scheduled THEN TIMESTAMPTZ '{day} 12:00:00+00'
                       END AS scheduled_start_utc FROM trips
                       WHERE NOT list_contains(?::VARCHAR[], trip_id)) TO ? (FORMAT PARQUET)""",
                [omitted, str(directory / "trip_days.parquet")],
            )
            delay = "NULL::BIGINT AS delay_seconds" if day.endswith("20") else "delay_seconds"
            conn.execute(
                f"""COPY (SELECT {identity}, trip_id, stop_sequence, {delay},
                       NULL::TIMESTAMPTZ AS scheduled_arrival_utc,
                       CASE WHEN stop_sequence < 5 THEN TIMESTAMPTZ '{day} 12:00:00+00'
                       END AS scheduled_departure_utc FROM stops
                       WHERE NOT list_contains(?::VARCHAR[], trip_id)) TO ? (FORMAT PARQUET)""",
                [omitted, str(directory / "stop_events.parquet")],
            )
    return Store(tmp_path.as_posix())


def test_bands_and_independent_recomputation(store: Store) -> None:
    result = network_day(store, "stm", DAY)
    assert result["status"] == "measured"
    assert result["city"] == "stm"
    assert result["start_date"] == result["end_date"] == DAY.isoformat()
    assert (result["early"], result["on_time"], result["late"]) == (1, 2, 1)
    assert result["classified"] == 4
    assert result["scheduled"] == 9
    assert result["share_observed"] == 4 / 9
    assert result["share_on_time"] == 0.5
    assert result["cleaning_versions"] == [1]
    assert result["method_version"] == METHOD_VERSION
    assert result["query_ms"] >= 0

    scheduled_ids = {
        ident
        for ident, scheduled, state, reason in TRIPS
        if scheduled and state != "cancelled" and reason != "route_without_live_data"
    }
    scheduled_stops = [delay for ident, _, delay in STOPS if ident in scheduled_ids]
    observed = [delay for delay in scheduled_stops if delay is not None]
    counts = {"early": 0, "on_time": 0, "late": 0}
    for delay in observed:
        if delay < -60:
            counts["early"] += 1
        elif delay > 300:
            counts["late"] += 1
        else:
            counts["on_time"] += 1
    assert {key: dict(result)[key] for key in counts} == counts
    assert result["classified"] == sum(counts.values()) == len(observed) <= len(scheduled_stops)
    assert result["scheduled"] == len(scheduled_stops)


def test_route_without_live_data_does_not_change_counts_or_shares(store: Store) -> None:
    comparable = network_day(store, "stm", date(2026, 11, 18))
    result = network_day(store, "stm", DAY)
    assert result["scheduled"] == comparable["scheduled"] == 9
    assert result["classified"] == comparable["classified"] == 4
    assert result["share_observed"] == comparable["share_observed"] == 4 / 9
    assert result["share_on_time"] == comparable["share_on_time"] == 0.5
    assert result["not_measured_route_without_live_data"] == 3
    assert comparable["not_measured_route_without_live_data"] == 0


def test_capture_gap_stays_in_scheduled_and_is_reported(store: Store) -> None:
    comparable = network_day(store, "stm", date(2026, 11, 21))
    result = network_day(store, "stm", date(2026, 11, 18))
    assert comparable["scheduled"] == 7
    assert result["scheduled"] == 9
    assert result["classified"] == comparable["classified"] == 4
    assert comparable["share_observed"] == 4 / 7
    assert result["share_observed"] == 4 / 9
    assert result["share_on_time"] == comparable["share_on_time"] == 0.5
    assert result["not_measured_capture_gap"] == 2
    assert comparable["not_measured_capture_gap"] == 0


def test_day_without_file_and_day_without_observations(store: Store) -> None:
    absent = network_day(store, "stm", date(2026, 11, 17))
    assert absent["status"] == "not_measured"
    assert absent["message"] == "not measured"
    assert absent["classified"] is absent["scheduled"] is absent["share_observed"] is None
    assert absent["not_measured_route_without_live_data"] is None
    assert absent["not_measured_capture_gap"] is None
    assert absent["cleaning_versions"] == []

    unobserved = network_day(store, "stm", date(2026, 11, 20))
    assert unobserved["status"] == "not_measured"
    assert unobserved["scheduled"] == 9
    assert unobserved["classified"] == 0
    assert unobserved["share_observed"] == 0
    assert unobserved["share_on_time"] is None
    assert unobserved["cleaning_versions"] == [1]


def test_timing_over_two_clean_days(
    store: Store, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "timing.json"
    monkeypatch.setenv("ENGINE_CLEAN_ROOT", store.root)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "timing",
            "--city",
            "stm",
            "--end-date",
            DAY.isoformat(),
            "--spans",
            "1",
            "2",
            "--out",
            str(out),
        ],
    )
    timing.main()
    report = json.loads(out.read_text(encoding="utf-8"))
    assert len(report["network_day"]) == 3
    assert len(report["timings"]) == 6
    totals = next(
        row for row in report["timings"] if row["days"] == 2 and row["query"] == timing.PERIOD
    )
    assert totals["counts"] == {
        "scheduled": 18,
        "classified": 8,
        "early": 2,
        "on_time": 4,
        "late": 2,
        "not_measured_route_without_live_data": 3,
        "not_measured_capture_gap": 4,
    }
    assert len(totals["runs_s"]) == 3


def test_bounded_wait_queue(store: Store, monkeypatch: pytest.MonkeyPatch) -> None:
    answer = network_day(store, "stm", DAY)
    release = Event()

    def blocking_query(store: Store, city: str, day: date) -> Evidence:
        assert release.wait(5)
        return answer

    monkeypatch.setattr("transit_engine.server.network_day", blocking_query)

    async def run() -> None:
        app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)

        async def request(day: int) -> ASGISendEvent:
            scope = cast(
                HTTPScope,
                {
                    "type": "http",
                    "method": "GET",
                    "path": "/network-punctuality",
                    "query_string": f"city=stm&date=2026-11-{day}".encode(),
                },
            )
            messages: list[ASGISendEvent] = []

            async def receive() -> Never:
                raise AssertionError("GET has no request body")

            async def send(message: ASGISendEvent) -> None:
                messages.append(message)

            await app(scope, receive, send)
            return messages[0]

        active = asyncio.create_task(request(19))
        await asyncio.sleep(0)
        waiting = asyncio.create_task(request(18))
        await asyncio.sleep(0)
        try:
            full = await request(17)
            timed_out = await waiting
            assert full["type"] == timed_out["type"] == "http.response.start"
            assert full["status"] == timed_out["status"] == 503
            assert (b"x-engine-queued", b"true") in timed_out["headers"]
            assert (b"x-engine-queued", b"false") in full["headers"]
        finally:
            release.set()
        completed = await active
        assert completed["type"] == "http.response.start"
        assert completed["status"] == 200

    asyncio.run(run())
