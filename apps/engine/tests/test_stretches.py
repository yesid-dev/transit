import asyncio
import json
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from math import floor
from pathlib import Path
from typing import Any, NamedTuple
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import duckdb
import pytest
from test_engine import FRIDAY, THURSDAY, Trip, _build_store, http, query

from transit_engine import server
from transit_engine.clean_manifest import SEGMENT_RUNS
from transit_engine.server import Engine
from transit_engine.store import Store
from transit_engine.stretches import receipt_tables, stretch_directory

ZONE = ZoneInfo("America/Toronto")
NOON = datetime(2026, 11, 19, 17, tzinfo=UTC)  # 12:00 in Montréal
LAYER = {"measure": "stretch_time_lost", "group": "stretch", "map_view": True}


class Pass(NamedTuple):
    trip: str
    line: str
    stretch: tuple[str, str, int, int]
    seconds: int
    speed: float | None
    minute: int = 0
    gap: int = 40


def _key(stretch: tuple[str, str, int, int]) -> int:
    text = "\x1f".join(str(part) for part in stretch)
    return int.from_bytes(sha256(text.encode()).digest()[:8], "big", signed=True)


def _passes() -> list[Pass]:
    shared = ("a", "b", 2, 1)
    passes = [
        Pass(f"A{i}", "A", shared, 10 + i, 30.0 + i, minute=i) for i in range(25)
    ]  # 25 counted passes on line A
    passes += [Pass(f"B{i}", "B", shared, 40 + 3 * i, 12.5, minute=i) for i in range(20)]
    passes += [Pass("A90", "A", shared, 5, 99.0, gap=120)]  # timed across a long hole
    passes += [Pass("A91", "A", shared, 6, None)]  # no measured speed
    passes += [Pass(f"A{i}", "A", ("b", "c", 1, 1), 30, 20.0) for i in range(5)]  # too few
    passes += [Pass("A30", "A", shared, 7, 50.0, minute=-360)]  # 06:00 is the default start
    return passes


def _expected(passes: list[Pass], hours: tuple[int, int] = (6, 24)) -> dict[str, Any]:
    """Clear run, median, time lost, total and clear-run speed, from the definitions."""
    counted = [
        p
        for p in passes
        if p.gap <= 90
        and p.speed is not None
        and hours[0] <= (NOON + timedelta(minutes=p.minute)).astimezone(ZONE).hour < hours[1]
    ]
    times = sorted(p.seconds for p in counted)
    speeds = sorted((floor(p.speed) for p in counted if p.speed is not None), reverse=True)
    n = len(times)
    boundary = -(-n // 10)  # ceil(n / 10)
    clear = times[boundary - 1]
    median = (times[(n + 1) // 2 - 1] + times[(n + 2) // 2 - 1]) / 2
    return {
        "passes": n,
        "clear_run_seconds": clear,
        "median_seconds": median,
        "time_lost_seconds": median - clear,
        "total_time_lost_seconds": sum(max(t - clear, 0) for t in times),
        "clear_run_speed_kmh": speeds[boundary - 1],
    }


def _write_day(root: Path, day: date, passes: list[Pass], types: dict[str, int]) -> Path:
    folder = root / "stretch" / "v13" / "stm" / day.isoformat()
    folder.mkdir(parents=True)
    staged = folder / "staging"
    staged.mkdir()
    stretches = sorted({p.stretch for p in passes})
    cells: dict[tuple[int, int, int, int, int], int] = {}
    for p in passes:
        entered = NOON + timedelta(minutes=p.minute)
        if p.gap > 90 or p.speed is None:
            continue
        cell = (_key(p.stretch), types[p.line], entered.astimezone(ZONE).hour, p.seconds,
                floor(p.speed))  # fmt: skip
        cells[cell] = cells.get(cell, 0) + 1
    with duckdb.connect() as conn:
        conn.execute("SET TimeZone = 'UTC'")
        conn.execute(
            """CREATE TABLE stretches (provider VARCHAR, service_date DATE,
            cleaning_version VARCHAR, stretch_key BIGINT, from_stop VARCHAR, to_stop VARCHAR,
            pieces SMALLINT, piece SMALLINT, length_m DOUBLE, from_lat DOUBLE, from_lon DOUBLE,
            to_lat DOUBLE, to_lon DOUBLE, shape_id VARCHAR)"""
        )
        conn.executemany(
            "INSERT INTO stretches VALUES ('stm', ?, '13', ?, ?, ?, ?, ?, 100.0, 45.5, -73.6, "
            "45.5, -73.599, 'sh')",
            [(day, _key(s), *s) for s in stretches],
        )
        conn.execute(
            """CREATE TABLE stretch_passes (provider VARCHAR, service_date DATE,
            cleaning_version VARCHAR, trip_id VARCHAR, route_id VARCHAR, direction_id INTEGER,
            vehicle_id VARCHAR, from_stop VARCHAR, to_stop VARCHAR, from_sequence BIGINT,
            pieces SMALLINT, piece SMALLINT, entered_at TIMESTAMPTZ, exited_at TIMESTAMPTZ,
            moving_speed_kmh DOUBLE, stopped_at_stop_seconds INTEGER,
            stopped_between_stops_seconds INTEGER, gap_seconds INTEGER)"""
        )
        conn.executemany(
            "INSERT INTO stretch_passes VALUES ('stm', ?, '13', ?, ?, 0, 'v', ?, ?, 1, ?, ?, "
            "?, ?, ?, 0, 0, ?)",
            [
                (
                    day,
                    p.trip,
                    p.line,
                    *p.stretch,
                    NOON + timedelta(minutes=p.minute),
                    NOON + timedelta(minutes=p.minute, seconds=p.seconds),
                    p.speed,
                    p.gap,
                )  # fmt: skip
                for p in sorted(passes, key=lambda p: (p.line, p.trip))
            ],
        )
        conn.execute(
            """CREATE TABLE stretch_summary (provider VARCHAR, service_date DATE,
            cleaning_version VARCHAR, stretch_key BIGINT, route_type SMALLINT, hour SMALLINT,
            pass_seconds INTEGER, speed_kmh SMALLINT, passes INTEGER,
            stopped_at_stop_seconds BIGINT, stopped_between_stops_seconds BIGINT)"""
        )
        conn.executemany(
            "INSERT INTO stretch_summary VALUES ('stm', ?, '13', ?, ?, ?, ?, ?, ?, 0, 0)",
            [(day, *cell, n) for cell, n in sorted(cells.items())],
        )
        files, tables = {}, {}
        for table in ("stretches", "stretch_passes", "stretch_summary"):
            target = staged / f"{table}.parquet"
            conn.execute(f"COPY {table} TO '{target.as_posix()}' (FORMAT parquet)")
            digest = sha256(target.read_bytes()).hexdigest()
            name = f"{table}-{digest[:16]}.parquet"
            target.rename(folder / name)
            files[name] = {"sha256": digest, "byte_size": (folder / name).stat().st_size,
                           "rows": 0}  # fmt: skip
            tables[table] = name
    staged.rmdir()
    receipt = {
        "provider": "stm",
        "service_date": day.isoformat(),
        "cleaning_version": "13",
        "tables": tables,
        "files": files,
    }
    (folder / "manifest.json").write_text(json.dumps(receipt), encoding="utf-8")
    return folder


def _store(tmp_path: Path, passes: list[Pass], days: tuple[date, ...] = (THURSDAY,)) -> Store:
    trips = tuple(
        Trip(trip, line, 0, "ran", None, True, (0,), route_type={"A": 3, "B": 0}[line])
        for trip, line in sorted({(p.trip, p.line) for p in passes})
    )
    store = _build_store(tmp_path, 12, dict.fromkeys(days, trips))
    for day in days:
        _complete_v12(Path(store.root), day)
        _write_day(Path(store.root), day, passes, {"A": 3, "B": 0})
    return store


def _complete_v12(root: Path, day: date) -> None:
    """A v12 receipt lists segment runs; stretch questions do not read them."""
    directory = root / "stm" / str(day) / "v12"
    with duckdb.connect() as conn:
        conn.execute(
            "COPY (SELECT 'stm' AS provider, ?::DATE AS service_date) TO ? (FORMAT PARQUET)",
            [day, str(directory / SEGMENT_RUNS)],
        )
    payload = (directory / SEGMENT_RUNS).read_bytes()
    marker = directory / "manifest.json"
    receipt = json.loads(marker.read_bytes())
    receipt["files"][SEGMENT_RUNS] = {
        "rows": 1, "sha256": sha256(payload).hexdigest(), "byte_size": len(payload),
    }  # fmt: skip
    marker.write_text(json.dumps(receipt), encoding="utf-8")


def _row(answer: dict[str, Any], stretch: tuple[str, str, int, int]) -> dict[str, Any]:
    keys = list(zip(answer["from_stop"], answer["to_stop"], answer["pieces"], answer["piece"],
                    strict=True))  # fmt: skip
    index = keys.index(stretch)
    return {
        column: values[index]
        for column, values in answer.items()
        if isinstance(values, list) and column != "info"
    }


def test_the_network_layer_follows_the_definitions(tmp_path: Path) -> None:
    passes = _passes()
    answer = query(_store(tmp_path, passes), **LAYER)
    row = _row(answer, ("a", "b", 2, 1))
    expected = _expected([p for p in passes if p.stretch == ("a", "b", 2, 1)])
    assert expected["passes"] == 46
    for column, value in expected.items():
        assert row[column] == value, column
    assert row["value"] == expected["time_lost_seconds"] and row["state"] == "measured"
    thin = _row(answer, ("b", "c", 1, 1))
    assert thin["state"] == "too_few_to_judge" and thin["value"] is None
    assert thin["passes"] == 5 and thin["clear_run_seconds"] is None
    assert answer["minimum_sample"] == 20
    speed = query(
        _store(tmp_path / "speed", passes), **{**LAYER, "measure": "stretch_clear_run_speed"}
    )
    assert _row(speed, ("a", "b", 2, 1))["value"] == expected["clear_run_speed_kmh"]
    assert answer["info"][0]["text"]["fr"]


def test_line_cuts_read_the_passes_and_agree_with_the_summary(tmp_path: Path) -> None:
    passes = _passes()
    store = _store(tmp_path, passes)
    line = _row(query(store, **LAYER, lines=("A",)), ("a", "b", 2, 1))
    only_a = [p for p in passes if p.line == "A" and p.stretch == ("a", "b", 2, 1)]
    for column, value in _expected(only_a).items():
        assert line[column] == value, column
    # The summary path with a vehicle-type cut sees the same passes as line A.
    by_type = _row(query(store, **LAYER, route_type=3), ("a", "b", 2, 1))
    assert {key: by_type[key] for key in _expected(only_a)} == _expected(only_a)
    one_line = _row(query(store, **LAYER, line="A", direction=0), ("a", "b", 2, 1))
    assert one_line["passes"] == line["passes"]
    typed_line = query(store, **LAYER, lines=("A",), route_type=0)
    assert typed_line["from_stop"] == []


def test_hours_and_vehicle_types_cut_the_counts(tmp_path: Path) -> None:
    passes = _passes()
    store = _store(tmp_path, passes)
    shared = [p for p in passes if p.stretch == ("a", "b", 2, 1)]
    early = query(store, **LAYER, hour_from=6, hour_to=7)
    assert _row(early, ("a", "b", 2, 1))["passes"] == 1
    noon = _row(query(store, **LAYER, hour=12), ("a", "b", 2, 1))
    assert noon["passes"] == _expected(shared, (12, 13))["passes"] == 45
    rail = _row(query(store, **LAYER, route_type=0), ("a", "b", 2, 1))
    assert rail["passes"] == 20 and rail["clear_run_seconds"] == 43  # 2nd fastest of 20
    # A start after the end runs across midnight: 13:00 to 07:00 keeps 06:00, not noon.
    for cut in ({}, {"lines": ("A",)}):
        night = _row(query(store, **LAYER, **cut, hour_from=13, hour_to=7), ("a", "b", 2, 1))
        assert night["passes"] == 1, cut


def test_a_day_without_stretch_timing_is_not_measured(tmp_path: Path) -> None:
    passes = _passes()
    store = _store(tmp_path, passes)
    # A second v12 day exists, but its stretch timing was never published.
    other = _build_store(tmp_path / "friday", 12, {FRIDAY: ()})
    _complete_v12(Path(other.root), FRIDAY)
    for item in Path(other.root).joinpath("stm").iterdir():
        item.rename(Path(store.root) / "stm" / item.name)
    answer = query(store, **LAYER, start=THURSDAY, end=FRIDAY)
    evidence = answer["evidence"]
    assert evidence["days_included"] == [str(THURSDAY)]
    assert evidence["days_not_measured"] == [str(FRIDAY)]
    assert evidence["days_not_measured_reasons"][str(FRIDAY)] == "stretch_timing_missing"
    assert _row(answer, ("a", "b", 2, 1))["passes"] == 46
    alone = query(store, **LAYER, start=FRIDAY, end=FRIDAY)
    assert alone["from_stop"] == [] and alone["evidence"]["days_included"] == []


def test_a_receipt_must_name_files_of_the_right_size(tmp_path: Path) -> None:
    store = _store(tmp_path, _passes())
    folder = Path(stretch_directory(store, "stm", THURSDAY))
    receipt = (folder / "manifest.json").read_bytes()
    assert receipt_tables(receipt, "stm", THURSDAY) is not None
    assert receipt_tables(receipt, "stm", FRIDAY) is None
    summary = next(folder.glob("stretch_summary-*.parquet"))
    summary.write_bytes(summary.read_bytes() + b"x")
    answer = query(store, **LAYER)
    assert answer["from_stop"] == [] and answer["evidence"]["days_included"] == []
    assert answer["evidence"]["days_not_measured"] == [str(THURSDAY)]


@pytest.mark.parametrize(
    "cut",
    [
        {"measure": "stretch_time_lost"},
        {"measure": "stretch_time_lost", "group": "stretch"},
        {"measure": "mean_time_lost", "group": "stretch", "map_view": True},
        {**LAYER, "stop": "a"},
        {**LAYER, "line": "A", "lines": ("A",)},
        {**LAYER, "hour": 7, "time_band": "midday"},
        {**LAYER, "hour_from": 6, "hour_to": 6},
    ],
)
def test_stretch_questions_are_map_layers_only(tmp_path: Path, cut: dict[str, Any]) -> None:
    store = _store(tmp_path, _passes())
    with pytest.raises(ValueError):
        query(store, **cut)


def test_the_engine_answers_stretch_layers_over_http(tmp_path: Path) -> None:
    store = _store(tmp_path, _passes())
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = {
        "city": "stm", "from": THURSDAY, "to": THURSDAY, "view": "map",
        "measure": "stretch_clear_run_speed", "group": "stretch", "lines": '["A"]',
        "time_band": "midday",
    }  # fmt: skip
    status, _, raw = asyncio.run(http(app, "/measure", urlencode(params)))
    assert status == 200, raw
    answer = json.loads(raw)
    assert answer["measure"] == "stretch_clear_run_speed"
    assert answer["evidence"]["cuts"]["lines"] == ["A"]
    assert _row(answer, ("a", "b", 2, 1))["state"] == "measured"


def _roll_up(
    store: Store, month: str, days: tuple[date, ...], key: str = "0123456789abcdef"
) -> Path:
    """A month rollup laid out as the nightly cleaning publishes it, from the day files."""
    root = Path(store.root)
    folder = root / "stretch" / "v13" / "stm" / "months" / f"{month}-{key}"
    folder.mkdir(parents=True)
    summaries, stretches, receipts = [], [], {}
    for day in days:
        day_folder = root / "stretch" / "v13" / "stm" / day.isoformat()
        day_receipt = (day_folder / "manifest.json").read_bytes()
        tables = json.loads(day_receipt)["tables"]
        summaries.append((day_folder / tables["stretch_summary"]).as_posix())
        stretches.append((day_folder / tables["stretches"]).as_posix())
        receipts[day.isoformat()] = sha256(day_receipt).hexdigest()
    files, names = {}, {}
    with duckdb.connect() as conn:
        for table, sql, sources in (
            (
                "stretch_summary",
                """SELECT provider, ? AS month, cleaning_version, stretch_key, route_type,
                    CASE isodow(service_date) WHEN 6 THEN 'saturday' WHEN 7 THEN 'sunday'
                        ELSE 'weekday' END AS day_type, hour, pass_seconds, speed_kmh,
                    sum(passes)::BIGINT AS passes, sum(stopped_at_stop_seconds)::BIGINT AS a,
                    sum(stopped_between_stops_seconds)::BIGINT AS b
                FROM read_parquet(?) GROUP BY ALL""",
                [month, summaries],
            ),
            (
                "stretches",
                """SELECT * EXCLUDE (rank) FROM (SELECT *, row_number() OVER (
                    PARTITION BY stretch_key ORDER BY service_date DESC) AS rank
                    FROM read_parquet(?)) WHERE rank = 1""",
                [stretches],
            ),
        ):
            staged = folder / table
            conn.execute(f"COPY ({sql}) TO '{staged.as_posix()}' (FORMAT parquet)", sources)
            digest = sha256(staged.read_bytes()).hexdigest()
            name = f"{table}-{digest[:16]}.parquet"
            staged.rename(folder / name)
            files[name] = {"sha256": digest, "byte_size": (folder / name).stat().st_size}
            names[table] = name
    receipt = {
        "provider": "stm", "month": month, "cleaning_version": "13",
        "days": receipts, "tables": names, "files": files,
    }  # fmt: skip
    (folder / "manifest.json").write_text(json.dumps(receipt), encoding="utf-8")
    return folder


def test_a_month_rollup_answers_exactly_like_its_days(tmp_path: Path) -> None:
    passes = _passes()
    store = _store(tmp_path, passes, days=(THURSDAY, FRIDAY))
    month = {"start": date(2026, 11, 1), "end": date(2026, 11, 30)}
    by_day = query(store, **LAYER, **month)
    weekday = query(store, **LAYER, **month, day_type="weekday", route_type=3)
    # An older rollup of one day sits next to the one that adds up both days.
    _roll_up(store, "2026-11", (THURSDAY,), key="aaaaaaaaaaaaaaaa")
    folder = _roll_up(store, "2026-11", (THURSDAY, FRIDAY))
    rolled = query(store, **LAYER, **month)
    for column in ("from_stop", "passes", "clear_run_seconds", "median_seconds",
                   "total_time_lost_seconds", "clear_run_speed_kmh", "value", "state"):  # fmt: skip
        assert rolled[column] == by_day[column], column
    assert rolled["evidence"]["days_included"] == by_day["evidence"]["days_included"]
    # The rollup alone answers: with the daily summaries hidden, nothing changes.
    daily = sorted((Path(store.root) / "stretch" / "v13" / "stm").glob("2026-*/stretch_summary-*"))
    for path in daily:
        path.rename(path.with_suffix(".hidden"))
    assert query(store, **LAYER, **month)["passes"] == by_day["passes"]
    for path in daily:
        path.with_suffix(".hidden").rename(path)
    assert _row(rolled, ("a", "b", 2, 1))["passes"] == 2 * 46
    typed = query(store, **LAYER, **month, day_type="weekday", route_type=3)
    assert typed["passes"] == weekday["passes"] and typed["value"] == weekday["value"]
    assert query(store, **LAYER, **month, day_type="sunday")["from_stop"] == []
    # A window that holds only part of the month reads its days one by one.
    one = query(store, **LAYER, start=THURSDAY, end=THURSDAY)
    assert _row(one, ("a", "b", 2, 1))["passes"] == 46
    # A rollup whose files no longer match its receipt is not used.
    summary = next(folder.glob("stretch_summary-*.parquet"))
    summary.write_bytes(summary.read_bytes() + b"x")
    assert query(store, **LAYER, **month)["passes"] == by_day["passes"]


def test_a_slow_stretch_question_says_busy_then_answers_the_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _store(tmp_path, _passes())
    monkeypatch.setattr(server, "STRETCH_SOFT_DEADLINE_S", 0)
    app = Engine(store, concurrency=1, queue_size=1, queue_wait_ms=50)
    params = urlencode({
        "city": "stm", "from": THURSDAY, "to": THURSDAY, "view": "map",
        "measure": "stretch_time_lost", "group": "stretch",
    })  # fmt: skip

    async def run() -> tuple[Any, ...]:
        first = await http(app, "/measure", params)
        # The query keeps going after the busy answer, holding its record slot.
        assert app.record.slots.locked()
        await asyncio.gather(*app.stretch_pending.values())
        assert not app.record.slots.locked()
        second = await http(app, "/measure", params)
        return first, second

    (status, headers, _), (again, _, raw) = asyncio.run(run())
    assert status == 503
    assert headers[b"retry-after"] == b"15"
    assert again == 200
    answer = json.loads(raw)
    direct = query(store, **LAYER)
    for column in ("from_stop", "passes", "clear_run_seconds", "value", "state"):
        assert answer[column] == direct[column], column


def test_the_vm_release_installs_the_r2_reader_its_unit_turns_on() -> None:
    # The unit points stretch questions at R2. Without the locked httpfs wheel every
    # stretch question fails on the VM; the image already syncs with the extra.
    ops = Path(__file__).parents[1] / "ops" / "linux"
    unit = (ops / "transit-engine.service").read_text(encoding="utf-8")
    assert "ENGINE_STRETCH_R2_ROOT=s3://" in unit
    script = (ops / "update-engine.sh").read_text(encoding="utf-8")
    sync = script[script.index('"$root/bin/uv" sync') :].split("\n", 2)
    assert "--extra r2" in " ".join(sync[:2])


def test_engine_connections_need_no_writable_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A network stretch window can make DuckDB reach for its spill folder. Its default
    # is ".tmp" in the working directory, which is "/" for the sandboxed VM service.
    store = _store(tmp_path, _passes())
    with store.connect() as conn:
        assert conn.execute("SELECT current_setting('temp_directory')").fetchone() == ("",)
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    _row(query(store, **LAYER), ("a", "b", 2, 1))
    assert not (work / ".tmp").exists()
