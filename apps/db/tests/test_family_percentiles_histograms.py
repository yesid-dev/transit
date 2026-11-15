from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest, utc_days
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 4, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("seed", (DAY, date(2026, 11, 2)), STAMP, 14, 10, "America/Toronto")
# route, delay stop, integer delay, capture timestamp. Feed-day keys deliberately differ.
SEED = [
    ("A", "A", 0, "2026-11-01 05:30:00.000001+00"),
    ("A", "A", 1, "2026-11-01 06:30:00.000002+00"),
    ("", "", -3600, "2026-11-01 04:00:00+00"),
    ("a", "a", 3600, "2026-11-02 04:59:59.999999+00"),
    ("é", "é", -1, "2026-11-01 07:00:00+00"),
    (None, "stop-only", 5, "2026-11-01 08:00:00+00"),
    ("route-only", None, 7, "2026-11-01 09:00:00+00"),
    ("null", "null", None, "2026-11-01 10:00:00+00"),
    ("ghost", "ghost", 3601, "2026-11-01 11:00:00+00"),
    ("ghost", "ghost", -3601, "2026-11-01 12:00:00+00"),
    ("prior", "prior", 9, "2026-11-01 03:59:59.999999+00"),
    ("next", "next", 11, "2026-11-02 05:00:00+00"),
]


def write_inputs(root, request=REQUEST, rows=SEED):
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "CREATE TABLE seed(route_id TEXT, delay_stop_id TEXT, delay_seconds INTEGER, "
            "captured_at_utc TIMESTAMPTZ)"
        )
        conn.executemany("INSERT INTO seed VALUES (?, ?, ?, ?)", rows)
        for window in utc_days(request):
            path = root / "gold.fact_trip_delay_snapshot" / f"{window}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            conn.execute(
                "COPY (SELECT 'seed'::TEXT provider_id, *, 20261031 snapshot_date_key "
                "FROM seed WHERE captured_at_utc::DATE = ?::DATE) TO ? (FORMAT PARQUET)",
                [window, str(path)],
            )
        path = root / "core.providers" / "all.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        conn.execute(
            "COPY (SELECT 'seed'::TEXT provider_id, ?::TEXT timezone) TO ? (FORMAT PARQUET)",
            [request.timezone, str(path)],
        )


def build(root, request=REQUEST):
    builder = resolve_builder("percentiles_histograms")
    assert builder is not None, "percentiles_histograms must be implemented"
    return run_family(builder, request, inputs_root=root, workdir=root, code_commit="a" * 40)


def test_capture_day_preserves_folds_binary_ids_nulls_and_numeric_types(tmp_path):
    write_inputs(tmp_path)
    output = build(tmp_path).output
    for entity in ("route", "stop"):
        only, delay = ("route-only", "7.00") if entity == "route" else ("stop-only", "5.00")
        assert output.tables[f"gold.{entity}_delay_percentile_daily"].rows == tuple(
            ("seed", day, key, count, Decimal(p50), Decimal(p90), STAMP)
            for day, key, count, p50, p90 in [
                (DAY, "", 1, "-3600.00", "-3600.00"),
                (DAY, "A", 2, "0.50", "0.90"),
                (DAY, "a", 1, "3600.00", "3600.00"),
                (DAY, only, 1, delay, delay),
                (DAY, "é", 1, "-1.00", "-1.00"),
                (date(2026, 11, 2), "next", 1, "11.00", "11.00"),
            ]
        )
    assert output.bodies == {}


def test_integer_extremes_are_excluded_without_overflowing_the_build(tmp_path):
    rows = [
        ("edge", "edge", delay, "2026-11-01T14:00:00+00:00")
        for delay in (0, 1, -2147483648, 2147483647)
    ]
    write_inputs(tmp_path, rows=rows)
    output = build(tmp_path).output
    for entity in ("route", "stop"):
        assert output.tables[f"gold.{entity}_delay_percentile_daily"].rows == (
            ("seed", DAY, "edge", 2, Decimal("0.50"), Decimal("0.90"), STAMP),
        )
    assert_math(output, REQUEST, rows)


def percentile_cont(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def assert_math(output, request, rows):
    zone = ZoneInfo(request.timezone)
    for entity, index in (("route", 0), ("stop", 1)):
        groups = {}
        for row in rows:
            key, delay = row[index], row[2]
            day = datetime.fromisoformat(row[3]).astimezone(zone).date()
            if day in request.local_dates and key is not None and delay is not None:
                if abs(delay) <= 3600:
                    groups.setdefault((day, key), []).append(delay)
        table = output.tables[f"gold.{entity}_delay_percentile_daily"]
        assert sum(row[3] for row in table.rows) == sum(map(len, groups.values()))
        assert {(row[1], row[2]) for row in table.rows} == set(groups)
        for _, day, key, count, p50, p90, stamp in table.rows:
            assert type(count) is int and count >= 0
            assert p50.is_finite() and p90.is_finite() and p50 <= p90
            assert not (p50.is_zero() and p50.is_signed())
            assert not (p90.is_zero() and p90.is_signed())
            assert "\0" not in key and stamp == request.as_of_utc
            values = groups[day, key]
            assert count == len(values)
            expected = [
                percentile_cont(values, fraction).quantize(Decimal("0.01"), ROUND_HALF_UP)
                for fraction in (Decimal("0.5"), Decimal("0.9"))
            ]
            assert [p50, p90] == expected


def test_percentiles_reconcile_with_plain_python_math_and_empty_day(tmp_path):
    request = replace(REQUEST, local_dates=(DAY, date(2026, 11, 2), date(2026, 11, 3)))
    # Generate a broader population from a small integer seed; include signed medians.
    rows = SEED + [
        ("math", "math", delay, "2026-11-01 14:00:00+00") for delay in (-9, -2, 0, 1, 8, 17, 31)
    ]
    write_inputs(tmp_path, request, rows)
    assert_math(build(tmp_path, request).output, request, rows)


def test_day_is_independent_of_neighbouring_requested_days(tmp_path):
    write_inputs(tmp_path)
    alone = build(tmp_path, replace(REQUEST, local_dates=(DAY,))).output
    combined = build(tmp_path).output
    for relation, table in alone.tables.items():
        assert table.rows == tuple(row for row in combined.tables[relation].rows if row[1] == DAY)


@pytest.mark.parametrize("zone", ["Etc/UTC", "America/Toronto"])
def test_retention_boundary_is_exact_and_refused_before_input_io(tmp_path, zone):
    midnight = datetime.combine(DAY, time(), ZoneInfo(zone)).astimezone(UTC)
    request = replace(
        REQUEST, timezone=zone, local_dates=(DAY,), as_of_utc=midnight + timedelta(days=14)
    )
    rows = [("cutoff", "cutoff", 1, midnight.isoformat())]
    write_inputs(tmp_path, request, rows)
    assert_math(build(tmp_path, request).output, request, rows)
    request = replace(request, as_of_utc=request.as_of_utc + timedelta(microseconds=1))
    with pytest.raises(ValueError, match="retention_edge_day 2026-11-01"):
        build(tmp_path / "absent", request)
