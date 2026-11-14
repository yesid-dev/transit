import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from transit_ops.providers.declaration import load_declaration
from transit_ops.providers.live_policy import sync_live_policy
from transit_ops.providers.registry import ProviderRegistry
from transit_ops.settings import Settings
from transit_ops.snapshots.providers import build_public_provider_catalog, provider_object_key
from transit_ops.snapshots.serialization import snapshot_json_bytes
from transit_ops.snapshots.storage import LocalSnapshotStorage

GOLDEN_PATH = Path(__file__).parent / "fixtures" / "provider_baseline" / "golden.json"
PROVIDER_DIR = Path(__file__).parents[1] / "config" / "providers"
DISPLAY_KEYS = {
    "provider": ("provider_id", "is_active", "bounds", "website_url"),
    "public": (
        "enabled",
        "labels",
        "basemap_url",
        "basemap_bounds",
        "posters_url",
        "fit_bounds",
        "max_bounds",
    ),
}


class RecordingConnection:
    def __init__(self):
        self.params = []

    def execute(self, statement, params):
        self.params.append(params)


def _catalogue_entries(registry, settings, *, complete=False):
    storage = LocalSnapshotStorage(settings.SNAPSHOT_LOCAL_ROOT, "v1")
    public_ids = []
    for provider_id in registry.list_provider_ids():
        config = registry.get_provider(provider_id)
        if not config.public.enabled:
            continue
        public_ids.append(provider_id)
        storage.put_json(
            f"{provider_id}/manifest.json",
            {
                "provider": provider_id,
                "display_name": config.provider.display_name,
                "city": config.provider.city,
                "tz": config.provider.timezone,
                "bbox": config.provider.bounds.bbox(),
                "attribution": config.provider.attribution_text,
                "dataset_version": "baseline-static",
                "labels": {},
                "surfaces": ["map"],
                "files": {
                    "live": {"generated_utc": "2026-10-03T00:00:00Z"},
                    "static": {"basemap": "static/basemap.json"},
                },
            },
            tier="live",
        )
        storage.put_json(
            f"{provider_id}/static/basemap.json",
            {
                "url": config.public.basemap_url,
                "attribution": config.provider.attribution_text,
                "generated_utc": "2026-10-03T00:00:00Z",
            },
            tier="static",
        )
        storage.put_bytes(
            provider_object_key(config.public.basemap_url, provider_id, None),
            bytes(100001),
            tier="static",
        )
    catalogue = build_public_provider_catalog(
        registry, storage, default_provider="stm" if complete else public_ids[0]
    )
    if complete:
        return catalogue
    return {entry.id: entry.model_dump(mode="json") for entry in catalogue.providers}


@pytest.fixture
def baseline(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, SNAPSHOT_LOCAL_ROOT=str(tmp_path))
    registry = ProviderRegistry.from_project_root(settings=settings)
    for provider_id in registry.list_provider_ids():
        for feed in registry.get_provider(provider_id).feeds.values():
            if feed.source_url_env_var:
                monkeypatch.delenv(feed.source_url_env_var, raising=False)
    # Rebuild typed settings after clearing overrides, as well as process-only values.
    settings = Settings(_env_file=None, SNAPSHOT_LOCAL_ROOT=str(tmp_path))
    registry = ProviderRegistry.from_project_root(settings=settings)
    entries = _catalogue_entries(registry, settings)
    result = {}
    for provider_id in registry.list_provider_ids():
        manifest = registry.get_provider(provider_id)
        connection = RecordingConnection()
        sync_live_policy(connection, manifest)
        display = manifest.to_display_dict(settings)
        result[provider_id] = {
            "provider_seed": manifest.to_provider_seed().as_params(),
            "feed_endpoint_seeds": [
                seed.as_params() for seed in manifest.to_feed_endpoint_seeds(settings)
            ],
            "live_policy_text": connection.params[0]["policy"],
            "show_provider": {
                section: {key: display.get(section, {}).get(key) for key in keys}
                for section, keys in DISPLAY_KEYS.items()
            },
        }
        if provider_id in entries:
            result[provider_id]["catalogue_entry"] = entries[provider_id]
    return result


def test_baseline_matches_golden(baseline):
    assert GOLDEN_PATH.exists(), "frozen golden missing: set PROVIDER_BASELINE_REGEN=1 to generate"
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    assert baseline.keys() == golden.keys(), "provider ids differ"
    for provider_id, expected in golden.items():
        actual = baseline[provider_id]
        assert actual.keys() == expected.keys(), f"{provider_id}: baseline keys differ"
        for key, value in expected.items():
            assert actual[key] == value, f"{provider_id}: {key} differs"


def test_golden_covers_every_provider_file():
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    assert set(golden) == {path.stem for path in PROVIDER_DIR.glob("*.yaml")}


def test_stm_file_loads_as_a_declaration():
    declaration = load_declaration(PROVIDER_DIR / "stm.yaml")
    assert (declaration.id, declaration.stage, declaration.default_locale) == (
        "stm",
        "public",
        "fr",
    )


def test_converted_declarations_keep_every_seeded_and_published_value(baseline):
    declaration = load_declaration(PROVIDER_DIR / "stm.yaml")
    gap = declaration.lines_without_live_data[0]
    assert gap.labels["en"].short == "Métro: real-time not available"
    assert gap.labels["en"].long == (
        "The STM does not publish real-time data for the métro. Live "
        "indicators cover the bus network; métro interruptions appear in "
        "service alerts."
    )
    assert gap.labels["fr"].short == "Métro : temps réel non disponible"
    assert gap.labels["fr"].long == (
        "La STM ne publie pas de données temps réel pour le métro. Les "
        "indicateurs en direct couvrent le réseau de bus; les interruptions "
        "de métro apparaissent dans les alertes de service."
    )
    assert baseline == json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    settings = Settings(_env_file=None)
    manifest = ProviderRegistry.from_project_root(settings=settings).get_provider("stm")
    expected_runtime = {
        "static_schedule": ("STM_STATIC_GTFS_URL", 86400, None, None, None),
        "gis_static": ("STM_GIS_URL", 86400, None, None, None),
        "trip_updates": ("STM_RT_TRIP_UPDATES_URL", 30, None, "apiKey", "STM_API_KEY"),
        "vehicle_positions": ("STM_RT_VEHICLE_POSITIONS_URL", 20, 10, "apiKey", "STM_API_KEY"),
        "i3_alerts": ("STM_I3_ALERTS_URL", 300, None, "apiKey", "STM_API_KEY"),
    }
    assert {
        key: (
            feed.source_url_env_var,
            feed.refresh_interval_seconds,
            feed.refresh_phase_seconds,
            feed.auth.auth_header_name,
            feed.auth.credential_env_var,
        )
        for key, feed in manifest.feeds.items()
    } == expected_runtime
    assert all(feed.auth.auth_query_param is None for feed in manifest.feeds.values())
    assert manifest.provider.reading_population == "vehicle_evidence"
    assert manifest.provider.live_source_lag_seconds == 0


def _expected_catalogue_bytes():
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    # Field order is part of the model serializer's published bytes.
    fields = (
        "id",
        "labels",
        "fit_bounds",
        "max_bounds",
        "geocode_context",
        "posters_url",
        "alert_links",
        "inputs",
    )
    expected = {
        "schema_version": 1,
        "methodology_version": "providers-1",
        "publish_generation_id": "providers@2026-10-03T00:00:00Z",
        "generated_utc": "2026-10-03T00:00:00Z",
        "default_provider": "stm",
        "providers": [
            {key: value["catalogue_entry"][key] for key in fields}
            for value in golden.values()
            if "catalogue_entry" in value
        ],
    }
    for entry in expected["providers"]:
        entry["inputs"] = {
            key: entry["inputs"][key]
            for key in (
                "static_schedule",
                "gis_static",
                "trip_updates",
                "vehicle_positions",
                "i3_alerts",
                "service_alerts",
            )
        }
    return json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def test_stm_catalogue_publication_bytes_are_unchanged(baseline, tmp_path, monkeypatch):
    class PublicationClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 3, tzinfo=UTC)

    monkeypatch.setattr("transit_ops.snapshots.providers.datetime", PublicationClock)
    settings = Settings(_env_file=None, SNAPSHOT_LOCAL_ROOT=str(tmp_path))
    registry = ProviderRegistry.from_project_root(settings=settings)
    catalogue = _catalogue_entries(registry, settings, complete=True)
    assert snapshot_json_bytes(catalogue) == _expected_catalogue_bytes()
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    for provider_id, expected_values in golden.items():
        assert snapshot_json_bytes(baseline[provider_id]) == snapshot_json_bytes(expected_values)


@pytest.mark.skipif(
    os.environ.get("PROVIDER_BASELINE_REGEN") != "1",
    reason="set PROVIDER_BASELINE_REGEN=1 to regenerate the frozen golden",
)
def test_regenerate_provider_baseline(baseline):
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN_PATH.write_text(
        json.dumps(baseline, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
