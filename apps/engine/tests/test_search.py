import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from test_engine import http

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
