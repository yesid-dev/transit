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
from transit_engine.cities import service_query
from transit_engine.series import LOCAL_HOUR, local_hour_sql
from transit_engine.server import Engine
from transit_engine.store import Store


def test_delay_distribution_http_csv_and_catalog(store: Store) -> None:
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    params = urlencode({
        "city": "stm",
        "from": THURSDAY,
        "to": THURSDAY,
        "measure": "delay_distribution",
        "format": "csv",
        "lang": "fr",
    })
    status, _, body = asyncio.run(http(app, "/measure", params))
    assert status == 200
    rows = list(csv.DictReader(io.StringIO(body.decode())))
    assert len(rows) == 22
    assert rows[0]["Écart minimal (s)"] == ""
    assert rows[0]["Écart maximal (s)"] == "-301"
    assert rows[-1]["Écart minimal (s)"] == "900"
    assert rows[-1]["Écart maximal (s)"] == ""
    classified = query(store)["evidence"]["counts"]["classified"]
    assert sum(int(row["Passages aux arrêts"]) for row in rows) == classified
    entry = next(entry for entry in measures.methods() if entry["id"] == "delay_distribution")
    assert entry["family"] == "punctuality"
    assert entry["csv_columns"]["fr"] == list(rows[0])


@pytest.mark.parametrize("version", [8, 10])
def test_delay_distribution_partitions_classified_events(tmp_path: Path, version: int) -> None:
    delays = (-500, -301, -300, -61, -60, -1, 0, 240, 299, 300, 301, 899, 900, None)
    main = Trip("main", "A", 0, "ran", None, True, delays, stop_ids=("S1",) * len(delays))
    trips = (
        *(main._replace(id=f"sample-{index}") for index in range(5)),
        main._replace(id="opposite", direction=1, delays=(301,) * len(delays)),
        main._replace(id="other", line="B", delays=(0,) * len(delays)),
        main._replace(id="added", state="added"),
        main._replace(id="cancelled", state="cancelled"),
    )
    store = _build_store(tmp_path, version, {THURSDAY: trips})
    for cuts in ({}, {"line": "A"}, {"line": "A", "direction": 0}, {"stop": "S1"}):
        timing = query(store, **cuts)
        distribution = query(store, measure="delay_distribution", **cuts)
        assert distribution["state"] == timing["state"] == "measured"
        assert distribution["group"] == "delay_minute"
        assert distribution["info"][0]["method_version"] == timing["info"][0]["method_version"]
        counts = timing["evidence"]["counts"]
        assert distribution["evidence"]["counts"] == counts
        bins = distribution["cells"]
        assert len(bins) == 22
        assert sum(cell["value"]["delay_distribution"] for cell in bins) == pytest.approx(1)
        for band in ("early", "on_time", "late"):
            assert (
                sum(cell["value"]["stop_events"] for cell in bins if cell["key"]["band"] == band)
                == counts[band]
            )
        if "direction" in cuts:
            by_bounds = {
                (cell["key"]["min_seconds"], cell["key"]["max_seconds"]):
                cell["value"]["stop_events"]
                for cell in bins
            }
            assert by_bounds[(None, -301)] == 10
            assert by_bounds[(-60, -1)] == 10
            assert by_bounds[(240, 300)] == 15
            assert by_bounds[(301, 359)] == 5
            assert by_bounds[(900, None)] == 5


@pytest.mark.parametrize(
    ("delays", "state"),
    [
        ((0,) * 10, "too_few_to_judge"),
        ((0,) * 30 + (None,) * 91, "not_measured"),
        ((0,) * 30, "measured"),
    ],
)
def test_delay_distribution_uses_punctuality_coverage(
    tmp_path: Path, delays: tuple[int | None, ...], state: str
) -> None:
    store = _build_store(tmp_path, 10, {THURSDAY: (Trip("a", "A", 0, "ran", None, True, delays),)})
    scope = {"start": THURSDAY, "end": FRIDAY}
    timing = query(store, **scope)
    answer = query(store, measure="delay_distribution", **scope)
    assert answer["state"] == timing["state"] == state
    assert answer["coverage_note"] == timing["coverage_note"]
    assert bool(answer["cells"]) == (state == "measured")


def _quantile(delays: list[int], fraction: float) -> float:
    delays = sorted(delays)
    rank = (len(delays) - 1) * fraction
    lo, hi = math.floor(rank), math.ceil(rank)
    return delays[lo] + (delays[hi] - delays[lo]) * (rank - lo)


def test_local_hour_keeps_timezone_semantics(store: Store) -> None:
    with service_query(store, "stm") as conn:
        fast = local_hour_sql(conn, "ts", date(2026, 3, 1), date(2026, 11, 2))
        standard = LOCAL_HOUR.format("ts")
        differences = conn.execute(
            f"""
            SELECT count(*)
            FROM (
                SELECT ts FROM generate_series(
                    TIMESTAMPTZ '2026-02-26 00:00:00+00',
                    TIMESTAMPTZ '2026-11-06 00:00:00+00',
                    INTERVAL '15 minutes'
                ) data(ts)
                UNION ALL SELECT NULL
            )
            WHERE ({fast}) IS DISTINCT FROM ({standard})
            """
        ).fetchall()
    assert differences == [(0,)]


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


@pytest.mark.parametrize("cleaning_version", [8, 9])
def test_hourly_coverage_counts_scheduled_stops_on_lines_with_live_data(
    tmp_path: Path, cleaning_version: int
) -> None:
    observed = (301,) * 10 + (0,) * 30
    store = _build_store(
        tmp_path,
        cleaning_version,
        {
            THURSDAY: (
                Trip("at-floor", "A", 0, "ran", None, True, observed + (None,) * 120),
                Trip(
                    "below-floor",
                    "A",
                    0,
                    "ran",
                    None,
                    True,
                    observed + (None,) * 121,
                    offset_minutes=60,
                ),
                *(
                    Trip(
                        f"no-live-{offset}",
                        "B",
                        0,
                        "not_measured",
                        "route_without_live_data",
                        False,
                        (None,) * 20,
                        offset_minutes=offset,
                    )
                    for offset in (0, 60, 120)
                ),
            ),
        },
    )
    cells = query(store, measure="late", group="hour")["cells"][7:10]
    assert [cell["evidence"]["excluded"]["route_without_live_data"] for cell in cells] == [20] * 3
    assert [cell["evidence"]["counts"]["scheduled"] for cell in cells] == [160, 161, 0]
    assert [cell["evidence"]["share_observed"] for cell in cells] == [0.25, 40 / 161, None]
    assert [cell["state"] for cell in cells] == ["measured", "not_measured", "no_live_data"]
    assert [cell["value"]["late"] for cell in cells] == [0.25, None, None]


def test_grid_keeps_after_midnight_event_on_its_service_weekday(store: Store) -> None:
    grid = query(store, start=FALL_BACK, end=FALL_BACK, group="weekday_hour")["cells"]
    cell = grid[6 * 24 + 1]
    assert cell["key"] == {"weekday": 7, "hour": 1}
    assert cell["evidence"]["counts"]["classified"] == 68
    assert (
        cell["value"]["on_time"]
        == query(store, start=FALL_BACK, end=FALL_BACK, hour=1)["value"]["on_time"]
    )


@pytest.mark.parametrize("version", [8, 9])
def test_stop_by_line_matches_individual_line_cuts_and_exports_csv(
    tmp_path: Path, version: int
) -> None:
    trips = tuple(
        Trip(f"a-{index}", "A", index % 2, "ran", None, True, (0,), stop_ids=("S1",))
        for index in range(32)
    )
    thin = Trip("b", "B", 0, "ran", None, True, (359,), stop_ids=("S1",))
    elsewhere = thin._replace(id="c", line="C", stop_ids=("S2",))
    store = _build_store(tmp_path, version, {THURSDAY: (*trips, thin, elsewhere)})
    scope = {"start": THURSDAY, "end": FRIDAY, "stop": "S1", "measure": "on_time"}
    cells = query(store, **scope, group="line")["cells"]
    assert [(row["key"]["line"], row["state"]) for row in cells] == [
        ("A", "measured"),
        ("B", "too_few_to_judge"),
    ]
    for row in cells:
        expected = query(store, **scope, line=row["key"]["line"])
        assert row["value"] == expected["value"]
        assert row["evidence"]["counts"] == expected["evidence"]["counts"]
    assert cells[0]["evidence"]["counts"]["classified"] == 32

    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    parameters = urlencode(
        {
            "city": "stm",
            "from": THURSDAY,
            "to": FRIDAY,
            "stop": "S1",
            "measure": "on_time",
            "group": "line",
            "format": "csv",
            "lang": "fr",
        }
    )
    status, _, body = asyncio.run(http(app, "/measure", parameters))
    assert status == 200
    good, thin_csv = csv.DictReader(io.StringIO(body.decode()))
    assert good["Identifiant de la ligne"] == "A"
    assert thin_csv["Identifiant de la ligne"] == "B"
    assert thin_csv["Valeur"] == ""


@pytest.mark.parametrize("version", [8, 9])
def test_finder_groups_match_individual_line_and_stop_cuts(tmp_path: Path, version: int) -> None:
    trips = tuple(
        Trip(f"a-{index}", "A", index % 2, "ran", None, True, (index * 12,), stop_ids=("S1",))
        for index in range(32)
    )
    thin = Trip("b", "B", 0, "ran", None, True, (359,), stop_ids=("S1",))
    no_live = Trip(
        "n", "N", 0, "unconfirmed", "route_without_live_data", False, (None,), stop_ids=("S2",)
    )
    added = Trip("extra", "A", 0, "added", None, True, (0,), stop_ids=("S3",))
    store = _build_store(tmp_path, version, {THURSDAY: (*trips, thin, no_live, added)})
    for measure, group, cut in (
        ("on_time", "line", "line"),
        ("trips_run", "line", "line"),
        ("on_time", "stop_id", "stop"),
    ):
        answer = query(store, start=THURSDAY, end=FRIDAY, measure=measure, group=group)
        assert answer["evidence"]["days_included"] == [str(THURSDAY)]
        assert answer["evidence"]["cleaning_versions"] == [version]
        assert len(answer["cells"]) == (2 if cut == "stop" else 3)
        for cell in answer["cells"]:
            single = query(store, start=THURSDAY, end=FRIDAY, measure=measure, **cell["key"])
            assert cell["state"] == single["state"]
            assert cell["value"] == single["value"]
            assert cell["evidence"]["counts"] == single["evidence"]["counts"]
            if cut == "stop":
                assert "days_included" not in cell["evidence"]
        assert answer["cells"][-1]["state"] == "no_live_data"
    stop_csv = measures.answer_csv(answer, "fr")
    assert [row["Identifiant de l’arrêt"] for row in csv.DictReader(io.StringIO(stop_csv))] == [
        "S1",
        "S2",
    ]


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


def test_stop_series_pools_stop_patterns_before_choosing_the_position(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    short = tuple(
        Trip(
            f"short-{index}",
            "A",
            0,
            "ran",
            None,
            True,
            (0, 0, 0),
            stop_ids=("start", "before", "target"),
        )
        for index in range(15)
    )
    long = tuple(
        Trip(
            f"long-{index}",
            "A",
            0,
            "ran",
            None,
            True,
            (0, 0, 0, 0, 345),
            stop_ids=("start", "before", "branch", "after", "target"),
        )
        for index in range(16)
    )
    reverse = Trip("reverse", "A", 1, "ran", None, True, (0,), stop_ids=("target",))
    other_line = reverse._replace(id="other-line", line="B", direction=0)
    later = FRIDAY + timedelta(days=3)
    store = _build_store(
        tmp_path, 6, {THURSDAY: (*short, reverse, other_line), FRIDAY: long[:15], later: long[15:]}
    )
    monkeypatch.setattr(measures, "DAYS_PER_QUERY_BATCH", 1)
    scope = {"start": THURSDAY, "line": "A", "group": "stop"}

    tied = query(store, **scope, end=FRIDAY, direction=0)
    tied_target = [cell for cell in tied["cells"] if cell["key"]["stop"] == "target"]
    assert len(tied_target) == 1
    assert tied_target[0]["key"]["stop_sequence"] == 3
    assert tied_target[0]["evidence"]["counts"]["classified"] == 30
    assert tied_target[0]["value"]["late"] == 0.5

    answer = query(store, **scope, end=later)
    cells = answer["cells"]
    assert [tuple(cell["key"].values()) for cell in cells] == [
        (0, 1, "start"),
        (0, 2, "before"),
        (0, 3, "branch"),
        (0, 4, "after"),
        (0, 5, "target"),
        (1, 1, "target"),
    ]
    assert cells[4]["evidence"]["counts"]["classified"] == 31
    assert cells[4]["value"]["late"] == 16 / 31
    assert cells[5]["state"] == "too_few_to_judge"
    export = csv.DictReader(io.StringIO(measures.answer_csv(answer, "en")))
    assert [(row["Direction"], row["Stop sequence"], row["Stop ID"]) for row in export] == [
        (str(direction), str(sequence), stop)
        for direction, sequence, stop in (tuple(cell["key"].values()) for cell in cells)
    ]


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
    ranking = json.loads(raw)
    assert ranking["rows"] == []
    (row,) = ranking["excluded"]
    assert (row["line"], row["direction"], row["departure"]) == ("A", 0, "07:00:00")
    assert row["counts"]["late"] == 8
    assert row["sample"] == 32
    assert row["counts"]["observed_service_dates"] == 1
    assert row["reason"] == "too_few_to_judge"
    status, _, _ = asyncio.run(http(app, "/ranking", cut + "&kind=line&measure=late"))
    assert status == 400


@pytest.mark.parametrize("cleaning_version", [8, 9])
def test_single_departure_keeps_repeated_stops_and_exact_observations(
    tmp_path: Path, cleaning_version: int
) -> None:
    store = _build_store(
        tmp_path,
        cleaning_version,
        {
            THURSDAY: (
                Trip(
                    "selected",
                    "A",
                    0,
                    "ran",
                    None,
                    True,
                    (-61, 301, None),
                    stop_ids=("loop", "middle", "loop"),
                ),
                Trip("other-direction", "A", 1, "ran", None, True, (60,) * 25 + (360,) * 5),
                Trip("later-departure", "A", 0, "ran", None, True, (20,), offset_minutes=1),
            ),
        },
    )
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=50)
    base = urlencode(
        {
            "city": "stm",
            "from": THURSDAY,
            "to": THURSDAY,
            "line": "A",
            "direction": 0,
            "departure": "07:00:00",
        }
    )
    stops = base + "&measure=punctuality&group=stop"
    status, _, raw = asyncio.run(http(app, "/measure", stops))
    assert status == 200, raw
    answer = json.loads(raw)
    assert answer["evidence"]["cleaning_versions"] == [cleaning_version]
    cells = answer["cells"]
    assert [cell["key"] for cell in cells] == [
        {"direction": 0, "stop_sequence": 1, "stop": "loop"},
        {"direction": 0, "stop_sequence": 2, "stop": "middle"},
        {"direction": 0, "stop_sequence": 3, "stop": "loop"},
    ]
    assert [cell["evidence"]["observed_delay_seconds"] for cell in cells] == [-61, 301, None]
    assert [cell["state"] for cell in cells] == [
        "too_few_to_judge",
        "too_few_to_judge",
        "not_measured",
    ]
    assert all(cell["value"]["median_delay"] is None for cell in cells)
    assert cells[2]["evidence"]["coverage_reason"] == "insufficient_coverage"
    status, _, raw = asyncio.run(http(app, "/measure", stops + "&format=csv&lang=fr"))
    assert status == 200, raw
    exported = csv.DictReader(io.StringIO(raw.decode()))
    assert exported.fieldnames == answer["info"][0]["csv_columns"]["fr"]
    assert [row["Retard observé (s)"] for row in exported] == ["-61", "301", ""]
    status, _, raw = asyncio.run(http(app, "/measure", base + "&measure=trips_run"))
    assert status == 200, raw
    assert json.loads(raw)["evidence"]["trip_ids"] == ["selected"]
    # The opposite departure clears the 30-stop display floor. Integer bins 60–74
    # and 360–374 have midpoints of 67 and 367 seconds respectively.
    other = base.replace("direction=0", "direction=1") + "&measure=punctuality"
    status, _, raw = asyncio.run(http(app, "/measure", other))
    assert status == 200, raw
    value = json.loads(raw)["value"]
    assert (value["median_delay"], value["p90_delay"]) == (67, 367)


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
