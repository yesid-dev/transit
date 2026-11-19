"""Capture the PostgreSQL publication context once per paired-shadow cycle.

Each read copies the query the PostgreSQL manifest and data-health builders run
(snapshots/builders/live.py), without their now() ages: the local builders age
every fact against the cycle instant. The five reads share one REPEATABLE READ,
READ ONLY transaction on the worker's engine, taken before the public publication
records this cycle's tier state, so both candidates read the same facts. Display
inputs come from the same owners the PostgreSQL manifest uses: the provider
registry and SNAPSHOT_PUBLIC_BASE_URL. A missing input refuses by name; an empty
result is a successfully read empty store, never a substitute for a missing one.

Live ruling 23: a feed's freshness budget is FRESH_FEED_AGE_SECONDS plus the
provider's declared live_source_lag_seconds, and `enabled` follows the declared
feed. The budget labels evidence only; no published byte depends on it.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import TYPE_CHECKING, Any, Protocol

from sqlalchemy import text

from transit_ops.capture_coverage.rules import FRESH_FEED_AGE_SECONDS
from transit_ops.live.publication_context import CapturedRows, PublicationContext, aware
from transit_ops.live.running import FeedPolicy
from transit_ops.sql_registry import named_query

if TYPE_CHECKING:
    from sqlalchemy import Connection, Engine

    from transit_ops.core.models import ProviderManifest, ProviderPublicConfig

SOURCE = "postgres"
NAMES = ("provider", "editions", "endpoints", "tiers", "feeds")
_READ_ONLY = text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")

# manifest.provider
_PROVIDER = named_query(
    "live.context.provider",
    """
    SELECT provider_id, display_name, short_name, city, timezone, default_language,
           attribution_text,
           min_latitude, max_latitude, min_longitude, max_longitude
    FROM core.providers
    WHERE provider_id = :provider_id
    """,
)

# manifest.version and publish.static_stamp, every current edition (no LIMIT).
_EDITIONS = named_query(
    "live.context.editions",
    """
    SELECT provider_id, dataset_version_id, source_version, loaded_at_utc
    FROM core.dataset_versions
    WHERE provider_id = :provider_id
      AND dataset_kind = 'static_schedule'
      AND is_current = true
    ORDER BY loaded_at_utc DESC, dataset_version_id DESC
    """,
)

# manifest.capability_endpoints
_ENDPOINTS = named_query(
    "live.context.endpoints",
    """
    SELECT DISTINCT provider_id, endpoint_key
    FROM core.feed_endpoints
    WHERE provider_id = :provider_id
      AND is_enabled = true
    ORDER BY endpoint_key
    """,
)

# data_health.lanes without its now() age; it also serves manifest.tier_state.
_TIERS = named_query(
    "live.context.tiers",
    """
    SELECT
        provider_id,
        tier,
        generated_utc,
        files_written,
        files_skipped,
        files_total,
        gate_checks_run,
        gate_errors,
        gate_warnings,
        gate_verdict,
        gate_generated_utc
    FROM core.snapshot_publish_state
    WHERE provider_id = :provider_id
      AND tier IN ('live', 'static', 'historic')
    ORDER BY tier
    """,
)

# data_health.feeds without its now() age. Serving and alert stamps are local evidence.
_FEEDS = named_query(
    "live.context.feeds",
    """
    SELECT f.provider_id, f.endpoint_key, f.status,
           capture.last_capture AS successful_completed_at_utc
    FROM gold.feed_freshness_current f
    LEFT JOIN LATERAL (
        SELECT ir.completed_at_utc AS last_capture
        FROM raw.ingestion_runs ir
        JOIN core.feed_endpoints fe ON fe.feed_endpoint_id = ir.feed_endpoint_id
        WHERE ir.provider_id = f.provider_id AND fe.endpoint_key = f.endpoint_key
          AND f.endpoint_key NOT IN (
              'trip_updates', 'vehicle_positions', 'i3_alerts', 'service_alerts'
          )
          AND ir.status = 'succeeded' AND ir.run_kind <> 'silver_load'
        ORDER BY ir.started_at_utc DESC, ir.ingestion_run_id DESC
        LIMIT 1
    ) capture ON true
    WHERE f.provider_id = :provider_id
    ORDER BY f.endpoint_key
    """,
)

_READS = (
    ("provider", _PROVIDER),
    ("editions", _EDITIONS),
    ("endpoints", _ENDPOINTS),
    ("tiers", _TIERS),
    ("feeds", _FEEDS),
)

type Sources = Mapping[str, Sequence[Mapping[str, Any]]]


class Registry(Protocol):
    def list_provider_ids(self) -> list[str]: ...
    def get_provider(self, provider_id: str) -> ProviderManifest: ...
    def get_public_config(self, provider_id: str) -> ProviderPublicConfig: ...


class ContextMissing(ValueError):
    def __init__(self, name: str) -> None:
        super().__init__(f"publication_context_missing:{name}")
        self.name = name


def feed_policy(manifest: ProviderManifest, endpoint: str) -> FeedPolicy:
    """Live ruling 23: the one existing fresh-feed rule plus the declared source lag."""
    feed = manifest.feeds.get(endpoint)
    return FeedPolicy(
        feed is not None and bool(feed.is_enabled),
        FRESH_FEED_AGE_SECONDS + manifest.provider.live_source_lag_seconds,
    )


def read_sources(conn: Connection, provider_id: str) -> dict[str, list[dict[str, Any]]]:
    params = {"provider_id": provider_id}
    return {name: [dict(r) for r in conn.execute(sql, params).mappings()] for name, sql in _READS}


def _value(value: object) -> object:
    if isinstance(value, datetime):
        return aware(value, "captured timestamp").isoformat()
    raise TypeError(f"uncapturable context value {type(value).__name__}")


def assemble(
    cycle: datetime,
    provider_id: str,
    sources: Sources,
    *,
    registry: Registry,
    public_base_url: str | None,
) -> PublicationContext:
    """Detach the read rows into canonical bytes stamped with the cycle instant."""
    cycle = aware(cycle, "cycle")
    for name in NAMES:
        if name not in sources:
            raise ContextMissing(name)
    if len(sources["provider"]) != 1:
        raise ContextMissing("provider")
    if provider_id not in registry.list_provider_ids():
        raise ContextMissing("provider_registry")
    if public_base_url is None:
        raise ContextMissing("public_base_url")
    manifest = registry.get_provider(provider_id)
    rows = {name: [dict(row) for row in sources[name]] for name in NAMES}
    rows["provider"][0].update(
        public_base_url=public_base_url,
        basemap_url=registry.get_public_config(provider_id).basemap_url,
        source_lag_s=manifest.provider.live_source_lag_seconds,
    )
    captured = {
        name: CapturedRows(
            SOURCE,
            cycle,
            json.dumps(
                body, default=_value, separators=(",", ":"), sort_keys=True, allow_nan=False
            ).encode(),
        )
        for name, body in rows.items()
    }
    return PublicationContext(
        cycle,
        provider_id,
        **captured,
        trip_policy=feed_policy(manifest, "trip_updates"),
        vehicle_policy=feed_policy(manifest, "vehicle_positions"),
    )


def postgres_context(
    engine: Engine, *, provider_id: str, registry: Registry, public_base_url: str | None
) -> Callable[[datetime], PublicationContext]:
    """The production ContextSource: one read-only snapshot per call, no PG clock."""

    def capture(cycle: datetime) -> PublicationContext:
        with engine.connect() as conn, conn.begin():
            conn.execute(_READ_ONLY)
            sources = read_sources(conn, provider_id)
        return assemble(
            cycle, provider_id, sources, registry=registry, public_base_url=public_base_url
        )

    return capture
