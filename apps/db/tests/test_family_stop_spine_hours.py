from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

import duckdb

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 4, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("seed", (DAY, date(2026, 11, 2)), STAMP, 14, 10, "America/Toronto")
# Capture-day membership deliberately disagrees with the feed key on every row.
SEED = [
    ("A", "S", -1, "2026-11-01 05:30:00.000001+00"),
    ("A", "S", 300, "2026-11-01 06:30:00.000002+00"),
    ("A", "S", 301, "2026-11-01 06:40:00+00"),
    (None, "", 3600, "2026-11-01 07:00:00+00"),
    ("", "", -3600, "2026-11-01 04:00:00+00"),
    ("a", "é", 1, "2026-11-02 04:59:59.999999+00"),
    ("é", None, 2, "2026-11-01 08:00:00+00"),
    ("A", "S", None, "2026-11-01 09:00:00+00"),
    ("A", "S", 3601, "2026-11-01 10:00:00+00"),
    ("A", "S", -3601, "2026-11-01 11:00:00+00"),
    ("prior", "S", 10, "2026-11-01 03:59:59.999999+00"),
]


def write_inputs(root, request=REQUEST, rows=SEED):
    builder = resolve_builder("stop_spine_hours")
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "CREATE TABLE seed(route_id TEXT, delay_stop_id TEXT, delay_seconds INTEGER, "
            "captured_at_utc TIMESTAMPTZ)"
        )
        if rows:
            conn.executemany("INSERT INTO seed VALUES (?, ?, ?, ?)", rows)
        for need in builder.inputs(request):
            path = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
            path.parent.mkdir(parents=True, exist_ok=True)
            if need.relation == "core.providers":
                conn.execute(
                    "COPY (SELECT 'seed'::TEXT provider_id, ?::TEXT timezone) TO ? (FORMAT "
                    "PARQUET)",
                    [request.timezone, str(path)],
                )
            elif need.relation == "gold.fact_trip_delay_snapshot":
                conn.execute(
                    "COPY (SELECT 'seed'::TEXT provider_id, *, 20261020::INTEGER "
                    "snapshot_date_key FROM seed WHERE captured_at_utc::DATE=?::DATE) TO ? "
                    "(FORMAT PARQUET)",
                    [need.window, str(path)],
                )
            else:
                conn.execute(
                    "COPY (SELECT 'seed'::TEXT provider_id, TIMESTAMPTZ '2026-10-01 "
                    "00:00:00+00' period_start_utc, 'old'::TEXT stop_id, 'A'::TEXT route_id, "
                    "1::INTEGER observation_count, 2.00::DECIMAL(12,2) "
                    "avg_arrival_delay_seconds, 2.00::DECIMAL(12,2) "
                    "avg_departure_delay_seconds, 0::INTEGER severe_delay_count, TIMESTAMPTZ "
                    "'2026-10-02 00:00:00+00' built_at_utc WHERE false) TO ? (FORMAT PARQUET)",
                    [str(path)],
                )


def build(root, request=REQUEST):
    builder = resolve_builder("stop_spine_hours")
    assert builder is not None, "stop_spine_hours must be implemented"
    return run_family(
        builder, request, inputs_root=root, workdir=root, code_commit="a" * 40
    ).output.tables


def test_capture_day_spines_and_utc_hours_preserve_folds_filters_and_math(tmp_path):
    assert resolve_builder("stop_spine_hours") is not None, "stop_spine_hours must be implemented"
    write_inputs(tmp_path)
    tables = build(tmp_path)
    assert tables["gold.stop_delay_spine"].rows == (
        ("seed", "", "", DAY, 1, 0, -3600, STAMP),
        ("seed", "", "__unrouted__", DAY, 1, 1, 3600, STAMP),
        ("seed", "S", "A", DAY, 3, 1, 600, STAMP),
        ("seed", "é", "a", DAY, 1, 0, 1, STAMP),
    )
    assert tables["gold.stop_delay_shift_daily"].rows == tuple(
        (*r[:4], "night", *r[4:]) for r in tables["gold.stop_delay_spine"].rows
    )
    hours = tables["gold.stop_delay_hourly"]
    assert [(r[1].hour, r[4], r[5]) for r in hours.rows if r[2:4] == ("S", "A")] == [
        (5, 1, Decimal("-1.00")),
        (6, 2, Decimal("300.50")),
    ]
    # Independent plain-Python raw-fact calculation for every output grain.
    from zoneinfo import ZoneInfo

    valid = [
        (route if route is not None else "__unrouted__", stop, delay, datetime.fromisoformat(ts))
        for route, stop, delay, ts in SEED
        if stop is not None and delay is not None and abs(delay) <= 3600
    ]
    for name, table in tables.items():
        for row in map(lambda r: dict(zip(table.columns, r, strict=True)), table.rows):
            group = [
                d
                for route, stop, d, ts in valid
                if route == row["route_id"]
                and stop == row["stop_id"]
                and (
                    ts.replace(minute=0, second=0, microsecond=0) == row["period_start_utc"]
                    if "hourly" in name
                    else ts.astimezone(ZoneInfo(REQUEST.timezone)).date()
                    == row["provider_local_date"]
                )
            ]
            assert type(row["observation_count"]) is int and row["observation_count"] == len(group)
            assert 0 <= row["severe_delay_count"] == sum(d > 300 for d in group) <= len(group)
            if "hourly" in name:
                expected = (Decimal(sum(group)) / len(group)).quantize(
                    Decimal(".01"), rounding=ROUND_HALF_UP
                )
                assert (
                    row["avg_arrival_delay_seconds"]
                    == row["avg_departure_delay_seconds"]
                    == expected
                )
                assert expected.is_finite() and not (expected.is_zero() and expected.is_signed())
            else:
                assert row["sum_delay_seconds"] == sum(group)
    assert sum(r[4] for r in tables["gold.stop_delay_spine"].rows) == 6
    assert sum(r[5] for r in tables["gold.stop_delay_shift_daily"].rows) == 6
    assert sum(r[4] for r in hours.rows if r[1] >= datetime(2026, 11, 1, 4, tzinfo=UTC)) == 6


def test_half_cent_rounding_is_exact_for_positive_and_negative_means(tmp_path):
    rows = [
        (route, "S", value, "2026-11-01 06:00:00+00")
        for route, sign in [("A", 1), ("a", -1)]
        for value in [sign] + [0] * 199
    ]
    write_inputs(tmp_path, rows=rows)
    assert [r[5] for r in build(tmp_path)["gold.stop_delay_hourly"].rows] == [
        Decimal(".01"),
        Decimal("-.01"),
    ]


def test_empty_day_and_neighbouring_days_do_not_change_daily_output(tmp_path):
    write_inputs(tmp_path)
    together = build(tmp_path)
    alone = build(tmp_path, replace(REQUEST, local_dates=(DAY,)))
    for name in ("gold.stop_delay_spine", "gold.stop_delay_shift_daily"):
        assert together[name].rows == alone[name].rows
        assert all(r[3] == DAY for r in together[name].rows)


def test_hourly_keeps_closed_history_deletes_stale_and_keeps_unchanged_stamp(tmp_path):
    request = replace(REQUEST, local_dates=(DAY, date(2026, 11, 3)), open_window_days=2)
    write_inputs(tmp_path, request, [("A", "S", 2, "2026-11-03 06:00:00+00")])
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        for day, values in [
            (
                DAY,
                "('seed', TIMESTAMPTZ '2026-11-01 06:00:00+00', 'old', 'A', 7, 4.00, 4.00, 0, "
                "TIMESTAMPTZ '2026-11-02 00:00:00+00')",
            ),
            (
                date(2026, 11, 3),
                "('seed', TIMESTAMPTZ '2026-11-03 06:00:00+00', 'S', 'A', 1, 2.00, 2.00, 0, "
                "TIMESTAMPTZ '2026-11-03 07:00:00+00'), ('seed', TIMESTAMPTZ '2026-11-03 "
                "07:00:00+00', 'stale', 'A', 1, 9.00, 9.00, 0, TIMESTAMPTZ '2026-11-03 "
                "08:00:00+00')",
            ),
        ]:
            path = tmp_path / "gold.stop_delay_hourly" / f"local={day}.parquet"
            conn.execute(
                "CREATE OR REPLACE TEMP TABLE prior AS SELECT * FROM read_parquet(?)", [str(path)]
            )
            conn.execute(f"INSERT INTO prior VALUES {values}")
            conn.execute("COPY prior TO ? (FORMAT PARQUET)", [str(path)])
    rows = build(tmp_path, request)["gold.stop_delay_hourly"].rows
    assert [(r[2], r[4], r[-1]) for r in rows] == [
        ("old", 7, datetime(2026, 11, 2, tzinfo=UTC)),
        ("S", 1, datetime(2026, 11, 3, 7, tzinfo=UTC)),
    ]


def test_shift_parts_and_hourly_counts_reconcile_on_a_full_capture_day(tmp_path):
    request = replace(REQUEST, timezone="Etc/UTC")
    raw = [
        ("A", "S", value, f"2026-11-01 {hour:02}:00:00+00")
        for hour in (0, 6, 8, 9, 14, 15, 18, 19, 22, 23)
        for value in (0, 0, 1)
    ]
    write_inputs(tmp_path, request, raw)
    tables = build(tmp_path, request)
    spine = tables["gold.stop_delay_spine"].rows
    assert spine == (("seed", "S", "A", DAY, 30, 0, 10, STAMP),)
    shifts = tables["gold.stop_delay_shift_daily"].rows
    assert [(r[4], r[5], r[7]) for r in shifts] == [
        ("am_peak", 6, 2),
        ("evening", 6, 2),
        ("midday", 6, 2),
        ("night", 6, 2),
        ("pm_peak", 6, 2),
    ]
    hours = tables["gold.stop_delay_hourly"].rows
    assert all(r[4:8] == (3, Decimal(".33"), Decimal(".33"), 0) for r in hours)
    assert sum(r[4] for r in hours) == sum(r[5] for r in shifts) == spine[0][4]
    assert sum(r[7] for r in shifts) == spine[0][6] == sum(r[2] for r in raw)


def test_hourly_output_excludes_unrequested_local_days(tmp_path):
    request = replace(REQUEST, local_dates=(DAY,))
    write_inputs(
        tmp_path,
        request,
        [
            ("A", "S", 1, "2026-11-01 06:15:00+00"),
            ("A", "S", 300, "2026-11-03 08:45:00+00"),
        ],
    )
    hours = build(tmp_path, request)["gold.stop_delay_hourly"].rows
    assert hours == (
        (
            "seed",
            datetime(2026, 11, 1, 6, tzinfo=UTC),
            "S",
            "A",
            1,
            Decimal("1.00"),
            Decimal("1.00"),
            0,
            STAMP,
        ),
    )


def test_fractional_offset_is_refused_before_inputs_are_opened(tmp_path):
    import pytest

    request = replace(REQUEST, local_dates=(date(2026, 11, 2),), timezone="America/St_Johns")
    with pytest.raises(ValueError, match="fractional_utc_offset.*America/St_Johns.*2026-11-02"):
        build(tmp_path / "missing", request)
    assert not list(tmp_path.iterdir())


def test_integer_extreme_ghosts_are_excluded_without_abs_overflow(tmp_path):
    write_inputs(
        tmp_path,
        rows=[
            ("A", "S", delay, "2026-11-01 06:00:00+00") for delay in (1, -2147483648, 2147483647)
        ],
    )
    tables = build(tmp_path)
    assert tables["gold.stop_delay_spine"].rows == (("seed", "S", "A", DAY, 1, 0, 1, STAMP),)
    assert tables["gold.stop_delay_shift_daily"].rows == (
        ("seed", "S", "A", DAY, "night", 1, 0, 1, STAMP),
    )
    assert tables["gold.stop_delay_hourly"].rows == (
        (
            "seed",
            datetime(2026, 11, 1, 6, tzinfo=UTC),
            "S",
            "A",
            1,
            Decimal("1.00"),
            Decimal("1.00"),
            0,
            STAMP,
        ),
    )


def test_fractional_offset_later_in_day_is_refused_before_inputs(tmp_path):
    from zoneinfo import ZoneInfo

    import pytest

    day = date(2026, 4, 5)
    zone = ZoneInfo("Australia/Lord_Howe")
    assert datetime(2026, 4, 5, tzinfo=zone).utcoffset() == timedelta(hours=11)
    request = replace(REQUEST, local_dates=(day,), timezone=zone.key)
    with pytest.raises(ValueError, match="fractional_utc_offset.*Australia/Lord_Howe.*2026-04-05"):
        build(tmp_path / "missing", request)
    assert not list(tmp_path.iterdir())
