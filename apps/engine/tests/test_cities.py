import asyncio
import json
from pathlib import Path

import pytest
from test_engine import http

from transit_engine.cities import UnknownCity, city_catalog, public_declaration
from transit_engine.server import Engine
from transit_engine.store import Store


def test_public_cities_shape_both_declaration_formats(tmp_path: Path) -> None:
    app = Engine(Store(str(tmp_path)), concurrency=1, queue_size=0, queue_wait_ms=10)
    status, _, body = asyncio.run(http(app, "/cities", ""))
    assert status == 200
    catalog = json.loads(body)
    cities = {city["id"]: city for city in catalog["providers"]}
    assert catalog["default_provider"] == "stm"
    assert "sto" not in cities
    assert cities["stm"]["labels"]["fr"]["city"] == "Montréal"
    assert cities["stm"]["inputs"]["i3_alerts"] is True
    assert cities["stm"]["lines_without_live_data"] == [{"route_types": [1], "route_ids": []}]
    assert cities["octranspo"]["inputs"]["service_alerts"] is False
    assert cities["octranspo"]["fit_bounds"] == [-75.95, 45.2, -75.43, 45.55]
    assert cities["octranspo"]["timezone"] == "America/Toronto"
    assert "feeds" not in cities["stm"]
    assert asyncio.run(http(app, "/cities", "city=stm"))[0] == 400


def test_catalog_excludes_nonpublic_cities_and_requires_one_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENGINE_PROVIDER_DECLARATIONS", str(tmp_path))
    (tmp_path / "hidden.yaml").write_text(
        "provider: {is_active: false}\npublic: {enabled: true, default_city: true}\n",
        encoding="utf8",
    )
    (tmp_path / "candidate.yaml").write_text("stage: candidate\n", encoding="utf8")
    (tmp_path / "example.yaml").write_text(
        "stage: public\ndefault_city: true\ntimezone: Europe/Paris\nname: Example\n"
        "labels:\n  en: {city: Example, operator: Rail}\n"
        "  fr: {city: Exemple, operator: Rail}\n",
        encoding="utf8",
    )
    for city in ("hidden", "candidate", "unknown"):
        with pytest.raises(UnknownCity, match="unknown city"):
            public_declaration(city)
    cities = city_catalog()
    assert cities["default_provider"] == "example"
    assert [provider["id"] for provider in cities["providers"]] == ["example"]
    (tmp_path / "example.yaml").unlink()
    with pytest.raises(RuntimeError, match="exactly one public default city"):
        city_catalog()
