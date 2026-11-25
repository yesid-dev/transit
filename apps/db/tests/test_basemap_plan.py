import pytest

from transit_ops.providers.basemap_plan import basemap_plan
from transit_ops.providers.registry import ProviderRegistry


def test_private_city_can_plan_an_extract_but_cannot_refresh() -> None:
    registry = ProviderRegistry.from_project_root()
    assert {job["provider"] for job in basemap_plan(registry)} == {"stm", "octranspo"}
    with pytest.raises(ValueError, match="requires plan_only"):
        basemap_plan(registry, "sto")
    assert basemap_plan(registry, "sto", plan_only=True) == [
        {
            "provider": "sto",
            "bbox": "-77.25,44.7,-74.2,46.4",
            "key": "v1/sto/static/basemap/gatineau.pmtiles",
            "file": "gatineau.pmtiles",
        }
    ]
