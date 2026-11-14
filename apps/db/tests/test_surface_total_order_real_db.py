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
)

IDS = ["é", "a", "_", "B", "9", "10"]
STAMP = "2026-08-01T00:00:00Z"


@pytest.fixture
def surface_db(real_db_engine, seed_provider, record_property):
    with real_db_engine.connect() as conn, conn.begin():
        provider = f"surface-order-{uuid4().hex[:10]}"
        seed_provider(conn, provider, display_name="Surface order", timezone="UTC")
        record_property(
            "database_collation",
            conn.execute(
                text("SELECT datcollate FROM pg_database WHERE datname = current_database()")
            ).scalar_one(),
        )
        yield conn, {"provider_id": provider}
        conn.rollback()


def test_offender_cutoff_base_head_and_strict_control(surface_db, record_property):
    conn, params = surface_db
    conn.execute(
        text("""
        INSERT INTO gold.repeat_offender
            (provider_id, entity_kind, entity_id, route_id, recurrence_days,
             window_days, avg_delay_seconds)
        VALUES (:provider_id, 'trip', :id, 'route', :days, 100, 120)
    """),
        [{**params, "id": f"strict-{i:02}", "days": 100 - i} for i in range(49)]
        + [{**params, "id": key, "days": 1} for key in ["a", "B"]],
    )
    base_sql = text("""
        SELECT entity_kind, entity_id, route_id, recurrence_days, window_days,
               avg_delay_seconds, severity_label
        FROM gold.repeat_offender WHERE provider_id = :provider_id
        ORDER BY recurrence_days DESC, avg_delay_seconds DESC LIMIT 50
    """)
    base = [row["entity_id"] for row in conn.execute(base_sql, params).mappings()]
    try:
        assert base[-1:] == ["B"]
    except AssertionError:
        record_property("base_offender_cutoff_assertion", f"FAIL: {base[-1:]!r} != ['B']")
    else:
        record_property("base_offender_cutoff_assertion", "PASS: unspecified tie matched ['B']")
    result = small_surfaces.build_repeat_offenders(conn, **params, generated_utc=STAMP)
    assert len(result.offenders) == 50
    assert [row.id for row in result.offenders[-1:]] == ["B"]
    record_property("head_offender_cutoff_assertion", "PASS: ['B']")
    conn.execute(
        text("""
        UPDATE gold.repeat_offender SET recurrence_days = 0
        WHERE provider_id = :provider_id AND entity_id = 'a'
    """),
        params,
    )
    control = small_surfaces.build_repeat_offenders(conn, **params, generated_utc=STAMP)
    base_control = [row["entity_id"] for row in conn.execute(base_sql, params).mappings()]
    assert [row.id for row in control.offenders] == base_control
    assert [row.id for row in control.offenders[-1:]] == ["B"]
    conn.execute(text("DELETE FROM gold.repeat_offender WHERE provider_id = :provider_id"), params)
    conn.execute(
        text("""
        INSERT INTO gold.repeat_offender
            (provider_id, entity_kind, entity_id, route_id, recurrence_days, avg_delay_seconds)
        VALUES (:provider_id, 'trip', :id, 'route', :days, :delay)
    """),
        [
            {**params, "id": key, "days": days, "delay": delay}
            for key, days, delay in [
                ("null-days", None, 0),
                ("null-delay", 1, None),
                ("known", 1, 120),
            ]
        ],
    )
    mixed = small_surfaces.build_repeat_offenders(conn, **params, generated_utc=STAMP)
    assert [row.id for row in mixed.offenders] == ["null-days", "null-delay", "known"]


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


def test_hotspot_twenty_first_tie_is_excluded(surface_db):
    conn, params = surface_db
    conn.execute(
        text("""
        INSERT INTO gold.repeated_problem_route_stop
            (provider_id, entity_kind, entity_id, route_id, period_grain,
             period_start_local, issue_count)
        VALUES (:provider_id, 'route', :id, :id, 'week', '2026-07-27', :issues)
    """),
        [{**params, "id": f"strict-{i:02}", "issues": 100 - i} for i in range(19)]
        + [{**params, "id": key, "issues": 1} for key in ["a", "B"]],
    )
    result = small_surfaces.build_hotspots(conn, **params, generated_utc=STAMP)
    assert len(result.hotspots) == 20
    assert [(row.rank, row.id) for row in result.hotspots[-2:]] == [(19, "strict-18"), (20, "B")]


def test_receipt_equal_delay_winner_and_dark_route_order(surface_db):
    conn, params = surface_db
    conn.execute(
        text("""
        INSERT INTO gold.citizen_accountability_daily (provider_id, provider_local_date)
        VALUES (:provider_id, '2026-07-31')
    """),
        params,
    )
    for key, on_time in [("a", 8), ("B", 2)]:
        binds = {**params, "id": key, "otp": on_time}
        conn.execute(
            text("""
            INSERT INTO gold.route_delay_hourly
                (provider_id, route_id, period_start_utc, delay_observation_count,
                 on_time_observation_count, usable_delay_observation_count,
                 usable_delay_sum_seconds)
            VALUES (:provider_id, :id, '2026-07-31T12:00Z', 10, :otp, 10, 1200)
        """),
            binds,
        )
        conn.execute(
            text("""
            INSERT INTO gold.route_delay_spine
                (provider_id, route_id, provider_local_date, hour_of_day_local, direction_id,
                 delay_observation_count, on_time_observation_count)
            VALUES (:provider_id, :id, '2026-07-31', 12, 0, 10, :otp)
        """),
            binds,
        )
        conn.execute(
            text("""
            INSERT INTO gold.route_cancellation_daily
                (provider_id, route_id, provider_local_date, scheduled_trip_days,
                 total_trip_days, canceled_trip_days)
            VALUES (:provider_id, :id, '2026-07-31', 10, 0, 0)
        """),
            binds,
        )
    receipt = small_surfaces.build_receipts(conn, **params, generated_utc=STAMP)["2026-07-31"]
    assert (receipt.worst_route.id, receipt.worst_route.otp_delta_pts) == ("B", -30.0)
    assert [row.id for row in receipt.service_states.not_reported_routes] == ["B", "a"]


def test_alert_history_equal_start_cutoff(surface_db):
    conn, params = surface_db
    endpoint = conn.execute(
        text("""
        INSERT INTO core.feed_endpoints (provider_id, endpoint_key, feed_kind, source_format)
        VALUES (:provider_id, 'alerts', 'i3_alerts', 'api_i3_json') RETURNING feed_endpoint_id
    """),
        params,
    ).scalar_one()
    run = conn.execute(
        text("""
        INSERT INTO raw.ingestion_runs (provider_id, feed_endpoint_id, run_kind, status)
        VALUES (:provider_id, :endpoint, 'i3_alerts', 'succeeded') RETURNING ingestion_run_id
    """),
        {**params, "endpoint": endpoint},
    ).scalar_one()
    snapshot = conn.execute(
        text("""
        INSERT INTO raw.i3_alert_snapshots
            (provider_id, feed_endpoint_id, ingestion_run_id, captured_at_utc, raw_payload_json)
        VALUES (:provider_id, :endpoint, :run, '2026-07-31T12:00Z', '{}')
        RETURNING i3_alert_snapshot_id
    """),
        {**params, "endpoint": endpoint, "run": run},
    ).scalar_one()
    conn.execute(
        text("""
        INSERT INTO silver.i3_alerts
            (provider_id, i3_alert_snapshot_id, alert_index, alert_id, captured_at_utc,
             active_period_start_utc, raw_alert_json, content_hash)
        VALUES (:provider_id, :snapshot, :i, :id, '2026-07-31T12:00Z',
                '2026-07-31T12:00Z', '{}', :id)
    """),
        [
            {**params, "snapshot": snapshot, "i": i, "id": key}
            for i, key in enumerate([f"0-{n:03}" for n in range(499)] + ["a", "B"])
        ],
    )
    result = small_surfaces.build_alert_history(
        conn, **params, generated_utc=STAMP, as_of_utc=datetime(2026, 8, 1, tzinfo=UTC)
    )
    assert result.total_in_window == 501
    assert result.truncated is True
    assert len(result.alerts) == 500
    assert [row.id for row in result.alerts[-2:]] == ["0-498", "B"]


def test_several_current_sources_keep_version_identity(surface_db):
    conn, params = surface_db
    endpoint = conn.execute(
        text("""
        INSERT INTO core.feed_endpoints (provider_id, endpoint_key, feed_kind, source_format)
        VALUES (:provider_id, 'static', 'static_schedule', 'gtfs_schedule_zip')
        RETURNING feed_endpoint_id
    """),
        params,
    ).scalar_one()
    run = conn.execute(
        text("""
        INSERT INTO raw.ingestion_runs (provider_id, feed_endpoint_id, run_kind, status)
        VALUES (:provider_id, :endpoint, 'static_schedule', 'succeeded') RETURNING ingestion_run_id
    """),
        {**params, "endpoint": endpoint},
    ).scalar_one()
    for key in ["a", "B", "é"]:
        conn.execute(
            text("""
            INSERT INTO core.dataset_versions
                (provider_id, feed_endpoint_id, source_ingestion_run_id, dataset_kind,
                 content_hash, source_url)
            VALUES (:provider_id, :endpoint, :run, 'gis_static', :key, :key)
        """),
            {**params, "endpoint": endpoint, "run": run, "key": key},
        )
    result = provenance.build_provenance(
        conn, **params, generated_utc=STAMP, as_of_utc=datetime(2026, 8, 1, tzinfo=UTC)
    )
    assert [row.chain for row in result.sources] == ["a", "B", "é"]
