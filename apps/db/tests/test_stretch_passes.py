import json
from dataclasses import replace
from datetime import UTC, date, datetime
from hashlib import sha256
from math import cos, pi, radians
from pathlib import Path
from random import Random
from zoneinfo import ZoneInfo

import duckdb
import pytest

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.stretch_day import SOURCE_FILES, publish_stretch_day, stretch_key_prefix
from transit_ops.stretch_passes import (
    STRETCH_VERSION,
    PassRow,
    PathStop,
    TripPath,
    VehicleInterval,
    build_stretch_day,
    stretch_key,
)

DAY = date(2026, 11, 25)
ZONE = ZoneInfo("America/Toronto")
# stretch_key('a', 'b', 1, 1): fixed so the key never changes between releases.
STABLE_KEY = -2661859989655278354
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


def _source_manifest() -> bytes:
    return json.dumps(
        {
            "provider": "stm",
            "service_date": DAY.isoformat(),
            "cleaning_version": "12",
            "schedule_sha256": "0" * 64,
            "files": {name: {} for name in SOURCE_FILES},
        }
    ).encode()


def test_trips_sharing_a_stop_pair_share_stretches(tmp_path: Path):
    other = [reading._replace(trip_id="t2", vehicle_id="v2") for reading in _drive()]
    paths = {"t1": replace(_path(), route_type=3), "t2": replace(_path(), route_type=3)}
    day = build_stretch_day("stm", DAY, paths, [*_drive(), *other])
    assert len(day.stretches) == 10 and len(day.passes) == 20
    storage = LocalBronzeStorage(storage_backend="local", root=tmp_path)
    files = publish_stretch_day(day, _source_manifest(), ZONE, storage, "")
    destination = tmp_path / stretch_key_prefix("stm", DAY)
    assert destination == tmp_path / "stretch" / "v13" / "stm" / DAY.isoformat()
    receipt = json.loads((destination / "manifest.json").read_text("utf-8"))
    assert receipt["files"] == files and receipt["facts"]["passes"] == 20
    assert receipt["source_manifest_sha256"] == sha256(_source_manifest()).hexdigest()
    with duckdb.connect() as connection:
        count, moving = connection.execute(
            "SELECT count(*), count(moving_speed_kmh) FROM read_parquet(?)",
            [str(destination / "stretch_passes.parquet")],
        ).fetchone()
        stretches = connection.execute(
            "SELECT count(*), sum(length_m) FROM read_parquet(?)",
            [str(destination / "stretches.parquet")],
        ).fetchone()
        summary = connection.execute(
            "SELECT sum(passes) FROM read_parquet(?)",
            [str(destination / "stretch_summary.parquet")],
        ).fetchone()
    assert (count, moving) == (20, 20)
    assert stretches == (10, pytest.approx(1000, abs=0.5))
    assert summary == (20,)
    # Create-only: the same day cannot be written again with other bytes.
    with pytest.raises(FileExistsError):
        publish_stretch_day(
            build_stretch_day("stm", DAY, paths, _drive()), _source_manifest(), ZONE, storage, ""
        )


def test_a_fix_too_far_ahead_is_taken_back():
    # The reading at 60 s says 700 m; the next two agree the vehicle was near 450 m.
    readings = [_at(0, 0), _at(20, 200), _at(40, 300), _at(60, 700), _at(80, 450)]
    readings += [_at(90, 520), _at(120, 800), _at(140, 1000)]
    day, rows = _passes(readings)
    assert day.facts.retracted == 1
    assert day.facts.off_route == 0
    assert len(rows) == 10
    by_piece = {(row["from_stop"], row["piece"]): row for row in rows}
    # 300 m at 40 s to 450 m at 80 s: the stretch from 400 m starts at 66.7 s.
    assert by_piece["stop1", 5]["entered"].timestamp() == START + 67


def test_one_reading_behind_is_jitter_and_is_not_taken_back():
    readings = [_at(0, 0), _at(20, 300), _at(40, 150), _at(60, 600), _at(80, 1000)]
    day, rows = _passes(readings)
    assert day.facts.retracted == 0 and day.facts.off_route == 1
    assert len(rows) == 10


def test_rows_are_sorted_by_line_then_trip():
    paths = {
        trip: replace(_path(), route_id=route)
        for trip, route in (("a", "r9"), ("b", "r1"), ("c", "r5"))
    }
    readings = [
        reading._replace(trip_id=trip, vehicle_id=trip) for trip in "abc" for reading in _drive()
    ]
    day = build_stretch_day("stm", DAY, paths, readings)
    assert [row.route_id for row in day.pass_rows()][::10] == ["r1", "r5", "r9"]


def test_the_stretch_key_is_stable():
    assert stretch_key("51234", "51240", 3, 2) != stretch_key("51240", "51234", 3, 2)
    assert stretch_key("a", "b", 1, 1) == STABLE_KEY


def test_the_summary_counts_every_usable_pass_and_keeps_exact_quantiles():
    rng = Random(7)
    paths = {f"t{i}": replace(_path(), route_type=3) for i in range(30)}
    readings = []
    for i in range(30):
        drive = _drive(speed=rng.uniform(5, 15), every=rng.choice((15, 20, 30)))
        readings += [reading._replace(trip_id=f"t{i}", vehicle_id=f"v{i}") for reading in drive]
    day = build_stretch_day("stm", DAY, paths, readings)
    rows = day.summary_rows(ZONE)
    usable = [
        row for row in day.passes if row.moving_speed_kmh is not None and row.gap_seconds <= 90
    ]
    assert sum(row[8] for row in rows) == len(usable) == day.facts.summary_passes
    assert {row[4] for row in rows} == {3}
    assert {row[5] for row in rows} == {7}  # 12:00 UTC is 07:00 in Montréal in November
    key = stretch_key("stop1", "stop2", 5, 3)
    times = sorted(
        int((row.exited_at - row.entered_at).total_seconds())
        for row in usable
        if (row.from_stop, row.pieces, row.piece) == ("stop1", 5, 3)
    )
    expanded = sorted(
        seconds for row in rows if row[3] == key for seconds in [row[6]] * int(row[8])
    )
    assert expanded == times


def _metres_east(lon: float) -> float:
    return (lon - LON) * cos(radians(LAT)) * _METRES_PER_DEGREE


def _random_trip(
    rng: Random, trip: str
) -> tuple[TripPath, list[VehicleInterval], list[tuple[float, float]]]:
    """A trip on a 2 km street: when it truly was at each stop, and its clean intervals."""
    stops = [0.0]
    while stops[-1] < 1_850:
        stops.append(stops[-1] + rng.uniform(60, 450))
    stops[-1] = 2_000.0
    path = TripPath(
        "r1",
        0,
        "s1",
        [(_lon(x), LAT) for x in range(0, 2_001, 40)],
        [PathStop(i + 1, f"{trip}-{i + 1}", LAT, _lon(x)) for i, x in enumerate(stops)],
        3,
    )
    # True motion: a dwell at every stop, then a leg at its own speed.
    timeline = [(0.0, 0.0)]
    at_stop = []  # (arrival, departure) at each stop
    for target in stops[1:]:
        second, where = timeline[-1]
        arrival = second
        second += rng.uniform(0, 40)
        at_stop.append((arrival, second))
        timeline.append((second, where))
        second += (target - where) / rng.uniform(3, 20)
        timeline.append((second, target))
    at_stop.append((timeline[-1][0], timeline[-1][0]))

    def true_at(t: float) -> float:
        for (t0, d0), (t1, d1) in zip(timeline, timeline[1:], strict=False):
            if t0 <= t <= t1:
                return d0 if t1 == t0 else d0 + (t - t0) / (t1 - t0) * (d1 - d0)
        return timeline[-1][1]

    intervals: list[VehicleInterval] = []
    t = 0.0
    while t <= timeline[-1][0] + 30:
        along = true_at(t) + rng.uniform(-5, 5)
        detour = rng.random() < 0.02
        observed = START + t
        last = intervals[-1] if intervals else None
        # The clean day keeps a vehicle within 15 m of one place as one interval.
        if (
            last is not None
            and not detour
            and abs(_metres_east(last.lon) - along) <= 15
            and abs(_lat(0) - last.lat) < 1e-3
            and observed - (last.last_seen - 2) <= 60
        ):
            intervals[-1] = last._replace(last_seen=observed + 2, readings=last.readings + 1)
        else:
            north = 200.0 if detour else rng.uniform(-8, 8)
            intervals.append(
                VehicleInterval(
                    trip, trip, observed, observed + 2, observed + 2, 1, _lat(north), _lon(along)
                )
            )
        t += rng.choice((15, 20, 30, 45))
    return path, intervals, at_stop


def test_random_trips_keep_the_math_of_every_pass():
    rng = Random(20261127)
    paths, readings, truth = {}, [], {}
    for i in range(60):
        trip = f"t{i:02}"
        paths[trip], intervals, truth[trip] = _random_trip(rng, trip)
        readings += intervals
    day = build_stretch_day("stm", DAY, paths, readings)
    by_trip: dict[str, list[PassRow]] = {}
    for row in day.pass_rows():
        by_trip.setdefault(row.trip_id, []).append(row)
        duration = (row.exited_at - row.entered_at).total_seconds()
        assert duration >= 0
        assert 0 <= row.stopped_at_stop_seconds + row.stopped_between_stops_seconds <= duration
        assert row.moving_speed_kmh is None or 0 < row.moving_speed_kmh <= 108
    errors = []
    for trip, rows in by_trip.items():
        for before, after in zip(rows, rows[1:], strict=False):
            assert after.entered_at >= before.exited_at  # no overlap
        runs: dict[int, list[PassRow]] = {}
        for row in rows:
            runs.setdefault(row.from_sequence, []).append(row)
        last = len(paths[trip].stops) - 1
        for sequence, pieces in runs.items():
            if [row.piece for row in pieces] != list(range(1, pieces[0].pieces + 1)):
                continue
            for before, after in zip(pieces, pieces[1:], strict=False):
                assert before.exited_at == after.entered_at  # the pieces add up to the run
            if sequence in (1, last):
                continue  # line ends leave out their first and last 30 m
            # A stop is passed at some moment from arrival to departure, so the run
            # lies between the shortest and the longest arrival-departure spans.
            run = (pieces[-1].exited_at - pieces[0].entered_at).total_seconds()
            (arrive_a, leave_a), (arrive_b, leave_b) = truth[trip][sequence - 1 : sequence + 1]
            low, high = arrive_b - leave_a, leave_b - arrive_a
            errors.append(max(low - run, run - high, 0.0))
    # The pieces of each stop-to-stop run cover the run's whole length.
    lengths: dict[tuple[str, str, int], float] = {}
    for (from_stop, to_stop, pieces, _), row in day.stretches.items():
        lengths[from_stop, to_stop, pieces] = lengths.get(
            (from_stop, to_stop, pieces), 0.0
        ) + float(
            row[8]  # type: ignore[arg-type]
        )
    for (from_stop, to_stop, pieces), total in lengths.items():
        a, b = (
            stop
            for stop in paths[from_stop.split("-")[0]].stops
            if stop.stop_id in (from_stop, to_stop)
        )
        assert total == pytest.approx(
            _metres_east(b.lon) - _metres_east(a.lon), abs=0.1 * pieces + 1
        )  # type: ignore[arg-type]
    assert len(errors) > 200
    errors.sort()
    assert errors[int(len(errors) * 0.9)] <= 5  # nine runs in ten within 5 s of the truth
    assert errors[-1] <= 45  # none off by more than one reading interval
