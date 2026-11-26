from datetime import date
from pathlib import Path
from typing import Any

import pytest
import yaml

from transit_ops.clean_days_plan import plan_entries
from transit_ops.providers.registry import ProviderRegistry

PROVIDERS = Path(__file__).parents[1] / "config" / "providers"


def _declare(directory: Path, name: str, *, public: bool, capture: bool) -> None:
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
    template["capture_enabled"] = capture
    (directory / f"{name}.yaml").write_text(yaml.safe_dump(template), encoding="utf-8")


@pytest.fixture
def registry(tmp_path: Path) -> ProviderRegistry:
    _declare(tmp_path, "alpha", public=True, capture=True)
    _declare(tmp_path, "beta", public=False, capture=True)
    _declare(tmp_path, "gamma", public=False, capture=False)
    return ProviderRegistry(tmp_path)


def test_scheduled_runs_add_capturing_private_cities_as_private(
    registry: ProviderRegistry,
) -> None:
    assert plan_entries(registry) == [
        {"provider": "alpha", "private": False},
        {"provider": "beta", "private": True},
    ]


def test_manual_backfill_marks_a_private_city(registry: ProviderRegistry) -> None:
    entries = plan_entries(
        registry, requested="beta", manual=True, first=date(2026, 6, 1), last=date(2026, 6, 2)
    )
    assert entries == [
        {"provider": "beta", "day": "2026-06-01", "private": True},
        {"provider": "beta", "day": "2026-06-02", "private": True},
    ]
    blank = plan_entries(registry, manual=True, first=date(2026, 6, 1), last=date(2026, 6, 1))
    assert blank == [{"provider": "alpha", "day": "2026-06-01", "private": False}]


@pytest.mark.parametrize(
    ("requested", "first", "last", "message"),
    [
        ("delta", date(2026, 6, 1), date(2026, 6, 1), "unknown"),
        ("beta", date(2026, 6, 2), date(2026, 6, 1), "on or before"),
        ("beta", date(2026, 1, 1), date(2026, 12, 31), "256"),
    ],
)
def test_manual_backfill_rejects_bad_requests(
    registry: ProviderRegistry, requested: str, first: date, last: date, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        plan_entries(registry, requested=requested, manual=True, first=first, last=last)
