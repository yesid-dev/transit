from datetime import UTC, date, datetime

import duckdb

from transit_ops.batch.build import BuildRequest, utc_days
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 4, 12, 0, 0, 123456, UTC)
REQUEST = BuildRequest("seed", (DAY, date(2026, 11, 2)), STAMP, 14, 10, "America/Toronto")
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


def write_inputs(root, request=REQUEST):
    with duckdb.connect() as conn:
        conn.execute(
            "CREATE TABLE seed(route_id TEXT, stop_id TEXT, occupancy_status INTEGER, "
            "delay_seconds INTEGER, captured_at_utc TIMESTAMPTZ, snapshot_date_key INTEGER)"
        )
        conn.executemany("INSERT INTO seed VALUES (?, ?, ?, ?, ?, ?)", SEED)
        for relation in ("gold.fact_vehicle_snapshot", "gold.fact_trip_delay_snapshot"):
            for window in utc_days(request):
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
            "COPY (SELECT 'seed'::TEXT provider_id, 'America/Toronto'::TEXT timezone) "
            "TO ? (FORMAT PARQUET)",
            [str(path)],
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
