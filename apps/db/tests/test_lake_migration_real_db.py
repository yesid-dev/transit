import json
from datetime import UTC, date, datetime
from uuid import uuid4

import psycopg
import pytest
from parallel_db import guarded_connect_kwargs
from test_rescue_fact_day import fact_source as fact_source

from transit_ops.history import datasets
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake import inventory
from transit_ops.lake.migration import MigrationRefused, plan_migration, run_migration


@pytest.fixture
def source(real_db_engine):
    with psycopg.connect(**guarded_connect_kwargs(real_db_engine.url), autocommit=True) as conn:
        yield conn


def plan(source, names=None, providers=None):
    return plan_migration(
        source,
        today_utc=date(2026, 11, 15),
        include_open=False,
        datasets=names,
        providers=providers,
        statement_timeout_s=60,
    )


def test_inventory_incomplete_refuses_to_plan(source):
    table = "public.stray_" + uuid4().hex
    source.execute(f"CREATE TABLE {table} (id bigint PRIMARY KEY)")
    try:
        with pytest.raises(MigrationRefused, match=table) as error:
            plan(source)
        assert error.value.reason == "inventory_incomplete"
    finally:
        source.execute(f"DROP TABLE {table}")


@pytest.fixture
def history(source, fact_source, monkeypatch):
    provider = fact_source[0]
    suffix = uuid4().hex
    names = ["public." + kind + "_" + suffix for kind in ("months", "edition", "state")]
    version = source.execute(
        "INSERT INTO core.dataset_versions "
        "(provider_id,feed_endpoint_id,source_ingestion_run_id,content_hash,checksum_sha256) "
        "SELECT provider_id,feed_endpoint_id,ingestion_run_id,%s,%s "
        "FROM raw.realtime_snapshot_index WHERE provider_id=%s RETURNING dataset_version_id",
        ("b" * 64, "b" * 64, provider),
    ).fetchone()[0]
    declarations = dict(datasets.HISTORY_DATASETS)
    for name, grain, column in zip(
        names, ("month", "edition", "month"), ("day", "edition_id", None), strict=True
    ):
        declarations[name] = datasets.HistoryDataset(
            name,
            datasets.TableSource(name, column, ("provider_id", "id"), None, 0),
            grain,
            None,
            (),
            1,
        )
        source.execute(
            f"CREATE TABLE {name} (provider_id text NOT NULL, id bigint NOT NULL, "
            "day date, edition_id bigint, PRIMARY KEY(provider_id,id))"
        )
    monkeypatch.setattr(datasets, "HISTORY_DATASETS", declarations)
    monkeypatch.setattr(inventory, "HISTORY_DATASETS", declarations)
    for index, day in enumerate(("2026-05-25", "2026-06-02")):
        source.execute(f"INSERT INTO {names[0]} VALUES (%s,%s,%s,NULL)", (provider, index, day))
    source.execute(f"INSERT INTO {names[1]} VALUES (%s,1,NULL,%s)", (provider, version))
    source.execute(f"INSERT INTO {names[2]} VALUES (%s,1,NULL,NULL)", (provider,))
    try:
        yield names, provider
    finally:
        for name in reversed(names):
            source.execute(f"DROP TABLE {name}")
        source.execute("DELETE FROM core.dataset_versions WHERE dataset_version_id=%s", (version,))


def test_dry_run_plans_seeded_windows_and_writes_nothing(source, history, tmp_path):
    names, provider = history
    before = source.execute(f"SELECT * FROM {names[0]} ORDER BY id").fetchall()
    result = plan(source, names, [provider])
    assert [(w.spec.dataset_id, w.spec.window_key) for w in result.windows] == [
        (names[2], "2026-11"),
        (names[0], "2026-05"),
        (names[0], "2026-06"),
        (names[1], "b" * 64),
    ]
    assert source.execute(f"SELECT * FROM {names[0]} ORDER BY id").fetchall() == before
    assert not list(tmp_path.iterdir())
    filtered = plan(source, names[:1], [provider])
    assert {w.spec.dataset_id for w in filtered.windows} == {names[0]}
    with source.transaction():
        with pytest.raises(MigrationRefused, match="not_read_only"):
            plan(source, names)


def test_execute_copies_every_planned_window_to_local_storage_with_proofs(
    source,
    history,
    real_db_engine,
    tmp_path,
):
    names, provider = history
    planned = plan(source, names, [provider])
    root = tmp_path / "objects"
    root.mkdir()
    storage = LocalBronzeStorage("local", root)
    records = []

    def connect():
        return psycopg.connect(**guarded_connect_kwargs(real_db_engine.url), autocommit=True)

    result = run_migration(
        planned,
        connect,
        storage,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2099, 1, 1, tzinfo=UTC),
        log=records.append,
    )
    assert result.failure is None
    assert [r["rows"] for r in records] == [1, 1, 1, 1]
    receipts = [
        json.loads(storage.read_bytes(key))
        for key in storage.list_keys("archive/")
        if key.endswith(".proof.json")
    ]
    assert {r["dataset_id"] for r in receipts} == set(names)
    assert all(r["proof"]["verified"] is True for r in receipts)
    before = {key: storage.read_bytes(key) for key in storage.list_keys("archive/")}
    again = run_migration(
        planned,
        connect,
        storage,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2099, 1, 1, tzinfo=UTC),
        log=lambda r: None,
    )
    assert again.outcomes == {
        "whole_state": {"already_copied": 1},
        "month": {"already_copied": 2},
        "edition": {"already_copied": 1},
    }
    assert before == {key: storage.read_bytes(key) for key in storage.list_keys("archive/")}
