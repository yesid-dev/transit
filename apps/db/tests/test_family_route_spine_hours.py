from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.engine import InputRefused
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.families.route_spine_hours import builder
from transit_ops.batch.families.route_spine_hours_sql import DDL, NAMES
from transit_ops.batch.run import run_family

REQUEST = BuildRequest(
    "seed",
    (date(2026, 11, 1), date(2026, 11, 2)),
    datetime(2026, 11, 4, 12, 0, 0, 123456, UTC),
    14,
    10,
    "America/Toronto",
)
EDGE_REQUEST = replace(REQUEST, local_dates=(date(2026, 10, 22),))
EDGE_ROWS = [
    ("A", "before", 0, 60, "2026-10-22T05:00:00+00:00"),
    ("A", "after", 0, 300, "2026-10-22T13:00:00+00:00"),
]


def test_family_declares_prior_rows_and_every_cohort_evidence_relation():
    builder = resolve_builder("route_spine_hours")
    assert builder is not None, "route_spine_hours must be implemented"
    relations = {need.relation for need in builder.inputs(REQUEST)}
    assert relations == {
        "core.providers",
        "core.feed_endpoints",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
        "raw.realtime_snapshot_index",
        "silver.rt_feed_snapshots",
        "silver.rt_entities",
        "silver.rt_trip_updates",
        "gold.fact_trip_delay_snapshot",
        "gold.warm_rollup_periods",
        "gold.trip_delay_summary_5m",
        "gold.route_delay_hourly",
    }


# Route, trip, direction, seconds, capture. The two 01:30 folds share a spine hour.
SEED = [
    ("A", "t", None, -60, "2026-11-01T05:30:00.000001+00:00"),
    ("A", "t", 0, 300, "2026-11-01T05:30:00.000002+00:00"),
    ("A", "t", 0, 301, "2026-11-01T06:30:00.000001+00:00"),
    ("A", "t", 1, 3601, "2026-11-01T06:30:00.000002+00:00"),
    ("A", None, 0, None, "2026-11-01T06:30:00.000003+00:00"),
    (None, "u", None, 1, "2026-11-01T07:00:00+00:00"),
    ("", "", None, -3600, "2026-11-01T07:00:00+00:00"),
    ("a", "x", None, 3600, "2026-11-02T04:59:59.999999+00:00"),
    ("é", "x", None, None, "2026-11-01T08:00:00+00:00"),
] + [("half", str(i), 0, int(i == 199), "2026-11-01T09:00:00+00:00") for i in range(200)]


def create_inputs(conn):
    for schema in ("core", "raw", "silver", "gold"):
        conn.execute(f"CREATE SCHEMA {schema}")
    for name, ddl in zip(NAMES[:2], DDL[:2], strict=True):
        conn.execute(f"CREATE TABLE gold.{name} ({ddl})")
    schemas = {
        "core.providers": "provider_id TEXT, timezone TEXT",
        "core.feed_endpoints": "feed_endpoint_id BIGINT, provider_id TEXT, endpoint_key TEXT",
        "raw.ingestion_runs": "ingestion_run_id BIGINT, provider_id TEXT, "
        "feed_endpoint_id BIGINT, status TEXT",
        "raw.ingestion_objects": "ingestion_object_id BIGINT, provider_id TEXT, "
        "ingestion_run_id BIGINT, checksum_sha256 TEXT, byte_size BIGINT",
        "raw.realtime_snapshot_index": "realtime_snapshot_id BIGINT, ingestion_run_id BIGINT, "
        "ingestion_object_id BIGINT, provider_id TEXT, feed_endpoint_id BIGINT, "
        "captured_at_utc TIMESTAMPTZ, feed_timestamp_utc TIMESTAMPTZ, entity_count INTEGER",
        "silver.rt_feed_snapshots": "rt_feed_snapshot_id BIGINT, "
        "source_realtime_snapshot_id BIGINT, "
        "provider_id TEXT, checksum_sha256 TEXT, byte_size BIGINT, feed_endpoint_id BIGINT, "
        "ingestion_run_id BIGINT, ingestion_object_id BIGINT, captured_at_utc TIMESTAMPTZ, "
        "feed_timestamp_utc TIMESTAMPTZ, endpoint_key TEXT, manifest_json JSON",
        "silver.rt_entities": "rt_feed_snapshot_id BIGINT, provider_id TEXT, "
        "entity_index INTEGER, entity_kind TEXT",
        "silver.rt_trip_updates": "rt_feed_snapshot_id BIGINT, provider_id TEXT, "
        "entity_index INTEGER",
        "gold.warm_rollup_periods": "provider_id TEXT, rollup_kind TEXT, "
        "period_start_utc TIMESTAMPTZ, "
        "built_at_utc TIMESTAMPTZ, invalidated_at_utc TIMESTAMPTZ",
        "gold.fact_trip_delay_snapshot": "provider_id TEXT, realtime_snapshot_id BIGINT, "
        "entity_index INTEGER, route_id TEXT, trip_id TEXT, direction_id INTEGER, "
        "delay_seconds INTEGER, captured_at_utc TIMESTAMPTZ",
    }
    for name, ddl in schemas.items():
        conn.execute(f"CREATE TABLE {name} ({ddl})")


def export_inputs(conn, root, request=REQUEST):
    for need in builder.inputs(request):
        path = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
        path.parent.mkdir(parents=True, exist_ok=True)
        predicate = "true"
        if need.window.startswith("local:"):
            predicate = f"timezone('{request.timezone}', period_start_utc)::DATE = "
            predicate += f"DATE '{need.window[6:]}'"
        elif need.window != "all":
            column = "period_start_utc" if "warm_rollup" in need.relation else "captured_at_utc"
            predicate = f"{column}::DATE = DATE '{need.window}'"
        conn.execute(
            f"COPY (SELECT * FROM {need.relation} WHERE {predicate}) TO ? (FORMAT PARQUET)",
            [str(path)],
        )


def write_inputs(root, seed=SEED, request=REQUEST):
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        create_inputs(conn)
        conn.execute("INSERT INTO core.providers VALUES ('seed', ?)", [request.timezone])
        conn.executemany(
            "INSERT INTO gold.fact_trip_delay_snapshot VALUES ('seed', 1, ?, ?, ?, ?, ?, ?)",
            [(i, *row) for i, row in enumerate(seed)],
        )
        export_inputs(conn, root, request)


def run(root, request=REQUEST):
    return run_family(builder, request, inputs_root=root, workdir=root, code_commit="a" * 40)


def records(table):
    return [dict(zip(table.columns, row, strict=True)) for row in table.rows]


def test_summary_hour_spine_match_literals_and_raw_math(tmp_path):
    write_inputs(tmp_path)
    output = run(tmp_path).output
    assert output.bodies == {}
    summaries, hours, spine = [records(output.tables[rel]) for rel in builder.tables]
    first = summaries[0]
    assert (
        first["route_id"],
        first["avg_delay_seconds"],
        first["trip_count"],
        first["observation_count"],
        first["usable_delay_sum_seconds"],
    ) == ("A", Decimal("120.00"), 1, 2, 240)
    assert next(row for row in summaries if row["route_id"] == "half")[
        "avg_delay_seconds"
    ] == Decimal("0.01")
    sample = next(
        row for row in hours if row["route_id"] == "A" and row["period_start_utc"].hour == 6
    )
    assert (
        sample["avg_delay_seconds"],
        sample["max_delay_seconds"],
        sample["usable_delay_sum_seconds"],
        sample["usable_delay_observation_count"],
    ) == (Decimal("301.00"), 301, 301, 1)
    a = next(row for row in spine if row["route_id"] == "A" and row["direction_id"] == 0)
    assert (
        a["hour_of_day_local"],
        a["observation_count"],
        a["delay_observation_count"],
        a["sum_delay_seconds"],
        a["delayed_trip_count"],
    ) == (1, 4, 3, 541, 2)
    assert a["delay_histogram"] == "{0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0}"
    assert {r["provider_local_date"] for r in spine} == {date(2026, 11, 1)}
    assert [r["route_id"] for r in spine] == ["", "A", "A", "a", "half", "é"]
    check_math(output, SEED)


def check_math(output, seed):
    """Independent loops reconcile every output grain with the raw test observations."""
    for relation, table in output.tables.items():
        for row in records(table):
            raw = []
            for route, trip, direction, delay, capture in seed:
                capture = datetime.fromisoformat(capture)
                local = capture.astimezone(ZoneInfo(REQUEST.timezone))
                if relation.endswith("spine"):
                    match = (
                        route == row["route_id"]
                        and local.date() == row["provider_local_date"]
                        and local.hour == row["hour_of_day_local"]
                        and (direction or 0) == row["direction_id"]
                    )
                else:
                    minute = capture.minute // 5 * 5 if relation.endswith("5m") else 0
                    match = (route if route is not None else "__unrouted__") == row[
                        "route_id"
                    ] and capture.replace(minute=minute, second=0, microsecond=0) == row[
                        "period_start_utc"
                    ]
                if match:
                    raw.append((trip, delay))
            known = [v for _, v in raw if v is not None]
            usable = [v for v in known if abs(v) <= 3600]
            assert row["observation_count"] == len(raw)
            assert row["delay_observation_count"] == len(known)
            assert row.get("sum_delay_seconds", row.get("usable_delay_sum_seconds")) == sum(usable)
            for name, value in row.items():
                if name.endswith("count") and value is not None:
                    assert type(value) is int and value >= 0
                if isinstance(value, Decimal):
                    assert value.is_finite() and not (value.is_zero() and value.is_signed())
                if isinstance(value, str):
                    assert "\0" not in value
            if relation.endswith("spine"):
                bins = list(map(int, row["delay_histogram"].strip("{}").split(",")))
                assert sum(bins) == len(usable)
            elif relation.endswith("5m"):
                mean = (
                    (Decimal(sum(known)) / len(known)).quantize(
                        Decimal(".01"), rounding=ROUND_HALF_UP
                    )
                    if known
                    else None
                )
                assert row["avg_delay_seconds"] == mean
                assert row["trip_count"] == len({t for t, _ in raw if t is not None})
            elif relation.endswith("hourly"):
                # Trip counts add per five-minute bucket, including repeated trips.
                buckets = {}
                for route, trip, _direction, delay, capture in seed:
                    stamp = datetime.fromisoformat(capture)
                    if (route if route is not None else "__unrouted__") == row[
                        "route_id"
                    ] and stamp.replace(minute=0, second=0, microsecond=0) == row[
                        "period_start_utc"
                    ]:
                        buckets.setdefault(stamp.minute // 5, []).append((trip, delay))
                assert row["trip_count"] == sum(
                    len({t for t, _ in values if t is not None}) for values in buckets.values()
                )
                weighted = Decimal(0)
                for values in buckets.values():
                    vals = [d for _, d in values if d is not None and abs(d) <= 3600]
                    if vals:
                        mean = (Decimal(sum(vals)) / len(vals)).quantize(
                            Decimal(".01"), rounding=ROUND_HALF_UP
                        )
                        weighted += mean * len(vals)
                expected = (
                    (weighted / len(usable)).quantize(Decimal(".01"), rounding=ROUND_HALF_UP)
                    if usable
                    else None
                )
                assert row["avg_delay_seconds"] == expected
            if known:
                on_time = row["on_time_observation_count"]
                assert on_time == sum(-60 <= v < 300 for v in known)
                assert 0 <= on_time / len(known) <= 1
    summaries, hours, spine = [records(output.tables[rel]) for rel in builder.tables]
    for name in ("observation_count", "delay_observation_count", "on_time_observation_count"):
        assert sum(r[name] or 0 for r in summaries) == sum(r[name] or 0 for r in hours)
        routed = [r for r in summaries if r["route_id"] != "__unrouted__"]
        assert sum(r[name] or 0 for r in routed) == sum(r[name] or 0 for r in spine)


def test_negative_halfway_rounds_away_from_zero(tmp_path):
    seed = [("A", str(i), 0, -int(i == 199), "2026-11-01T09:00:00+00:00") for i in range(200)]
    write_inputs(tmp_path, seed)
    output = run(tmp_path).output
    for relation in builder.tables[:2]:
        assert records(output.tables[relation])[0]["avg_delay_seconds"] == Decimal("-.01")
    check_math(output, seed)


def test_nul_text_is_a_named_failure(tmp_path):
    write_inputs(tmp_path, [("A\0", "t", 0, 1, "2026-11-01T09:00:00+00:00")])
    with pytest.raises(ValueError, match="NUL.*route_id"):
        run(tmp_path)


@pytest.mark.parametrize("state", ["clean", "dirty", "future"])
def test_trusted_prior_periods_keep_proof_and_hour_clock_order(tmp_path, state):
    from dataclasses import replace
    from datetime import timedelta

    write_inputs(tmp_path, SEED[:2])
    prior = run(tmp_path).output
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        create_inputs(conn)
        conn.execute("INSERT INTO core.providers VALUES ('seed','America/Toronto')")
        for rel in builder.tables[:2]:
            table = prior.tables[rel]
            for row in records(table):
                row["built_at_utc"] = REQUEST.as_of_utc - timedelta(days=2)
                conn.execute(
                    f"INSERT INTO {rel} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",
                    list(row.values()),
                )
        for period in {r["period_start_utc"] for r in records(prior.tables[builder.tables[0]])}:
            days = {"clean": 3, "dirty": 1, "future": -1}[state]
            conn.execute(
                "INSERT INTO gold.warm_rollup_periods VALUES "
                "('seed','trip_delay_summary_5m',?,?,NULL)",
                [period, REQUEST.as_of_utc - timedelta(days=days)],
            )
        export_inputs(conn, tmp_path)
    if state == "future":
        with pytest.raises(ValueError, match="child period built after as_of_utc"):
            run(tmp_path)
        return
    result = run(tmp_path, replace(REQUEST, open_window_days=1)).output
    stamp = records(result.tables[builder.tables[1]])[0]["built_at_utc"]
    assert stamp == (
        REQUEST.as_of_utc if state == "dirty" else REQUEST.as_of_utc - timedelta(days=2)
    )
    assert result.tables[builder.tables[2]].rows == ()


def test_day_result_is_independent_of_requested_neighbours(tmp_path):
    from dataclasses import replace

    write_inputs(tmp_path)
    together = run(tmp_path).output
    alone = run(tmp_path, replace(REQUEST, local_dates=REQUEST.local_dates[:1])).output
    assert together == alone


def test_replacement_without_silver_cohort_is_refused(tmp_path):
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        create_inputs(conn)
        conn.execute("INSERT INTO core.providers VALUES ('seed','America/Toronto')")
        conn.execute(
            "INSERT INTO gold.trip_delay_summary_5m "
            "(provider_id,period_start_utc,route_id,trip_count,observation_count,"
            "delay_observation_count,delayed_trip_count,outlier_count,built_at_utc) "
            "VALUES ('seed','2026-11-01 05:30:00+00','A',1,1,1,1,0,?)",
            [REQUEST.as_of_utc],
        )
        export_inputs(conn, tmp_path)
    with pytest.raises(ValueError, match="Retained capture evidence is incomplete"):
        run(tmp_path)


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "checksum",
        "manifest",
        "entities",
        "facts",
        "fractional_count",
        "rounded_count",
        "float_integer",
    ],
)
def test_replacement_requires_matching_complete_cohort(tmp_path, fault):
    capture = "2026-11-01 05:30:00+00"
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        create_inputs(conn)
        conn.execute("INSERT INTO core.providers VALUES ('seed','America/Toronto')")
        conn.execute("INSERT INTO core.feed_endpoints VALUES (1,'seed','trip_updates')")
        conn.execute("INSERT INTO raw.ingestion_runs VALUES (1,'seed',1,'succeeded')")
        conn.execute("INSERT INTO raw.ingestion_objects VALUES (1,'seed',1,repeat('a',64),1)")
        conn.execute(
            "INSERT INTO raw.realtime_snapshot_index VALUES "
            "(1,1,1,'seed',1,?::TIMESTAMPTZ,?::TIMESTAMPTZ,1)",
            [capture, capture],
        )
        conn.execute(
            "INSERT INTO silver.rt_feed_snapshots VALUES "
            "(1,1,'seed',repeat('a',64),1,1,1,1,?::TIMESTAMPTZ,?::TIMESTAMPTZ,"
            "'trip_updates','{\"entity_count\":1}')",
            [capture, capture],
        )
        conn.execute("INSERT INTO silver.rt_entities VALUES (1,'seed',0,'trip_update')")
        conn.execute("INSERT INTO silver.rt_trip_updates VALUES (1,'seed',0)")
        conn.execute(
            "INSERT INTO gold.fact_trip_delay_snapshot VALUES "
            "('seed',1,0,'A','t',0,60,?::TIMESTAMPTZ)",
            [capture],
        )
        conn.execute(
            "INSERT INTO gold.trip_delay_summary_5m "
            "(provider_id,period_start_utc,route_id,trip_count,observation_count,"
            "delay_observation_count,delayed_trip_count,outlier_count,built_at_utc) "
            "VALUES ('seed',?::TIMESTAMPTZ,'stale',1,1,1,1,0,?)",
            [capture, REQUEST.as_of_utc],
        )
        changes = {
            "checksum": "UPDATE silver.rt_feed_snapshots SET checksum_sha256=repeat('b',64)",
            "manifest": "UPDATE silver.rt_feed_snapshots "
            'SET manifest_json=\'{"entity_count":"1"}\'',
            "entities": "DELETE FROM silver.rt_entities",
            "facts": "DELETE FROM gold.fact_trip_delay_snapshot",
            "fractional_count": "UPDATE silver.rt_feed_snapshots "
            "SET manifest_json='{\"entity_count\":1.5}'",
            "rounded_count": "UPDATE silver.rt_feed_snapshots "
            "SET manifest_json='{\"entity_count\":1.0000000000000001}'",
            "float_integer": "UPDATE silver.rt_feed_snapshots "
            "SET manifest_json='{\"entity_count\":1.0}'",
        }
        if fault:
            conn.execute(changes[fault])
        export_inputs(conn, tmp_path)
    if fault:
        with pytest.raises(ValueError, match="Retained capture evidence is incomplete") as caught:
            run(tmp_path)
        if fault in {"fractional_count", "rounded_count", "float_integer"}:
            assert "entity_count" in str(caught.value)
    else:
        output = run(tmp_path).output
        summary = records(output.tables[builder.tables[0]])
        assert [(r["route_id"], r["usable_delay_sum_seconds"]) for r in summary] == [("A", 60)]
        assert records(output.tables[builder.tables[1]])[0]["built_at_utc"] == REQUEST.as_of_utc


def test_accepted_retention_boundary_day_reconciles_every_fact(tmp_path):
    write_inputs(tmp_path, EDGE_ROWS, EDGE_REQUEST)
    output = run(tmp_path, EDGE_REQUEST).output
    for relation, table in output.tables.items():
        rows = records(table)
        assert sum(row["observation_count"] for row in rows) == 2, relation
        column = "sum_delay_seconds" if relation.endswith("spine") else "usable_delay_sum_seconds"
        assert sum(row[column] for row in rows) == 360, relation
    check_math(output, EDGE_ROWS)


def test_partial_day_input_is_refused_by_its_missing_capture_day(tmp_path):
    write_inputs(tmp_path, EDGE_ROWS, EDGE_REQUEST)
    missing = tmp_path / "gold.fact_trip_delay_snapshot" / "2026-10-22.parquet"
    assert missing.resolve().is_relative_to(tmp_path.resolve())
    missing.unlink()
    with pytest.raises(InputRefused, match="gold.fact_trip_delay_snapshot window 2026-10-22"):
        run(tmp_path, EDGE_REQUEST)


@pytest.mark.parametrize(
    "zone,day,stamp",
    [
        ("America/St_Johns", date(2026, 11, 2), REQUEST.as_of_utc),
        # This day starts at +09:00, then folds back into a +08:30 offset before it ends.
        ("Asia/Pyongyang", date(2015, 8, 14), datetime(2015, 8, 17, tzinfo=UTC)),
    ],
)
def test_fractional_offset_day_is_refused_before_input_io(tmp_path, zone, day, stamp):
    request = replace(REQUEST, timezone=zone, local_dates=(day,), as_of_utc=stamp)
    with pytest.raises(ValueError, match=f"fractional_utc_offset.*{zone}.*{day}"):
        run(tmp_path / "absent", request)
    assert not (tmp_path / "absent").exists()


def test_integer_extremes_are_outliers_without_overflow(tmp_path):
    seed = [
        ("A", str(i), 0, delay, "2026-11-01T09:00:00+00:00")
        for i, delay in enumerate((-2147483648, 2147483647))
    ]
    write_inputs(tmp_path, seed)
    output = run(tmp_path).output
    check_math(output, seed)
    summary, hour, spine = [records(output.tables[relation])[0] for relation in builder.tables]
    assert (
        summary["outlier_count"],
        summary["avg_delay_seconds"],
        summary["usable_delay_sum_seconds"],
    ) == (2, Decimal("-0.50"), 0)
    assert (
        hour["usable_delay_observation_count"],
        hour["usable_delay_sum_seconds"],
        hour["avg_delay_seconds"],
    ) == (0, 0, None)
    assert spine["sum_delay_seconds"] == 0
