import asyncio
import csv
import io
import json
import sys
from collections import Counter
from datetime import UTC, date, datetime
from hashlib import sha256
from pathlib import Path
from threading import Event
from typing import Any, NamedTuple, Never, cast
from urllib.parse import parse_qs, urlencode, urlsplit

import duckdb
import pytest
from uvicorn._types import ASGISendEvent, HTTPScope

from transit_engine import timing
from transit_engine.clean_manifest import STOP_EVENTS, TRIP_DAYS
from transit_engine.measures import MIN_CLASSIFIED_STOP_EVENTS, Question, ask
from transit_engine.server import Engine
from transit_engine.store import Store

THURSDAY = date(2026, 11, 19)
FRIDAY = date(2026, 11, 20)
SATURDAY = date(2026, 11, 21)
SUNDAY = date(2026, 11, 22)
FALL_BACK = date(2026, 11, 1)


class Trip(NamedTuple):
    id: str
    line: str
    direction: int
    state: str
    reason: str | None
    live: bool
    delays: tuple[int | None, ...]


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
    with duckdb.connect() as conn:
        conn.execute("""
            CREATE TABLE trips (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR, trip_id VARCHAR,
                route_id VARCHAR, direction_id INTEGER, state VARCHAR, state_reason VARCHAR,
                route_has_live_data BOOLEAN, scheduled_start_utc TIMESTAMPTZ
            );
            CREATE TABLE stops (
                provider VARCHAR, service_date DATE, cleaning_version VARCHAR, trip_id VARCHAR,
                stop_id VARCHAR, stop_sequence BIGINT, delay_seconds BIGINT,
                scheduled_arrival_utc TIMESTAMPTZ, scheduled_departure_utc TIMESTAMPTZ
            );
            """)
        for day in (FALL_BACK, THURSDAY, SATURDAY, SUNDAY):
            directory = tmp_path / "stm" / str(day) / "v3"
            directory.mkdir(parents=True)
            start = (
                datetime(2026, 11, 2, 6, 15, tzinfo=UTC)
                if day == FALL_BACK
                else datetime(2026, 11, day.day, 12, tzinfo=UTC)
            )
            states: Counter[str] = Counter()
            bases: Counter[str] = Counter()
            for trip in TRIPS:
                identity = ("stm", day, "3", trip.id)
                scheduled = start if trip.state != "added" else None
                conn.execute(
                    "INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        *identity,
                        trip.line,
                        trip.direction,
                        trip.state,
                        trip.reason,
                        trip.live,
                        scheduled,
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
                    stops.append((*identity, stop, seq, delay, arrival, None))
                    bases["not_observed" if delay is None else "trip_update_reported"] += 1
                conn.executemany("INSERT INTO stops VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", stops)
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
            (directory / "manifest.json").write_text(
                json.dumps(
                    {
                        "provider": "stm",
                        "service_date": str(day),
                        "cleaning_version": "3",
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
    return Store(tmp_path.as_posix())


def query(store: Store, **kwargs: Any) -> dict[str, Any]:
    parameters = {"measure": "punctuality", "city": "stm", "start": THURSDAY, "end": THURSDAY}
    return ask(store, Question(**{**parameters, **kwargs}))


def test_bands_use_exact_thresholds(store: Store) -> None:
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
    assert evidence["cleaning_versions"] == [3]
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


def test_blob_discovery_checks_both_files(store: Store) -> None:
    # Exercise httpfs's glob/read_blob query path against local files.
    remote = Store(store.root, s3_endpoint="example.invalid")
    with store.connect() as conn:
        assert remote.files(conn, "stm", THURSDAY) is not None
        path = Path(store.root) / "stm" / str(THURSDAY) / "v3" / TRIP_DAYS
        path.write_bytes(path.read_bytes()[:-1])
        assert remote.files(conn, "stm", THURSDAY) is None


@pytest.mark.parametrize("remote", [False, True])
def test_explicit_audit_detects_same_size_corruption(store: Store, remote: bool) -> None:
    target = Store(store.root, s3_endpoint="example.invalid") if remote else store
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


def test_http_and_bilingual_csv_come_from_same_registry(store: Store) -> None:
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = urlencode({"measure": "punctuality", "city": "stm", "from": THURSDAY, "to": THURSDAY})

    async def run() -> None:
        status, _, catalog = await http(app, "/how-we-measure")
        assert status == 200
        status, _, answer = await http(app, "/measure", params)
        assert status == 200
        info = json.loads(catalog)
        assert info == json.loads(answer)["info"]
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
        if parameters.startswith(f"&{key}="):
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
