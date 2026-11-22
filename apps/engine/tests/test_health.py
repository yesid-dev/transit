import asyncio
import json
from datetime import date, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any, Never, cast
from urllib.parse import urlencode

import pytest
from uvicorn._types import ASGISendEvent, HTTPScope

from transit_engine.clean_manifest import (
    ALERTS,
    FEED_POLLS,
    SCHEDULED_STOP_TIMES,
    STOP_EVENTS,
    TRIP_DAYS,
    VEHICLE_POSITIONS,
)
from transit_engine.health import MAX_DAYS, data_health
from transit_engine.server import Engine
from transit_engine.store import Store

DAY = date(2026, 11, 19)
TABLE_NAMES = (
    "stop_events",
    "trip_days",
    "scheduled_stop_times",
    "vehicle_positions",
    "feed_polls",
    "alerts",
)
ROWS = {
    STOP_EVENTS: 3,
    TRIP_DAYS: 2,
    SCHEDULED_STOP_TIMES: 5,
    VEHICLE_POSITIONS: 4,
    FEED_POLLS: 6,
    ALERTS: 0,
}


def clean_day(
    root: Path,
    day: date,
    *,
    version: int = 6,
    alerts: str = "tracked",
    rows: dict[str, int] | None = None,
) -> Path:
    directory = root / "stm" / day.isoformat() / f"v{version}"
    directory.mkdir(parents=True)
    table_rows = {**ROWS, **(rows or {})}
    tables = [STOP_EVENTS, TRIP_DAYS]
    if version in {4, 5, 6}:
        tables += [SCHEDULED_STOP_TIMES, VEHICLE_POSITIONS, FEED_POLLS]
    if alerts == "tracked":
        tables.append(ALERTS)
    files: dict[str, dict[str, int | str]] = {}
    for name in tables:
        payload = f"{name}:{day}".encode()
        (directory / name).write_bytes(payload)
        files[name] = {
            "rows": table_rows[name],
            "byte_size": len(payload),
            "sha256": sha256(payload).hexdigest(),
        }
    manifest: dict[str, Any] = {
        "provider": "stm",
        "service_date": day.isoformat(),
        "cleaning_version": str(version),
        "schedule_sha256": "a" * 64,
        "built_at_utc": f"{day}T06:30:00+00:00",
        "builder_git_commit": None,
        "files": files,
        "row_counts_by_basis": {"trip_update_reported": table_rows[STOP_EVENTS]},
        "row_counts_by_state": {"ran": table_rows[TRIP_DAYS]},
    }
    if alerts == "not_tracked":
        manifest["alerts"] = "not_tracked"
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return directory


def test_present_day_reports_each_table_and_its_rows(tmp_path: Path) -> None:
    clean_day(tmp_path, DAY)
    result = data_health(Store(tmp_path.as_posix()), "stm", DAY, DAY)
    assert result["city"] == "stm"
    assert result["from"] == result["to"] == DAY.isoformat()
    assert result["cleaning_version"] == "6"
    [entry] = result["days"]
    assert entry["service_date"] == DAY.isoformat()
    assert entry["status"] == "present"
    assert "reason" not in entry
    assert entry["cleaning_version"] == "6"
    assert entry["built_at_utc"] == f"{DAY}T06:30:00+00:00"
    assert list(entry["tables"]) == list(TABLE_NAMES)
    assert entry["tables"]["stop_events"] == {"status": "present", "rows": 3}
    assert entry["tables"]["trip_days"] == {"status": "present", "rows": 2}
    assert entry["tables"]["alerts"] == {"status": "present", "rows": 0}


def test_no_manifest_is_a_missing_day(tmp_path: Path) -> None:
    result = data_health(Store(tmp_path.as_posix()), "stm", DAY, DAY)
    [entry] = result["days"]
    assert entry["status"] == "missing"
    assert entry["reason"] == "no_manifest"
    assert entry["cleaning_version"] == "6"
    assert entry["built_at_utc"] is None
    assert set(entry["tables"]) == set(TABLE_NAMES)
    assert {table["status"] for table in entry["tables"].values()} == {"missing"}


@pytest.mark.parametrize("damage", ["json", "service_date"])
def test_invalid_manifest_is_a_missing_day(tmp_path: Path, damage: str) -> None:
    directory = clean_day(tmp_path, DAY)
    marker = directory / "manifest.json"
    if damage == "json":
        marker.write_bytes(b"{")
    else:
        manifest = json.loads(marker.read_bytes())
        manifest["service_date"] = (DAY - timedelta(days=1)).isoformat()
        marker.write_text(json.dumps(manifest), encoding="utf-8")
    [entry] = data_health(Store(tmp_path.as_posix()), "stm", DAY, DAY)["days"]
    assert entry["status"] == "missing"
    assert entry["reason"] == "invalid_manifest"
    assert {table["status"] for table in entry["tables"].values()} == {"missing"}


def test_untracked_alerts_are_reported_without_a_file(tmp_path: Path) -> None:
    clean_day(tmp_path, DAY, alerts="not_tracked")
    [entry] = data_health(Store(tmp_path.as_posix()), "stm", DAY, DAY)["days"]
    assert entry["status"] == "present"
    assert entry["tables"]["alerts"] == {"status": "not_tracked"}
    assert entry["tables"]["stop_events"] == {"status": "present", "rows": 3}


@pytest.mark.parametrize("damage", ["deleted", "size"])
def test_a_damaged_listed_file_makes_the_day_incomplete(tmp_path: Path, damage: str) -> None:
    directory = clean_day(tmp_path, DAY)
    if damage == "deleted":
        (directory / TRIP_DAYS).unlink()
    else:
        (directory / STOP_EVENTS).write_bytes(b"x")
    [entry] = data_health(Store(tmp_path.as_posix()), "stm", DAY, DAY)["days"]
    assert entry["status"] == "incomplete"
    assert entry["tables"]["scheduled_stop_times"]["status"] == "present"
    if damage == "deleted":
        assert entry["tables"]["trip_days"] == {"status": "missing", "reason": "file_missing"}
        assert entry["tables"]["stop_events"]["status"] == "present"
    else:
        assert entry["tables"]["stop_events"] == {
            "status": "missing",
            "reason": "size_mismatch",
        }
        assert entry["tables"]["trip_days"]["status"] == "present"


def test_a_range_with_a_gap_lists_each_day(tmp_path: Path) -> None:
    clean_day(tmp_path, DAY)
    clean_day(tmp_path, DAY + timedelta(days=2))
    days = data_health(Store(tmp_path.as_posix()), "stm", DAY, DAY + timedelta(days=2))["days"]
    assert [entry["service_date"] for entry in days] == [
        (DAY + timedelta(days=offset)).isoformat() for offset in range(3)
    ]
    assert [entry["status"] for entry in days] == ["present", "missing", "present"]
    assert days[1]["reason"] == "no_manifest"
    assert days[2]["tables"]["stop_events"]["status"] == "present"


def test_the_range_is_limited_to_400_days(tmp_path: Path) -> None:
    clean_day(tmp_path, DAY)
    store = Store(tmp_path.as_posix())
    days = data_health(store, "stm", DAY, DAY + timedelta(days=MAX_DAYS - 1))["days"]
    assert len(days) == MAX_DAYS
    with pytest.raises(ValueError, match="at most 400 days"):
        data_health(store, "stm", DAY, DAY + timedelta(days=MAX_DAYS))
    with pytest.raises(ValueError, match="ordered service date range"):
        data_health(store, "stm", DAY + timedelta(days=1), DAY)


@pytest.mark.parametrize("city", ["", "STM", "../stm", "stm/east"])
def test_an_invalid_city_is_rejected(tmp_path: Path, city: str) -> None:
    with pytest.raises(ValueError, match="invalid city"):
        data_health(Store(tmp_path.as_posix()), city, DAY, DAY)


async def get(
    app: Engine, path: str, query_string: str = ""
) -> tuple[int, dict[bytes, bytes], bytes]:
    scope = cast(
        HTTPScope,
        {"type": "http", "method": "GET", "path": path, "query_string": query_string.encode()},
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


def test_route_returns_json_and_rejects_bad_parameters(tmp_path: Path) -> None:
    clean_day(tmp_path, DAY)
    app = Engine(Store(tmp_path.as_posix()), concurrency=1, queue_size=1, queue_wait_ms=50)
    params = urlencode({"city": "stm", "from": DAY, "to": DAY})

    async def run() -> None:
        status, headers, body = await get(app, "/data-health", params)
        assert status == 200
        assert headers[b"content-type"] == b"application/json"
        payload = json.loads(body)
        assert payload["cleaning_version"] == "6"
        assert payload["days"][0]["status"] == "present"
        for query in (
            params + "&format=csv",
            urlencode({"city": "STM", "from": DAY, "to": DAY}),
            urlencode({"city": "stm", "from": DAY}),
            urlencode({"city": "stm", "from": DAY, "to": DAY - timedelta(days=1)}),
            urlencode({"city": "stm", "from": DAY, "to": DAY + timedelta(days=MAX_DAYS)}),
            urlencode({"city": "stm", "from": "20261119", "to": DAY}),
        ):
            status, _, body = await get(app, "/data-health", query)
            assert status == 400
            assert json.loads(body)["message"]

    asyncio.run(run())
