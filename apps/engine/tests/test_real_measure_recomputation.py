import asyncio
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import duckdb
import pytest
from plain_measures import DAY, Sample, recompute
from test_engine import http

from transit_engine.server import Engine
from transit_engine.store import Store

ROOT = Path(__file__).parent / "fixtures" / "real-measures"
CASES = {"stm": ("51", "41027"), "octranspo": ("75", "6417")}
MEASURES = (
    "service_delivered",
    "waiting_and_gaps",
    "crowding",
    "alert_counts",
    "vehicle_hours_in_service",
    "corridors",
    "accessibility",
    "poll_success",
)


@pytest.fixture(scope="module", params=tuple(CASES))
def sample(request: pytest.FixtureRequest) -> tuple[str, dict[str, Sample]]:
    city: str = request.param
    with duckdb.connect() as conn:
        return city, recompute(conn, ROOT / city / str(DAY) / "v11", *CASES[city])


async def ask(root: Path, city: str, measure: str) -> dict[str, Any]:
    line, vehicle = CASES[city]
    query = {"city": city, "from": str(DAY), "to": str(DAY), "measure": measure}
    if measure.startswith("vehicle_"):
        query["vehicle"] = vehicle
    elif measure != "poll_success":
        query["line"] = line
    engine = Engine(Store(root.as_posix(), 11), concurrency=1, queue_size=1, queue_wait_ms=100)
    status, headers, payload = await http(engine, "/measure", urlencode(query))
    assert status == 200, payload
    assert headers[b"x-transit-cleaning-version"] == b"11"
    answer: dict[str, Any] = json.loads(payload)
    assert answer["evidence"]["days_pending"] == []
    return answer


def check_fields(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    for key, value in expected.items():
        if isinstance(value, dict):
            check_fields(actual[key], value)
        elif isinstance(value, float):
            assert actual[key] == pytest.approx(value, abs=1e-8, rel=1e-12), key
        else:
            assert actual[key] == value, key


@pytest.mark.parametrize("measure", MEASURES)
def test_real_day_against_plain_recomputation(
    sample: tuple[str, dict[str, Sample]], measure: str
) -> None:
    city, plain = sample
    expected = plain[measure]
    actual = asyncio.run(ask(ROOT, city, measure))
    assert actual["state"] == expected.state
    values = expected.values.copy()
    if measure == "vehicle_hours_in_service":
        trips = asyncio.run(ask(ROOT, city, "vehicle_trips_run"))
        assert trips["state"] == expected.state
        assert trips["value"]["vehicle_trips_run"] == values.pop("vehicle_trips_run")
    check_fields(actual["value"], values)
    check_fields(actual["evidence"]["counts"], expected.counts)
