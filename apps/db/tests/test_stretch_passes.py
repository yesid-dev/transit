import json
from datetime import UTC, date, datetime
from math import cos, pi, radians
from pathlib import Path

import duckdb
import pytest

from transit_ops.stretch_passes import (
    STRETCH_VERSION,
    PathStop,
    TripPath,
    VehicleInterval,
    build_stretch_day,
    write_stretch_day,
)

DAY = date(2026, 11, 25)
LAT = 45.5
LON = -73.6
START = datetime(2026, 11, 25, 12, tzinfo=UTC).timestamp()
_METRES_PER_DEGREE = pi / 180 * 6_371_008.8


def _lon(metres: float) -> float:
    return LON + metres / (cos(radians(LAT)) * _METRES_PER_DEGREE)


def _lat(metres: float) -> float:
    return LAT + metres / _METRES_PER_DEGREE


def _path(stops: tuple[float, ...] = (0, 500, 1000), length: float = 1000) -> TripPath:
    shape = [(_lon(x), LAT) for x in range(0, int(length) + 1, 50)]
    return TripPath(
        "r1",
        0,
        "s1",
        shape,
        [PathStop(i + 1, f"stop{i + 1}", LAT, _lon(x)) for i, x in enumerate(stops)],
    )


def _at(second: float, metres: float, *, held: float = 0, north: float = 0) -> VehicleInterval:
    """One interval at ``metres`` along the shape, held for ``held`` seconds."""
    observed = START + second
    return VehicleInterval(
        "t1",
        "v1",
        observed,
        observed + 2,
        observed + 2 + held,
        2 if held else 1,
        _lat(north),
        _lon(metres),
    )


def _drive(
    speed: float = 10, every: float = 20, *, dwell_at: float | None = None, dwell: float = 0
) -> list[VehicleInterval]:
    readings = []
    second, metres = 0.0, 0.0
    paused = False
    while metres <= 1000:
        if dwell_at is not None and not paused and metres >= dwell_at:
            readings.append(_at(second, dwell_at, held=dwell))
            second += dwell + every
            metres = dwell_at + speed * every
            paused = True
            continue
        readings.append(_at(second, metres))
        second += every
        metres += speed * every
    return readings


def _passes(readings: list[VehicleInterval], path: TripPath | None = None):
    day = build_stretch_day("stm", DAY, {"t1": path or _path()}, readings)
    columns = (
        "provider service_date version trip route direction vehicle from_stop to_stop "
        "from_sequence pieces piece entered exited speed at_stop between gap"
    ).split()
    return day, [dict(zip(columns, row, strict=True)) for row in day.passes]


def test_pieces_tile_each_stop_to_stop_run_and_time_a_steady_drive():
    day, rows = _passes(_drive())
    assert [(row["from_stop"], row["piece"]) for row in rows] == [
        *(("stop1", piece) for piece in range(1, 6)),
        *(("stop2", piece) for piece in range(1, 6)),
    ]
    assert all(row["pieces"] == 5 for row in rows)
    for before, after in zip(rows, rows[1:], strict=False):
        assert before["exited"] == after["entered"]
    inner = [row for row in rows if row["piece"] not in (1, 5)]
    assert {row["speed"] for row in inner} == {36.0}
    assert all(row["at_stop"] == row["between"] == 0 for row in rows)
    assert all(row["version"] == STRETCH_VERSION for row in rows)
    assert len(day.stretches) == 10
    assert day.facts.placed == len(_drive())


def test_stop_dwell_is_time_stopped_at_the_stop_and_kept_out_of_speed():
    _, rows = _passes(_drive(dwell_at=500, dwell=60))
    stopped = sum(row["at_stop"] for row in rows)
    assert 58 <= stopped <= 62
    assert sum(row["between"] for row in rows) == 0
    holding = [row for row in rows if row["at_stop"]]
    assert [(row["from_stop"], row["piece"]) for row in holding] == [("stop2", 1)]
    assert holding[0]["speed"] == pytest.approx(36.0, abs=1.5)
    # The vehicle reaches stop 2 at 60 s (from 400 m at 40 s); the run from stop 1
    # starts 30 m out of the line end, 3 s in, and leaves the dwell to the next run.
    run = [row for row in rows if row["from_stop"] == "stop1"]
    assert (run[-1]["exited"] - run[0]["entered"]).total_seconds() == 57


def test_hold_between_stops_is_time_stopped_between_stops():
    readings = [_at(0, 0), _at(20, 200), _at(40, 300, held=45), _at(110, 500), _at(130, 700)]
    readings += [_at(150, 900), _at(170, 1000)]
    _, rows = _passes(readings)
    assert sum(row["between"] for row in rows) == pytest.approx(45, abs=1)
    assert sum(row["at_stop"] for row in rows) == 0
    for row in rows:
        total = (row["exited"] - row["entered"]).total_seconds()
        assert 0 <= row["at_stop"] + row["between"] <= total


def test_a_frozen_position_is_not_a_stop():
    # The feed repeats 200 m for 140 s, then shows the vehicle 700 m on 20 s later.
    readings = [_at(0, 0), _at(20, 200, held=140), _at(180, 900), _at(190, 1000)]
    day, rows = _passes(readings)
    assert day.facts.frozen_holds == 1
    assert sum(row["at_stop"] + row["between"] for row in rows) == 0
    assert max(row["speed"] for row in rows) < 108
    assert max(row["gap"] for row in rows) == 160


def test_an_impossible_speed_keeps_its_times_but_not_its_speed():
    # 200 m in 4 s is 180 km/h: the passes still tile the run, without a speed.
    readings = [_at(0, 0), _at(20, 200), _at(24, 400), _at(64, 800), _at(84, 1000)]
    day, rows = _passes(readings)
    assert day.facts.implausible_speeds > 0
    assert all(row["speed"] is None or row["speed"] <= 108 for row in rows)
    assert len(rows) == 10


def test_line_end_layover_is_left_out():
    readings = [_at(0, 0, held=600), *(_at(620 + 20 * i, 200 * (i + 1)) for i in range(5))]
    _, rows = _passes(readings)
    first = rows[0]
    assert first["from_stop"] == "stop1" and first["piece"] == 1
    assert first["entered"].timestamp() >= START + 600
    assert first["at_stop"] == 0
    assert rows[-1]["exited"].timestamp() <= START + 620 + 20 * 4


def test_off_route_and_backward_readings_do_not_break_the_passes():
    readings = [_at(0, 0), _at(20, 200), _at(30, 250, north=200), _at(40, 195)]
    readings += [_at(60, 400), _at(80, 600), _at(100, 800), _at(120, 1000)]
    day, rows = _passes(readings)
    assert day.facts.off_route == 1
    assert len(rows) == 10
    assert all(row["exited"] > row["entered"] for row in rows)


def test_a_long_hole_in_the_readings_is_not_timed():
    readings = [_at(0, 0), _at(20, 200), _at(900, 800), _at(920, 1000)]
    day, rows = _passes(readings)
    assert day.facts.skipped_gap_pieces == 6
    assert {(row["from_stop"], row["piece"]) for row in rows} == {
        ("stop1", 1), ("stop1", 2), ("stop2", 4), ("stop2", 5),
    }  # fmt: skip


def test_trips_sharing_a_stop_pair_share_stretches(tmp_path: Path):
    other = [reading._replace(trip_id="t2", vehicle_id="v2") for reading in _drive()]
    day = build_stretch_day("stm", DAY, {"t1": _path(), "t2": _path()}, [*_drive(), *other])
    assert len(day.stretches) == 10 and len(day.passes) == 20
    destination, files = write_stretch_day(day, tmp_path, {"provider": "stm"})
    assert destination == tmp_path / "stm" / DAY.isoformat() / f"v{STRETCH_VERSION}"
    receipt = json.loads((destination / "manifest.json").read_text("utf-8"))
    assert receipt["files"] == files and receipt["facts"]["passes"] == 20
    with duckdb.connect() as connection:
        count, moving = connection.execute(
            "SELECT count(*), count(moving_speed_kmh) FROM read_parquet(?)",
            [str(destination / "stretch_passes.parquet")],
        ).fetchone()
        stretches = connection.execute(
            "SELECT count(*), sum(length_m) FROM read_parquet(?)",
            [str(destination / "stretches.parquet")],
        ).fetchone()
    assert (count, moving) == (20, 20)
    assert stretches == (10, pytest.approx(1000, abs=0.5))
    with pytest.raises(FileExistsError):
        write_stretch_day(day, tmp_path, {"provider": "stm"})
