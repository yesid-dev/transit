from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal
from fractions import Fraction

import duckdb

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 4, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest(
    "repeat_offenders_seed", (DAY, date(2026, 11, 2)), STAMP, 14, 10, "America/Toronto"
)
SEED = [
    ("A", "T", "V", 300, "2026-11-01 05:30:00.000001+00"),
    ("A", "T", "V", 301, "2026-11-01 06:30:00.000002+00"),
    ("", "", None, -3600, "2026-11-01 04:00:00+00"),
    ("a", None, "é", 3600, "2026-11-02 04:59:59.999999+00"),
    (None, "T", "V", 1, "2026-11-01 07:00:00+00"),
    ("A", "T", "V", None, "2026-11-01 08:00:00+00"),
    *[("A", "T", "V", d, "2026-11-01 09:00:00+00") for d in (-2147483648, 2147483647, -3601, 3601)],
    ("prior", "T", "V", 1, "2026-11-01 03:59:59.999999+00"),
]
# (kind, id, route, day, severe count, exact sum, in-clamp count)
SPINES = [
    ("route", "A", "A", DAY, 1, 601, 2),
    ("route", "A", "A", date(2026, 10, 31), 0, 1, 3),
    ("route", "a", "a", DAY, 0, 120001, 200),
    ("route", "é", "é", DAY, 10, 1, 30),
    ("stop", "", "__unrouted__", DAY, 1, -1, 200),
    ("stop", "S", "A", DAY, 0, 60001, 200),
    ("stop", "watch", "A", DAY, 0, 60000, 200),
    ("stop", "null", "A", DAY, 0, 0, 0),
]


def write_inputs(root, request=REQUEST, rows=SEED):
    builder = resolve_builder("repeat_offenders")
    assert builder is not None, "repeat_offenders must be implemented"
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "CREATE TABLE facts(route_id TEXT, trip_id TEXT, vehicle_id TEXT, "
            "delay_seconds INTEGER, captured_at_utc TIMESTAMPTZ)"
        )
        if rows:
            conn.executemany("INSERT INTO facts VALUES (?,?,?,?,?)", rows)
        conn.execute(
            "CREATE TABLE spines(kind TEXT, id TEXT, route TEXT, day DATE, "
            "severe INTEGER, total BIGINT, n INTEGER)"
        )
        conn.executemany("INSERT INTO spines VALUES (?,?,?,?,?,?,?)", SPINES)
        for need in builder.inputs(request):
            path = root / need.relation / (need.window.replace(":", "=") + ".parquet")
            path.parent.mkdir(parents=True, exist_ok=True)
            if need.relation == "core.providers":
                sql, args = (
                    "SELECT ?::TEXT provider_id, ?::TEXT timezone",
                    [request.provider_id, request.timezone],
                )
            elif need.relation == "gold.fact_trip_delay_snapshot":
                sql = "SELECT ?::TEXT provider_id, * FROM facts WHERE captured_at_utc::DATE=?::DATE"
                args = [request.provider_id, need.window]
            else:
                route = need.relation == "gold.route_delay_spine"
                identity = "route route_id" if route else "id stop_id, route route_id"
                count = "[n]::SMALLINT[] delay_histogram" if route else "n observation_count"
                sql = (
                    f"SELECT ?::TEXT provider_id, {identity}, day provider_local_date, "
                    f"severe severe_delay_count, total sum_delay_seconds, {count} "
                    "FROM spines WHERE kind=? AND day=?::DATE"
                )
                args = [
                    request.provider_id,
                    "route" if route else "stop",
                    need.window.removeprefix("local:"),
                ]
            conn.execute(f"COPY ({sql}) TO ? (FORMAT PARQUET)", [*args, str(path)])


def build(root, request=REQUEST):
    builder = resolve_builder("repeat_offenders")
    assert builder is not None, "repeat_offenders must be implemented"
    return run_family(
        builder, request, inputs_root=root, workdir=root, code_commit="a" * 40
    ).output.tables


def test_daily_capture_day_filters_and_independent_entity_counts(tmp_path):
    write_inputs(tmp_path)
    rows = build(tmp_path)["gold.repeat_offender_daily_spine"].rows
    p = REQUEST.provider_id
    assert rows == (
        (p, "trip", "", "", DAY, 1, 0, -3600, STAMP),
        (p, "trip", "T", "A", DAY, 2, 1, 601, STAMP),
        (p, "vehicle", "V", "A", DAY, 2, 1, 601, STAMP),
        (p, "vehicle", "é", "a", DAY, 1, 1, 3600, STAMP),
    )
    from zoneinfo import ZoneInfo

    for _, kind, entity, route, day, count, severe, total, stamp in rows:
        values = [
            d
            for r, t, v, d, ts in SEED
            if r == route
            and (t if kind == "trip" else v) == entity
            and d is not None
            and -3600 <= d <= 3600
            and datetime.fromisoformat(ts).astimezone(ZoneInfo(REQUEST.timezone)).date() == day
        ]
        assert type(count) is int and count == len(values) > 0
        assert type(severe) is int and 0 <= severe == sum(d > 300 for d in values) <= count
        assert total == sum(values) and stamp == STAMP
    assert (
        build(tmp_path, replace(REQUEST, local_dates=(DAY,)))[
            "gold.repeat_offender_daily_spine"
        ].rows
        == rows
    )


def test_weekly_pooled_means_exact_half_cents_and_severity(tmp_path):
    write_inputs(tmp_path)
    rows = build(tmp_path)["gold.repeated_problem_route_stop"].rows
    assert [(r[1:4], r[6:9]) for r in rows] == [
        (("route", "A", "A"), (1, Decimal("120.40"), "high")),
        (("route", "a", "a"), (0, Decimal("600.01"), "critical")),
        (("route", "é", "é"), (10, Decimal("0.03"), "critical")),
        (("stop", "", "__unrouted__"), (1, Decimal("-0.01"), "high")),
        (("stop", "S", "A"), (0, Decimal("300.01"), "high")),
    ]
    for _, kind, entity, route, grain, week, issues, mean, _severity, stamp in rows:
        group = [r for r in SPINES if r[:3] == (kind, entity, route)]
        assert grain == "week" and week == date(2026, 10, 26) and stamp == STAMP
        assert type(issues) is int and issues == sum(r[4] for r in group) >= 0
        n = sum(r[6] for r in group)
        if n:
            exact = Fraction(sum(r[5] for r in group), n) * 100
            rounded = (abs(exact).numerator * 2 + exact.denominator) // (2 * exact.denominator)
            assert Fraction(mean) == Fraction(rounded if exact >= 0 else -rounded, 100)
            assert mean.is_finite() and not (mean.is_zero() and mean.is_signed())
        else:
            assert mean is None


def test_empty_day_has_no_daily_rows_and_fractional_zone_is_supported(tmp_path):
    request = replace(REQUEST, timezone="America/St_Johns")
    write_inputs(tmp_path, request, [])
    assert build(tmp_path, request)["gold.repeat_offender_daily_spine"].rows == ()


def test_retention_boundary_accepts_the_entire_day_and_refuses_partial_day(tmp_path):
    from datetime import timedelta

    import pytest

    request = replace(REQUEST, as_of_utc=datetime(2026, 11, 15, 4, tzinfo=UTC))
    write_inputs(tmp_path, request)
    rows = build(tmp_path, request)["gold.repeat_offender_daily_spine"].rows
    assert [(r[1:4], r[5:8]) for r in rows] == [
        (("trip", "", ""), (1, 0, -3600)),
        (("trip", "T", "A"), (2, 1, 601)),
        (("vehicle", "V", "A"), (2, 1, 601)),
        (("vehicle", "é", "a"), (1, 1, 3600)),
    ]
    with pytest.raises(ValueError, match="retention_edge_day 2026-11-01"):
        build(tmp_path, replace(request, as_of_utc=request.as_of_utc + timedelta(microseconds=1)))


def test_weekly_histograms_read_lossless_postgres_array_text_exports(tmp_path):
    import csv
    from shutil import copyfile

    from transit_ops.lake.parquet_codec import write_window
    from transit_ops.lake.table_schema import TableSchema

    native, exported = tmp_path / "native", tmp_path / "exported"
    write_inputs(native)
    schema = TableSchema.from_columns(
        [
            ("provider_id", "text", True),
            ("route_id", "text", True),
            ("provider_local_date", "date", True),
            ("severe_delay_count", "integer", True),
            ("sum_delay_seconds", "bigint", True),
            ("delay_histogram", "smallint[]", False),
        ],
        ("provider_id", "route_id", "provider_local_date"),
    )
    for source in native.rglob("*.parquet"):
        target = exported / source.relative_to(native)
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.parent.name != "gold.route_delay_spine":
            copyfile(source, target)
            continue
        with duckdb.connect() as conn:
            rows = conn.execute("SELECT * FROM read_parquet(?)", [str(source)]).fetchall()
        with target.with_suffix(".csv").open("w", encoding="utf-8", newline="") as file:
            writer = csv.writer(file, lineterminator="\n")
            writer.writerow(c.name for c in schema.columns)
            for row in rows:
                # COPY array text, including NULL elements.
                histogram = "{" + ",".join(str(n) for n in row[-1]) + ",NULL}"
                writer.writerow((*row[:-1], histogram))
        write_window(target.with_suffix(".csv"), schema, target, metadata={}, temp_dir=tmp_path)
        with duckdb.connect() as conn:
            assert (
                conn.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(target)]).fetchall()[
                    -1
                ][1]
                == "VARCHAR"
            )
    assert build(exported) == build(native)
