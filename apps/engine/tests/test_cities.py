import asyncio
import json
import shutil
from datetime import date
from pathlib import Path

import pytest
from test_engine import _build_store, http

from transit_engine.cities import UnknownCity, city_catalog, public_declaration
from transit_engine.health import data_health
from transit_engine.server import Engine
from transit_engine.store import Store

LICENCE_GOLDEN = (
    Path(__file__).resolve().parents[2] / "data-proxy/test/fixtures/download-licences.golden.json"
)


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
    assert all(city["record_through"] is None for city in cities.values())
    assert cities["stm"]["labels"]["fr"]["city"] == "Montréal"
    assert cities["stm"]["inputs"]["i3_alerts"] is True
    assert cities["stm"]["inputs"]["occupancy"] is True
    assert cities["stm"]["lines_without_live_data"] == [{"route_types": [1], "route_ids": []}]
    assert cities["octranspo"]["inputs"]["service_alerts"] is False
    assert cities["octranspo"]["fit_bounds"] == [-75.95, 45.2, -75.43, 45.55]
    assert cities["octranspo"]["timezone"] == "America/Toronto"
    assert cities["octranspo"]["name_separators"] == {
        "ends": "<>",
        "languages": "~",
        "language_order": ["en", "fr"],
    }
    assert "name_separators" not in cities["stm"]
    assert "feeds" not in cities["stm"]
    assert asyncio.run(http(app, "/cities", "city=stm"))[0] == 400


def test_city_catalog_supplies_the_approved_download_licences() -> None:
    golden = json.loads(LICENCE_GOLDEN.read_text(encoding="utf-8"))["licences"]
    cities = {city["id"]: city for city in city_catalog()["providers"]}
    for city, source in (
        ("stm", {"en": "STM", "fr": "de la STM"}),
        ("octranspo", {"en": "OC Transpo", "fr": "d’OC Transpo"}),
    ):
        expected = {
            key: value for key, value in golden[city].items() if key not in ("contact", "changes")
        }
        assert cities[city]["download_licence"] == {**expected, "source": source}


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
        'name_separators: {ends: "<>", languages: "~", language_order: [fr, en]}\n'
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
    assert cities["providers"][0]["name_separators"] == {
        "ends": "<>",
        "languages": "~",
        "language_order": ["fr", "en"],
    }
    (tmp_path / "default-city.txt").write_text("hidden\n", encoding="utf8")
    with pytest.raises(RuntimeError, match="default city must be a public provider"):
        city_catalog()


def test_private_city_remains_hidden_with_a_complete_clean_day(tmp_path: Path) -> None:
    day = date(2026, 11, 25)
    store = _build_store(tmp_path, cleaning_version=9, trips_by_day={day: ()}, city="sto")
    assert data_health(store, "sto", day, day)["days"][0]["status"] == "present"
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=10)
    status, _, body = asyncio.run(http(app, "/cities"))
    assert status == 200
    assert {city["id"] for city in json.loads(body)["providers"]} == {"stm", "octranspo"}
    for route, query in (
        ("search-index", "city=sto"),
        ("schedule-index", "city=sto"),
        ("schedule-map", "city=sto"),
        ("data-health", f"city=sto&from={day}&to={day}"),
        ("measure", f"city=sto&from={day}&to={day}&measure=on_time"),
        ("ranking", f"city=sto&from={day}&to={day}&measure=on_time&kind=line"),
    ):
        status, _, body = asyncio.run(
            http(app, f"/{route}", query, headers=((b"x-transit-require-public-city", b"1"),))
        )
        assert status == 400, route
        assert json.loads(body) == {"message": "unknown city"}


def test_record_through_tracks_the_latest_complete_edition_after_a_mirror_copy(
    tmp_path: Path,
) -> None:
    store = _build_store(tmp_path, cleaning_version=9)
    app = Engine(store, concurrency=1, queue_size=0, queue_wait_ms=10)
    city = tmp_path / "stm"
    original = max(city.iterdir())
    for day, version, missing in (
        ("2026-11-25", 9, None),
        ("2026-11-27", 9, "feed_polls.parquet"),
        ("2026-11-28", 8, None),
    ):
        target = city / day / f"v{version}"
        shutil.copytree(original / "v9", target)
        receipt = target / "manifest.json"
        manifest = json.loads(receipt.read_bytes())
        manifest.update(service_date=day, cleaning_version=str(version))
        receipt.write_text(json.dumps(manifest), encoding="utf-8")
        if missing:
            (target / missing).unlink()

    def anchors() -> dict[str, str | None]:
        status, _, body = asyncio.run(http(app, "/cities"))
        assert status == 200
        return {row["id"]: row["record_through"] for row in json.loads(body)["providers"]}

    assert anchors() == {"stm": "2026-11-25", "octranspo": None}
    shutil.copyfile(original / "v9/feed_polls.parquet", city / "2026-11-27/v9/feed_polls.parquet")
    (tmp_path / ".record-v9").touch()
    assert anchors() == {"stm": "2026-11-27", "octranspo": None}
