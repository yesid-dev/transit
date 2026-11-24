import asyncio
import json
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from statistics import mean, median, quantiles
from typing import Any
from urllib.parse import urlencode

import duckdb
import pytest
from test_engine import FRIDAY, SUNDAY, THURSDAY, Poll, StopTiming, Trip, _build_store, http, query
from test_ranking import _json, _request

from transit_engine.clean_manifest import SEGMENT_RUNS, STOP_EVENTS
from transit_engine.corridors import SEGMENT_BIN_SECONDS
from transit_engine.server import Engine

STOPS = (
    StopTiming("from", -30, 0, "departure"),
    StopTiming("middle", 120, 150),
    StopTiming("to", 240, 270),
)


def _trip(
    line: str, index: int, delays: tuple[int | None, ...], minute: int = 0, **changes: Any
) -> Trip:
    return Trip(
        f"{line}-{index}",
        line,
        0,
        "ran",
        None,
        True,
        delays,
        minute,
        stop_times=STOPS[: len(delays)],
    )._replace(**changes)


def test_corridors_measure_series_and_rankings(tmp_path: Path) -> None:
    pattern = (-5, 18, 30, 65) * 6
    main = tuple(_trip("A", i, (75, 75 + loss, 79 + loss), 59) for i, loss in enumerate(pattern))
    rival = tuple(_trip("B", i, (0, 29), 59) for i in range(20))
    thin = _trip("A", 100, (0, 100), 59, direction=1)
    trips = (*main, *rival, thin)
    polls = tuple(Poll("trip_updates", second) for second in range(3480, 3961, 60))
    store = _build_store(
        tmp_path,
        6,
        dict.fromkeys((THURSDAY, SUNDAY), trips),
        dict.fromkeys((THURSDAY, SUNDAY), polls),
    )
    cut = {"line": "A", "direction": 0, "from_stop": "from", "to_stop": "middle"}
    measured = query(store, measure="corridors", **cut)
    assert measured["state"] == "measured"
    values = measured["value"]
    assert values["mean_time_lost"] == 27
    assert values["total_vehicle_minutes_lost"] == 10.8
    assert measured["evidence"]["counts"]["observed_runs"] == 24
    assert measured["evidence"]["counts"]["scheduled_seconds"] == 24 * 120
    assert measured["evidence"]["counts"]["observed_seconds"] == 24 * 120 + 648

    # Independently reconstruct the two clocks for each trip, then compare elapsed times.
    losses = []
    for trip in main:
        first, second = trip.stop_times[:2]
        delay_a, delay_b = trip.delays[:2]
        assert first.departure is not None and second.arrival is not None
        assert delay_a is not None and delay_b is not None
        scheduled_a = trip.offset_minutes * 60 + first.departure
        scheduled_b = trip.offset_minutes * 60 + second.arrival
        observed_a, observed_b = scheduled_a + delay_a, scheduled_b + delay_b
        losses.append((observed_b - observed_a) - (scheduled_b - scheduled_a))
    half_bin = (SEGMENT_BIN_SECONDS - 1) / 2
    assert values["median_time_lost"] == pytest.approx(median(losses), abs=half_bin)
    assert values["p90_time_lost"] == pytest.approx(
        quantiles(losses, n=10, method="inclusive")[-1], abs=half_bin
    )
    assert values["mean_time_lost"] == mean(losses)
    assert values["total_vehicle_minutes_lost"] == sum(losses) / 60

    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    request = {"measure": "corridors", "city": "stm", "from": THURSDAY, "to": SUNDAY, **cut}
    status, _, raw = asyncio.run(
        http(app, "/measure", urlencode({**request, "group": "weekday_hour"}))
    )
    assert status == 200
    cells = {(c["key"]["weekday"], c["key"]["hour"]): c for c in json.loads(raw)["cells"]}
    # Departure at 07:59, with the observation after 08:00.
    assert cells[4, 7]["value"] == cells[7, 7]["value"] == values
    assert cells[4, 8]["evidence"]["counts"]["observed_runs"] == 0
    assert cells[5, 7]["state"] == "not_measured"
    grouped = query(
        store, measure="total_vehicle_minutes_lost", end=SUNDAY, group="day_type", hour=7, **cut
    )
    assert [(c["key"]["day_type"], c["state"]) for c in grouped["cells"]] == [
        ("weekday", "measured"),
        ("saturday", "not_measured"),
        ("sunday", "measured"),
    ]
    combined = query(store, measure="corridors", end=SUNDAY, hour=7, **cut)
    assert combined["value"]["total_vehicle_minutes_lost"] == 21.6
    assert str(FRIDAY) in combined["evidence"]["days_not_measured"]

    ranked = _json(store, kind="segment")
    assert [row["id"] for row in ranked["rows"]] == [
        '["B",0,"from","middle"]',
        '["A",0,"from","middle"]',
        '["A",0,"middle","to"]',
    ]
    row = ranked["rows"][1]
    assert {key: row[key] for key in cut} == cut
    assert row["range"]["upper"] == row["value"] + half_bin
    assert [(row["direction"], row["reason"]) for row in ranked["excluded"]] == [
        (1, "too_few_to_judge")
    ]
    totals = _json(store, kind="segment", measure="total_vehicle_minutes_lost")
    assert [row["line"] for row in totals["rows"]] == ["A", "B", "A"]
    lines = _json(store, kind="line", measure="total_vehicle_minutes_lost", **{"class": "all"})
    assert [(row["id"], row["value"]) for row in lines["rows"]] == [
        ("A", (648 + 24 * 4 + 100) / 60),
        ("B", 20 * 29 / 60),
    ]
    ranked_cut = _json(
        store,
        kind="segment",
        **{key: str(value) for key, value in cut.items()},
        hour="7",
        day_type="weekday",
    )
    assert [r["id"] for r in ranked_cut["rows"]] == [row["id"]]
    lines_cut = _json(
        store,
        kind="line",
        measure="total_vehicle_minutes_lost",
        line="A",
        direction="0",
        **{"class": "all"},
    )
    assert [(r["id"], r["value"]) for r in lines_cut["rows"]] == [("A", (648 + 24 * 4) / 60)]
    assert _request(store, kind="segment", measure="on_time")[0] == 400
    assert _request(store, kind="segment", from_stop="from")[0] == 400
    status, _, exported = _request(store, kind="segment", format="csv", lang="fr")
    assert status == 200
    assert "Arrêt de départ" in exported.decode()


def test_corridor_exclusion_reasons_and_thresholds(tmp_path: Path) -> None:
    mixed = STOPS[1]._replace(basis="trip_update_passed")
    invalid = STOPS[1]._replace(arrival=0)
    passed = tuple(stop._replace(basis="trip_update_passed") for stop in STOPS[:2])
    stopped = tuple(stop._replace(event="arrival", basis="vehicle_stopped") for stop in STOPS[:2])
    trips = (
        _trip("A", 0, (0, None, 0)),
        _trip("A", 1, (0, 0), stop_times=(STOPS[0], mixed)),
        _trip("A", 2, (0, 0), stop_times=(STOPS[0], invalid)),
        _trip("A", 3, (0, -121)),
        _trip("A", 4, (0, 481)),
        _trip("A", 5, (0, 0), 10),
        _trip("A", 6, (0, 0), state="cancelled"),
        _trip("A", 7, (0, 0), state="not_measured", reason="capture_gap"),
        _trip("A", 8, (None, None), live=False),
        _trip("A", 9, (0, 480)),  # Exactly five scheduled run times.
        _trip("A", 10, (0, -120), stop_times=passed),  # Exactly zero observed seconds.
        _trip("A", 11, (0, 0), stop_times=stopped),
    )
    polls = tuple(
        Poll(feed, second, "error" if feed == "vehicle_positions" and 600 < second < 840 else "ok")
        for feed in ("trip_updates", "vehicle_positions")
        for second in range(-120, 961, 60)
    )
    store = _build_store(tmp_path, 6, {THURSDAY: trips}, {THURSDAY: polls})
    cut = {"from_stop": "from", "to_stop": "middle"}
    result = query(store, measure="corridors", **cut)
    assert result["state"] == "too_few_to_judge"
    assert all(value is None for value in result["value"].values())
    evidence = result["evidence"]
    assert evidence["counts"] == {
        "scheduled_runs": 12,
        "observed_runs": 3,
        "scheduled_seconds": 390,
        "observed_seconds": 750,
        "vehicle_stopped": 1,
        "vehicle_nearby": 0,
        "trip_update_reported": 1,
        "trip_update_passed": 1,
    }
    assert evidence["excluded"] == {
        "route_without_live_data": 1,
        "cancelled": 1,
        "capture_gap": 2,
        "missing_observation": 1,
        "incomparable_basis": 1,
        "invalid_scheduled_run": 1,
        "negative_observed_run": 1,
        "excessive_observed_run": 1,
    }
    assert evidence["share_observed"] == 0.30
    skipped = query(store, measure="corridors", from_stop="from", to_stop="to")
    assert skipped["evidence"]["counts"]["scheduled_runs"] == 0
    ranked = _json(store, kind="segment", **cut)
    assert ranked["excluded"][0]["excluded"] == evidence["excluded"]


@pytest.mark.parametrize("version", [12, 13])
def test_clean_segment_runs_match_legacy_corridors(tmp_path: Path, version: int) -> None:
    # Three observed cohorts exercise common coverage, a gap in one required feed,
    # and a static guard that must take precedence over a poll gap.
    trips = (
        *(_trip("A", i, (0, i % 3)) for i in range(30)),
        _trip("B", 0, (0, 25), 10),
        _trip("B", 1, (0, 481), 10),
        _trip("B", 2, (0, 0), 12),
        _trip("Rail", 0, (None, None), live=False),
    )
    polls = tuple(
        Poll(feed, second)
        for feed, seconds in (
            ("trip_updates", range(-60, 841, 60)),
            ("vehicle_positions", (-60, 0, 60, 120, 180, 720, 780, 840)),
        )
        for second in seconds
    )
    legacy = _build_store(tmp_path, 11, {THURSDAY: trips}, {THURSDAY: polls})
    clean = _build_store(tmp_path, version, {THURSDAY: trips}, {THURSDAY: polls})
    directory = tmp_path / "stm" / str(THURSDAY) / f"v{version}"
    start = datetime(2026, 11, 19, 12, tzinfo=UTC)
    rows: list[tuple[object, ...]] = [
        ("A", start, start, start + timedelta(seconds=120 + i % 3), 120 + i % 3, None)
        for i in range(30)
    ]
    later = start + timedelta(minutes=10)
    rows.extend([
        ("B", later, later, later + timedelta(seconds=145), 145, None),
        ("B", later, later, later + timedelta(seconds=601), 601, "excessive_observed_run"),
        ("B", later + timedelta(minutes=2), later + timedelta(minutes=2),
         later + timedelta(minutes=4), 120, None),
        ("Rail", start, None, None, None, "route_without_live_data"),
    ])
    with duckdb.connect() as conn:
        conn.execute("""
            CREATE TABLE facts (route_id VARCHAR, scheduled_departure_at TIMESTAMPTZ,
                observed_departure_at TIMESTAMPTZ, observed_arrival_at TIMESTAMPTZ,
                observed_run_seconds BIGINT, exclusion VARCHAR)
        """)
        conn.executemany("INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?)", rows)
        conn.execute("""
            COPY (
                SELECT 'stm' AS provider, ?::VARCHAR AS cleaning_version, ?::DATE AS service_date,
                    0 AS direction_id, 'from' AS from_stop, 'middle' AS to_stop,
                    CASE WHEN observed_run_seconds IS NULL THEN 'not_observed'
                        ELSE 'trip_update_reported' END AS from_basis,
                    CASE WHEN observed_run_seconds IS NOT NULL THEN 120 END
                        AS scheduled_run_seconds, *
                FROM facts
            ) TO ? (FORMAT PARQUET)
        """, [str(version), THURSDAY, str(directory / SEGMENT_RUNS)])
    payload = (directory / SEGMENT_RUNS).read_bytes()
    marker = directory / "manifest.json"
    receipt = json.loads(marker.read_bytes())
    receipt["files"][SEGMENT_RUNS] = {
        "rows": len(rows), "sha256": sha256(payload).hexdigest(), "byte_size": len(payload),
    }
    marker.write_text(json.dumps(receipt), encoding="utf-8")

    def stable(value: Any) -> Any:
        if isinstance(value, dict):
            return {
                key: stable(item) for key, item in value.items()
                if key not in {"query_ms", "cleaning_versions"}
            }
        if isinstance(value, list):
            return [stable(item) for item in value]
        return value

    for cut in ({}, {"line": "A", "direction": 0}, {"line": "B"}, {"line": "Rail"},
                {"hour": 7, "from_stop": "from", "to_stop": "middle"}):
        assert stable(query(clean, measure="corridors", **cut)) == stable(
            query(legacy, measure="corridors", **cut)
        )
    for cut in ({}, {"line": "A", "direction": "0"}):
        assert stable(_json(clean, kind="segment", **cut)) == stable(
            _json(legacy, kind="segment", **cut)
        )
    for line in ("A", "B", "Rail"):
        map_cut: dict[str, object] = {
            "measure": "mean_time_lost", "group": "segment", "map_view": True, "line": line,
        }
        assert stable(query(clean, **map_cut)) == stable(query(legacy, **map_cut))

    receipt["source_date"] = "2026-11-19"
    marker.write_text(json.dumps(receipt), encoding="utf-8")
    network = query(clean, measure="mean_time_lost", group="segment", map_view=True)
    assert "direction" not in network
    assert network["from_stop"] == ["from"]
    assert network["to_stop"] == ["middle"]
    assert network["lines"] == [["A", "B", "Rail"]]
    # B's final run is covered by both feeds. Its other runs cannot enter the mean.
    assert network["value"] == [30 / 31]
    assert network["sample"] == [31]
    assert network["state"] == [3]
    assert network["evidence"]["source_date"] == "2026-11-19"

    app = Engine(clean, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = {
        "city": "stm", "from": THURSDAY, "to": FRIDAY, "view": "map",
        "measure": "mean_time_lost", "group": "segment",
    }
    status, _, raw = asyncio.run(http(app, "/measure", urlencode(params)))
    assert status == 200
    partial = json.loads(raw)
    for column in ("from_stop", "to_stop", "state", "value", "sample", "lines"):
        assert partial[column] == network[column]
    assert partial["evidence"]["days_measured"] == [str(THURSDAY)]
    assert partial["evidence"]["days_not_measured"] == [str(FRIDAY)]
    assert partial["evidence"]["days_pending"] == [str(FRIDAY)]
    assert partial["evidence"]["source_date"] == network["evidence"]["source_date"]

    status, _, raw = asyncio.run(http(app, "/measure", urlencode({**params, "from": FRIDAY})))
    assert status == 200
    unmeasured = json.loads(raw)
    for column in ("from_stop", "to_stop", "state", "value", "sample", "lines"):
        assert unmeasured[column] == []
    assert unmeasured["evidence"]["days_not_measured"] == [str(FRIDAY)]
    assert "source_date" not in unmeasured["evidence"]

    friday_marker = directory.parent.parent / str(FRIDAY) / f"v{version}" / "manifest.json"
    friday_marker.parent.mkdir(parents=True)
    friday_marker.write_text(json.dumps({
        "provider": "stm",
        "service_date": str(FRIDAY),
        "cleaning_version": str(version),
        "built_at_utc": "2026-11-21T12:00:00+00:00",
        "status": "no_raw_captures",
    }), encoding="utf-8")
    status, _, raw = asyncio.run(http(app, "/measure", urlencode(params)))
    assert status == 200
    declared = json.loads(raw)
    assert declared["value"] == network["value"]
    assert declared["evidence"]["days_not_measured_reasons"] == {str(FRIDAY): "no_raw_captures"}
    assert declared["evidence"]["days_pending"] == []

    segment = directory / SEGMENT_RUNS
    segment.unlink()
    for mismatched in (False, True):
        if mismatched:
            segment.write_bytes(payload[:-1])
        status, _, raw = asyncio.run(http(app, "/measure", urlencode(params)))
        assert status == 409
        assert json.loads(raw)["reason"] == "segment_runs_missing"
    segment.write_bytes(payload)

    # The manifest's listed segment facts supply corridors while stop events are pending.
    (directory / STOP_EVENTS).unlink()
    result = query(clean, measure="corridors", line="A")
    assert result["state"] == "measured"
    assert result["evidence"]["counts"]["observed_runs"] == 30
    assert result["evidence"]["days_pending"] == [str(THURSDAY)]


def test_map_answers_keep_samples_and_non_value_states(tmp_path: Path) -> None:
    known = tuple(_trip("A", i, (360, 380)) for i in range(32))
    on_time = tuple(
        _trip("B", i, (0, 0), stop_times=(STOPS[0]._replace(stop_id="on-time"), STOPS[1]))
        for i in range(30)
    )
    thin = _trip("A", 33, (0, 40), direction=1)
    missing = _trip("A", 34, (None, None), direction=0, stop_times=STOPS[1:])
    rail = _trip("Rail", 1, (None, None), live=False)
    store = _build_store(
        tmp_path, 11, {THURSDAY: (*known, *on_time, thin, missing, rail)},
        {THURSDAY: tuple(Poll("trip_updates", second) for second in range(-120, 601, 60))},
    )
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    filters = {"city": "stm", "from": THURSDAY, "to": THURSDAY, "view": "map"}

    def ask_map(**params: Any) -> tuple[int, dict[str, Any]]:
        status, _, raw = asyncio.run(http(app, "/measure", urlencode({**filters, **params})))
        return status, json.loads(raw)

    status, stops = ask_map(measure="late", group="stop_id")
    assert status == 200
    stop_values = dict(zip(
        stops["stop"], zip(stops["state"], stops["value"], stops["sample"], strict=True),
        strict=True,
    ))
    assert stop_values["on-time"] == (3, 0, 30)
    assert stop_values["to"] == (0, None, 0)
    assert stop_values["from"] == (3, 970, 33)

    status, segments = ask_map(measure="mean_time_lost", group="segment", line="A")
    assert status == 200
    assert list(zip(
        segments["direction"], segments["from_stop"], segments["to_stop"],
        segments["state"], segments["value"], segments["sample"], strict=True,
    )) == [
        (0, "from", "middle", 3, 20.0, 32),
        (0, "middle", "to", 0, None, 0),
        (1, "from", "middle", 1, None, 1),
    ]
    status, direction = ask_map(measure="mean_time_lost", group="segment", line="A", direction=1)
    assert status == 200
    assert direction["direction"] == [1]
    status, rail_segments = ask_map(measure="mean_time_lost", group="segment", line="Rail")
    assert status == 200
    assert rail_segments["state"] == [2]
    assert rail_segments["value"] == [None]
    status, refusal = ask_map(measure="mean_time_lost", group="segment")
    assert status == 409
    assert refusal["reason"] == "segment_runs_version_required"
    assert ask_map(measure="mean_time_lost", group="segment", direction=0)[0] == 400
    assert ask_map(measure="late", group="stop_id", format="csv")[0] == 400
