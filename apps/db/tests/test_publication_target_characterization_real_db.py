import json
from pathlib import Path

import revision_2_seed as seed
from publication_target_cases import (
    catalog_case,
    compare_golden,
    graph_cases,
    inventory,
    storage_pair,
)
from sqlalchemy import text

from transit_ops import settings as settings_module
from transit_ops.gold import rollups
from transit_ops.gold.alert_archive import sync_alert_archive
from transit_ops.snapshots import historic_tier, publish
from transit_ops.snapshots.builders.historic import (
    line_history,
    network_history,
    network_trend,
    provenance,
    stop_history,
)


def _capture_lane(engine, settings, root, provider_id, tier):
    remote, local, client = storage_pair(root, provider_id=provider_id)
    try:
        result = publish.publish_snapshot(
            provider_id,
            tier=tier,
            settings=settings,
            engine=engine,
            storage=remote,
        )
        assert result.keys_written
        headers = {
            "public, max-age=20": "live",
            "public, max-age=86400, stale-while-revalidate=86400": "static",
            "public, max-age=3600, stale-while-revalidate=86400": "historic",
            "public, max-age=31536000, immutable": "historic_immutable",
            "private, no-store": "internal",
        }
        for key, obj in client.objects.items():
            relative = key.removeprefix(f"v1/{provider_id}/")
            assert relative != key and obj["ContentType"] == "application/json"
            local.put_bytes(relative, obj["Body"], tier=headers[obj["CacheControl"]])
            assert Path(local.full_key(relative)).read_bytes() == obj["Body"]
        if tier == "historic":
            root_value = remote.get_json("historic/history/index.json")
            assert {family["family"] for family in root_value["families"]} == {
                "alerts",
                "receipts",
                "network",
                "lines",
                "stops",
                "hotspots",
                "repeat_offenders",
            }
            assert f"v1/{provider_id}/_meta/publish_state_historic.json" in client.objects
        if tier == "static":
            assert f"v1/{provider_id}/static/basemap.json" not in client.objects
            assert f"v1/{provider_id}/_meta/publish_state_static.json" in client.objects
        return inventory(client.objects)
    finally:
        remote.close()


def _configure(root, monkeypatch):
    settings = seed.settings_for(root)
    monkeypatch.setattr(rollups, "PERCENTILE_LOOKBACK_DAYS", seed.RETENTION_DAYS - 1)
    for module in (line_history, network_history, network_trend, provenance, stop_history):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(settings_module, "get_settings", lambda: settings)
    for module in (publish, historic_tier):
        monkeypatch.setattr(module, "utc_now", lambda: seed.HISTORY_CLOCK)
    return settings


def _capture(engine, root, monkeypatch):
    settings = _configure(root, monkeypatch)
    seed.delete_rows(engine)
    try:
        seed.seed_history(engine, settings, root)
        for provider_id in seed.PROVIDERS.values():
            sync_alert_archive(
                provider_id,
                from_date=seed.DAYS[0],
                to_date=seed.DAYS[-1],
                settings=settings,
                engine=engine,
                synced_at_utc=seed.BUILD_CLOCK,
            )
        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE raw.ingestion_runs SET started_at_utc=:t, completed_at_utc=:t "
                    "WHERE provider_id=ANY(:ids) AND run_kind='static_schedule'"
                ),
                {"t": seed.BUILD_CLOCK, "ids": list(seed.PROVIDERS.values())},
            )
        cases = {}
        with seed.pinned_engine(engine, seed.HISTORY_CLOCK) as pinned:
            for tier in ("static", "historic", "live"):
                if tier == "live":
                    seed.seed_live(pinned, settings, root, seed.HISTORY_CLOCK)
                for label, provider_id in seed.PROVIDERS.items():
                    cases[f"{label}/{tier}"] = _capture_lane(
                        pinned, settings, root / label / tier, provider_id, tier
                    )
        cases["catalog"] = catalog_case(root / "catalog", monkeypatch)
        cases.update(graph_cases(root / "graphs"))
        return cases
    finally:
        seed.delete_rows(engine)
        assert seed.remaining_rows(engine) == {}


def test_publication_bytes_keys_and_headers_match_pre_refactor_golden(
    real_db_engine, tmp_path, monkeypatch
):
    first = _capture(real_db_engine, tmp_path / "first", monkeypatch)
    second = _capture(real_db_engine, tmp_path / "second", monkeypatch)
    assert first == second, json.dumps({"first": first, "second": second}, sort_keys=True)
    compare_golden(first)
