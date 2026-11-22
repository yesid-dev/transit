import asyncio
import csv
import io
import json
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlencode

import duckdb
import pytest
from test_engine import FRIDAY, SATURDAY, THURSDAY, Trip, _build_store, http

from transit_engine import measures
from transit_engine.clean_manifest import ALERTS, VEHICLE_POSITIONS
from transit_engine.server import Engine
from transit_engine.store import Store


class Reading(NamedTuple):
    line: str
    stop: str
    first: datetime
    seconds: int
    readings: int
    status: int | None
    percentage: int | None = None


class Notice(NamedTuple):
    id: str
    version: str
    periods: tuple[tuple[datetime | None, datetime | None], ...]
    lines: tuple[str, ...]
    stops: tuple[str, ...]
    effect: str = "DETOUR"
    cause: str = "CONSTRUCTION"


def utc(day: date, hour: int, minute: int = 0, second: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, second, tzinfo=UTC)


def _write_table(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    day: date,
    name: str,
    schema: str,
    records: list[tuple[object, ...]],
) -> None:
    directory = Path(store.root) / "stm" / str(day) / "v6"
    marker = directory / "manifest.json"
    manifest = json.loads(marker.read_text(encoding="utf-8"))
    conn.execute(
        f"CREATE OR REPLACE TABLE fixture (provider VARCHAR, cleaning_version VARCHAR,"
        f" service_date DATE, {schema})"
    )
    if records:
        placeholders = ", ".join("?" for _ in range(len(records[0]) + 3))
        conn.executemany(
            f"INSERT INTO fixture VALUES ({placeholders})",
            [("stm", "6", day, *record) for record in records],
        )
    target = directory / name
    conn.execute("COPY fixture TO ? (FORMAT PARQUET)", [str(target)])
    payload = target.read_bytes()
    manifest["files"][name] = {
        "rows": len(records),
        "sha256": sha256(payload).hexdigest(),
        "byte_size": len(payload),
    }
    marker.write_text(json.dumps(manifest), encoding="utf-8")


def _not_tracked(store: Store, day: date) -> None:
    marker = Path(store.root) / "stm" / str(day) / "v6" / "manifest.json"
    manifest = json.loads(marker.read_text(encoding="utf-8"))
    del manifest["files"][ALERTS]
    manifest["alerts"] = "not_tracked"
    marker.write_text(json.dumps(manifest), encoding="utf-8")
    (marker.parent / ALERTS).unlink()


@pytest.fixture
def history(tmp_path: Path) -> tuple[Store, list[Reading], dict[date, tuple[Notice, ...]]]:
    trips = {
        day: tuple(Trip(line, line, 0, "ran", None, True, (0, 0)) for line in lines)
        for day, lines in ((THURSDAY, "ABC"), (SATURDAY, "AD"))
    }
    store = _build_store(tmp_path, 6, trips)
    first = utc(THURSDAY, 12)
    readings = [
        *(Reading("A", "first", first, 900, 8, 5) for _ in range(40)),
        *(Reading("A", "first", first, 30, 3, 0, 15) for _ in range(40)),
        *(Reading("A", "first", utc(SATURDAY, 12), 30, 2, None, 75) for _ in range(20)),
        Reading("A", "first", utc(SATURDAY, 12), 40, 4, None, 105),
        Reading("A", "other", utc(THURSDAY, 12, 59, 40), 50, 4, 2),
        Reading("A", "first", first, 60, 10, None),
        Reading("B", "first", first, 30, 2, 3),
        Reading("C", "first", first, 30, 5, 7),
        Reading("D", "first", utc(SATURDAY, 12), 30, 5, 8),
    ]
    original = Notice("a", "1", ((utc(THURSDAY, 4), utc(THURSDAY, 7)),), ("A",), ("first",))
    notices: dict[date, tuple[Notice, ...]] = {
        THURSDAY: (
            original,
            Notice("a", "2", ((utc(THURSDAY, 6), utc(THURSDAY, 8)),), ("A",), ("first",)),
            Notice("point", "1", (), (), (), "OTHER_EFFECT", "UNKNOWN_CAUSE"),
            Notice("expired", "1", ((utc(THURSDAY, 2), utc(THURSDAY, 5)),), ("B",), ()),
        ),
        SATURDAY: (
            original,
            Notice(
                "b",
                "1",
                (
                    (utc(SATURDAY, 6), utc(SATURDAY, 7)),
                    (utc(SATURDAY, 8), utc(SATURDAY, 10)),
                    (utc(SATURDAY, 9), utc(SATURDAY, 11)),
                ),
                ("A", "B"),
                ("first", "outside"),
            ),
            Notice(
                "c", "1", ((utc(SATURDAY, 14), None),), ("D",), ("first",), "NO_SERVICE", "WEATHER"
            ),
            Notice(
                "d",
                "1",
                ((utc(SATURDAY, 4) + timedelta(days=1), utc(SATURDAY, 7) + timedelta(days=1)),),
                (),
                (),
            ),
        ),
    }
    with duckdb.connect() as conn:
        # Match the clean-day writer's interpretation of nested naive UTC timestamps.
        conn.execute("SET TimeZone = 'UTC'")
        for day in trips:
            _write_table(
                conn,
                store,
                day,
                VEHICLE_POSITIONS,
                "vehicle_id VARCHAR, route_id VARCHAR, stop_id VARCHAR, trip_id VARCHAR,"
                " observed_at_utc TIMESTAMPTZ, last_seen_at_utc TIMESTAMPTZ, readings BIGINT,"
                " occupancy_status INTEGER, occupancy_percentage BIGINT",
                [
                    (
                        f"vehicle-{index}",
                        row.line,
                        row.stop,
                        row.line,
                        row.first,
                        row.first + timedelta(seconds=row.seconds),
                        row.readings,
                        row.status,
                        row.percentage,
                    )
                    for index, row in enumerate(readings)
                    if row.first.date() == day
                ],
            )
            _write_table(
                conn,
                store,
                day,
                ALERTS,
                "alert_id VARCHAR, version VARCHAR, first_seen_at_utc TIMESTAMPTZ,"
                " last_seen_at_utc TIMESTAMPTZ, active_periods STRUCT(start_utc TIMESTAMPTZ,"
                " end_utc TIMESTAMPTZ)[], route_ids VARCHAR[], stop_ids VARCHAR[],"
                " effect VARCHAR, cause VARCHAR, source VARCHAR",
                [
                    (
                        item.id,
                        item.version,
                        utc(day, 14),
                        utc(day, 14 if not item.periods else 15),
                        [
                            {
                                "start_utc": start.replace(tzinfo=None) if start else None,
                                "end_utc": end.replace(tzinfo=None) if end else None,
                            }
                            for start, end in item.periods
                        ],
                        list(item.lines),
                        list(item.stops),
                        item.effect,
                        item.cause,
                        "fixture",
                    )
                    for item in notices[day]
                ],
            )
    return store, readings, notices


def _get(store: Store, path: str, measure: str, **cuts: object) -> dict[str, Any]:
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = {"city": "stm", "from": THURSDAY, "to": SATURDAY, "measure": measure, **cuts}
    status, _, body = asyncio.run(http(app, path, urlencode(params)))
    assert status == 200, body
    result: dict[str, Any] = json.loads(body)
    return result


def test_crowding_matches_independent_vehicle_time_and_reports_coverage(
    history: tuple[Store, list[Reading], dict[date, tuple[Notice, ...]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, readings, _ = history
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    answer = _get(store, "/measure", "crowding", line="A", direction=0, stop="first")
    seconds: defaultdict[str, int] = defaultdict(int)
    all_readings = occupied_readings = 0
    for row in readings:
        if row.line != "A" or row.stop != "first":
            continue
        all_readings += row.readings
        if row.status is None and row.percentage is None:
            continue
        occupied_readings += row.readings
        level = (
            "full"
            if row.status == 5 or (row.percentage or 0) >= 100
            else "empty"
            if row.status == 0
            else "75%"
        )
        seconds[level] += min(row.seconds, 60)
    assert seconds == {"full": 2440, "empty": 1200, "75%": 600}
    total = sum(seconds.values())
    evidence = answer["evidence"]
    assert answer["state"] == "measured"
    assert answer["value"]["crowding_full"] == seconds["full"] / total
    assert answer["value"]["crowding_empty"] == seconds["empty"] / total
    assert evidence["percentage_levels"][0]["share"] == seconds["75%"] / total
    assert evidence["counts"]["occupancy_vehicle_seconds"] == total
    assert evidence["counts"]["occupancy_readings"] == occupied_readings
    assert evidence["counts"]["readings"] == all_readings
    assert evidence["share_occupancy_readings"] == occupied_readings / all_readings
    assert evidence["excluded"]["capped_intervals"] == 40
    assert evidence["days_not_measured"] == [str(FRIDAY)]

    late_hour = _get(store, "/measure", "crowding", line="A", hour=8, day_type="weekday")
    assert late_hour["state"] == "too_few_to_judge"
    assert late_hour["evidence"]["counts"]["occupancy_vehicle_seconds"] == 30
    assert late_hour["evidence"]["share_occupancy_readings"] is None
    assert _get(store, "/measure", "crowding", line="A", direction=1)["state"] == "unknown"
    missing = _get(store, "/measure", "crowding", **{"from": FRIDAY, "to": FRIDAY})
    assert missing["state"] == "not_measured"
    untracked = _get(store, "/measure", "crowding", line="C")
    assert untracked["state"] == "not_tracked"
    assert all(value is None for value in untracked["value"].values())
    assert untracked["evidence"]["share_occupancy_readings"] == 0
    ranked = _get(store, "/ranking", "crowding_full", kind="line", **{"class": "all"})
    assert [row["id"] for row in ranked["rows"]] == ["A"]
    assert ranked["rows"][0]["value"] == seconds["full"] / (total + 50)
    assert ranked["rows"][0]["range"]["method"] == "occupancy_weighted_wilson_95"
    assert {row["id"]: row["reason"] for row in ranked["excluded"]} == {
        "B": "too_few_to_judge",
        "C": "not_tracked",
        "D": "not_tracked",
    }


def test_alert_counts_and_hours_match_independent_hour_sets(
    history: tuple[Store, list[Reading], dict[date, tuple[Notice, ...]]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, _, notices = history
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    first, end = utc(THURSDAY, 5), utc(SATURDAY, 5) + timedelta(days=1)
    occupied_hours: set[tuple[str, datetime]] = set()
    versions: set[tuple[str, str]] = set()
    for day, items in notices.items():
        for notice in items:
            for start, stop in notice.periods or ((None, None),):
                start = start or utc(day, 14)
                stop = stop or utc(day, 15 if notice.periods else 14)
                if start == stop and first <= start < end:
                    versions.add((notice.id, notice.version))
                for step in range((end - first) // timedelta(hours=1)):
                    tick = first + timedelta(hours=step)
                    if start <= tick < stop:
                        occupied_hours.add((notice.id, tick))
                        versions.add((notice.id, notice.version))
    assert len(occupied_hours) == 9
    answer = _get(store, "/measure", "alert_counts")
    assert answer["value"] == {
        "alerts": len({id_ for id_, _ in versions}),
        "alert_versions": len(versions),
        "alert_hours": len(occupied_hours),
    }
    assert answer["evidence"]["counts"]["alert_seconds"] == 9 * 3600
    cut = _get(
        store,
        "/measure",
        "alert_counts",
        line="A",
        stop="first",
        effect="DETOUR",
        cause="CONSTRUCTION",
        to=THURSDAY,
    )
    assert cut["value"] == {"alerts": 1, "alert_versions": 2, "alert_hours": 3.0}
    assert _get(store, "/measure", "alert_counts", line="C")["value"]["alerts"] == 0
    assert _get(store, "/measure", "alert_counts", stop="other")["value"]["alert_hours"] == 0
    line_rows = _get(store, "/ranking", "alert_hours", kind="line")["rows"]
    assert [(row["id"], row["value"]) for row in line_rows] == [
        ("A", 7),
        ("B", 4),
        ("D", 1),
        ("C", 0),
    ]
    assert line_rows[-1]["counts"]["alerts"] == 0
    stop_rows = _get(store, "/ranking", "alert_hours", kind="stop")["rows"]
    assert [(row["id"], row["value"]) for row in stop_rows] == [("first", 8), ("other", 0)]


def test_untracked_alerts_are_excluded_and_missing_archive_is_not_zero(
    history: tuple[Store, list[Reading], dict[date, tuple[Notice, ...]]],
) -> None:
    store, _, _ = history
    _not_tracked(store, SATURDAY)
    untracked = _get(store, "/measure", "alert_counts", **{"from": SATURDAY})
    assert untracked["state"] == "not_tracked"
    assert untracked["evidence"]["counts"]["alerts"] is None
    assert untracked["evidence"]["days_not_tracked"] == [str(SATURDAY)]
    all_untracked = _get(store, "/ranking", "alert_hours", kind="stop", **{"from": SATURDAY})
    assert all_untracked["state"] == "not_tracked"
    assert all_untracked["rows"] == []
    assert {row["reason"] for row in all_untracked["excluded"]} == {"not_tracked"}
    assert all(row["sample"] is None for row in all_untracked["excluded"])
    result = _get(store, "/ranking", "alert_hours", kind="line")
    assert [(row["id"], row["value"]) for row in result["rows"]] == [
        ("A", 3),
        ("B", 0),
        ("C", 0),
    ]
    assert [(row["id"], row["reason"]) for row in result["excluded"]] == [("D", "not_tracked")]
    missing = _get(store, "/measure", "alert_counts", **{"from": FRIDAY, "to": FRIDAY})
    assert missing["state"] == "not_measured"
    assert missing["value"]["alerts"] is None


def test_empty_alert_file_gives_zero_and_missing_tracked_file_does_not(
    history: tuple[Store, list[Reading], dict[date, tuple[Notice, ...]]],
) -> None:
    store, _, _ = history
    with duckdb.connect() as conn:
        path = Path(store.root) / "stm" / str(THURSDAY) / "v6" / ALERTS
        descriptions = conn.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]
        ).fetchall()
        schema = ", ".join(f"{name} {type_}" for name, type_, *_ in descriptions[3:])
        _write_table(conn, store, THURSDAY, ALERTS, schema, [])
    dates = {"from": THURSDAY, "to": THURSDAY}
    empty = _get(store, "/measure", "alert_counts", **dates)
    assert empty["state"] == "measured"
    assert empty["value"] == {"alerts": 0, "alert_versions": 0, "alert_hours": 0}
    path.unlink()
    missing = _get(store, "/measure", "alert_counts", **dates)
    assert missing["state"] == "not_measured"
    assert missing["value"]["alerts"] is None


@pytest.mark.parametrize("family", ["crowding", "alert_counts"])
def test_historical_methods_and_french_csv_use_the_same_registry(
    history: tuple[Store, list[Reading], dict[date, tuple[Notice, ...]]],
    family: str,
) -> None:
    store, _, _ = history
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = urlencode({"city": "stm", "from": THURSDAY, "to": SATURDAY, "measure": family})
    status, _, definition = asyncio.run(http(app, "/how-we-measure"))
    assert status == 200
    info = [item for item in json.loads(definition) if item["family"] == family]
    assert info == _get(store, "/measure", family)["info"]
    status, _, payload = asyncio.run(http(app, "/measure", params + "&format=csv&lang=fr"))
    assert status == 200
    rows = list(csv.reader(io.StringIO(payload.decode())))
    assert rows[0] == info[0]["csv_columns"]["fr"]
    assert [row[0] for row in rows[1:]] == [item["id"] for item in info]
