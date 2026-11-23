import asyncio
import json
from datetime import UTC, date, datetime, timedelta, tzinfo
from pathlib import Path
from typing import Self
from zoneinfo import ZoneInfo

import pytest
from test_engine import Trip, _build_store, http
from test_historical_measures import _write_table

from transit_engine import search
from transit_engine.clean_manifest import TRIP_DAYS, VEHICLE_POSITIONS
from transit_engine.server import Engine
from transit_engine.store import Store


def test_search_reads_latest_edition_for_a_declared_public_city(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    declarations = tmp_path / "providers"
    declarations.mkdir()
    (declarations / "demo.yaml").write_text(
        "stage: public\ntimezone: America/Toronto\noverrides:\n  stable_vehicle_ids: false\n",
        encoding="utf8",
    )
    monkeypatch.setenv("ENGINE_PROVIDER_DECLARATIONS", str(declarations))
    latest = datetime.now(UTC).astimezone(ZoneInfo("America/Toronto")).date() - timedelta(days=1)
    store = Store(str(tmp_path))
    for age in (1, 2):
        day = latest - timedelta(days=age)
        directory = tmp_path / "search" / "v1" / "demo" / str(day)
        directory.mkdir(parents=True)
        (directory / f"v{store.cleaning_version}.json").write_text(
            json.dumps(
                {
                    "date": str(day),
                    "routes": [],
                    "stops": [],
                    "route_directions": {"L1": [{"dir": 0, "headsign": "Terminus"}]},
                }
            ),
            encoding="utf8",
        )

    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=10)
    status, _, body = asyncio.run(http(app, "/search-index", "city=demo"))
    assert status == 200
    assert json.loads(body) == {
        "schedule": {"date": str(latest - timedelta(days=1)), "routes": [], "stops": []},
        "vehicles": None,
        "vehicle_state": "not_tracked",
    }
    for invalid in ("city=unknown", "city=demo&city=demo", "city=demo&q=text"):
        assert asyncio.run(http(app, "/search-index", invalid))[0] == 400
    status, _, body = asyncio.run(http(app, "/schedule-index", "city=demo"))
    assert status == 200
    assert json.loads(body)["schedule"]["route_directions"] == {
        "L1": [{"dir": 0, "headsign": "Terminus"}]
    }


def test_search_keeps_only_stable_ids_with_in_service_evidence_in_the_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    end = date(2026, 11, 22)

    class Clock(datetime):
        @classmethod
        def now(cls, tz: tzinfo | None = None) -> Self:
            # Noon UTC is on the same date in the provider time zone.
            tomorrow = end + timedelta(days=1)
            return cls(tomorrow.year, tomorrow.month, tomorrow.day, 12, tzinfo=UTC).astimezone(tz)

    monkeypatch.setattr(search, "datetime", Clock)
    readings: dict[date, list[tuple[str, str | None, int]]] = {
        end: [("shared", "trip", 3), ("recent", "trip", 2), ("idle", None, 5)],
        end - timedelta(days=6): [("shared", "trip", 2), ("earlier", "trip", 2)],
        end - timedelta(days=2): [("transient", "trip", 1)],
        end - timedelta(days=7): [("outside", "trip", 3)],
        end - timedelta(days=14): [("unstable", "trip", 1)],
    }
    store = _build_store(
        tmp_path, 6, dict.fromkeys(readings, (Trip("trip", "A", 0, "ran", None, True, (0,)),))
    )
    with store.connect() as conn:
        for day, rows in readings.items():
            _write_table(
                conn,
                store,
                day,
                TRIP_DAYS,
                "trip_id VARCHAR, state VARCHAR, vehicle_id VARCHAR",
                [("trip", "ran", None)],
            )
            _write_table(
                conn,
                store,
                day,
                VEHICLE_POSITIONS,
                "vehicle_id VARCHAR, trip_id VARCHAR, readings BIGINT",
                rows,
            )

    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=10)
    for day, state, vehicles in (
        (end, "ready", [{"id": "earlier"}, {"id": "recent"}, {"id": "shared"}]),
        (end - timedelta(days=14), "not_tracked", None),
        (end + timedelta(days=7), "unavailable", None),
    ):
        end = day
        status, _, body = asyncio.run(http(app, "/search-index", "city=stm"))
        assert status == 200
        assert json.loads(body) == {"schedule": None, "vehicles": vehicles, "vehicle_state": state}
