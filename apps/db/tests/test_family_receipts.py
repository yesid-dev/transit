from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.replay import family_input_needs
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 5, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("receipts_seed", (DAY,), STAMP, 14, 10, "America/Toronto")
# route, local hour, direction, severe, delayed, sum, histogram
ROUTES = [(r, 1, i, 1, 2, 601, [1, 1]) for i, r in enumerate(("", "A", "a", "é"))]
# stop, UTC hour, arrival, departure, severe
STOPS = [
    ("S", 5, Decimal("300.01"), None, 0),
    ("S", 6, None, 301, 0),
    ("", 7, Decimal("0.10"), 900, 0),
    (None, 8, None, None, 1),
]
ALERTS = [(None, None, None, None), ("", "", "", ""), ("x", "", "", "")]


def write_inputs(root, request=REQUEST, routes=ROUTES, stops=STOPS, alerts=ALERTS):
    builder = resolve_builder("receipts")
    assert builder is not None, "receipts must be implemented"
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute("CREATE SCHEMA gold; CREATE SCHEMA silver; CREATE SCHEMA core")
        conn.execute("CREATE TABLE core.providers(provider_id TEXT, timezone TEXT)")
        conn.execute(
            "INSERT INTO core.providers VALUES (?,?)", [request.provider_id, request.timezone]
        )
        conn.execute(
            "CREATE TABLE gold.route_delay_spine(provider_id TEXT, route_id TEXT, "
            "provider_local_date DATE, hour_of_day_local INTEGER, direction_id INTEGER, "
            "severe_delay_count INTEGER, delayed_trip_count INTEGER, "
            "sum_delay_seconds BIGINT, delay_histogram BIGINT[])"
        )
        for r, hour, direction, severe, delayed, total, hist in routes:
            conn.execute(
                "INSERT INTO gold.route_delay_spine VALUES (?,?,?,?,?,?,?,?,?)",
                [request.provider_id, r, DAY, hour, direction, severe, delayed, total, hist],
            )
        conn.execute(
            "CREATE TABLE gold.stop_delay_hourly(provider_id TEXT, stop_id TEXT, "
            "period_start_utc TIMESTAMPTZ, avg_arrival_delay_seconds DECIMAL(12,2), "
            "avg_departure_delay_seconds DECIMAL(12,2), severe_delay_count INTEGER)"
        )
        for stop, hour, arrival, departure, severe in stops:
            conn.execute(
                "INSERT INTO gold.stop_delay_hourly VALUES (?,?,?,?,?,?)",
                [
                    request.provider_id,
                    stop,
                    datetime(2026, 11, 1, hour, tzinfo=UTC),
                    arrival,
                    departure,
                    severe,
                ],
            )
        conn.execute(
            "CREATE TABLE silver.i3_alerts(provider_id TEXT, captured_at_utc TIMESTAMPTZ, "
            "description_text TEXT, severity TEXT, cause TEXT, effect TEXT)"
        )
        for description, severity, cause, effect in alerts:
            conn.execute(
                "INSERT INTO silver.i3_alerts VALUES (?,?,?,?,?,?)",
                [
                    request.provider_id,
                    datetime(2026, 11, 1, 6, 0, 0, 1, UTC),
                    description,
                    severity,
                    cause,
                    effect,
                ],
            )
        for need in builder.inputs(request):
            path = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
            path.parent.mkdir(parents=True, exist_ok=True)
            where = ""
            if need.relation == "gold.stop_delay_hourly":
                where = f" WHERE period_start_utc::DATE = DATE '{need.window}'"
            conn.execute(
                f"COPY (SELECT * FROM {need.relation}{where}) TO ? (FORMAT PARQUET)", [str(path)]
            )


def build(root, request=REQUEST, **kwargs):
    write_inputs(root, request, **kwargs)
    return (
        run_family(
            resolve_builder("receipts"),
            request,
            inputs_root=root,
            workdir=root,
            code_commit="a" * 40,
        )
        .output.tables["gold.citizen_accountability_daily"]
        .rows
    )


def test_counts_and_score_reconcile_with_independent_arithmetic(tmp_path):
    rows = build(tmp_path)
    # Four distinct route ids, one distinct affected stop despite the repeated hour.
    # Null/empty alert descriptions have identical content; x is the second hash.
    severe = sum(r[3] for r in ROUTES)
    delayed = sum(r[4] for r in ROUTES)
    score = Decimal(2 * 4 + 1 + delayed + 3 * severe + 2 * 2)
    assert rows == (("receipts_seed", DAY, 4, 1, delayed, severe, 2, score, STAMP),)
    assert all(type(n) is int and n >= 0 for n in rows[0][2:7])
    assert score.is_finite() and not score.is_signed()


@pytest.mark.parametrize(
    "routes,stops,alerts,expected",
    [
        ([], [], ALERTS, (None, None, 0, 0, 2, None)),
        ([], STOPS, [], (None, 1, 0, 0, 0, Decimal("1"))),
        ([], [], [], None),
        ([("tie", 0, 0, 0, 0, 60001, [200])], [], [], (1, None, 0, 0, 0, Decimal("2"))),
        (
            [("cap", 0, 0, 4000, 4000, 0, [1])],
            [],
            [],
            (1, None, 4000, 4000, 0, Decimal("9999.9999")),
        ),
    ],
)
def test_missing_telemetry_exact_halfway_mean_and_score_clamp(
    tmp_path, routes, stops, alerts, expected
):
    rows = build(tmp_path, routes=routes, stops=stops, alerts=alerts)
    assert rows == (() if expected is None else (("receipts_seed", DAY, *expected, STAMP),))


def test_requested_empty_day_does_not_leak_other_dates(tmp_path):
    assert build(tmp_path, replace(REQUEST, local_dates=(date(2026, 11, 2),))) == ()


def test_fixed_day_is_whole_even_outside_the_reporting_open_window(tmp_path):
    assert build(tmp_path, replace(REQUEST, open_window_days=1)) == (
        ("receipts_seed", DAY, 4, 1, 8, 4, 2, Decimal("33.0000"), STAMP),
    )


def test_fractional_hour_zone_refuses_before_reading_inputs():
    builder = resolve_builder("receipts")
    assert builder is not None, "receipts must be implemented"
    with pytest.raises(ValueError, match="fractional_utc_offset"):
        builder.inputs(replace(REQUEST, timezone="America/St_Johns"))


def test_archive_preflight_resolves_the_alert_source():
    from transit_ops.batch.build import InputNeed

    builder = resolve_builder("receipts")
    assert builder is not None
    assert InputNeed("silver.i3_alerts", "all") in family_input_needs([builder], REQUEST)


def test_histograms_match_native_lists_after_canonical_export(tmp_path):
    import csv
    from shutil import copyfile

    from transit_ops.lake.parquet_codec import write_window
    from transit_ops.lake.table_schema import TableSchema

    native, exported = tmp_path / "native", tmp_path / "exported"
    routes = [
        *ROUTES,
        ("nullable", 2, 0, 0, 1, 601, [1, None, 1]),
        ("empty", 2, 0, 0, 0, 0, []),
        ("null", 2, 0, 0, 0, 0, None),
        ("all-null", 2, 0, 0, 0, 0, [None]),
    ]
    write_inputs(native, routes=routes, stops=[s for s in STOPS if s[0] is not None])
    pg_types = {
        "VARCHAR": "text",
        "DATE": "date",
        "INTEGER": "integer",
        "BIGINT": "bigint",
        "BIGINT[]": "smallint[]",
        "DECIMAL(12,2)": "numeric(12,2)",
        "TIMESTAMP WITH TIME ZONE": "timestamp with time zone",
    }
    for source in native.rglob("*.parquet"):
        target = exported / source.relative_to(native)
        target.parent.mkdir(parents=True, exist_ok=True)
        route = source.parent.name == "gold.route_delay_spine"
        if not route and source.parent.name != "gold.stop_delay_hourly":
            copyfile(source, target)
            continue
        key = (
            ("provider_id", "route_id", "provider_local_date", "hour_of_day_local", "direction_id")
            if route
            else ("provider_id", "period_start_utc", "stop_id")
        )
        with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
            columns = conn.execute(
                "DESCRIBE SELECT * FROM read_parquet(?)", [str(source)]
            ).fetchall()
            projection = (
                "*" if route else "* REPLACE (period_start_utc::VARCHAR AS period_start_utc)"
            )
            rows = conn.execute(
                f"SELECT {projection} FROM read_parquet(?)", [str(source)]
            ).fetchall()
        schema = TableSchema.from_columns(
            [(name, pg_types[kind], name in key) for name, kind, *_ in columns], key
        )
        with target.with_suffix(".csv").open("w", encoding="utf-8", newline="") as stream:
            stream.write(",".join(c.name for c in schema.columns) + "\n")
            writer = csv.writer(stream, lineterminator="\n", quoting=csv.QUOTE_NOTNULL)
            for row in rows:
                if route and row[-1] is not None:
                    histogram = (
                        "{" + ",".join("NULL" if n is None else str(n) for n in row[-1]) + "}"
                    )
                    row = (*row[:-1], histogram)
                writer.writerow(row)
        write_window(target.with_suffix(".csv"), schema, target, metadata={}, temp_dir=tmp_path)
    builder = resolve_builder("receipts")
    outputs = [
        run_family(builder, REQUEST, inputs_root=root, workdir=root, code_commit="a" * 40).output
        for root in (native, exported)
    ]
    assert outputs[0] == outputs[1]
    assert outputs[1].tables["gold.citizen_accountability_daily"].rows == (
        ("receipts_seed", DAY, 5, 1, 9, 4, 2, Decimal("36.0000"), STAMP),
    )
