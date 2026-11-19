import hashlib
import json
from datetime import UTC, datetime, timedelta

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


def archive(
    storage, relation, window, query, *, revision=0, version=1, provider="sample", assignments=None
):
    key = table_copy_key(
        relation, provider, revision, get_dataset(relation).archive_grain, window, version, 1
    )
    path = storage.root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect() as conn:
        conn.execute("SET TimeZone='UTC'")
        conn.execute(
            f"COPY ({query}) TO ? (FORMAT parquet, KV_METADATA ?)",
            [str(path), {"edition_assignments": json.dumps(assignments or {})}],
        )
        rows = conn.execute("SELECT count(*) FROM read_parquet(?)", [str(path)]).fetchone()[0]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    record = dict(
        format_version=1,
        kind="table_copy",
        dataset_id=relation,
        provider_id=provider,
        revision=revision,
        window_key=window,
        content_version=version,
        schema_version=1,
        key=key,
        object_sha256=digest,
        object_bytes=path.stat().st_size,
        proof=dict(verified=True, object_sha256=digest, object_bytes=path.stat().st_size),
    )
    record["rows"] = record["proof"]["rows"] = rows
    put(storage, proof_key(key), record)
    return key


def bootstrap(storage, query=None, *, assignments=None):
    return archive(
        storage,
        "core.dataset_versions",
        "2026-11",
        query
        or (
            "SELECT 'sample' AS provider_id, 7::BIGINT AS dataset_version_id, "
            f"'{('c' * 64)}' AS checksum_sha256, NULL::VARCHAR AS content_hash, "
            "'static_schedule' AS dataset_kind, true AS is_current, "
            "TIMESTAMPTZ '2026-11-01 00:00:00+00' AS loaded_at_utc"
        ),
        assignments=assignments if assignments is not None else {7: "c" * 64},
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
        "repeat(c,64) AS checksum_sha256, NULL::VARCHAR AS content_hash, "
        "'static_schedule' AS dataset_kind, true AS is_current, "
        "TIMESTAMPTZ '2026-11-01 00:00:00+00' AS loaded_at_utc "
        "FROM (VALUES ('c'), ('d')) t(c)",
    )
    with pytest.raises(ValueError, match="ambiguous edition id: 7"):
        edition_mapping(storage.root / key, "sample")


def test_repeated_sto_content_resolves_each_version_to_its_own_proven_copy(tmp_path):
    storage = store(tmp_path)
    boot = bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, id::BIGINT AS dataset_version_id, "
        "NULL::VARCHAR AS checksum_sha256, repeat('c',64) AS content_hash, "
        "'static_schedule' AS dataset_kind, id=133 AS is_current, "
        "TIMESTAMPTZ '2026-11-01 00:00:00+00' AS loaded_at_utc "
        "FROM (VALUES (132), (133)) t(id)",
        assignments={132: "c" * 64, 133: "c" * 64 + ".v133"},
    )
    mapping = edition_mapping(storage.root / boot, "sample")
    for ident, window in ((132, "c" * 64), (133, "c" * 64 + ".v133")):
        need = InputNeed("silver.trips", f"edition:{ident}")
        with pytest.raises(SourcesMissing):
            resolve_sources([need], storage, "sample", STAMP, mapping)
        key = archive(
            storage, "silver.trips", window, f"SELECT {ident}::BIGINT AS dataset_version_id"
        )
        assert resolve_sources([need], storage, "sample", STAMP, mapping)[0].key == key


@pytest.mark.parametrize("old_metadata", [False, True])
def test_pruned_registry_replays_exact_versions_from_old_and_new_bootstrap(tmp_path, old_metadata):
    from transit_ops.lake.edition_assignments import persist_assignments, stored_assignments

    storage = store(tmp_path)
    assigned = {132: "c" * 64, 133: "c" * 64 + ".v133"}
    for ident, window in assigned.items():
        archive(storage, "silver.trips", window, f"SELECT {ident}::BIGINT AS dataset_version_id")
    registry = (
        "SELECT 'sample' AS provider_id, id::BIGINT AS dataset_version_id, "
        "NULL::VARCHAR AS checksum_sha256, repeat('c',64) AS content_hash, "
        "'static_schedule' AS dataset_kind, id=133 AS is_current, "
        "TIMESTAMPTZ '2026-10-01 00:00:00+00' AS loaded_at_utc "
        "FROM (VALUES (132), (133)) t(id)"
    )
    archive(
        storage,
        "core.dataset_versions",
        "2026-10",
        registry,
        assignments=assigned if old_metadata else None,
    )
    persist_assignments(storage, "sample", assigned)
    # Retention removes 132 before the next registry snapshot. No surviving
    # registration can take its name, even when replay uses the old bootstrap.
    archive(
        storage,
        "core.dataset_versions",
        "2026-11",
        registry + " WHERE id=133",
        assignments=stored_assignments(storage, "sample"),
    )
    before = {key: storage.read_bytes(key) for key in storage.list_keys("archive/")}
    for month, ids in ((10, (132, 133)), (11, (133,))):
        root = tmp_path / f"fetch-{month}"
        root.mkdir()
        needs = [InputNeed("core.dataset_versions", "all")]
        needs += [InputNeed("silver.trips", f"edition:{ident}") for ident in ids]
        result = fetch_replay_inputs(
            storage,
            root,
            "sample",
            datetime(2026, month, 25, tzinfo=UTC),
            lambda mapping, needs=needs: needs,
        )
        for ident in ids:
            with duckdb.connect() as conn:
                rows = conn.execute(
                    "SELECT dataset_version_id FROM read_parquet(?)",
                    [str(root / "silver.trips" / f"edition={ident}.parquet")],
                ).fetchall()
            assert rows == [(ident,)]
        assert all(r["rows_dropped"] == 0 for r in result["receipts"])
        local = edition_mapping(root / "core.dataset_versions" / "all.parquet", "sample")
        assert {ident: local[ident] for ident in ids} == {ident: assigned[ident] for ident in ids}
    assert before == {key: storage.read_bytes(key) for key in storage.list_keys("archive/")}


@pytest.mark.parametrize("failure", ["empty", "corrupt"])
def test_unprovable_legacy_ownership_refuses_before_replay(tmp_path, failure):
    storage = store(tmp_path)
    bootstrap(storage, assignments={})
    key = archive(
        storage,
        "silver.trips",
        "c" * 64,
        "SELECT 7::BIGINT AS dataset_version_id" + (" WHERE false" if failure == "empty" else ""),
    )
    if failure == "corrupt":
        (storage.root / key).write_bytes(b"corrupt")
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(ValueError, match="edition_identity"):
        fetch_replay_inputs(
            storage, root, "sample", STAMP, lambda _: [InputNeed("silver.trips", "edition:7")]
        )
    assert not list(root.glob("silver.*"))


def legacy_ownership_copy(
    storage, provider, *, owner=42, empty=False, row_provider=None, assignments=None
):
    from transit_ops.lake.archive_keys import schema_key
    from transit_ops.lake.edition_identity import assignment_json
    from transit_ops.lake.parquet_codec import write_window
    from transit_ops.lake.parquet_verify import Expected, prove_window
    from transit_ops.lake.table_copy import _receipt
    from transit_ops.lake.table_export import ExportedWindow, WindowSpec
    from transit_ops.lake.table_schema import TableSchema

    schema = TableSchema.from_columns(
        [("dataset_version_id", "bigint", True), ("provider_id", "text", True)],
        ["dataset_version_id", "provider_id"],
    )
    spec = WindowSpec("silver.trips", provider, "c" * 64)
    csv = storage.root / "legacy.csv"
    csv.write_text(
        "dataset_version_id,provider_id\n" + ("" if empty else f"42,{row_provider or provider}\n"),
        encoding="utf8",
        newline="",
    )
    digest = hashlib.sha256(csv.read_bytes()).hexdigest()
    path = storage.root / "legacy.parquet"
    metadata = (
        {}
        if owner is None
        else {
            "edition_assignments": assignment_json(
                assignments if assignments is not None else {owner: spec.window_key}
            )
        }
    )
    written = write_window(
        csv,
        schema,
        path,
        metadata=metadata,
        temp_dir=storage.root,
    )
    rows = 0 if empty else 1
    proof = prove_window(
        csv, path, schema, expect=Expected(digest, rows, written.sha256), temp_dir=storage.root
    )
    key = table_copy_key("silver.trips", provider, 0, "edition", spec.window_key, 1, 1)
    target = storage.root / key
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(path.read_bytes())
    schema_path = storage.root / schema_key("silver.trips", 1)
    schema_path.parent.mkdir(parents=True, exist_ok=True)
    schema_path.write_bytes(schema.to_json())
    exported = ExportedWindow(spec, csv, digest, csv.stat().st_size, rows, schema, STAMP, "test")
    put(storage, proof_key(key), _receipt(exported, written, proof, key, 1, 1, "a" * 40))
    return key


@pytest.mark.parametrize("provider", ["stm", "octranspo"])
def test_legacy_owner_is_adopted_from_verified_rows_without_recopy(tmp_path, provider):
    from transit_ops.lake.edition_assignments import archive_assignments, persist_assignments
    from transit_ops.lake.edition_identity import edition_keys

    storage = store(tmp_path)
    key = legacy_ownership_copy(storage, provider, owner=None)
    before = {k: storage.read_bytes(k) for k in storage.list_keys("archive/v1/tables/")}
    assigned = archive_assignments(storage, provider, ["c" * 64])
    assert assigned == {42: "c" * 64}
    persist_assignments(storage, provider, assigned)
    assert edition_keys([(42, None, "c" * 64)], assignments=assigned) == {42: "c" * 64}
    # The old owner can disappear; a new registration is still qualified.
    assert edition_keys([(43, None, "c" * 64)], assignments=assigned) == {43: "c" * 64 + ".v43"}
    need = InputNeed("silver.trips", "edition:42")
    assert resolve_sources([need], storage, provider, STAMP, assigned)[0].key == key
    assert before == {k: storage.read_bytes(k) for k in storage.list_keys("archive/v1/tables/")}


def test_legacy_object_adopts_only_the_owner_established_by_its_rows(tmp_path):
    from transit_ops.lake.edition_assignments import archive_assignments

    storage = store(tmp_path)
    legacy_ownership_copy(storage, "stm", assignments={42: "c" * 64, 133: "c" * 64 + ".v133"})
    assert archive_assignments(storage, "stm", ["c" * 64]) == {42: "c" * 64}


@pytest.mark.parametrize(
    "case", ["contradictory", "empty", "provider", "rows", "schema", "missing"]
)
def test_legacy_adoption_requires_coherent_proof_and_nonempty_owner_rows(tmp_path, case):
    from transit_ops.lake.edition_assignments import archive_assignments

    storage = store(tmp_path)
    key = legacy_ownership_copy(
        storage,
        "stm",
        owner=43 if case == "contradictory" else 42,
        empty=case == "empty",
        row_provider="octranspo" if case == "provider" else None,
    )
    if case in {"rows", "schema", "missing"}:
        receipt = json.loads(storage.read_bytes(proof_key(key)))
        if case == "rows":
            receipt["rows"] = receipt["proof"]["rows"] = 2
        elif case == "schema":
            receipt["proof"]["schema_sha256"] = "d" * 64
        else:
            receipt["proof"]["missing_from_copy"] = 1
        (storage.root / proof_key(key)).write_text(json.dumps(receipt), encoding="utf8")
    with pytest.raises(ValueError, match="edition_identity"):
        archive_assignments(storage, "stm", ["c" * 64])


def test_proven_copy_of_another_edition_refuses_instead_of_becoming_empty(tmp_path):
    storage = store(tmp_path)
    assigned = {133: "c" * 64 + ".v133"}
    bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, 133::BIGINT AS dataset_version_id, "
        "NULL::VARCHAR AS checksum_sha256, repeat('c',64) AS content_hash, "
        "'static_schedule' AS dataset_kind, true AS is_current, "
        "TIMESTAMPTZ '2026-11-01 00:00:00+00' AS loaded_at_utc",
        assignments=assigned,
    )
    archive(storage, "silver.trips", assigned[133], "SELECT 132::BIGINT AS dataset_version_id")
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(ValueError, match="edition_identity") as error:
        fetch_replay_inputs(
            storage, root, "sample", STAMP, lambda _: [InputNeed("silver.trips", "edition:133")]
        )
    assert error.value.reason == "edition_identity"
    assert not list(root.glob("silver.*"))


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
    archive(
        storage,
        "core.providers",
        "2026-11",
        "SELECT 'sample' AS provider_id, 'America/Toronto' AS timezone",
    )

    class Builder(OccupancyCrowdingBuilder):
        family_id = "headways"

        def inputs(self, request):
            assert request.timezone == "America/Toronto"
            assert request.as_of_utc == datetime(2026, 11, 2, 7, tzinfo=UTC)
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
        lambda: pytest.fail("local declarations read"),
    )
    monkeypatch.setattr(
        replay,
        "postgres_input_needs",
        lambda *_: (
            InputNeed("core.dataset_versions", "all"),
            InputNeed("core.providers", "all"),
        ),
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
    assert value["needs"] == [
        {"relation": "core.dataset_versions", "window": "all"},
        {"relation": "core.providers", "window": "all"},
    ]
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

    from transit_ops.batch.families import headways
    from transit_ops.batch.families.occupancy_crowding import OccupancyCrowdingBuilder
    from transit_ops.commands.batch import app
    from transit_ops.history import storage as history

    class Builder(OccupancyCrowdingBuilder):
        family_id = "headways"

        def inputs(self, request):
            return (InputNeed("silver.rt_entities", "all"),)

    monkeypatch.setattr(headways, "builder", Builder() if working_only else None)
    monkeypatch.setattr(history, "history_storage", lambda *a: pytest.fail("storage opened"))
    result = CliRunner().invoke(
        app,
        [
            "fetch-inputs",
            "--provider",
            "sample",
            "--date",
            "2026-11-01",
            "--timezone",
            "UTC",
            "--as-of",
            STAMP.isoformat(),
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


def test_occupancy_preflight_does_not_require_unread_declared_alerts(tmp_path):
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
    assert result["absent_unread"] == ()
    assert not (root / "silver.i3_alerts").exists()


@pytest.mark.parametrize("empty", [True, False])
def test_archive_fk_closure_skips_only_proven_empty_children(tmp_path, empty):
    from transit_ops.batch.input_sources import archive_input_needs

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return (
                [{"referred_schema": "silver", "referred_table": "routes"}]
                if name == "trips"
                else []
            )

    storage = store(tmp_path)
    child = InputNeed("silver.trips", "edition:7")
    archive(
        storage,
        child.relation,
        "c" * 64,
        "SELECT 7 AS dataset_version_id, 'R' AS route_id" + (" WHERE false" if empty else ""),
    )
    needs = archive_input_needs([child], storage, "sample", STAMP, {7: "c" * 64}, Catalog())
    if empty:
        assert needs == (child,)
        assert resolve_sources(needs, storage, "sample", STAMP, {7: "c" * 64})
    else:
        with pytest.raises(SourcesMissing) as caught:
            resolve_sources(needs, storage, "sample", STAMP, {7: "c" * 64})
        assert caught.value.needs == (InputNeed("silver.routes", "edition:7"),)


@pytest.mark.parametrize(
    "rows, required",
    [
        ("WHERE false", False),
        ("WHERE true", True),
        ("WHERE false UNION ALL SELECT 7, NULL", False),
        ("UNION ALL SELECT 7, NULL", True),
    ],
)
def test_local_fk_closure_uses_child_rows(tmp_path, rows, required):
    from transit_ops.batch.replay import local_parent_references, parent_input_needs

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return (
                [
                    {
                        "referred_schema": "silver",
                        "referred_table": "routes",
                        "constrained_columns": ["dataset_version_id", "route_id"],
                    }
                ]
                if name == "trips"
                else []
            )

    root = tmp_path / "inputs"
    folder = root / "silver.trips"
    folder.mkdir(parents=True)
    with duckdb.connect() as conn:
        conn.execute(
            "COPY (SELECT 7 AS dataset_version_id, 'R' AS route_id "
            + rows
            + ") TO ? (FORMAT parquet)",
            [str(folder / "edition=7.parquet")],
        )
    child = InputNeed("silver.trips", "edition:7")
    needs = parent_input_needs(
        [child],
        Catalog(),
        lambda need, fk: local_parent_references(need, fk, root, tmp_path / "work"),
    )
    assert (InputNeed("silver.routes", "edition:7") in needs) is required


def test_parent_reference_checks_repeat_across_relations_and_fk_shapes(tmp_path):
    from transit_ops.batch.replay import local_parent_references

    root = tmp_path / "inputs"
    for relation in ("silver.trips", "silver.stop_times"):
        folder = root / relation
        folder.mkdir(parents=True)
        with duckdb.connect() as conn:
            conn.execute(
                "COPY (SELECT 7 AS dataset_version_id, NULL::VARCHAR AS route_id) "
                "TO ? (FORMAT parquet)",
                [str(folder / "edition=7.parquet")],
            )
    for _ in range(2):
        actual = [
            local_parent_references(
                InputNeed(relation, "edition:7"),
                {"constrained_columns": columns},
                root,
                tmp_path / "work",
            )
            for relation, columns in (
                ("silver.trips", ["dataset_version_id"]),
                ("silver.trips", ["dataset_version_id", "route_id"]),
                ("silver.stop_times", ["dataset_version_id"]),
            )
        ]
        assert actual == [True, False, True]


@pytest.mark.parametrize("explicit_gis", [False, True])
def test_schedule_reader_ignores_gis_but_explicit_family_needs_still_refuse(
    tmp_path, monkeypatch, explicit_gis
):
    from contextlib import nullcontext

    from transit_ops.batch import input_sources
    from transit_ops.batch.build import BuildRequest

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return []

    class ReadsGIS:
        def inputs(self, request):
            return (InputNeed("silver.trips", "edition:8"),)

    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(Catalog()))
    storage = store(tmp_path)
    bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, i::BIGINT AS dataset_version_id, "
        "repeat(c,64) AS checksum_sha256, NULL::VARCHAR AS content_hash, "
        "kind AS dataset_kind, current AS is_current, "
        "TIMESTAMPTZ '2026-11-01 00:00:00+00' AS loaded_at_utc "
        "FROM (VALUES (7,'c','static_schedule',true), (8,'d','gis_static',true), "
        "(9,'e','static_schedule',false)) t(i,c,kind,current)",
    )
    archive(storage, "core.providers", "2026-11", "SELECT 'sample' AS provider_id")
    for relation in (
        "silver.trips",
        "silver.calendar",
        "silver.calendar_dates",
        "silver.stop_times",
    ):
        archive(storage, relation, "c" * 64, "SELECT 7::BIGINT AS dataset_version_id")
    root = tmp_path / "inputs"
    root.mkdir()
    request = BuildRequest("sample", (datetime(2026, 11, 1).date(),), STAMP, 14, 7, "UTC")
    if explicit_gis:
        with pytest.raises(SourcesMissing) as caught:
            input_sources.fetch_from_catalog(storage, root, request, [ReadsGIS()])
        assert caught.value.needs == (InputNeed("silver.trips", "edition:8"),)
    else:
        result = input_sources.fetch_from_catalog(storage, root, request, [])
        assert result["needs"] == [{"relation": "core.providers", "window": "all"}]
        assert not (root / "core.dataset_versions").exists()


def test_changed_bootstrap_refuses_before_any_other_payload(tmp_path, monkeypatch):
    storage = store(tmp_path)
    first_key = bootstrap(storage)
    archive(storage, "core.providers", "2026-11", "SELECT 'sample' AS provider_id")
    opened, observed = [], {}
    original = LocalBronzeStorage.open_stream

    def opening(self, key, **kwargs):
        opened.append(key)
        return original(self, key, **kwargs)

    def needs_for(mapping):
        observed.update(mapping)
        archive(
            storage,
            "core.dataset_versions",
            "2026-11",
            "SELECT 'sample' AS provider_id, i::BIGINT AS dataset_version_id, "
            "repeat(c,64) AS checksum_sha256, NULL::VARCHAR AS content_hash, "
            "'static_schedule' AS dataset_kind, true AS is_current, "
            "TIMESTAMPTZ '2026-11-01 00:00:00+00' AS loaded_at_utc "
            "FROM (VALUES (7,'c'), (8,'d')) t(i,c)",
            version=2,
        )
        return (InputNeed("core.dataset_versions", "all"), InputNeed("core.providers", "all"))

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", opening)
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(ValueError, match="bootstrap_source_changed.*core.dataset_versions"):
        fetch_replay_inputs(storage, root, "sample", STAMP, needs_for)
    assert observed == {7: "c" * 64}
    assert opened == [first_key]
    assert list(root.iterdir()) == []


def bundle(storage, keys, stamp=STAMP, *, closure_queries=None):
    from transit_ops.lake.alert_bundle import CLOSURE_RELATIONS, PREFIX

    overrides = closure_queries or {}

    closure_queries = {
        "core.providers": (
            "SELECT provider_id, 'UTC' AS timezone "
            "FROM (VALUES ('sample'),('other')) t(provider_id)"
        ),
        "core.feed_endpoints": (
            "SELECT * FROM (VALUES (1,'sample'),(2,'other')) t(feed_endpoint_id,provider_id)"
        ),
        "raw.i3_alert_snapshots": (
            "SELECT *, TIMESTAMPTZ '2026-11-01 00:00:00+00' AS captured_at_utc "
            "FROM (VALUES (1,'sample'),(2,'other')) t(i3_alert_snapshot_id,provider_id)"
        ),
        "raw.ingestion_runs": (
            "SELECT *, TIMESTAMPTZ '2026-11-01 00:00:00+00' AS started_at_utc "
            "FROM (VALUES (1,'sample'),(2,'other')) t(ingestion_run_id,provider_id)"
        ),
        "raw.ingestion_objects": (
            "SELECT *, TIMESTAMPTZ '2026-11-01 00:00:00+00' AS created_at_utc "
            "FROM (VALUES (1,'sample'),(2,'other')) t(ingestion_object_id,provider_id)"
        ),
    } | overrides
    closure = []
    for relation in CLOSURE_RELATIONS:
        path = storage.root / (relation + ".parquet")
        with duckdb.connect() as conn:
            conn.execute(
                f"COPY ({closure_queries[relation]}) TO ? (FORMAT parquet)",
                [str(path)],
            )
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        key = f"archive/v1/bundle-closure/{relation}/{digest}.parquet"
        put(storage, key, payload)
        closure.append(
            dict(
                dataset_id=relation,
                provider_id="_shared",
                key=key,
                object_sha256=digest,
                object_bytes=len(payload),
                rows=2,
                proof=dict(verified=True, object_sha256=digest, object_bytes=len(payload), rows=2),
            )
        )
    value = dict(
        format_version=2,
        kind="silver_alert_state",
        snapshot_at_utc=stamp.isoformat(),
        coverage_from_utc="2026-10-04T07:00:00+00:00",
        members=[json.loads(storage.read_bytes(proof_key(k))) for k in keys],
        closure=closure,
    )
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    version = hashlib.sha256(body).hexdigest()
    put(storage, PREFIX + version + ".json", body)
    return version


def alert_copies(storage, version=1):
    return [
        archive(
            storage,
            r,
            "2026-11",
            q,
            version=version,
            provider="_shared" if r.endswith("active_periods") else "sample",
        )
        for r, q in (
            (
                "silver.i3_alerts",
                "SELECT * FROM (VALUES (1, 0, 'sample'), (2, 0, 'other')) "
                "t(i3_alert_snapshot_id, alert_index, provider_id)",
            ),
            (
                "silver.i3_alert_informed_entities",
                "SELECT * FROM (VALUES (1, 0, 0, 'sample'), (2, 0, 0, 'other')) "
                "t(i3_alert_snapshot_id, alert_index, entity_index, provider_id)",
            ),
            (
                "silver.i3_alert_active_periods",
                "SELECT * FROM (VALUES (1, 0, 0), (2, 0, 0)) "
                "t(i3_alert_snapshot_id, alert_index, period_index)",
            ),
        )
    ]


def test_alert_bundle_pins_members_and_filters_shared_children(tmp_path):
    storage = store(tmp_path)
    keys = alert_copies(storage)
    version = bundle(storage, keys)
    alert_copies(storage, version=2)  # New member receipts alone cannot replace a bundle.
    needs = [InputNeed("silver.i3_alerts", "all")]
    sources = resolve_sources(needs, storage, "sample", STAMP, {})
    assert {s.key for s in sources if not s.receipt.get("bundle_closure")} == set(keys)
    root = tmp_path / "scoped"
    receipts = materialize(sources, {s.key: storage.root / s.key for s in sources}, root, STAMP)
    for r in receipts:
        assert r["rows_kept"] == 1 and r["rows_dropped"] == 1
        assert r["bundle_version"] == version and r["snapshot_at_utc"] == STAMP.isoformat()
    with duckdb.connect() as conn:
        for relation in (
            "silver.i3_alerts",
            "silver.i3_alert_active_periods",
            "silver.i3_alert_informed_entities",
        ):
            assert conn.execute(
                "SELECT i3_alert_snapshot_id FROM read_parquet(?)",
                [str(root / relation / "all.parquet")],
            ).fetchall() == [(1,)]


def test_alert_members_without_bundle_are_not_current(tmp_path):
    storage = store(tmp_path)
    alert_copies(storage)
    with pytest.raises(SourcesMissing, match="silver.i3_alerts"):
        resolve_sources([InputNeed("silver.i3_alerts", "all")], storage, "sample", STAMP, {})


@pytest.mark.parametrize(
    "missing", ["silver.i3_alert_active_periods", "silver.i3_alert_informed_entities"]
)
def test_missing_bundle_member_refuses_by_name(tmp_path, missing):
    storage = store(tmp_path)
    keys = alert_copies(storage)
    bundle(storage, keys)
    key = next(k for k in keys if missing in k)
    (storage.root / key).unlink()
    with pytest.raises(SourcesMissing, match=missing):
        resolve_sources([InputNeed("silver.i3_alerts", "all")], storage, "sample", STAMP, {})


def test_receipts_declared_inputs_resolve_after_r31():
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.families.receipts import builder
    from transit_ops.batch.replay import family_input_needs

    request = BuildRequest("sample", (datetime(2026, 11, 1).date(),), STAMP, 14, 7, "UTC")
    assert builder is not None
    assert InputNeed("silver.i3_alerts", "all") in family_input_needs([builder], request)


def test_alert_fetch_manifest_pins_scoped_files_and_refuses_later_pruned_coverage(tmp_path):
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.replay import validate_alert_bundle

    storage = store(tmp_path)
    bundle(storage, alert_copies(storage))
    root = tmp_path / "inputs"
    root.mkdir()
    fetch_replay_inputs(
        storage,
        root,
        "sample",
        STAMP,
        lambda _: [InputNeed("silver.i3_alerts", "all")],
        bootstrap_editions=False,
    )
    request = BuildRequest("sample", (datetime(2026, 11, 1).date(),), STAMP, 14, 7, "UTC")
    assert validate_alert_bundle(root, request)[0][0] == "alert-bundle.json"
    document = json.loads((root / "alert-bundle.json").read_text())
    document[0]["coverage_from_utc"] = "2026-11-02T00:00:00+00:00"
    (root / "alert-bundle.json").write_text(json.dumps(document))
    with pytest.raises(ValueError, match="bundle_coverage.*2026-11-01"):
        validate_alert_bundle(root, request)


def test_missing_fk_parent_refuses_by_name_before_load(tmp_path):
    from types import SimpleNamespace

    from transit_ops.batch.replay import validate_parent_rows

    path = tmp_path / "child.parquet"
    with duckdb.connect() as conn:
        conn.execute("COPY (SELECT 99 AS i3_alert_snapshot_id) TO ? (FORMAT parquet)", [str(path)])

    class Catalog:
        def get_foreign_keys(self, table, schema):
            return [
                dict(
                    constrained_columns=["i3_alert_snapshot_id"],
                    referred_columns=["i3_alert_snapshot_id"],
                    referred_schema="raw",
                    referred_table="i3_alert_snapshots",
                )
            ]

    with pytest.raises(ValueError, match="raw.i3_alert_snapshots"):
        validate_parent_rows(
            [SimpleNamespace(relation="silver.i3_alerts", files=[path])], Catalog()
        )


def test_new_bundle_replaces_all_members_at_its_actual_cutoff(tmp_path):
    from datetime import timedelta

    storage = store(tmp_path)
    first = alert_copies(storage)
    bundle(storage, first)
    second = alert_copies(storage, version=2)
    later = STAMP + timedelta(hours=1)
    bundle(storage, second, later)
    need = [InputNeed("silver.i3_alert_active_periods", "all")]
    assert {
        s.key
        for s in resolve_sources(need, storage, "sample", STAMP, {})
        if not s.receipt.get("bundle_closure")
    } == set(first)
    assert {
        s.key
        for s in resolve_sources(need, storage, "sample", later, {})
        if not s.receipt.get("bundle_closure")
    } == set(second)


@pytest.mark.parametrize(
    "day,cut",
    [
        ("2026-11-10", "2026-11-03T07:00:00+00:00"),
        ("2026-11-01", "2026-11-02T04:30:00+00:00"),
        ("2026-03-08", "2026-03-09T03:30:00+00:00"),
    ],
)
def test_bundle_refuses_a_day_whose_end_is_after_snapshot(tmp_path, day, cut):
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.replay import validate_alert_bundle

    root = tmp_path / "inputs"
    root.mkdir()
    (root / "alert-bundle.json").write_text(
        json.dumps(
            [
                dict(
                    version="a" * 64,
                    snapshot_at_utc=cut,
                    coverage_from_utc="2026-01-01T00:00:00+00:00",
                    files={},
                )
            ]
        )
    )
    request = BuildRequest(
        "sample",
        (datetime.fromisoformat(day).date(),),
        datetime(2026, 11, 14, tzinfo=UTC),
        30,
        7,
        "America/Toronto",
    )
    with pytest.raises(ValueError, match="bundle_coverage"):
        validate_alert_bundle(root, request)


def test_alert_bundle_uses_only_its_pinned_parent_closure(tmp_path):
    from transit_ops.lake.alert_bundle import CLOSURE_RELATIONS

    storage = store(tmp_path)
    keys = alert_copies(storage)
    bundle(storage, keys)
    need = [InputNeed("silver.i3_alerts", "all")]
    before = resolve_sources(need, storage, "sample", STAMP, {})
    for relation in CLOSURE_RELATIONS:
        archive(
            storage, relation, "2026-11", "SELECT 'sample' AS provider_id WHERE false", version=99
        )
    after = resolve_sources(need, storage, "sample", STAMP, {})
    assert before == after
    assert {s.needs[0].relation for s in after if s.receipt.get("bundle_closure")} == set(
        CLOSURE_RELATIONS
    )


def test_bundle_missing_closure_refuses_by_parent_name(tmp_path):
    storage = store(tmp_path)
    bundle(storage, alert_copies(storage))
    source = next(
        s
        for s in resolve_sources(
            [InputNeed("silver.i3_alerts", "all")], storage, "sample", STAMP, {}
        )
        if s.needs[0].relation == "raw.i3_alert_snapshots"
    )
    (storage.root / source.key).unlink()
    with pytest.raises(ValueError, match="bundle_parent_missing: raw.i3_alert_snapshots"):
        resolve_sources([InputNeed("silver.i3_alerts", "all")], storage, "sample", STAMP, {})


@pytest.mark.parametrize(
    "day,start,end",
    [
        ("2026-11-01", "2026-11-01T04:00:00+00:00", "2026-11-02T05:00:00+00:00"),
        ("2026-03-08", "2026-03-08T05:00:00+00:00", "2026-03-09T04:00:00+00:00"),
    ],
)
def test_bundle_accepts_the_complete_dst_day_with_six_hour_margin(tmp_path, day, start, end):
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.replay import validate_alert_bundle
    from transit_ops.lake.alert_bundle import CLOSURE_RELATIONS, MEMBERS

    hashes = {}
    for relation in (*MEMBERS, *CLOSURE_RELATIONS):
        path = tmp_path / relation / "all.parquet"
        path.parent.mkdir()
        path.write_bytes(b"fixture")
        hashes[relation] = hashlib.sha256(b"fixture").hexdigest()
    (tmp_path / "alert-bundle.json").write_text(
        json.dumps(
            [
                dict(
                    version="a" * 64,
                    snapshot_at_utc=(datetime.fromisoformat(end) + timedelta(hours=6)).isoformat(),
                    coverage_from_utc=start,
                    files=hashes,
                )
            ]
        )
    )
    request = BuildRequest(
        "sample",
        (datetime.fromisoformat(day).date(),),
        datetime(2026, 11, 14, tzinfo=UTC),
        30,
        7,
        "America/Toronto",
    )
    assert validate_alert_bundle(tmp_path, request)[0][0] == "alert-bundle.json"


def test_source_preflight_refuses_future_day_before_payload_download(tmp_path, monkeypatch):
    from transit_ops.batch.build import BuildRequest

    storage = store(tmp_path)
    bundle(storage, alert_copies(storage))
    request = BuildRequest(
        "sample",
        (datetime(2026, 11, 10).date(),),
        datetime(2026, 11, 14, tzinfo=UTC),
        30,
        7,
        "America/Toronto",
    )
    monkeypatch.setattr(
        LocalBronzeStorage, "open_stream", lambda *a, **kw: pytest.fail("payload downloaded")
    )
    with pytest.raises(ValueError, match="bundle_coverage: 2026-11-10"):
        resolve_sources(
            [InputNeed("silver.i3_alerts", "all")],
            storage,
            "sample",
            request.as_of_utc,
            {},
            request=request,
        )


@pytest.mark.parametrize(
    "day,start,end",
    [
        ("2026-11-01", "2026-11-01T04:00:00+00:00", "2026-11-02T05:00:00+00:00"),
        ("2026-03-08", "2026-03-08T05:00:00+00:00", "2026-03-09T04:00:00+00:00"),
    ],
)
def test_bundle_requires_six_hours_after_complete_dst_day(day, start, end):
    from datetime import timedelta

    from transit_ops.lake.alert_bundle import validate_coverage

    local = datetime.fromisoformat(day).date()
    floor = datetime.fromisoformat(start)
    close = datetime.fromisoformat(end)
    with pytest.raises(ValueError, match="bundle_coverage"):
        validate_coverage(
            close + timedelta(hours=6, microseconds=-1),
            floor,
            [local],
            "America/Toronto",
            STAMP.replace(month=12),
        )
    validate_coverage(
        close + timedelta(hours=6), floor, [local], "America/Toronto", STAMP.replace(month=12)
    )


def test_independent_provider_survives_an_empty_alert_closure(tmp_path):
    from test_lake_alert_bundle import SeedSource

    from transit_ops.batch.engine import open_batch_session
    from transit_ops.batch.inputs import resolve_inputs
    from transit_ops.lake.alert_bundle import MEMBERS, copy_group
    from transit_ops.lake.table_export import WindowSpec
    from transit_ops.sql_registry import named_query

    source = SeedSource()
    source.db.execute("ALTER TABLE core.providers ADD COLUMN timezone VARCHAR DEFAULT 'UTC'")
    source.columns["core.providers"].append("timezone")
    for relation in MEMBERS:
        source.db.execute(f"DELETE FROM {relation}")
    storage = store(tmp_path)
    work = tmp_path / "copy"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    try:
        copy_group(
            source, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
        )
    finally:
        source.db.close()
    archive(
        storage,
        "core.providers",
        "2026-11",
        "SELECT 'p' AS provider_id, 'UTC' AS timezone",
        provider="p",
    )
    root = tmp_path / "inputs"
    root.mkdir()
    needs = [InputNeed("silver.i3_alerts", "all"), InputNeed("core.providers", "all")]
    fetch_replay_inputs(storage, root, "p", STAMP, lambda _: needs, bootstrap_editions=False)
    area = tmp_path / "session"
    area.mkdir()
    with open_batch_session(
        resolve_inputs([InputNeed("core.providers", "all")], root), workdir=area
    ) as session:
        assert (
            session.execute(
                named_query(
                    "batch.replay.provider_timezone",
                    "SELECT timezone FROM core.providers WHERE provider_id=:p",
                ),
                {"p": "p"},
            ).scalar_one()
            == "UTC"
        )


@pytest.mark.parametrize("conflict", [False, True])
def test_independent_ingestion_parents_are_union_loaded_and_conflicts_refuse(tmp_path, conflict):
    storage = store(tmp_path)
    bundle(storage, alert_copies(storage))
    stamp = "2026-11-01 01:00:00+00" if conflict else "2026-11-01 00:00:00+00"
    parent = archive(
        storage,
        "raw.ingestion_runs",
        "2026-11",
        f"SELECT *, TIMESTAMPTZ '{stamp}' AS started_at_utc FROM "
        "(VALUES (1,'sample'),(3,'sample')) t(ingestion_run_id,provider_id)",
    )
    sources = resolve_sources(
        [InputNeed("silver.i3_alerts", "all"), InputNeed("raw.ingestion_runs", "2026-11-01")],
        storage,
        "sample",
        STAMP,
        {},
    )
    assert parent in {s.key for s in sources}
    root = tmp_path / "materialized"
    paths = {s.key: storage.root / s.key for s in sources}
    if conflict:
        with pytest.raises(ValueError, match="closure_conflict: raw.ingestion_runs"):
            materialize(sources, paths, root, STAMP)
    else:
        materialize(sources, paths, root, STAMP)
        with duckdb.connect() as conn:
            assert conn.execute(
                "SELECT ingestion_run_id FROM read_parquet(?) ORDER BY 1",
                [str(root / "raw.ingestion_runs" / "all.parquet")],
            ).fetchall() == [(1,), (3,)]


def test_non_alert_parent_needs_survive_alert_preflight(tmp_path):
    from transit_ops.batch.input_sources import archive_input_needs

    class Catalog:
        def get_foreign_keys(self, table, schema):
            edges = {
                "gold.fact_vehicle_snapshot": [("raw", "realtime_snapshot_index")],
                "raw.realtime_snapshot_index": [
                    ("raw", "ingestion_runs"),
                    ("raw", "ingestion_objects"),
                ],
            }
            return [
                dict(referred_schema=s, referred_table=t)
                for s, t in edges.get(schema + "." + table, [])
            ]

    storage = store(tmp_path)
    bundle(storage, alert_copies(storage))
    needs = archive_input_needs(
        [
            InputNeed("silver.i3_alerts", "all"),
            InputNeed("core.providers", "all"),
            InputNeed("gold.fact_vehicle_snapshot", "2026-11-01"),
        ],
        storage,
        "sample",
        STAMP,
        {},
        Catalog(),
    )
    assert InputNeed("core.providers", "all") in needs
    assert InputNeed("raw.ingestion_runs", "2026-11-01") in needs
    assert InputNeed("raw.ingestion_objects", "2026-11-01") in needs


@pytest.fixture(scope="module")
def replay_payload_seed(tmp_path_factory):
    root = tmp_path_factory.mktemp("replay-payload")
    path = root / "seed.parquet"
    with duckdb.connect(
        config={"threads": 1, "memory_limit": "1024MB", "preserve_insertion_order": False}
    ) as conn:
        conn.execute(
            "COPY (SELECT range AS i3_alert_snapshot_id, 'sample' AS provider_id, "
            "range AS ingestion_run_id, repeat(md5(range::VARCHAR),2048) AS raw_payload_json "
            "FROM range(20000)) TO ? (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2048)",
            [str(path)],
        )
    return path


@pytest.mark.parametrize("budget", [1024, 32])
def test_payload_closure_materializes_or_refuses_by_memory_budget(
    tmp_path, replay_payload_seed, budget
):
    from shutil import copyfile

    from transit_ops.batch.input_sources import Source

    path = tmp_path / "closure.parquet"
    copyfile(replay_payload_seed, path)
    source = Source(
        "closure",
        dict(
            bundle_closure=True,
            bundle_version="a" * 64,
            replay_provider="sample",
            bundle_snapshot_at_utc=STAMP.isoformat(),
            object_sha256="b" * 64,
            object_bytes=path.stat().st_size,
        ),
        (InputNeed("raw.i3_alert_snapshots", "all"),),
    )
    root = tmp_path / "inputs"
    if budget == 32:
        with pytest.raises(ValueError, match="replay_memory.*raw.i3_alert_snapshots.*32MB"):
            materialize([source], {"closure": path}, root, STAMP, memory_limit_mb=budget)
    else:
        materialize([source], {"closure": path}, root, STAMP, memory_limit_mb=budget)
        with duckdb.connect(config={"threads": 1, "memory_limit": "1024MB"}) as conn:
            assert conn.execute(
                "SELECT count(*),sum(length(raw_payload_json)) FROM read_parquet(?)",
                [str(root / "raw.i3_alert_snapshots" / "all.parquet")],
            ).fetchone() == (20000, 1_310_720_000)


def test_partial_copy_refuses_past_cut_and_later_revision_supersedes(tmp_path):
    storage = store(tmp_path)
    relation = "raw.realtime_snapshot_index"
    need = InputNeed(relation, "2026-11-02")
    for version, cut in [(1, "2026-11-03T05:00:00+00:00"), (2, "2026-11-03T06:00:00+00:00")]:
        key = archive(storage, relation, "2026-11", "SELECT 1 AS id", version=version)
        record = json.loads(storage.read_bytes(proof_key(key)))
        record.update(partial=True, cut_utc=cut)
        put(storage, proof_key(key), record)
        if version == 1:
            with pytest.raises(ValueError, match="window_coverage"):
                resolve_sources([need], storage, "sample", STAMP, {})
        else:
            assert resolve_sources([need], storage, "sample", STAMP, {})[0].key == key


@pytest.mark.parametrize("late", [False, True])
def test_cut_coverage_through_catalog_preflight(tmp_path, monkeypatch, late):
    from contextlib import nullcontext
    from datetime import date

    from transit_ops.batch import input_sources
    from transit_ops.batch.build import BuildRequest, utc_days
    from transit_ops.batch.families.span_skipped_stops import SpanSkippedStopsBuilder

    request = BuildRequest(
        "sample",
        (date(2026, 11, 13 if late else 14),),
        datetime(2026, 11, 15, 17, tzinfo=UTC),
        30,
        10,
        "America/Toronto",
    )

    class Ordinary:
        family_id = "ordinary"

        def inputs(self, request):
            return tuple(InputNeed("gold.fact_trip_delay_snapshot", d) for d in utc_days(request))

    builder = SpanSkippedStopsBuilder() if late else Ordinary()

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return (
                [dict(referred_schema="raw", referred_table="realtime_snapshot_index")]
                if name == "fact_trip_delay_snapshot"
                else []
            )

    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(Catalog()))
    storage = store(tmp_path)
    bootstrap(storage)
    archive(
        storage,
        "core.providers",
        "2026-11",
        "SELECT 'sample' AS provider_id, 'America/Toronto' AS timezone",
    )
    for need in builder.inputs(request):
        key = archive(
            storage,
            need.relation,
            need.window,
            f"SELECT TIMESTAMPTZ '{need.window} 00:00:00+00' AS captured_at_utc WHERE false",
        )
        if need.window == "2026-11-15":
            receipt = json.loads(storage.read_bytes(proof_key(key)))
            receipt.update(partial=True, cut_utc="2026-11-15T11:00:00+00:00")
            put(storage, proof_key(key), receipt)
    root = tmp_path / "inputs"
    root.mkdir()
    if late:
        with pytest.raises(ValueError, match="window_coverage"):
            resolve_sources(
                builder.inputs(request), storage, "sample", request.as_of_utc, {}, request=request
            )
        with pytest.raises(ValueError, match="window_coverage"):
            input_sources.fetch_from_catalog(storage, root, request, [builder])
    else:
        assert input_sources.fetch_from_catalog(storage, root, request, [builder])["needs"]


def test_date_bound_is_stricter_than_timestamp_cut(tmp_path):
    storage = store(tmp_path)
    key = archive(storage, "gold.route_delay_spine", "2026-11", "SELECT 1 AS id")
    value = json.loads(storage.read_bytes(proof_key(key)))
    value.update(partial=True, cut_utc="2026-11-15T11:00:00+00:00", date_bound="2026-11-14")
    put(storage, proof_key(key), value)
    with pytest.raises(ValueError, match="window_coverage.*date_bound"):
        resolve_sources(
            [InputNeed("gold.route_delay_spine", "2026-11-14")],
            storage,
            "sample",
            datetime(2026, 11, 15, 17, tzinfo=UTC),
            {},
        )


def test_selected_known_incomplete_copy_refuses_by_digest(tmp_path):
    storage = store(tmp_path)
    relation = "gold.fact_trip_delay_snapshot"
    key = archive(storage, relation, "2026-11-01", "SELECT 1 AS id", provider="octranspo")
    record = json.loads(storage.read_bytes(proof_key(key)))
    record["object_sha256"] = record["proof"]["object_sha256"] = (
        "8d6b9a92e21ac850eb94d9b3b44c0774701d32b40954cd9c19938164c818e128"
    )
    record["content_sha256"] = "1e67bd67bb7544c30a151e3ca4f4575089c45a6377a5553ac69db9a512b48d89"
    record["rows"] = record["proof"]["rows"] = 234241
    put(storage, proof_key(key), record)
    with pytest.raises(ValueError, match="known_incomplete.*234241"):
        resolve_sources([InputNeed(relation, "2026-11-01")], storage, "octranspo", STAMP, {})


def test_proven_rescue_wins_over_competing_known_bad_archive(tmp_path):
    storage = store(tmp_path)
    relation = "gold.fact_trip_delay_snapshot"
    need = InputNeed(relation, "2026-11-01")
    archive_key = archive(storage, relation, need.window, "SELECT 1 AS id", provider="octranspo")
    record = json.loads(storage.read_bytes(proof_key(archive_key)))
    record["object_sha256"] = record["proof"]["object_sha256"] = (
        "8d6b9a92e21ac850eb94d9b3b44c0774701d32b40954cd9c19938164c818e128"
    )
    record["content_sha256"] = "1e67bd67bb7544c30a151e3ca4f4575089c45a6377a5553ac69db9a512b48d89"
    put(storage, proof_key(archive_key), record)
    key = "rescue/v1/parquet/octranspo/2026-11-01/fact_trip_delay_snapshot.parquet"
    rescue_record = dict(
        key=key,
        object_sha256="a" * 64,
        object_bytes=12,
        proof=dict(verified=True, object_sha256="a" * 64, object_bytes=12),
    )
    put(
        storage,
        key.rsplit("/", 1)[0] + "/receipt.json",
        dict(
            format_version=1,
            kind="rescue_parquet",
            provider="octranspo",
            day=need.window,
            tables={"fact_trip_delay_snapshot": rescue_record},
        ),
    )
    assert resolve_sources([need], storage, "octranspo", STAMP, {})[0].key == key


def test_fetched_rescue_provenance_survives_materialization(tmp_path):
    from transit_ops.batch.engine import InputRefused
    from transit_ops.batch.inputs import resolve_inputs

    storage = store(tmp_path)
    need = InputNeed("gold.fact_trip_delay_snapshot", "2026-11-01")
    key = "rescue/v1/parquet/octranspo/2026-11-01/fact_trip_delay_snapshot.parquet"
    path = storage.root / key
    path.parent.mkdir(parents=True)
    with duckdb.connect() as conn:
        conn.execute(
            "COPY (SELECT 'octranspo' AS provider_id, "
            "TIMESTAMPTZ '2026-11-01 12:00:00+00' AS captured_at_utc) TO ? (FORMAT parquet)",
            [str(path)],
        )
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    size = path.stat().st_size
    record = dict(
        key=key,
        object_sha256=digest,
        object_bytes=size,
        proof=dict(verified=True, object_sha256=digest, object_bytes=size),
    )
    put(
        storage,
        key.rsplit("/", 1)[0] + "/receipt.json",
        dict(
            format_version=1,
            kind="rescue_parquet",
            provider="octranspo",
            day=need.window,
            tables={"fact_trip_delay_snapshot": record},
        ),
    )
    root = tmp_path / "inputs"
    root.mkdir()
    fetch_replay_inputs(
        storage, root, "octranspo", STAMP, lambda _: [need], bootstrap_editions=False
    )
    local = resolve_inputs([need], root, provider_id="octranspo")[0].files[0]
    value = json.loads((root / "fetch-receipts.json").read_text())["files"][
        local.relative_to(root).as_posix()
    ]
    assert value["input_sha256"] == hashlib.sha256(local.read_bytes()).hexdigest()
    assert value["sources"][0]["key"] == key
    assert value["sources"][0]["object_sha256"] == digest
    assert resolve_inputs([], root) == ()
    local.write_bytes(local.read_bytes() + b"changed")
    with pytest.raises(InputRefused, match="input_provenance_missing"):
        resolve_inputs([need], root, provider_id="octranspo")


def edition_parent_archive(storage):
    """Edition 7 references object 5 (run 1, July) and run 2 (August) only."""
    bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, 7::BIGINT AS dataset_version_id, "
        f"'{('c' * 64)}' AS checksum_sha256, NULL::VARCHAR AS content_hash, "
        "'static_schedule' AS dataset_kind, true AS is_current, "
        "TIMESTAMPTZ '2025-08-02 00:00:00+00' AS loaded_at_utc, "
        "5::BIGINT AS source_ingestion_object_id, 2::BIGINT AS source_ingestion_run_id",
    )
    objects = (
        "SELECT * FROM (VALUES (5, 1, 'sample', TIMESTAMPTZ '2025-08-01 00:00:05+00'), "
        "(6, 9, 'sample', TIMESTAMPTZ '2025-08-01 00:00:06+00')) "
        "t(ingestion_object_id, ingestion_run_id, provider_id, created_at_utc)"
    )
    runs = "SELECT * FROM (VALUES {}) t(ingestion_run_id, provider_id, started_at_utc)"
    keys = {
        "objects-2025-08": archive(storage, "raw.ingestion_objects", "2025-08", objects),
        "objects-2025-09": archive(
            storage,
            "raw.ingestion_objects",
            "2025-09",
            objects.replace("2025-08", "2025-09").replace("(5, 1", "(8, 1"),
        ),
        "runs-2025-07": archive(
            storage,
            "raw.ingestion_runs",
            "2025-07",
            runs.format("(1, 'sample', TIMESTAMPTZ '2025-07-31 23:59:58+00')"),
        ),
        "runs-2025-08": archive(
            storage,
            "raw.ingestion_runs",
            "2025-08",
            runs.format(
                "(2, 'sample', TIMESTAMPTZ '2025-08-01 00:00:00+00'), "
                "(3, 'sample', TIMESTAMPTZ '2025-08-03 00:00:00+00')"
            ),
        ),
    }
    return keys


EDITION_NEEDS = [
    InputNeed("core.dataset_versions", "all"),
    InputNeed("raw.ingestion_objects", "all"),
    InputNeed("raw.ingestion_runs", "all"),
]


def test_pinned_edition_parents_fetch_only_referenced_months_and_rows(tmp_path, monkeypatch):
    storage = store(tmp_path)
    keys = edition_parent_archive(storage)
    opened = []
    original = LocalBronzeStorage.open_stream

    def opening(self, key, **kwargs):
        opened.append(key)
        return original(self, key, **kwargs)

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", opening)
    root = tmp_path / "inputs"
    root.mkdir()
    references = {
        "raw.ingestion_objects": ("2025-08",),
        "raw.ingestion_runs": ("2025-07", "2025-08"),
    }
    fetch_replay_inputs(
        storage, root, "sample", STAMP, lambda _: EDITION_NEEDS, references=references
    )
    assert keys["objects-2025-09"] not in opened
    with duckdb.connect() as conn:

        def ids(relation, column):
            return conn.execute(
                f"SELECT {column} FROM read_parquet(?) ORDER BY 1",
                [str(root / relation / "all.parquet")],
            ).fetchall()

        # Row-aware: the unrelated object 6 (run 9 outside the closure) never loads.
        assert ids("raw.ingestion_objects", "ingestion_object_id") == [(5,)]
        assert ids("raw.ingestion_runs", "ingestion_run_id") == [(1,), (2,)]


def test_pinned_edition_parents_refuse_a_missing_referenced_row(tmp_path):
    storage = store(tmp_path)
    edition_parent_archive(storage)
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(ValueError, match="fk_parent_outside_range: raw.ingestion_runs"):
        fetch_replay_inputs(
            storage,
            root,
            "sample",
            STAMP,
            lambda _: EDITION_NEEDS,
            references={
                "raw.ingestion_objects": ("2025-08",),
                "raw.ingestion_runs": ("2025-08",),
            },
        )


def test_unpinned_edition_parents_still_require_every_month_since_the_first(tmp_path):
    storage = store(tmp_path)
    edition_parent_archive(storage)
    root = tmp_path / "inputs"
    root.mkdir()
    with pytest.raises(SourcesMissing):
        fetch_replay_inputs(storage, root, "sample", STAMP, lambda _: EDITION_NEEDS)


def edition_parent_catalog():
    """The 0093 FKs of the whole-state edition metadata and its parents."""
    parents = {
        ("core", "dataset_versions"): ("ingestion_objects", "ingestion_runs"),
        ("raw", "ingestion_objects"): ("ingestion_runs",),
    }

    class Catalog:
        def get_foreign_keys(self, name, schema):
            return [
                {"referred_schema": "raw", "referred_table": parent}
                for parent in parents.get((schema, name), ())
            ]

    return Catalog()


def edition_builder(monkeypatch):
    """An edition reader whose only replay input is the edition metadata itself."""
    from transit_ops.batch import replay

    monkeypatch.setattr(
        replay,
        "postgres_input_needs",
        lambda request, editions: (InputNeed("core.dataset_versions", "all"),) if editions else (),
    )

    class EditionReader:
        family_id = "cancellations_service_states"
        tables = ()
        published_keys = ()
        variants = {}

        def inputs(self, request):
            return ()

        def build(self, *args):
            raise AssertionError("fetch must not build")

    return EditionReader()


@pytest.mark.parametrize("older_month", [False, True])
def test_pinned_open_month_parents_pass_the_public_fk_preflight(tmp_path, monkeypatch, older_month):
    from contextlib import nullcontext

    from test_batch_editions import REQUEST

    from transit_ops.batch import input_sources

    monkeypatch.setattr(
        input_sources, "replay_catalog", lambda: nullcontext(edition_parent_catalog())
    )
    storage = store(tmp_path)
    bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, 7::BIGINT AS dataset_version_id, "
        f"'{('c' * 64)}' AS checksum_sha256, NULL::VARCHAR AS content_hash, "
        "'static_schedule' AS dataset_kind, true AS is_current, "
        "TIMESTAMPTZ '2026-11-02 00:00:00+00' AS loaded_at_utc, "
        "5::BIGINT AS source_ingestion_object_id, 2::BIGINT AS source_ingestion_run_id",
    )
    open_copies = [
        archive(
            storage,
            "raw.ingestion_objects",
            "2026-11",
            "SELECT 5::BIGINT AS ingestion_object_id, 2::BIGINT AS ingestion_run_id, "
            "'sample' AS provider_id, TIMESTAMPTZ '2026-11-02 00:00:05+00' AS created_at_utc",
        ),
        archive(
            storage,
            "raw.ingestion_runs",
            "2026-11",
            "SELECT 2::BIGINT AS ingestion_run_id, 'sample' AS provider_id, "
            "TIMESTAMPTZ '2026-11-02 00:00:00+00' AS started_at_utc",
        ),
    ]
    if older_month:  # A contiguous closed month from an earlier export.
        archive(
            storage,
            "raw.ingestion_objects",
            "2026-10",
            "SELECT 4::BIGINT AS ingestion_object_id, 1::BIGINT AS ingestion_run_id, "
            "'sample' AS provider_id, TIMESTAMPTZ '2026-10-02 00:00:05+00' AS created_at_utc",
        )
    for key in open_copies:  # The export's open-month cut copy (#1107), cut before as_of.
        record = json.loads(storage.read_bytes(proof_key(key)))
        record.update(partial=True, cut_utc="2026-11-03T06:30:00+00:00")
        put(storage, proof_key(key), record)
    root = tmp_path / "inputs"
    root.mkdir()
    input_sources.fetch_from_catalog(
        storage,
        root,
        REQUEST,
        [edition_builder(monkeypatch)],
        references={"raw.ingestion_objects": ("2026-11",), "raw.ingestion_runs": ("2026-11",)},
    )
    with duckdb.connect() as conn:
        for relation, column, expected in (
            ("raw.ingestion_objects", "ingestion_object_id", [(5,)]),
            ("raw.ingestion_runs", "ingestion_run_id", [(2,)]),
        ):
            assert (
                conn.execute(
                    f"SELECT {column} FROM read_parquet(?) ORDER BY 1",
                    [str(root / relation / "all.parquet")],
                ).fetchall()
                == expected
            )


def test_alert_bundle_closure_parents_survive_the_edition_pin(tmp_path):
    """receipts (alerts) and an edition family share one provider-day fetch row."""
    storage = store(tmp_path)
    objects = (
        "SELECT * FROM (VALUES {}) "
        "t(ingestion_object_id, ingestion_run_id, provider_id, created_at_utc)"
    )
    runs = "SELECT * FROM (VALUES {}) t(ingestion_run_id, provider_id, started_at_utc)"
    november = "TIMESTAMPTZ '2026-11-01 00:00:00+00'"
    bundle(
        storage,
        alert_copies(storage),
        closure_queries={
            "raw.ingestion_objects": objects.format(
                f"(1, 1, 'sample', {november}), (2, 2, 'other', {november})"
            ),
            "raw.ingestion_runs": runs.format(
                f"(1, 'sample', {november}), (2, 'other', {november})"
            ),
        },
    )
    bootstrap(
        storage,
        "SELECT 'sample' AS provider_id, 7::BIGINT AS dataset_version_id, "
        f"'{('c' * 64)}' AS checksum_sha256, NULL::VARCHAR AS content_hash, "
        "'static_schedule' AS dataset_kind, true AS is_current, "
        "TIMESTAMPTZ '2025-08-02 00:00:00+00' AS loaded_at_utc, "
        "5::BIGINT AS source_ingestion_object_id, 6::BIGINT AS source_ingestion_run_id",
    )
    august = "TIMESTAMPTZ '2025-08-01 00:00:05+00'"
    archive(
        storage,
        "raw.ingestion_objects",
        "2025-08",
        objects.format(f"(5, 6, 'sample', {august}), (9, 9, 'sample', {august})"),
    )
    archive(storage, "raw.ingestion_runs", "2025-08", runs.format(f"(6, 'sample', {august})"))
    root = tmp_path / "inputs"
    root.mkdir()
    fetch_replay_inputs(
        storage,
        root,
        "sample",
        STAMP,
        lambda _: [InputNeed("silver.i3_alerts", "all"), *EDITION_NEEDS],
        references={"raw.ingestion_objects": ("2025-08",), "raw.ingestion_runs": ("2025-08",)},
    )
    with duckdb.connect() as conn:

        def ids(relation, column):
            return conn.execute(
                f"SELECT {column} FROM read_parquet(?) ORDER BY 1",
                [str(root / relation / "all.parquet")],
            ).fetchall()

        # The alert closure's provider parents (1) load beside the edition parents only;
        # the unreferenced archive object 9 stays out.
        assert ids("raw.ingestion_objects", "ingestion_object_id") == [(1,), (5,)]
        assert ids("raw.ingestion_runs", "ingestion_run_id") == [(1,), (6,)]
