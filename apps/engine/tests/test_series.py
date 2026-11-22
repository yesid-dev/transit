import asyncio
import csv
import io
import json
import math
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlencode

import pytest
from test_engine import FALL_BACK, FRIDAY, THURSDAY, Trip, _build_store, http, query
from test_engine import store as store

from transit_engine import measures
from transit_engine.server import Engine
from transit_engine.store import Store


def _quantile(delays: list[int], fraction: float) -> float:
    delays = sorted(delays)
    rank = (len(delays) - 1) * fraction
    lo, hi = math.floor(rank), math.ceil(rank)
    return delays[lo] + (delays[hi] - delays[lo]) * (rank - lo)


def test_day_series_matches_plain_python_and_preserves_missing_days(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    start = date(2026, 11, 23)
    days = [start + timedelta(days=index) for index in range(7)]
    trips: dict[date, tuple[Trip, ...]] = {
        day: (
            Trip("main", "A", 0, "ran", None, True, tuple(range(-115, 435, 13 + offset))),
            Trip("thin", "A", 1, "ran", None, True, (23, 42, None), 60),
        )
        for offset, day in enumerate(days)
        if offset != 2
    }
    store = _build_store(tmp_path, 6, trips)
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 2)
    scope = {"start": start, "end": days[-1], "line": "A"}
    series = query(store, **scope, group="day")
    cells = series["cells"]
    assert [cell["key"] for cell in cells] == [{"day": str(day)} for day in days]
    assert series["evidence"]["days_not_measured"] == [str(days[2])]
    for day, cell in zip(days, cells, strict=True):
        if day not in trips:
            assert cell["state"] == "not_measured"
            assert cell["value"]["on_time"] is None
            assert cell["evidence"]["counts"]["classified"] is None
            continue
        delays = [delay for trip in trips[day] for delay in trip.delays if delay is not None]
        counts = cell["evidence"]["counts"]
        assert cell["state"] == "measured"
        assert counts["classified"] == len(delays)
        assert counts["scheduled"] == sum(len(trip.delays) for trip in trips[day])
        assert cell["value"]["on_time"] == sum(-60 <= d <= 300 for d in delays) / len(delays)
        assert cell["value"]["median_delay"] == pytest.approx(_quantile(delays, 0.5), abs=7.5)
        assert cell["value"]["p90_delay"] == pytest.approx(_quantile(delays, 0.9), abs=7.5)

    ungrouped = query(store, **scope)["evidence"]["counts"]
    for label, count in ungrouped.items():
        assert sum(cell["evidence"]["counts"][label] or 0 for cell in cells) == count
    for group, count, key in (
        ("hour", 24, {"hour": 7}),
        ("weekday_hour", 168, {"weekday": 1, "hour": 7}),
        ("day_type", 3, {"day_type": "weekday"}),
        ("direction", 2, {"direction": 0}),
    ):
        grouped = query(store, **scope, group=group)["cells"]
        assert len(grouped) == len({tuple(cell["key"].items()) for cell in grouped}) == count
        assert next(cell for cell in grouped if cell["key"] == key)["state"] == "measured"
        assert (
            sum(cell["evidence"]["counts"]["classified"] or 0 for cell in grouped)
            == (ungrouped["classified"])
        )
    hour = query(store, **scope, group="hour")["cells"][8]
    assert hour["evidence"]["counts"]["classified"] == 12
    assert hour["state_text"]["en"] == "Too few to judge"
    assert hour["value"]["on_time"] is None
    grid = query(store, **scope, group="weekday_hour")["cells"]
    assert grid[2 * 24 + 7]["state"] == "not_measured"


def test_grid_keeps_after_midnight_event_on_its_service_weekday(store: Store) -> None:
    grid = query(store, start=FALL_BACK, end=FALL_BACK, group="weekday_hour")["cells"]
    cell = grid[6 * 24 + 1]
    assert cell["key"] == {"weekday": 7, "hour": 1}
    assert cell["evidence"]["counts"]["classified"] == 68
    assert (
        cell["value"]["on_time"]
        == query(store, start=FALL_BACK, end=FALL_BACK, hour=1)["value"]["on_time"]
    )


@pytest.mark.parametrize("measure", ["on_time", "punctuality"])
def test_series_csv_has_one_row_per_cell_with_registry_headings(store: Store, measure: str) -> None:
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    params = urlencode(
        {"city": "stm", "from": THURSDAY, "to": FRIDAY, "measure": measure, "group": "day"}
    )
    status, _, raw = asyncio.run(http(app, "/measure", params))
    assert status == 200, raw
    status, _, raw_csv = asyncio.run(http(app, "/measure", params + "&format=csv&lang=fr"))
    assert status == 200, raw_csv
    reader = csv.DictReader(io.StringIO(raw_csv.decode()))
    assert reader.fieldnames == json.loads(raw)["info"][0]["csv_columns"]["fr"]
    measured, missing = list(reader)
    assert missing["Date de service"] == str(FRIDAY)
    if measure == "on_time":
        assert measured["État"] == "Mesuré"
        assert missing["État"] == "Non mesuré"
        assert missing["Valeur"] == ""
    else:
        assert json.loads(missing["État"])["on_time"] == "Non mesuré"
        assert json.loads(missing["Valeur"])["on_time"] is None


def test_stop_series_orders_by_direction_and_scheduled_sequence(tmp_path: Path) -> None:
    trips = tuple(
        Trip(f"trip-{index}", "A", 0, "ran", None, True, (0,) * 9 + (345,)) for index in range(30)
    ) + (
        Trip("reverse", "A", 1, "ran", None, True, (0,)),
        Trip("other-line", "B", 0, "ran", None, True, (600,) * 11),
    )
    store = _build_store(tmp_path, 6, {THURSDAY: trips})
    cells = query(store, start=THURSDAY, end=THURSDAY, line="A", group="stop")["cells"]
    assert [(cell["key"]["direction"], cell["key"]["stop_sequence"]) for cell in cells] == [
        *((0, index) for index in range(1, 11)),
        (1, 1),
    ]
    assert cells[0]["key"]["stop"] == "first"
    assert cells[0]["value"]["late"] == 0
    assert cells[9]["value"]["late"] == 1
    assert cells[9]["evidence"]["counts"]["classified"] == 30
    assert cells[-1]["state"] == "too_few_to_judge"
    cut = query(store, start=THURSDAY, end=THURSDAY, line="A", direction=1, group="stop")
    assert cut["cells"] == [cells[-1]]


def test_line_departure_series_and_ranking_apply_the_same_cuts(store: Store) -> None:
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    base = urlencode({"city": "stm", "from": THURSDAY, "to": THURSDAY})
    cut = base + "&line=A&direction=0"
    status, _, raw = asyncio.run(http(app, "/measure", cut + "&measure=trips_run&group=departure"))
    assert status == 200, raw
    (cell,) = json.loads(raw)["cells"]
    assert cell["key"] == {"direction": 0, "departure": "07:00:00"}
    assert cell["evidence"]["counts"]["cancelled"] == 1
    assert cell["evidence"]["counts"]["missing"] == 1
    assert cell["evidence"]["counts"]["scheduled"] == 3
    assert cell["state"] == "too_few_to_judge"
    status, _, raw = asyncio.run(http(app, "/ranking", cut + "&kind=departure&measure=late"))
    assert status == 200, raw
    (row,) = json.loads(raw)["rows"]
    assert (row["line"], row["direction"], row["departure"]) == ("A", 0, "07:00:00")
    assert row["counts"]["late"] == 8
    assert row["sample"] == 32


@pytest.mark.parametrize(
    "suffix",
    [
        "measure=on_time&group=stop",
        "measure=trips_run&group=stop&line=A",
        "measure=on_time&group=departure&line=A",
    ],
)
def test_line_series_rejects_unsupported_cuts(store: Store, suffix: str) -> None:
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    base = urlencode({"city": "stm", "from": THURSDAY, "to": THURSDAY})
    status, _, _ = asyncio.run(http(app, "/measure", base + "&" + suffix))
    assert status == 400
