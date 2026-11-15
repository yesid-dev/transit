from contextlib import nullcontext

import pytest
from test_batch_editions import REQUEST
from test_batch_input_sources import archive, bootstrap, store

from transit_ops.batch import input_sources
from transit_ops.batch.build import InputNeed
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.ingestion.storage import LocalBronzeStorage


class EmptyCatalog:
    def get_foreign_keys(self, name, schema):
        return []


def test_public_fetch_non_edition_needs_no_schedule_archive(tmp_path, monkeypatch):
    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(EmptyCatalog()))
    storage = store(tmp_path)
    builder = resolve_builder("occupancy_crowding")
    needs = set(builder.inputs(REQUEST)) | {InputNeed("core.providers", "all")}
    for need in needs:
        query = (
            "SELECT 'sample' provider_id, 'UTC' timezone"
            if need.window == "all"
            else "SELECT TIMESTAMPTZ '2026-11-01 00:00:00+00' captured_at_utc WHERE false"
        )
        archive(storage, need.relation, "2026-11" if need.window == "all" else need.window, query)
    root = tmp_path / "inputs"
    root.mkdir()
    result = input_sources.fetch_from_catalog(storage, root, REQUEST, [builder])
    assert {InputNeed(**n) for n in result["needs"]} == needs
    assert not (root / "core.dataset_versions").exists()
    assert not list(root.glob("silver.*"))


@pytest.mark.parametrize("active", ["false", "true UNION ALL SELECT true"])
def test_public_fetch_refuses_unresolved_current_before_payloads(tmp_path, monkeypatch, active):
    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(EmptyCatalog()))
    storage = store(tmp_path)
    first = bootstrap(
        storage,
        "SELECT 'sample' provider_id, row_number() OVER ()::BIGINT "
        "dataset_version_id, repeat(chr(96 + row_number() OVER ()::INTEGER), 64) checksum_sha256, "
        "NULL::VARCHAR content_hash, 'static_schedule' dataset_kind, "
        "is_current, now() loaded_at_utc FROM (SELECT " + active + ") t(is_current)",
    )
    opened = []
    original = LocalBronzeStorage.open_stream

    def opening(self, key, **kwargs):
        opened.append(key)
        return original(self, key, **kwargs)

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", opening)
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(ValueError, match="edition_unresolved"):
        input_sources.fetch_from_catalog(
            storage, root, REQUEST, [resolve_builder("cancellations_service_states")]
        )
    assert opened == [first]


@pytest.mark.parametrize("missing", [False, True])
def test_cancellation_preflight_uses_bootstrap_edition(tmp_path, monkeypatch, missing):
    class Catalog:
        def get_foreign_keys(self, name, schema):
            return []

    observed = []
    builder = resolve_builder("cancellations_service_states")

    class RecordingBuilder:
        family_id = "cancellations_service_states"

        def inputs(self, request):
            observed.append(request)
            return builder.inputs(request)

    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(Catalog()))
    storage = store(tmp_path)
    first = bootstrap(storage)
    archive(storage, "core.providers", "2026-11", "SELECT 'sample' AS provider_id")
    for day in ("2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"):
        archive(
            storage,
            "gold.fact_trip_delay_snapshot",
            day,
            f"SELECT TIMESTAMPTZ '{day} 12:00:00+00' AS captured_at_utc",
        )
    for relation in (
        "silver.trips",
        "silver.calendar",
        "silver.calendar_dates",
        "silver.stop_times",
    ):
        if not missing or relation != "silver.trips":
            archive(storage, relation, "c" * 64, "SELECT 7::BIGINT AS dataset_version_id")
    opened = []
    original = LocalBronzeStorage.open_stream

    def opening(self, key, **kwargs):
        opened.append(key)
        return original(self, key, **kwargs)

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", opening)
    root = tmp_path / "inputs"
    root.mkdir()
    if missing:
        with pytest.raises(input_sources.SourcesMissing) as caught:
            input_sources.fetch_from_catalog(storage, root, REQUEST, [RecordingBuilder()])
        assert InputNeed("silver.trips", "edition:7") in caught.value.needs
        assert opened == [first]
    else:
        result = input_sources.fetch_from_catalog(storage, root, REQUEST, [RecordingBuilder()])
        assert {"relation": "core.dataset_versions", "window": "all"} in result["needs"]
        assert {"relation": "silver.trips", "window": "edition:7"} in result["needs"]
    assert observed[0].edition_source == "current_at_build"
    assert set(observed[0].edition_by_day.values()) == {7}
