from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest, utc_days
from transit_ops.batch.families.occupancy_crowding import builder
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 4, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("seed", (DAY, date(2026, 11, 2)), STAMP, 14, 10, "America/Toronto")
RETENTION_REQUEST = replace(
    REQUEST,
    local_dates=(date(2026, 10, 23),),
    as_of_utc=datetime(2026, 11, 5, tzinfo=UTC),
    timezone="Etc/UTC",
)
# The skew allowance starts exactly at the retention cutoff; equality is buildable.
RETENTION_ROWS = [("A", "S", 1, 1, "2026-10-22 00:00:00+00", 20261023)]
RETENTION_FEEDS = ["2026-10-23 00:00:00+00"]
# R26 assumes feed time is no more than one UTC day ahead of capture time.
# Capture may lag feed by any amount, up to the build stamp, within retained facts.
SKEW_CASES = (
    ("America/Toronto", "2026-11-02 04:59:59+00", "2026-11-03 00:00:00+00", 19),
    ("Etc/UTC", "2026-11-01 23:59:59+00", "2026-11-02 00:00:01+00", 0),
)
# route, stop, occupancy, delay, capture instant, date key. Both 01:30 folds coalesce.
SEED = [
    ("A", "S", 0, -1, "2026-11-01 05:30:00.000001+00", 20261101),
    ("A", "S", 1, 0, "2026-11-01 06:30:00.000002+00", 20261101),
    ("A", "S", 3, 1, "2026-11-01 06:40:00+00", 20261101),
    ("A", "S", 4, 2, "2026-11-01 06:50:00+00", 20261101),
    (None, None, 5, 4, "2026-11-01 07:00:00+00", 20261101),
    ("", "", 2, -3600, "2026-11-01 04:00:00+00", 20261101),
    ("a", "é", 5, 3600, "2026-11-02 04:59:59.999999+00", 20261101),
    ("é", None, 6, 3601, "2026-11-01 08:00:00+00", 20261101),
    ("Z", None, None, None, "2026-11-01 09:00:00+00", 20261101),
    ("A", "S", 6, 3, "2026-11-01 10:00:00+00", 20261101),
    ("A", "S", 0, None, "2026-11-01 11:00:00+00", 20261101),
    ("A", "S", 0, -3601, "2026-11-01 12:00:00+00", 20261101),
    ("prior", None, 0, 10, "2026-11-01 03:59:59.999999+00", 20261031),
]


def write_inputs(root, request=REQUEST, rows=SEED, feed_stamps=None):
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        conn.execute(
            "CREATE TABLE seed(route_id TEXT, stop_id TEXT, occupancy_status INTEGER, "
            "delay_seconds INTEGER, captured_at_utc TIMESTAMPTZ, snapshot_date_key INTEGER, "
            "feed_timestamp_utc TIMESTAMPTZ)"
        )
        conn.executemany(
            "INSERT INTO seed VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(*row, feed_stamps[i] if feed_stamps else row[4]) for i, row in enumerate(rows)],
        )
        # Supply the complete available capture archive, independently of declared needs.
        first = request.as_of_utc.date() - timedelta(days=request.fact_retention_days)
        for relation in ("gold.fact_vehicle_snapshot", "gold.fact_trip_delay_snapshot"):
            for offset in range(request.fact_retention_days + 1):
                window = (first + timedelta(days=offset)).isoformat()
                path = root / relation / f"{window}.parquet"
                path.parent.mkdir(parents=True, exist_ok=True)
                conn.execute(
                    "COPY (SELECT 'seed'::TEXT provider_id, * FROM seed "
                    "WHERE captured_at_utc::DATE = ?::DATE) TO ? (FORMAT PARQUET)",
                    [window, str(path)],
                )
        path = root / "core.providers" / "all.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        conn.execute(
            "COPY (SELECT 'seed'::TEXT provider_id, ?::TEXT timezone) TO ? (FORMAT PARQUET)",
            [request.timezone, str(path)],
        )


def test_family_preserves_bands_fallback_filters_and_exact_numeric_rows(tmp_path):
    builder = resolve_builder("occupancy_crowding")
    assert builder is not None, "occupancy_crowding must be implemented"
    write_inputs(tmp_path)
    result = run_family(
        builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    tables = result.output.tables
    daily = tables["gold.route_occupancy_band_daily"]
    assert daily.rows == tuple(
        ("seed", DAY, route, *counts, STAMP)
        for route, counts in [
            ("", (1, 0, 0, 1, 0, 0)),
            ("A", (6, 3, 1, 0, 2, 0)),
            ("Z", (0, 0, 0, 0, 0, 0)),
            ("__unrouted__", (1, 0, 0, 0, 0, 1)),
            ("a", (1, 0, 0, 0, 0, 1)),
            ("é", (0, 0, 0, 0, 0, 0)),
        ]
    )
    hourly = tables["gold.route_occupancy_band_hourly"]
    assert hourly.rows == tuple(
        ("seed", route, DAY, hour, *counts, STAMP)
        for route, hour, counts in [
            ("", 0, (1, 0, 0, 1, 0, 0)),
            ("A", 1, (4, 1, 1, 0, 2, 0)),
            ("A", 5, (0, 0, 0, 0, 0, 0)),
            ("A", 6, (1, 1, 0, 0, 0, 0)),
            ("A", 7, (1, 1, 0, 0, 0, 0)),
            ("Z", 4, (0, 0, 0, 0, 0, 0)),
            ("__unrouted__", 2, (1, 0, 0, 0, 0, 1)),
            ("a", 23, (1, 0, 0, 0, 0, 1)),
            ("é", 3, (0, 0, 0, 0, 0, 0)),
        ]
    )
    assert tables["gold.stop_occupancy_band_daily"].rows == (
        ("seed", DAY, "", 1, 0, 0, 1, 0, 0, STAMP),
        ("seed", DAY, "S", 6, 3, 1, 0, 2, 0, STAMP),
        ("seed", DAY, "é", 1, 0, 0, 0, 0, 1, STAMP),
    )
    assert tables["gold.route_delay_by_crowding_daily"].rows == (
        ("seed", DAY, "", "few_seats", 1, "-3600", "-3600.00", STAMP),
        ("seed", DAY, "A", "empty", 1, "-1", "-1.00", STAMP),
        ("seed", DAY, "A", "many_seats", 1, "0", "0.00", STAMP),
        ("seed", DAY, "A", "standing", 2, "3", "1.50", STAMP),
        ("seed", DAY, "a", "full", 1, "3600", "3600.00", STAMP),
    )
    assert result.output.bodies == {}


def expected_occupancy_row(relation, hour, day=DAY, stamp=STAMP):
    if "hourly" in relation:
        return ("seed", "A", day, hour, 1, 0, 1, 0, 0, 0, stamp)
    return ("seed", day, "S" if "stop_" in relation else "A", 1, 0, 1, 0, 0, 0, stamp)


@pytest.mark.parametrize("relation", builder.tables[:3])
@pytest.mark.parametrize("zone,feed,capture,hour", SKEW_CASES)
def test_feed_day_includes_capture_outside_its_utc_windows(
    tmp_path, relation, zone, feed, capture, hour
):
    request = replace(REQUEST, local_dates=(DAY,), timezone=zone)
    write_inputs(tmp_path, request, [("A", "S", 1, 1, capture, 20261101)], [feed])
    assert capture[:10] not in utc_days(request)
    result = run_family(
        builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    assert result.output.tables[relation].rows == (expected_occupancy_row(relation, hour),)


@pytest.mark.parametrize("zone,feed,capture,hour", SKEW_CASES)
def test_day_output_is_independent_of_neighbouring_requested_days(
    tmp_path, zone, feed, capture, hour
):
    request = replace(REQUEST, local_dates=(DAY,), timezone=zone)
    write_inputs(tmp_path, request, [("A", "S", 1, 1, capture, 20261101)], [feed])
    alone = run_family(
        builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    neighbours = replace(
        request, local_dates=(DAY - timedelta(days=1), DAY, DAY + timedelta(days=1))
    )
    combined = run_family(
        builder, neighbours, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    for relation, table in alone.output.tables.items():
        other = combined.output.tables[relation]
        index = other.columns.index("provider_local_date")
        assert table.rows == tuple(row for row in other.rows if row[index] == DAY)


@pytest.mark.parametrize(
    "capture,hour",
    [
        ("2026-10-31 20:00:00+00", 16),
        ("2026-11-04 11:59:59.999999+00", 6),
    ],
)
def test_occupancy_reads_skew_allowance_and_capture_through_build_day(tmp_path, capture, hour):
    request = replace(REQUEST, local_dates=(DAY,))
    write_inputs(
        tmp_path, request, [("A", "S", 1, 1, capture, 20261101)], ["2026-11-01 04:00:00+00"]
    )
    result = run_family(
        builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    for relation in builder.tables[:3]:
        assert result.output.tables[relation].rows == (expected_occupancy_row(relation, hour),)


def test_buildable_occupancy_windows_keep_skew_day_and_crowding_keeps_capture_days():
    request = replace(REQUEST, local_dates=(DAY,))
    needs = builder.inputs(request)
    vehicle_days = [n.window for n in needs if n.relation == "gold.fact_vehicle_snapshot"]
    assert vehicle_days[0] == "2026-10-31"
    assert vehicle_days[-1] == "2026-11-04"
    assert all(
        date.fromisoformat(right) - date.fromisoformat(left) == timedelta(days=1)
        for left, right in zip(vehicle_days, vehicle_days[1:], strict=False)
    )
    assert tuple(
        n.window for n in needs if n.relation == "gold.fact_trip_delay_snapshot"
    ) == utc_days(request)


@pytest.mark.parametrize(
    "day",
    [
        pytest.param(date(2026, 10, 21), id="archived_row_may_have_been_pruned"),
        pytest.param(date(2026, 10, 20), id="older_row_may_remain_in_prune_backlog"),
        pytest.param(date(2026, 10, 22), id="skew_allowance_crosses_exact_cutoff"),
    ],
)
def test_retention_edge_day_is_refused_before_opening_inputs(tmp_path, day):
    request = replace(REQUEST, local_dates=(day, DAY), timezone="Etc/UTC")
    # R26a refuses ambiguous membership, regardless of archive rows or prune backlog.
    with pytest.raises(ValueError) as caught:
        run_family(
            builder,
            request,
            inputs_root=tmp_path / "missing",
            workdir=tmp_path,
            code_commit="a" * 40,
        )
    assert "retention_edge_day" in str(caught.value)
    assert day.isoformat() in str(caught.value)
    assert "2026-10-21T12:00:00.123456+00:00" in str(caught.value)


@pytest.mark.parametrize("zone,hour", [("Etc/UTC", 0), ("America/Toronto", 4)])
def test_retention_guard_preserves_local_midnight_and_microseconds(tmp_path, zone, hour):
    boundary = replace(
        RETENTION_REQUEST,
        timezone=zone,
        as_of_utc=datetime(2026, 11, 5, hour, tzinfo=UTC),
    )
    assert builder.inputs(boundary)
    request = replace(boundary, as_of_utc=boundary.as_of_utc + timedelta(microseconds=1))
    with pytest.raises(ValueError) as caught:
        run_family(
            builder,
            request,
            inputs_root=tmp_path / "missing",
            workdir=tmp_path,
            code_commit="a" * 40,
        )
    assert "retention_edge_day 2026-10-23" in str(caught.value)
    assert f"2026-10-22T{hour:02}:00:00.000001+00:00" in str(caught.value)


def test_buildable_day_keeps_fact_exactly_at_retention_cutoff(tmp_path):
    request = RETENTION_REQUEST
    write_inputs(tmp_path, request, RETENTION_ROWS, RETENTION_FEEDS)
    result = run_family(
        builder, request, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    for relation in builder.tables[:3]:
        assert result.output.tables[relation].rows == (
            expected_occupancy_row(relation, 0, date(2026, 10, 23), request.as_of_utc),
        )
    assert result.output.tables[builder.tables[3]].rows == ()
