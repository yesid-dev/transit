"""Raw publication observations; never project, parse or rewrite captured bodies."""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from historic_graph_fixtures import graph_from_bundles
from test_partitioned_history_publish import (
    _empty_line_history_plan,
    _empty_point_history_indexes,
    _empty_stop_history_plan,
    _stop_history_plan,
)
from test_snapshots_storage import _StableCasClient

from transit_ops.core.models import ProviderBoundsConfig, ProviderPublicConfig
from transit_ops.settings import Settings
from transit_ops.snapshots import providers
from transit_ops.snapshots.builders.historic.network_history import build_network_history_from_rows
from transit_ops.snapshots.builders.static import build_basemap
from transit_ops.snapshots.contract import AlertArchiveIndex, ReceiptsIndex
from transit_ops.snapshots.storage import build_snapshot_storage

SOURCE = "b9e9fa14d38f4a2a4ca3d7ac85d42c5e6a3c8976"
GOLDEN = Path(__file__).parent / "fixtures/publication_target_r2.json"


def canonical(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def summary(cases):
    return {
        "source": SOURCE,
        "cases": {
            name: {"count": len(rows), "sha256": hashlib.sha256(canonical(rows)).hexdigest()}
            for name, rows in sorted(cases.items())
        },
    }


def compare_golden(cases):
    captured = canonical({"golden": summary(cases), "inventory": cases}).decode()
    message = f"H1A_INVENTORY_BEGIN\n{captured}H1A_INVENTORY_END"
    assert GOLDEN.exists(), message
    assert GOLDEN.read_bytes() == canonical(summary(cases)), message


def inventory(objects):
    return [
        [
            key,
            len(obj["Body"]),
            hashlib.sha256(obj["Body"]).hexdigest(),
            obj["ContentType"],
            obj["CacheControl"],
        ]
        for key, obj in sorted(objects.items())
    ]


def assert_inventory(objects, expected):
    actual = inventory(objects)
    assert actual == expected, f"publication inventory\nexpected={expected!r}\nactual={actual!r}"


def storage_pair(root: Path, *, provider_id: str | None = "test"):
    client = _StableCasClient()
    remote = build_snapshot_storage(
        Settings(_env_file=None, SNAPSHOT_STORAGE_BACKEND="s3", SNAPSHOT_R2_BUCKET="test-bucket"),
        provider_id=provider_id,
        client=client,
    )
    local = build_snapshot_storage(
        Settings(_env_file=None, SNAPSHOT_STORAGE_BACKEND="local", SNAPSHOT_LOCAL_ROOT=str(root)),
        provider_id=provider_id,
    )
    return remote, local, client


def catalog_case(root, monkeypatch):
    settings = Settings(_env_file=None)
    bounds = ProviderBoundsConfig(
        min_latitude=45, max_latitude=46, min_longitude=-74, max_longitude=-73
    )
    public = ProviderPublicConfig(enabled=True, basemap_url="static/basemap/map.pmtiles")
    identity = SimpleNamespace(
        is_active=True,
        city="Ville",
        display_name="Réseau",
        short_name="R",
        timezone="America/Toronto",
        bounds=bounds,
    )
    config = SimpleNamespace(provider=identity, public=public, feeds={})
    registry = SimpleNamespace(
        settings=settings, list_provider_ids=lambda: ["test"], get_provider=lambda _id: config
    )
    clock = SimpleNamespace(now=lambda _tz: datetime(2025, 9, 2, 7, tzinfo=UTC))
    monkeypatch.setattr(providers, "datetime", clock)
    remote, local, client = storage_pair(root, provider_id=None)
    stamp = "2025-09-02T07:00:00Z"
    manifest = dict(
        provider="test",
        display_name="Réseau",
        city="Ville",
        tz=identity.timezone,
        bbox=bounds.bbox(),
        attribution="Test",
        dataset_version="fixed",
        labels={},
        surfaces=["map"],
        files={"live": {"generated_utc": stamp}, "static": {"basemap": "static/basemap.json"}},
    )
    return _catalog_outputs(
        root, settings, registry, public, stamp, manifest, remote, local, client
    )


def _catalog_outputs(root, settings, registry, public, stamp, manifest, remote, local, client):
    local.put_json("test/manifest.json", manifest, tier="live")
    basemap = build_basemap(settings, public=public, generated_utc=stamp)
    local.put_json("test/static/basemap.json", basemap, tier="static")
    local.put_bytes("test/static/basemap/map.pmtiles", bytes(100001), tier="static")
    catalog = providers.build_public_provider_catalog(registry, local, default_provider="test")
    for store in (remote, local):
        store.put_json("providers.json", catalog, tier="live")
        store.put_json("test/static/basemap.json", basemap, tier="static")
    assert build_basemap(settings, public=ProviderPublicConfig(), generated_utc=stamp) is None
    assert set(client.objects) == {"v1/providers.json", "v1/test/static/basemap.json"}
    for key, obj in client.objects.items():
        assert (root / key).read_bytes() == obj["Body"]
        assert obj["ContentType"] == "application/json"
    assert client.objects["v1/providers.json"]["CacheControl"] == "public, max-age=20"
    assert client.objects["v1/test/static/basemap.json"]["CacheControl"] == (
        "public, max-age=86400, stale-while-revalidate=86400"
    )
    remote.close()
    return inventory(client.objects)


def graph_cases(root):
    stamp = "2026-07-13T00:00:00Z"
    points = _empty_point_history_indexes(stamp)
    graph = graph_from_bundles(
        alerts=AlertArchiveIndex(
            generated_utc=stamp,
            collection_generation_id="empty-alerts",
            first_available_date=None,
            last_available_date=None,
            total_alerts=0,
            months=[],
        ),
        receipts=ReceiptsIndex(
            generated_utc=stamp, collection_generation_id="empty-receipts", dates=[]
        ),
        network=build_network_history_from_rows(
            delay_rows=[],
            fact_rows=[],
            cancellation_rows=[],
            occupancy_rows=[],
            generated_utc=stamp,
            provider_id="test",
        ).index,
        lines=_empty_line_history_plan().materialize(),
        stops=_empty_stop_history_plan().materialize(),
        hotspots=points[0],
        repeat_offenders=points[1],
    )
    empty = graph.build_root(stamp)
    assert empty.generated_utc == stamp
    assert all(family.first_available_date is None for family in empty.families)
    remote, _local, client = storage_pair(root)
    remote.put_json("historic/history/index.json", empty, tier="historic")
    cases = {"empty_history": inventory(client.objects)}
    client.objects.clear()
    bundle = _stop_history_plan().materialize()
    for key, payload in bundle.partition_items:
        assert "412f4220c3a9e99baa" in key
        remote.put_immutable_json(key, payload)
    cases["utf8_stop"] = inventory(client.objects)
    remote.close()
    return cases
