"""Exercise the historic SQL at its PostgreSQL execution seam."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text

from transit_ops.snapshots.builders.historic import (
    provenance,
    route_reliability,
    route_reliability_batch,
    small_surfaces,
    stop_reliability,
)

IDS = ["é", "a", "_", "B", "9", "10"]
BINARY = ["10", "9", "B", "_", "a", "é"]


@pytest.fixture
def surface_db(real_db_engine, seed_provider):
    with real_db_engine.connect() as conn, conn.begin():
        provider = f"surface-order-{uuid4().hex[:10]}"
        seed_provider(conn, provider, display_name="Surface order", timezone="UTC")
        print(
            "database collation:",
            conn.execute(
                text("SELECT datcollate FROM pg_database WHERE datname = current_database()")
            ).scalar_one(),
        )
        yield conn, {"provider_id": provider}
        conn.rollback()


def test_offender_limit_breaks_equal_metrics_by_binary_identity(surface_db):
    conn, params = surface_db
    conn.execute(
        text("""
        INSERT INTO gold.repeat_offender
            (provider_id, entity_kind, entity_id, route_id, recurrence_days,
             window_days, avg_delay_seconds)
        VALUES (:provider_id, 'trip', :id, :route, 5, 7, 120)
    """),
        [{**params, "id": value, "route": route} for value in IDS for route in ["a", "B"]],
    )
    result = small_surfaces.build_repeat_offenders(
        conn, **params, generated_utc="2026-08-01T00:00:00Z"
    )
    assert [(row.id, row.route) for row in result.offenders] == [
        ("10", "B"),
        ("10", "a"),
        ("9", "B"),
        ("9", "a"),
        ("B", "B"),
        ("B", "a"),
        ("_", "B"),
        ("_", "a"),
        ("a", "B"),
        ("a", "a"),
        ("é", "B"),
        ("é", "a"),
    ]


def test_latest_run_uses_run_identity_when_start_times_tie(surface_db):
    conn, params = surface_db
    for key in IDS:
        endpoint = conn.execute(
            text("""
            INSERT INTO core.feed_endpoints
                (provider_id, endpoint_key, feed_kind, source_format)
            VALUES (:provider_id, :key, 'trip_updates', 'gtfs_rt_trip_updates')
            RETURNING feed_endpoint_id
        """),
            {**params, "key": key},
        ).scalar_one()
        for status in ["failed", "succeeded"]:
            conn.execute(
                text("""
                INSERT INTO raw.ingestion_runs
                    (provider_id, feed_endpoint_id, run_kind, status,
                     started_at_utc, completed_at_utc)
                VALUES (:provider_id, :endpoint, 'trip_updates', :status,
                        '2026-07-31T12:00:00Z', '2026-07-31T12:01:00Z')
            """),
                {**params, "endpoint": endpoint, "status": status},
            )
    result = provenance.build_provenance(
        conn,
        **params,
        generated_utc="2026-08-01T00:00:00Z",
        as_of_utc=datetime(2026, 8, 1, tzinfo=UTC),
    )
    assert [(row.feed, row.status) for row in result.freshness] == [
        ("10", "succeeded"),
        ("9", "succeeded"),
        ("B", "succeeded"),
        ("_", "succeeded"),
        ("a", "succeeded"),
        ("é", "succeeded"),
    ]


def test_stop_habit_order_includes_local_cell(surface_db):
    conn, params = surface_db
    conn.execute(
        text("""
        INSERT INTO gold.stop_delay_hourly
            (provider_id, stop_id, route_id, period_start_utc,
             observation_count, severe_delay_count)
        VALUES (:provider_id, :id, 'route', CAST(:stamp AS timestamptz), 1, 1)
    """),
        [
            {**params, "id": value, "stamp": stamp}
            for value in IDS
            for stamp in ["2026-07-28T09:00:00Z", "2026-07-27T10:00:00Z", "2026-07-27T08:00:00Z"]
        ],
    )
    rows = conn.execute(stop_reliability._STOP_HABIT_SQL, params).mappings().all()
    assert [(r["stop_id"], r["day_of_week_iso"], r["hour_of_day_local"]) for r in rows] == [
        (value, day, hour) for value in BINARY for day, hour in [(1, 8), (1, 10), (2, 9)]
    ]


@pytest.mark.parametrize("batch", [False, True])
def test_direction_shift_text_order(surface_db, batch):
    conn, params = surface_db
    conn.execute(
        text("""
        INSERT INTO gold.route_headway_by_direction_shift
            (provider_id, route_id, direction_id, service_day_kind, shift)
        VALUES (:provider_id, 'route', 0, 'weekday', :id)
    """),
        [{**params, "id": value} for value in IDS],
    )
    query = (
        route_reliability_batch._HEADWAY_DIRECTION_SQL
        if batch
        else route_reliability._ROUTE_HEADWAY_DIRECTION_SQL
    )
    rows = conn.execute(query, {**params, "route_id": "route"}).mappings().all()
    assert [r["shift"] for r in rows] == ["10", "9", "B", "_", "a", "é"]
