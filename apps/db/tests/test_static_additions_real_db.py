import json
from datetime import timedelta

import pytest
from sqlalchemy import text

from transit_ops.snapshots.builders.static import build_routes_index


@pytest.fixture
def policy_routes(real_db_engine, seed_provider):
    with real_db_engine.begin() as conn:
        for provider in ("static_policy", "static_other"):
            seed_provider(conn, provider, display_name="Synthetic transit")
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
            VALUES ('static_policy', 1, :route, :route, 0)
        """),
            [{"route": route} for route in routes],
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
