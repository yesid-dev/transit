"""The captured publication context equals what the PostgreSQL builders read."""

from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from test_live_builders_status_real_db import Sources, cycle_fixture, prepare
from test_live_running import AT, Holder, inputs
from test_live_running import local as local

from transit_ops.live.builders_status import build_bundle
from transit_ops.live.context_capture import (
    ContextMissing,
    assemble,
    feed_policy,
    postgres_context,
    read_sources,
)
from transit_ops.providers.registry import ProviderRegistry
from transit_ops.snapshots.builders import live
from transit_ops.snapshots.builders._helpers import _iso
from transit_ops.snapshots.serialization import snapshot_json_bytes


def add_feeds(pg, provider, manifest):
    """Declared live feeds are enabled endpoints; a static feed ages from its last poll."""
    for key in ("trip_updates", "vehicle_positions"):
        if feed_policy(manifest, key).enabled:
            pg.execute(
                text(
                    "INSERT INTO pg_temp.feed_endpoints (provider_id,endpoint_key,is_enabled) "
                    "VALUES (:p,:key,true)"
                ),
                dict(p=provider, key=key),
            )
    pg.execute(
        text(
            "INSERT INTO pg_temp.feed_endpoints "
            "(feed_endpoint_id,provider_id,endpoint_key,is_enabled) "
            "VALUES (9001,:p,'static_schedule',true)"
        ),
        {"p": provider},
    )
    pg.execute(
        text(
            "INSERT INTO pg_temp.feed_freshness_current (provider_id,endpoint_key,status) "
            "VALUES (:p,'static_schedule','failed')"
        ),
        {"p": provider},
    )
    for run_id, kind, status, age in (
        (1, "static_schedule", "succeeded", 7200),
        (2, "static_schedule", "succeeded", 600),
        (3, "silver_load", "succeeded", 60),  # Never completion evidence for the poll.
        (4, "static_schedule", "failed", 30),
    ):
        pg.execute(
            text(
                "INSERT INTO pg_temp.ingestion_runs "
                "(ingestion_run_id,provider_id,feed_endpoint_id,run_kind,status,"
                "started_at_utc,completed_at_utc) "
                "VALUES (:id,:p,9001,:kind,:status,:at,:at)"
            ),
            dict(id=run_id, p=provider, kind=kind, status=status, at=AT - timedelta(seconds=age)),
        )


@pytest.mark.parametrize("provider", ["stm", "octranspo"])
def test_captured_context_reproduces_postgresql_manifest_and_health_bytes(
    real_db_engine, local, provider
):
    fixture, settings = cycle_fixture(local, provider, False)
    registry = ProviderRegistry.from_project_root(settings=settings)
    with real_db_engine.connect() as pg, pg.begin() as tx:
        try:
            prepare(pg, fixture, local)
            add_feeds(pg, provider, registry.get_provider(provider))
            sources = Sources(pg)
            captured = assemble(
                AT,
                provider,
                read_sources(sources, provider),
                registry=registry,
                public_base_url=settings.SNAPSHOT_PUBLIC_BASE_URL,
            )
            args = dict(provider_id=provider, generated_utc=_iso(AT))
            expected = {
                "manifest.json": live.build_manifest(sources, settings=settings, **args),
                "status/data_health.json": live.build_data_health(sources, **args),
            }
        finally:
            tx.rollback()
    ours = build_bundle(local, Holder(None), inputs(local), captured)
    for key, payload in expected.items():
        assert ours[key] == snapshot_json_bytes(payload), f"captured context differs: {key}"
    feeds = {row["endpoint_key"]: row for row in captured.rows("feeds")}
    assert feeds["static_schedule"]["successful_completed_at_utc"] == (
        (AT - timedelta(seconds=600)).isoformat()
    )
    assert feeds["i3_alerts"]["successful_completed_at_utc"] is None


def test_production_capture_reads_the_migrated_schema_read_only_and_refuses_by_name(
    real_db_engine,
):
    settings_url = "https://example.org"
    registry = ProviderRegistry.from_project_root(
        settings=SimpleNamespace(SNAPSHOT_PUBLIC_BASE_URL=settings_url)
    )
    provider = registry.list_provider_ids()[0]
    capture = postgres_context(
        real_db_engine,
        provider_id="shadow-context-absent",
        registry=registry,
        public_base_url=settings_url,
    )
    # All five copied reads run against the installed tables and views first.
    with pytest.raises(ContextMissing, match="^publication_context_missing:provider$"):
        capture(AT)
    with real_db_engine.connect() as pg, pg.begin():
        pg.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        rows = read_sources(pg, provider)
    assert set(rows) == {"provider", "editions", "endpoints", "tiers", "feeds"}
