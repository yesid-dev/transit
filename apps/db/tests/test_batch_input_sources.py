import hashlib
import json
from datetime import UTC, datetime

import duckdb
import pytest

from transit_ops.batch.build import InputNeed
from transit_ops.batch.input_sources import (
    SourcesMissing,
    edition_mapping,
    fetch_replay_inputs,
    materialize,
    resolve_sources,
)
from transit_ops.history.datasets import get_dataset
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.archive_keys import proof_key, table_copy_key

STAMP = datetime(2026, 11, 3, 7, tzinfo=UTC)


def store(tmp_path):
    root = tmp_path / "objects"
    root.mkdir()
    return LocalBronzeStorage("local", root)


def put(storage, key, value):
    path = storage.root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value).encode() if isinstance(value, dict) else value)


def test_rescue_receipt_resolves_exact_identity(tmp_path):
    storage = store(tmp_path)
    key = "rescue/v1/parquet/sample/2026-11-01/fact_vehicle_snapshot.parquet"
    record = {
        "key": key,
        "object_sha256": "a" * 64,
        "object_bytes": 12,
        "proof": {"verified": True, "object_sha256": "a" * 64, "object_bytes": 12},
    }
    put(
        storage,
        "rescue/v1/parquet/sample/2026-11-01/receipt.json",
        {
            "format_version": 1,
            "kind": "rescue_parquet",
            "provider": "sample",
            "day": "2026-11-01",
            "tables": {"fact_vehicle_snapshot": record},
        },
    )
    need = InputNeed("gold.fact_vehicle_snapshot", "2026-11-01")
    sources = resolve_sources([need], storage, "sample", STAMP, {})
    assert [(s.key, s.needs) for s in sources] == [(key, (need,))]


def archive(storage, relation, window, query, *, revision=0, version=1):
    key = table_copy_key(
        relation, "sample", revision, get_dataset(relation).archive_grain, window, version, 1
    )
    path = storage.root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect() as conn:
        conn.execute("SET TimeZone='UTC'")
        conn.execute(f"COPY ({query}) TO ? (FORMAT parquet)", [str(path)])
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    record = dict(
        format_version=1,
        kind="table_copy",
        dataset_id=relation,
        provider_id="sample",
        revision=revision,
        window_key=window,
        content_version=version,
        schema_version=1,
        key=key,
        object_sha256=digest,
        object_bytes=path.stat().st_size,
        proof=dict(verified=True, object_sha256=digest, object_bytes=path.stat().st_size),
    )
    put(storage, proof_key(key), record)
    return key


def bootstrap(storage, query=None):
    return archive(
        storage,
        "core.dataset_versions",
        "2026-11",
        query
        or (
            "SELECT 'sample' AS provider_id, 7::BIGINT AS dataset_version_id, "
            f"'{('c' * 64)}' AS checksum_sha256, NULL::VARCHAR AS content_hash"
        ),
    )


@pytest.mark.parametrize(
    "days, months, expected",
    [
        (["2026-11-01", "2026-11-02"], ["2026-11"], [(1,), (2,)]),
        (["2026-10-31", "2026-11-01"], ["2026-10", "2026-11"], [(0,), (1,)]),
    ],
)
def test_month_windows_are_fetched_once_and_only_in_range_rows_survive(
    tmp_path, monkeypatch, days, months, expected
):
    storage = store(tmp_path)
    boot = bootstrap(storage)
    keys = [
        archive(
            storage,
            "raw.realtime_snapshot_index",
            month,
            "SELECT * FROM (VALUES (0, TIMESTAMPTZ '2026-10-31 23:00:00+00'), "
            "(1, TIMESTAMPTZ '2026-11-01 00:00:00+00'), "
            "(2, TIMESTAMPTZ '2026-11-02 00:00:00+00'), "
            "(3, TIMESTAMPTZ '2026-11-03 00:00:00+00')) t(id,captured_at_utc) "
            f"WHERE strftime(captured_at_utc, '%Y-%m')='{month}'",
        )
        for month in months
    ]
    opened = []
    original = LocalBronzeStorage.open_stream

    def opening(self, key, **kwargs):
        opened.append(key)
        return original(self, key, **kwargs)

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", opening)
    root = tmp_path / "inputs"
    root.mkdir()
    needs = [InputNeed("core.dataset_versions", "all")] + [
        InputNeed("raw.realtime_snapshot_index", day) for day in days
    ]
    result = fetch_replay_inputs(storage, root, "sample", STAMP, lambda _: needs)
    assert sorted(opened) == sorted([boot, *keys])
    assert len(opened) == len(set(opened))
    with duckdb.connect() as conn:
        rows = conn.execute(
            "SELECT id FROM read_parquet(?, hive_partitioning=false) ORDER BY id",
            [[str(p) for p in (root / "raw.realtime_snapshot_index").glob("*.parquet")]],
        ).fetchall()
    assert rows == expected
    receipts = [r for r in result["receipts"] if r["key"] in keys]
    assert sum(r["rows_kept"] for r in receipts) == 2
    assert sum(r["rows_dropped"] for r in receipts) == (1 if len(months) == 1 else 2)


def test_latest_whole_state_snapshot_is_loaded_once(tmp_path):
    storage = store(tmp_path)
    archive(storage, "core.providers", "2026-10", "SELECT 'old' AS provider_id")
    key = archive(storage, "core.providers", "2026-11", "SELECT 'sample' AS provider_id")
    needs = [InputNeed("core.providers", "all")]
    sources = resolve_sources(needs, storage, "sample", STAMP, {})
    assert [s.key for s in sources] == [key]
    root = tmp_path / "result"
    receipts = materialize(sources, {key: storage.root / key}, root, STAMP)
    assert receipts[0]["rows_kept"] == 1
    assert receipts[0]["rows_dropped"] == 0


def test_missing_sources_lists_every_need_before_payloads(tmp_path):
    storage = store(tmp_path)
    needs = [
        InputNeed("gold.fact_vehicle_snapshot", "2026-11-01"),
        InputNeed("raw.realtime_snapshot_index", "2026-11-02"),
    ]
    with pytest.raises(SourcesMissing) as caught:
        resolve_sources(needs, storage, "sample", STAMP, {})
    assert caught.value.needs == tuple(needs)
    assert all(f"({n.relation}, {n.window})" in str(caught.value) for n in needs)


def test_edition_mapping_resolves_checksum_and_refuses_unknown_ids(tmp_path):
    storage = store(tmp_path)
    boot = bootstrap(storage)
    mapping = edition_mapping(storage.root / boot, "sample")
    key = archive(storage, "silver.trips", "c" * 64, "SELECT 7::BIGINT AS dataset_version_id")
    need = InputNeed("silver.trips", "edition:7")
    assert resolve_sources([need], storage, "sample", STAMP, mapping)[0].key == key
    with pytest.raises(ValueError, match="unknown edition id.*edition:8"):
        resolve_sources([InputNeed("silver.trips", "edition:8")], storage, "sample", STAMP, mapping)


def test_ambiguous_edition_id_refuses(tmp_path):
    storage = store(tmp_path)
    key = bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, 7::BIGINT AS dataset_version_id, "
        "repeat(c,64) AS checksum_sha256, NULL::VARCHAR AS content_hash "
        "FROM (VALUES ('c'), ('d')) t(c)",
    )
    with pytest.raises(ValueError, match="ambiguous edition id: 7"):
        edition_mapping(storage.root / key, "sample")


@pytest.mark.parametrize("missing", [True, False])
def test_bad_bootstrap_refuses_before_other_downloads(tmp_path, monkeypatch, missing):
    storage = store(tmp_path)
    if not missing:
        key = bootstrap(storage)
        (storage.root / key).write_bytes(b"corrupt")
    called = []
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(ValueError):
        fetch_replay_inputs(storage, root, "sample", STAMP, lambda _: called.append(True))
    assert called == []
    assert list(root.iterdir()) == []


def test_wrong_rescue_identity_is_refused(tmp_path):
    storage = store(tmp_path)
    put(
        storage,
        "rescue/v1/parquet/sample/2026-11-01/receipt.json",
        {
            "format_version": 1,
            "kind": "rescue_parquet",
            "provider": "other",
            "day": "2026-11-01",
            "tables": {},
        },
    )
    with pytest.raises(ValueError, match="identity differs"):
        resolve_sources(
            [InputNeed("gold.fact_vehicle_snapshot", "2026-11-01")], storage, "sample", STAMP, {}
        )


def test_cli_prints_one_json_line_with_local_receipts(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from typer.testing import CliRunner

    from transit_ops import providers
    from transit_ops.batch import input_sources, replay
    from transit_ops.batch.families import headways
    from transit_ops.batch.families.occupancy_crowding import OccupancyCrowdingBuilder
    from transit_ops.commands.batch import app
    from transit_ops.history import storage as history
    from transit_ops.settings import get_settings

    storage = store(tmp_path)
    bootstrap(storage)

    class Builder(OccupancyCrowdingBuilder):
        family_id = "headways"

        def inputs(self, request):
            return ()

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return []

    monkeypatch.setattr(headways, "builder", Builder())
    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(Catalog()))

    class Scope:
        def resolve(self, backend):
            return storage

        def close(self):
            pass

    monkeypatch.setattr(history, "history_storage", lambda _: Scope())
    monkeypatch.setattr(
        providers,
        "load_providers",
        lambda: {
            "sample": SimpleNamespace(timezone="America/Toronto"),
        },
    )
    monkeypatch.setattr(
        replay, "postgres_input_needs", lambda *_: (InputNeed("core.dataset_versions", "all"),)
    )
    get_settings.cache_clear()
    root = tmp_path / "inputs"
    root.mkdir()
    result = CliRunner().invoke(
        app,
        [
            "fetch-inputs",
            "--provider",
            "sample",
            "--date",
            "2026-11-01",
            "--inputs",
            str(root),
            "--family",
            "headways",
        ],
    )
    assert result.exit_code == 0, result.output
    assert len(result.stdout.splitlines()) == 1
    value = json.loads(result.stdout)
    assert value["needs"] == [{"relation": "core.dataset_versions", "window": "all"}]
    assert value["bytes"] > 0
    assert value["receipts"][0]["rows_kept"] == 1


@pytest.mark.parametrize("column", ["NULL::TIMESTAMPTZ AS captured_at_utc", "1 AS other"])
def test_missing_or_null_window_column_is_refused(tmp_path, column):
    storage = store(tmp_path)
    key = archive(storage, "raw.realtime_snapshot_index", "2026-11", f"SELECT {column}")
    sources = resolve_sources(
        [InputNeed("raw.realtime_snapshot_index", "2026-11-01")], storage, "sample", STAMP, {}
    )
    with pytest.raises(ValueError, match="window column.*captured_at_utc"):
        materialize(sources, {key: storage.root / key}, tmp_path / "inputs", STAMP)


def test_current_revision_does_not_mix_with_old_rows(tmp_path):
    storage = store(tmp_path)
    archive(storage, "core.providers", "2026-11", "SELECT 'old' AS provider_id")
    key = archive(
        storage, "core.providers", "2026-11", "SELECT 'sample' AS provider_id", revision=1
    )
    assert [
        s.key
        for s in resolve_sources([InputNeed("core.providers", "all")], storage, "sample", STAMP, {})
    ] == [key]


def test_payload_preflight_downloads_only_bootstrap_on_missing_need(tmp_path, monkeypatch):
    storage = store(tmp_path)
    boot = bootstrap(storage)
    archive(storage, "core.providers", "2026-11", "SELECT 'sample' AS provider_id")
    opened = []
    original = LocalBronzeStorage.open_stream

    def opening(self, key, **kwargs):
        opened.append(key)
        return original(self, key, **kwargs)

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", opening)
    needs = [
        InputNeed("core.dataset_versions", "all"),
        InputNeed("core.providers", "all"),
        InputNeed("raw.realtime_snapshot_index", "2026-11-01"),
        InputNeed("gold.fact_vehicle_snapshot", "2026-11-02"),
    ]
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(SourcesMissing) as caught:
        fetch_replay_inputs(storage, root, "sample", STAMP, lambda _: needs)
    assert set(caught.value.needs) == set(needs[2:])
    assert opened == [boot]
    assert list(root.iterdir()) == []


@pytest.mark.parametrize("working_only", [False, True])
def test_requested_unreplayable_family_refuses_before_any_storage(
    tmp_path, monkeypatch, working_only
):
    from typer.testing import CliRunner

    from transit_ops.batch import input_sources
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.families import headways
    from transit_ops.batch.families.occupancy_crowding import OccupancyCrowdingBuilder
    from transit_ops.commands.batch import app
    from transit_ops.history import storage as history

    class Builder(OccupancyCrowdingBuilder):
        family_id = "headways"

        def inputs(self, request):
            return (InputNeed("silver.i3_alerts", "all"),)

    monkeypatch.setattr(headways, "builder", Builder() if working_only else None)
    monkeypatch.setattr(
        input_sources,
        "replay_request",
        lambda *a: BuildRequest("sample", (datetime(2026, 11, 1).date(),), STAMP, 14, 7, "UTC"),
    )
    monkeypatch.setattr(history, "history_storage", lambda *a: pytest.fail("storage opened"))
    result = CliRunner().invoke(
        app,
        [
            "fetch-inputs",
            "--provider",
            "sample",
            "--date",
            "2026-11-01",
            "--inputs",
            str(tmp_path),
            "--family",
            "headways",
        ],
    )
    assert result.exit_code == 1
    assert ("input_not_archived" if working_only else "family_not_replayable") in result.output


def test_fk_closure_uses_catalog_and_missing_parent_refuses(tmp_path):
    from transit_ops.batch.replay import parent_input_needs

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return (
                [{"referred_schema": "gold", "referred_table": "dim_route_history"}]
                if (schema, name) == ("gold", "fact_vehicle_snapshot")
                else []
            )

    day = InputNeed("gold.fact_vehicle_snapshot", "2026-11-01")
    needs = parent_input_needs([day], Catalog())
    assert set(needs) == {day, InputNeed("gold.dim_route_history", "all")}
    storage = store(tmp_path)
    archive(storage, day.relation, day.window, "SELECT 1 AS value")
    with pytest.raises(SourcesMissing) as caught:
        resolve_sources(needs, storage, "sample", STAMP, {})
    assert caught.value.needs == (InputNeed("gold.dim_route_history", "all"),)


def test_occupancy_preflight_records_unread_alerts_as_absent(tmp_path):
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.families.occupancy_crowding import builder
    from transit_ops.batch.fetch_inputs import needs_for_replay
    from transit_ops.batch.replay import family_input_needs, postgres_input_needs

    storage = store(tmp_path)
    bootstrap(storage)
    request = BuildRequest("sample", (datetime(2026, 11, 1).date(),), STAMP, 14, 7, "UTC")
    family_input_needs([builder], request)
    needs = needs_for_replay([builder], request, postgres_needs=postgres_input_needs(request, [7]))
    for need in needs:
        if need.relation == "core.dataset_versions":
            continue
        source = get_dataset(need.relation).source
        grain = get_dataset(need.relation).archive_grain
        window = (
            "2026-11" if need.window == "all" else ("c" * 64 if grain == "edition" else need.window)
        )
        query = (
            "SELECT 7::BIGINT AS dataset_version_id"
            if grain == "edition"
            else (
                "SELECT 'sample' AS provider_id, 'UTC' AS timezone"
                if source.window_column is None
                else f"SELECT TIMESTAMPTZ '{need.window} 00:00:00+00' AS {source.window_column}"
            )
        )
        archive(storage, need.relation, window, query)
    root = tmp_path / "inputs"
    root.mkdir()
    result = fetch_replay_inputs(storage, root, "sample", STAMP, lambda _: needs)
    assert {r["relation"] for r in result["absent_unread"]} == {
        "silver.i3_alerts",
        "silver.i3_alert_active_periods",
        "silver.i3_alert_informed_entities",
    }
    assert all(r["status"] == "absent_unread" and r["reason"] for r in result["absent_unread"])
    assert not (root / "silver.i3_alerts").exists()
