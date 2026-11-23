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
    status, headers, body = asyncio.run(http(app, "/cities", ""))
    assert status == 200
    catalog = json.loads(body)
    revision = catalog["answer_revision"]
    assert len(revision) == 16
    assert headers[b"x-transit-answer-revision"] == revision.encode("ascii")
    assert catalog["cleaning_version"] == app.store.cleaning_version
    _, method_headers, _ = asyncio.run(http(app, "/how-we-measure"))
    assert method_headers[b"x-transit-answer-revision"] == revision.encode("ascii")
    assert method_headers[b"x-transit-cleaning-version"] == str(app.store.cleaning_version).encode()
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


@pytest.mark.parametrize(
    ("route", "cut"),
    [("measure", "&measure=on_time"), ("ranking", "&kind=line"), ("data-health", "")],
)
def test_catalog_outage_check_rejects_unpublished_cities(
    tmp_path: Path, route: str, cut: str
) -> None:
    app = Engine(Store(str(tmp_path)), concurrency=1, queue_size=0, queue_wait_ms=10)
    status, headers, body = asyncio.run(
        http(
            app,
            f"/{route}",
            f"city=sto&from=2026-11-20&to=2026-11-20{cut}",
            headers=((b"x-transit-require-public-city", b"1"),),
        )
    )
    assert status == 400
    assert headers[b"x-transit-answer-revision"]
    assert json.loads(body) == {"message": "unknown city"}


def test_catalog_excludes_nonpublic_cities_and_requires_one_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENGINE_PROVIDER_DECLARATIONS", str(tmp_path))
    (tmp_path / "default-city.txt").write_text("example\n", encoding="utf8")
    (tmp_path / "hidden.yaml").write_text(
        "provider: {is_active: false}\npublic: {enabled: true}\n",
        encoding="utf8",
    )
    (tmp_path / "candidate.yaml").write_text("stage: candidate\n", encoding="utf8")
    (tmp_path / "example.yaml").write_text(
        "stage: public\ntimezone: Europe/Paris\nname: Example\n"
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
    (tmp_path / "default-city.txt").write_text("hidden\n", encoding="utf8")
    with pytest.raises(RuntimeError, match="default city must be a public provider"):
        city_catalog()
