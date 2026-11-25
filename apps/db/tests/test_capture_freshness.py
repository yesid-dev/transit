from datetime import UTC, datetime, timedelta

import yaml
from test_readiness import CONFIG

from transit_ops.capture_freshness import check_capture_freshness
from transit_ops.ingestion.common import build_bronze_object_storage_path
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.providers.registry import ProviderRegistry, load_provider_manifest


def test_capture_freshness_lists_only_opted_in_cities_and_enabled_feeds(tmp_path):
    providers = tmp_path / "providers"
    providers.mkdir()
    source = load_provider_manifest(CONFIG / "sto.yaml")
    for city in ("fixture_capture", "fixture_legacy"):
        manifest = source.model_dump(mode="json")
        manifest["provider"].update(provider_id=city, is_active=False)
        if city == "fixture_capture":
            manifest["capture_enabled"] = True
        manifest["feeds"]["service_alerts"]["is_enabled"] = False
        (providers / f"{city}.yaml").write_text(yaml.safe_dump(manifest), encoding="utf-8")

    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    now = datetime(2026, 11, 25, 0, 0, 10, tzinfo=UTC)
    for feed, age, partition in (
        ("static_schedule", 86_400, "ingested_at_utc"),
        ("trip_updates", 200, "captured_at_utc"),
        ("trip_updates", 20, "captured_at_utc"),
        ("trip_updates", -60, "captured_at_utc"),
        ("trip_updates", 5 * 86_400, "captured_at_utc"),
        ("vehicle_positions", 5 * 86_400, "captured_at_utc"),
    ):
        key = build_bronze_object_storage_path(
            provider_id="fixture_capture",
            endpoint_key=feed,
            partition_label=partition,
            observed_at_utc=now - timedelta(seconds=age),
            object_name="sample",
            checksum_sha256="0" * 64,
        )
        blob = tmp_path / "sample"
        blob.write_bytes(b"raw feed")
        storage.put_if_absent(blob, key)

    readings = check_capture_freshness(ProviderRegistry(providers), storage, now=now)

    assert {
        (reading.city, reading.feed): (reading.status, reading.age_seconds) for reading in readings
    } == {
        ("fixture_capture", "static_schedule"): ("fresh", 86_400),
        ("fixture_capture", "trip_updates"): ("fresh", 20),
        ("fixture_capture", "vehicle_positions"): ("late", 5 * 86_400),
    }

    storage = LocalBronzeStorage("local", tmp_path / "empty")
    missing = check_capture_freshness(ProviderRegistry(providers), storage, now=now)
    assert len(missing) == 3
    assert all(reading.status == "missing" for reading in missing)
