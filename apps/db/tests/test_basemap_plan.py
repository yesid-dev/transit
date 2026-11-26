from pathlib import Path
from typing import Any

import pytest
import yaml

from transit_ops.providers.basemap_plan import basemap_plan
from transit_ops.providers.registry import ProviderRegistry

PROVIDERS = Path(__file__).parents[1] / "config" / "providers"


def _declare(directory: Path, name: str, *, public: bool, legacy: bool | None) -> None:
    # Synthetic cities built from a public declaration's shape.
    template: dict[str, Any] = yaml.safe_load(
        next(
            path.read_text(encoding="utf-8")
            for path in sorted(PROVIDERS.glob("*.yaml"))
            if "provider:" in path.read_text(encoding="utf-8")
        )
    )
    template["provider"]["provider_id"] = name
    template["provider"]["is_active"] = public
    template["public"]["enabled"] = public
    template["public"]["basemap_url"] = f"/data/v1/{name}/static/basemap/{name}.pmtiles"
    if legacy is not None:
        template["public"]["basemap_legacy"] = legacy
    (directory / f"{name}.yaml").write_text(yaml.safe_dump(template), encoding="utf-8")


@pytest.fixture
def registry(tmp_path: Path) -> ProviderRegistry:
    _declare(tmp_path, "alpha", public=True, legacy=None)
    _declare(tmp_path, "beta", public=False, legacy=None)
    _declare(tmp_path, "gamma", public=False, legacy=False)
    _declare(tmp_path, "delta", public=True, legacy=False)
    return ProviderRegistry(tmp_path)


def _legacy(jobs: list[dict[str, str | bool]]) -> dict[str, str | bool]:
    return {str(job["provider"]): job["legacy"] for job in jobs}


def test_scheduled_refresh_skips_private_cities_and_marks_clean_only(
    registry: ProviderRegistry,
) -> None:
    assert _legacy(basemap_plan(registry)) == {"alpha": True, "delta": False}


def test_private_city_publishes_only_to_clean_storage(registry: ProviderRegistry) -> None:
    with pytest.raises(ValueError, match="requires plan_only or a clean-only basemap"):
        basemap_plan(registry, "beta")
    assert _legacy(basemap_plan(registry, "beta", plan_only=True)) == {"beta": True}
    (job,) = basemap_plan(registry, "gamma")
    assert job["legacy"] is False
    assert job["key"] == "v1/gamma/static/basemap/gamma.pmtiles"


def test_copy_mode_needs_a_legacy_object(registry: ProviderRegistry) -> None:
    assert _legacy(basemap_plan(registry, "alpha", copy_current=True)) == {"alpha": True}
    for city in ("gamma", "delta"):
        with pytest.raises(ValueError, match="No legacy basemap to copy"):
            basemap_plan(registry, city, copy_current=True)


def test_declared_cities_keep_a_valid_plan() -> None:
    registry = ProviderRegistry.from_project_root()
    assert basemap_plan(registry)
    for city in registry.list_provider_ids():
        assert basemap_plan(registry, city, plan_only=True)
