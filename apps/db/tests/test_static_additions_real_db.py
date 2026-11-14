import json
from datetime import timedelta

import pytest
from sqlalchemy import text

from transit_ops.snapshots.builders.static import build_routes_index


def _seed_dataset_version(conn):
    return conn.execute(
        text("""
        WITH endpoint AS (
            INSERT INTO core.feed_endpoints(provider_id,endpoint_key,feed_kind,source_format)
            VALUES ('static_policy','static_schedule','static_schedule','gtfs_schedule_zip')
            RETURNING feed_endpoint_id
        ), run AS (
            INSERT INTO raw.ingestion_runs(provider_id,feed_endpoint_id,run_kind,status)
            SELECT 'static_policy',feed_endpoint_id,'static_schedule','succeeded' FROM endpoint
            RETURNING ingestion_run_id,feed_endpoint_id
        )
        INSERT INTO core.dataset_versions(provider_id,feed_endpoint_id,
            source_ingestion_run_id,dataset_kind,content_hash,is_current)
        SELECT 'static_policy',feed_endpoint_id,ingestion_run_id,
            'static_schedule',repeat('a',64),true FROM run
        RETURNING dataset_version_id
    """)
    ).scalar_one()


@pytest.fixture
def policy_routes(real_db_engine, seed_provider):
    with real_db_engine.begin() as conn:
        for provider in ("static_policy", "static_other"):
            seed_provider(conn, provider, display_name="Synthetic transit")
        version = _seed_dataset_version(conn)
        routes = ["free", "absent", "lower", "upper", "older", "future", "other"]
        conn.execute(
            text("""
            UPDATE core.providers SET lines_without_live_data=CAST(:policy AS jsonb)
            WHERE provider_id='static_policy'
        """),
            {"policy": json.dumps([{"route_ids": routes[1:]}])},
        )
        conn.execute(
            text("""
            INSERT INTO gold.dim_route
                (provider_id, dataset_version_id, route_id, route_short_name, route_type)
            VALUES ('static_policy', :version, :route, :route, 0)
        """),
            [{"route": route, "version": version} for route in routes],
        )
        # CURRENT_TIMESTAMP is fixed for this transaction, including both endpoints.
        now = conn.execute(text("SELECT CURRENT_TIMESTAMP")).scalar_one()
        for route, offset in (("lower", -900), ("upper", 0), ("older", -901), ("future", 1)):
            conn.execute(
                text("""
                INSERT INTO core.route_live_observations VALUES ('static_policy', :route, :at)
            """),
                {"route": route, "at": now + timedelta(seconds=offset)},
            )
        conn.execute(
            text("""
            INSERT INTO core.route_live_observations VALUES ('static_other', 'other', :at)
        """),
            {"at": now},
        )
        yield conn
        conn.rollback()


def test_routes_index_live_data_uses_declaration_and_recent_observation(policy_routes):
    result = build_routes_index(policy_routes, provider_id="static_policy", generated_utc="old")
    assert {route.id: route.live_data for route in result.routes} == {
        "free": True,
        "absent": False,
        "lower": True,
        "upper": True,
        "older": False,
        "future": False,
        "other": False,
    }
    assert all(route.type == 0 for route in result.routes)


def test_live_data_does_not_use_the_edition_stamp_as_now(policy_routes):
    result = build_routes_index(
        policy_routes, provider_id="static_policy", generated_utc="2000-01-01T00:00:00Z"
    )
    assert result.generated_utc == "2000-01-01T00:00:00Z"
    assert next(route for route in result.routes if route.id == "upper").live_data is True
