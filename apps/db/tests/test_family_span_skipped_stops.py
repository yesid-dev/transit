from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 5, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("seed", (DAY,), STAMP, 14, 10, "America/Toronto")
EDGE_REQUEST = replace(
    REQUEST,
    local_dates=(date(2026, 10, 23),),
    as_of_utc=datetime(2026, 11, 5, tzinfo=UTC),
    timezone="Etc/UTC",
)
EDGE_SEED = [
    ("A", "t", "2026-10-22 00:00:00+00", 20261023, date(2026, 10, 23), 1, 1, 1, 1, 0),
    (None, None, "2026-10-24 12:00:00+00", 20261024, None, None, 0, 0, 1, 1),
]
ISOLATED_DAY = date(2025, 6, 3)
ISOLATED_REQUEST = BuildRequest(
    "seed", (ISOLATED_DAY,), datetime(2025, 9, 1, 6, tzinfo=UTC), 36500, 90, "America/Toronto"
)
ISOLATED_SEED = [("B10", "t", "2025-06-03 16:12:00+00", 20250603, ISOLATED_DAY, 180, 1, 0, 1, 0)]
OVERNIGHT_SEED = ISOLATED_SEED + [
    ("B10", "night", "2025-06-04 04:30:00+00", 20250604, ISOLATED_DAY, 240, 1, 0, 1, 1)
]
# Feed time is at most one UTC day ahead of capture; arbitrary later capture is allowed.
# route, trip, capture, feed-day key, service day, delay, updates, skipped, snapshot, entity
SEED = [
    ("A", "a", "2026-11-01 05:30:00.000001+00", 20261101, DAY, 7, 3, 1, 1, 0),
    ("A", "a", "2026-11-01 06:30:00.000001+00", 20261101, DAY, None, 0, 0, 1, 1),
    ("A", "Z", "2026-11-02 05:00:30.000001+00", 20261102, DAY, 10, 1, 1, 1, 2),
    ("A", "é", "2026-11-02 05:00:30.000001+00", 20261102, DAY, 10, 1, 0, 1, 3),
    ("A", "Z", "2026-11-02 06:00:00+00", 20261102, DAY, 40, 0, 0, 1, 4),
    ("A", "é", "2026-11-02 06:00:00+00", 20261102, DAY, 99, 0, 0, 1, 5),
    ("", "", "2026-11-01 07:00:00+00", 20261101, DAY, None, 0, 0, 1, 6),
    (None, "t", "2026-11-01 08:00:00+00", 20261101, DAY, 1, 1, 1, 1, 7),
    ("é", None, "2026-11-03 08:00:00+00", 20261101, None, 1, 32, 1, 1, 8),
    ("a", "t", "2026-11-01 09:00:00+00", 20261101, DAY, 2, 1, 0, 1, 9),
]


def write_inputs(root, request=REQUEST, rows=SEED):
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "CREATE TABLE seed(route_id TEXT, trip_id TEXT, captured_at_utc TIMESTAMPTZ, "
            "snapshot_date_key INTEGER, start_date DATE, delay_seconds INTEGER, "
            "stop_time_update_count INTEGER, skipped_stop_count INTEGER, "
            "realtime_snapshot_id BIGINT, entity_index INTEGER)"
        )
        if rows:
            conn.executemany("INSERT INTO seed VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        first = request.as_of_utc.date() - timedelta(days=request.fact_retention_days)
        for offset in range(request.fact_retention_days + 1):
            window = (first + timedelta(days=offset)).isoformat()
            path = root / "gold.fact_trip_delay_snapshot" / f"{window}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            conn.execute(
                "COPY (SELECT 'seed'::TEXT provider_id, * FROM seed "
                "WHERE captured_at_utc::DATE = ?::DATE) TO ? (FORMAT PARQUET)",
                [window, str(path)],
            )


def build(root, request=REQUEST, rows=SEED):
    builder = resolve_builder("span_skipped_stops")
    assert builder is not None, "span_skipped_stops must be implemented"
    write_inputs(root, request, rows)
    return run_family(
        builder, request, inputs_root=root, workdir=root, code_commit="a" * 40
    ).output.tables


def rounding_rows():
    # Small valid facts reproduce ties after aggregation, not just per-row rates.
    return [
        (
            route,
            None,
            "2026-11-01 12:00:00+00",
            20261101,
            None,
            None,
            100,
            int(i < skipped),
            1,
            offset + i,
        )
        for route, skipped, offset in (
            ("tie29", 29, 10),
            ("tie57", 57, 210),
            ("zero", 0, 410),
        )
        for i in range(200)
    ]


def test_span_uses_next_feed_day_total_trip_order_and_half_minute_rounding(tmp_path):
    tables = build(tmp_path)
    assert tables["gold.route_service_span_daily"].rows == (
        (
            "seed",
            DAY,
            "",
            datetime(2026, 11, 1, 7, tzinfo=UTC),
            datetime(2026, 11, 1, 7, tzinfo=UTC),
            0,
            None,
            None,
            1,
            STAMP,
        ),
        (
            "seed",
            DAY,
            "A",
            datetime(2026, 11, 1, 5, 30, 0, 1, UTC),
            datetime(2026, 11, 2, 5, 0, 30, 1, UTC),
            1411,
            7,
            40,
            3,
            STAMP,
        ),
        (
            "seed",
            DAY,
            "a",
            datetime(2026, 11, 1, 9, tzinfo=UTC),
            datetime(2026, 11, 1, 9, tzinfo=UTC),
            0,
            2,
            2,
            1,
            STAMP,
        ),
    )


def test_skipped_counts_include_missing_trip_and_late_capture_with_exact_rates(tmp_path):
    tables = build(tmp_path)
    assert tables["gold.route_skipped_stop_daily"].rows == (
        ("seed", DAY, "", 0, 0, None, STAMP),
        ("seed", DAY, "A", 3, 1, Decimal("33.33"), STAMP),
        ("seed", DAY, "a", 1, 0, Decimal("0.00"), STAMP),
        ("seed", DAY, "é", 32, 1, Decimal("3.13"), STAMP),
    )


def test_empty_day_is_absent_and_neighbouring_days_do_not_change_output(tmp_path):
    alone = build(tmp_path / "alone")
    together = build(tmp_path / "together", replace(REQUEST, local_dates=(DAY, DAY + timedelta(1))))
    for name in alone:
        assert tuple(row for row in together[name].rows if row[1] == DAY) == alone[name].rows
    empty = build(tmp_path / "empty", rows=[])
    assert all(table.rows == () for table in empty.values())


def test_math_reconciles_each_output_with_raw_facts(tmp_path):
    rows = [*SEED, *rounding_rows()]
    tables = build(tmp_path, rows=rows)
    for row in tables["gold.route_service_span_daily"].rows:
        _, day, route, first, last, minutes, _, _, count, _ = row
        trips = {}
        for r, trip, captured, key, service, *_ in rows:
            if r == route and trip is not None and service == day and key in (20261101, 20261102):
                trips.setdefault(trip, []).append(datetime.fromisoformat(captured))
        starts = [min(values) for values in trips.values()]
        assert first == min(starts) <= last == max(starts)
        assert type(count) is int and count == len(trips) >= 0
        seconds = Decimal(str((last - first).total_seconds()))
        assert minutes == int((seconds / 60).quantize(Decimal(1), rounding="ROUND_HALF_UP")) >= 0
    for row in tables["gold.route_skipped_stop_daily"].rows:
        _, _, route, total, skipped, rate, _ = row
        raw = [r for r in rows if r[0] == route and r[3] == 20261101]
        assert type(total) is int and total == sum(r[6] for r in raw) >= 0
        assert type(skipped) is int and skipped == sum(r[7] for r in raw)
        assert 0 <= skipped <= total
        if total:
            expected = (Decimal(100 * skipped) / total).quantize(
                Decimal(".01"), rounding="ROUND_HALF_UP"
            )
            assert rate == expected and 0 <= rate / 100 <= 1
            assert rate.is_finite() and not (rate.is_zero() and rate.is_signed())
        else:
            assert rate is None
    rates = {row[2]: row[3:6] for row in tables["gold.route_skipped_stop_daily"].rows}
    assert rates["tie29"] == (20000, 29, Decimal("0.15"))
    assert rates["tie57"] == (20000, 57, Decimal("0.29"))
    assert rates["zero"] == (20000, 0, Decimal("0.00"))


def test_retention_edge_is_refused_before_inputs_are_opened(tmp_path):
    request = replace(REQUEST, local_dates=(date(2026, 10, 22),))
    builder = resolve_builder("span_skipped_stops")
    assert builder is not None
    with pytest.raises(ValueError, match="retention_edge_day 2026-10-22.*cutoff"):
        run_family(builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40)


def test_capture_at_retention_cutoff_and_one_day_skew_are_included(tmp_path):
    tables = build(tmp_path, EDGE_REQUEST, EDGE_SEED)
    assert tables["gold.route_service_span_daily"].rows[0][3:9] == (
        datetime(2026, 10, 22, tzinfo=UTC),
        datetime(2026, 10, 22, tzinfo=UTC),
        0,
        1,
        1,
        1,
    )
    assert tables["gold.route_skipped_stop_daily"].rows[0][3:6] == (1, 1, Decimal("100.00"))


def test_snapshot_identity_breaks_observation_ties_independent_of_file_order(tmp_path):
    row = SEED[0]
    other = (*row[:5], 99, 0, 0, 2, row[9])
    for i, rows in enumerate(([other, row], [row, other])):
        coverage = (None, None, *SEED[2][2:4], None, *SEED[2][5:])
        tables = build(tmp_path / str(i), rows=[*rows, coverage])
        assert tables["gold.route_service_span_daily"].rows[0][6:9] == (7, 99, 1)


@pytest.mark.parametrize("open_days", [90, 36000])
@pytest.mark.parametrize("covered", [False, True])
def test_span_waits_for_next_day_coverage_and_includes_overnight_trip(tmp_path, open_days, covered):
    request = replace(ISOLATED_REQUEST, open_window_days=open_days)
    archive = replace(ISOLATED_REQUEST, fact_retention_days=100)
    write_inputs(tmp_path, archive, OVERNIGHT_SEED if covered else ISOLATED_SEED)
    builder = resolve_builder("span_skipped_stops")
    actual = run_family(
        builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    span = actual.output.tables["gold.route_service_span_daily"].rows
    if covered:
        assert span == (
            (
                "seed",
                ISOLATED_DAY,
                "B10",
                datetime(2025, 6, 3, 16, 12, tzinfo=UTC),
                datetime(2025, 6, 4, 4, 30, tzinfo=UTC),
                738,
                180,
                240,
                2,
                request.as_of_utc,
            ),
        )
    else:
        assert span == ()
    assert actual.output.tables["gold.route_skipped_stop_daily"].rows == (
        ("seed", ISOLATED_DAY, "B10", 1, 0, Decimal("0.00"), request.as_of_utc),
    )


def test_next_day_observations_do_not_complete_span_while_that_day_is_open(tmp_path):
    request = replace(ISOLATED_REQUEST, as_of_utc=datetime(2025, 6, 4, 12, tzinfo=UTC))
    write_inputs(tmp_path, replace(request, fact_retention_days=100), OVERNIGHT_SEED)
    actual = run_family(
        resolve_builder("span_skipped_stops"),
        request,
        inputs_root=tmp_path,
        workdir=tmp_path,
        code_commit="a" * 40,
    )
    assert actual.output.tables["gold.route_service_span_daily"].rows == ()
