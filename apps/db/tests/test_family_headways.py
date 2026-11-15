from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from fractions import Fraction
from statistics import median, stdev

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.headways import HeadwaysBuilder
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 2)
STAMP = datetime(2026, 11, 4, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("seed", (DAY, date(2026, 11, 3)), STAMP, 14, 10, "America/Toronto")
EDGE_SECONDS = (
    1,
    30,
    60,
    120,
    180,
    240,
    300,
    360,
    480,
    600,
    720,
    900,
    1200,
    1500,
    1800,
    2400,
    3600,
    5400,
    7200,
    10800,
    14399,
    14400,
)
BUNCHING_GAPS = ((2, 4, 6), (62, 124, 186), (62, 124, 124, 186), (61, 124, 124, 187))


def bunching_rows(gaps):
    elapsed = 0
    rows = []
    for i, seconds in enumerate((0, *gaps)):
        elapsed += seconds
        rows.append(
            (
                "A",
                f"b{i}",
                0,
                DAY,
                datetime(2026, 11, 2, 12, tzinfo=UTC) + timedelta(seconds=elapsed),
                0,
                DAY,
                20261102,
            )
        )
    return rows


def edge_rows():
    start = datetime(2026, 11, 2, 5, tzinfo=UTC)
    return [
        (str(seconds), f"t{i}", 0, DAY, start + timedelta(seconds=i * seconds), 3600, DAY, 20261102)
        for seconds in EDGE_SECONDS
        for i in (0, 1)
    ]


def seed_rows():
    rows = []
    # Exact half-way median (6.25); ties, binary ids, empty versus missing route.
    for route in ("", "A", "a", "é", None):
        for i, seconds in enumerate((0, 60, 435, 1035)):
            rows.append(
                (
                    route,
                    f"t{i}",
                    0,
                    DAY,
                    datetime(2026, 11, 2, 12, tzinfo=UTC)
                    + timedelta(seconds=seconds, microseconds=1),
                    0,
                    DAY,
                    20261102,
                )
            )
    # Weekend fall-back folds belong to direction/daytype only.
    for i, hour in enumerate((5, 6)):
        rows.append(
            (
                "fold",
                f"f{i}",
                None,
                None,
                datetime(2026, 11, 1, hour, 30, tzinfo=UTC),
                0,
                date(2026, 11, 1),
                20261101,
            )
        )
    return rows


def write_inputs(root, request=REQUEST, rows=None):
    rows = seed_rows() if rows is None else rows
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "CREATE TABLE seed(route_id TEXT, trip_id TEXT, direction_id INTEGER, "
            "start_date DATE, captured_at_utc TIMESTAMPTZ, delay_seconds INTEGER, "
            "snapshot_local_date DATE, snapshot_date_key INTEGER)"
        )
        if rows:
            conn.executemany("INSERT INTO seed VALUES (?,?,?,?,?,?,?,?)", rows)
        for offset in range(request.fact_retention_days + 1):
            day = request.as_of_utc.date() - timedelta(days=offset)
            path = root / "gold.fact_trip_delay_snapshot" / f"{day}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            conn.execute(
                "COPY (SELECT 'seed' provider_id, * FROM seed WHERE "
                "captured_at_utc::DATE = ?) TO ? (FORMAT PARQUET)",
                [day, str(path)],
            )
        path = root / "core.providers" / "all.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        conn.execute(
            "COPY (SELECT 'seed' provider_id, ?::TEXT timezone) TO ? (FORMAT PARQUET)",
            [request.timezone, str(path)],
        )


def test_headways_match_independent_gap_math_and_keep_weekend_direction(tmp_path):
    builder = HeadwaysBuilder()
    write_inputs(tmp_path)
    tables = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    ).output.tables
    gaps = [
        (b[4] - a[4]).total_seconds() / 60
        for a, b in zip(seed_rows()[:3], seed_rows()[1:4], strict=True)
    ]
    assert gaps == [1, 6.25, 10]
    shift = tables["gold.route_headway_by_shift"]
    assert shift.rows == tuple(
        ("seed", r, "am_peak", "6.3", 3, STAMP, Decimal("0.7862"), 1) for r in ("", "A", "a", "é")
    )
    assert median(gaps) == 6.25
    assert round(stdev(gaps) / (sum(gaps) / len(gaps)), 4) == 0.7862
    direction = tables["gold.route_headway_by_direction_shift"]
    assert direction.rows == tuple(
        sorted(
            [("seed", r, 0, "am_peak", "weekday", "6.3", 3, STAMP) for r in ("", "A", "a", "é")]
            + [("seed", "fold", 0, "night", "weekend", "60.0", 1, STAMP)]
        )
    )


def test_daily_headways_reconcile_gap_moments_and_histogram(tmp_path):
    builder = resolve_builder("headways")
    assert builder is not None, "headways must be implemented"
    write_inputs(tmp_path)
    tables = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    ).output.tables
    gaps = [1, 6.25, 10]
    daily = tables["gold.route_headway_shift_daily"]
    for row in daily.rows:
        values = dict(zip(daily.columns, row, strict=True))
        assert values["provider_local_date"] == DAY
        assert values["gap_count"] == len(gaps)
        assert Decimal(values["sum_gap_min"]) == Decimal("17.25")
        assert Decimal(values["sum_gap_sq_min"]) == Decimal("140.0625")
        assert values["trip_count"] == 4
        assert values["bunched_gap_count"] == 1
        histogram = [int(n) for n in values["gap_histogram"].strip("{}").split(",")]
        assert sum(histogram) == len(gaps)
        assert all(n >= 0 for n in histogram)
        assert min(gaps) <= float(Decimal(values["sum_gap_min"])) / len(gaps) <= max(gaps)
    assert len(daily.rows) == 4


def test_daily_microsecond_gap_keeps_exact_squared_numeric(tmp_path):
    builder = resolve_builder("headways")
    assert builder is not None, "headways must be implemented"
    first = ("A", "one", 0, DAY, datetime(2026, 11, 2, 12, tzinfo=UTC), 0, DAY, 20261102)
    second = ("A", "two", 0, DAY, first[4] + timedelta(microseconds=1), 0, DAY, 20261102)
    write_inputs(tmp_path, rows=[first, second])
    output = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    ).output.tables["gold.route_headway_shift_daily"]
    row = dict(zip(output.columns, output.rows[0], strict=True))
    assert row["gap_count"] == 1
    assert row["sum_gap_min"] == "0.000000016666666666666667"
    # Independent rational long division, rounded at PostgreSQL's scale 24.
    exact = Fraction(1, 60_000_000)
    rounded = Fraction(round(exact * 10**24), 10**24)
    assert Fraction(row["sum_gap_min"]) == rounded
    assert abs(Fraction(row["sum_gap_min"]) - exact) <= Fraction(1, 2 * 10**24)
    assert Fraction(row["sum_gap_sq_min"]) == rounded**2
    assert len(row["sum_gap_sq_min"].split(".")[1]) == 48


def test_retained_witness_vetoes_phantom_start_independent_of_requested_neighbours(tmp_path):
    from dataclasses import replace

    rows = seed_rows()[:4]
    witness = (*rows[0][:4], rows[0][4] - timedelta(days=1), 0, DAY - timedelta(days=1), 20261101)
    write_inputs(tmp_path, rows=[*rows, witness])
    builder = resolve_builder("headways")
    alone = run_family(
        builder,
        replace(REQUEST, local_dates=(DAY,)),
        inputs_root=tmp_path,
        workdir=tmp_path,
        code_commit="a" * 40,
    )
    combined = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    table = alone.output.tables["gold.route_headway_shift_daily"]
    row = dict(zip(table.columns, table.rows[0], strict=True))
    assert row["gap_count"] == 2
    assert row["trip_count"] == 3
    assert Decimal(row["sum_gap_min"]) == Decimal("16.25")
    assert table == combined.output.tables[table.relation]


def test_retention_edge_is_refused_before_reading_inputs(tmp_path):
    from dataclasses import replace

    with pytest.raises(ValueError, match="retention_edge_day 2026-10-21"):
        run_family(
            resolve_builder("headways"),
            replace(REQUEST, local_dates=(date(2026, 10, 21),)),
            inputs_root=tmp_path / "missing",
            workdir=tmp_path,
            code_commit="a" * 40,
        )


def test_histogram_edges_clamp_and_delay_filters_reconcile_with_integer_facts(tmp_path):
    rows = edge_rows()
    # Invalid delay, missing trip, duplicate ping and missing delay cannot invent starts.
    bad = [
        ("bad", "x", 0, DAY, rows[0][4], 3601, DAY, 20261102),
        ("bad", None, 0, DAY, rows[0][4], 0, DAY, 20261102),
        ("bad", "y", 0, DAY, rows[0][4], None, DAY, 20261102),
    ]
    write_inputs(tmp_path, rows=[*rows, *bad, rows[0]])
    tables = run_family(
        resolve_builder("headways"),
        REQUEST,
        inputs_root=tmp_path,
        workdir=tmp_path,
        code_commit="a" * 40,
    ).output.tables
    daily = tables["gold.route_headway_shift_daily"]
    assert len(daily.rows) == len(EDGE_SECONDS) - 1
    for record in daily.rows:
        row = dict(zip(daily.columns, record, strict=True))
        seconds = int(row["route_id"])
        histogram = [int(v) for v in row["gap_histogram"].strip("{}").split(",")]
        # The first 20 seeds sit at successive published bin lower bounds;
        # 14399 seconds stays in the last bin, 14400 is excluded altogether.
        expected_bin = min(EDGE_SECONDS.index(seconds), 19)
        assert histogram == [int(i == expected_bin) for i in range(20)]
        assert row["gap_count"] == 1 and row["trip_count"] == 2
        value = Fraction(row["sum_gap_min"])
        assert value > 0
        assert abs(value - Fraction(seconds, 60)) <= Fraction(1, 2 * 10**16)
        assert Fraction(row["sum_gap_sq_min"]) == value * value
    for table in tables.values():
        for record in table.rows:
            row = dict(zip(table.columns, record, strict=True))
            assert row.get("headway_cov") is None
            for column in ("observed_headway_min", "sum_gap_min", "sum_gap_sq_min"):
                if column in row:
                    value = Decimal(row[column])
                    assert value.is_finite() and value >= 0
                    assert not (value.is_zero() and value.is_signed())


@pytest.mark.parametrize("gaps", BUNCHING_GAPS)
def test_bunching_uses_strict_exact_half_median_for_odd_and_even_samples(tmp_path, gaps):
    write_inputs(tmp_path, rows=bunching_rows(gaps))
    tables = run_family(
        resolve_builder("headways"),
        REQUEST,
        inputs_root=tmp_path,
        workdir=tmp_path,
        code_commit="a" * 40,
    ).output.tables
    rational_gaps = [Fraction(gap, 60) for gap in gaps]
    threshold = median(rational_gaps) / 2
    expected = sum(gap < threshold for gap in rational_gaps)
    assert expected == (1 if gaps[0] == 61 else 0)
    for name, column in (
        ("route_headway_by_shift", "bunched_count"),
        ("route_headway_shift_daily", "bunched_gap_count"),
    ):
        table = tables["gold." + name]
        assert [dict(zip(table.columns, row, strict=True))[column] for row in table.rows] == [
            expected
        ]


def test_integer_minimum_delay_does_not_change_valid_rows_or_veto_trip_start(tmp_path):
    builder = resolve_builder("headways")
    write_inputs(tmp_path)
    expected = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    ).output
    first = seed_rows()[0]
    invalid = [
        (*first[:5], -2147483648, *first[6:]),
        (*first[:4], first[4] - timedelta(days=1), -2147483648, DAY - timedelta(days=1), 20261101),
    ]
    write_inputs(tmp_path, rows=[*seed_rows(), *invalid])
    actual = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    ).output
    assert actual == expected
