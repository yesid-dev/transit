"""Small disposable seed; the database fixture is the only availability guard."""

import json
from datetime import UTC, datetime, timedelta

import duckdb
import psycopg
import pytest
from parallel_db import guarded_connect_kwargs

from transit_ops.batch.build import InputNeed
from transit_ops.batch.input_sources import SourcesMissing, resolve_sources
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.alert_bundle import MEMBERS, PREFIX, copy_group
from transit_ops.lake.table_export import WindowSpec

PROVIDER = "alert_bundle_seed"


@pytest.fixture
def alert_seed(real_db_engine, seed_provider):
    args = guarded_connect_kwargs(real_db_engine.url)
    with real_db_engine.begin() as conn:
        seed_provider(conn, PROVIDER, display_name=PROVIDER)
    with psycopg.connect(**args, autocommit=True) as conn:
        endpoint = conn.execute(
            "INSERT INTO core.feed_endpoints(provider_id,endpoint_key,feed_kind,source_format) "
            "VALUES (%s,'i3_alerts','i3_alerts','api_i3_json') RETURNING feed_endpoint_id",
            (PROVIDER,),
        ).fetchone()[0]
        run = conn.execute(
            "INSERT INTO raw.ingestion_runs(provider_id,feed_endpoint_id,run_kind,status) "
            "VALUES (%s,%s,'i3_alerts','succeeded') RETURNING ingestion_run_id",
            (PROVIDER, endpoint),
        ).fetchone()[0]
        snapshot = conn.execute(
            "INSERT INTO raw.i3_alert_snapshots(provider_id,feed_endpoint_id,"
            "ingestion_run_id,raw_payload_json) "
            "VALUES (%s,%s,%s,'{}') RETURNING i3_alert_snapshot_id",
            (PROVIDER, endpoint, run),
        ).fetchone()[0]

        def insert(connection, index):
            with connection.transaction():
                connection.execute(
                    "INSERT INTO silver.i3_alerts(i3_alert_snapshot_id,alert_index,provider_id,"
                    "captured_at_utc,raw_alert_json,content_hash) "
                    "VALUES (%s,%s,%s,now(),'{}',%s)",
                    (snapshot, index, PROVIDER, str(index) * 64),
                )
                connection.execute(
                    "INSERT INTO silver.i3_alert_informed_entities("
                    "i3_alert_snapshot_id,alert_index,"
                    "entity_index,provider_id,raw_entity_json) VALUES (%s,%s,0,%s,'{}')",
                    (snapshot, index, PROVIDER),
                )
                connection.execute(
                    "INSERT INTO silver.i3_alert_active_periods(i3_alert_snapshot_id,alert_index,"
                    "period_index) VALUES (%s,%s,0)",
                    (snapshot, index),
                )

        try:
            insert(conn, 0)
            yield conn, args, snapshot, insert
        finally:
            conn.execute("DELETE FROM raw.i3_alert_snapshots WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM raw.ingestion_runs WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM core.feed_endpoints WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM core.providers WHERE provider_id=%s", (PROVIDER,))
            for table in (
                "raw.i3_alert_snapshots",
                "raw.ingestion_runs",
                "core.feed_endpoints",
                "core.providers",
                "silver.i3_alerts",
                "silver.i3_alert_informed_entities",
            ):
                assert conn.execute(
                    f"SELECT count(*) FROM {table} WHERE provider_id=%s", (PROVIDER,)
                ).fetchone() == (0,)
            assert conn.execute(
                "SELECT count(*) FROM silver.i3_alert_active_periods WHERE i3_alert_snapshot_id=%s",
                (snapshot,),
            ).fetchone() == (0,)


@pytest.mark.parametrize("fail_mid_group", [False, True])
def test_one_snapshot_and_last_bundle_proof(alert_seed, tmp_path, monkeypatch, fail_mid_group):
    from transit_ops.lake import table_export

    conn, args, snapshot, insert = alert_seed
    original = table_export._copy
    interleaved = False

    def copy(*a, **kw):
        nonlocal interleaved
        result = original(*a, **kw)
        if not interleaved:
            interleaved = True
            with psycopg.connect(**args, autocommit=True) as writer:
                insert(writer, 1)
                writer.execute(
                    "UPDATE raw.i3_alert_snapshots SET raw_payload_json=%s::jsonb "
                    "WHERE i3_alert_snapshot_id=%s",
                    ('{"late":true}', snapshot),
                )
        return result

    monkeypatch.setattr(table_export, "_copy", copy)
    events = []

    class Storage(LocalBronzeStorage):
        def put_if_absent(self, path, key):
            events.append(key)
            if fail_mid_group and "silver.i3_alert_informed_entities" in key:
                raise OSError("mid-group failure")
            return super().put_if_absent(path, key)

    (tmp_path / "objects").mkdir()
    storage = Storage("local", tmp_path / "objects")
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else PROVIDER, "2026-11")
        for r in MEMBERS
    ]
    if fail_mid_group:
        with pytest.raises(OSError, match="mid-group"):
            copy_group(
                conn, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
            )
        assert list(storage.list_keys(PREFIX)) == []
        with pytest.raises(SourcesMissing, match="silver.i3_alerts"):
            resolve_sources(
                [InputNeed("silver.i3_alerts", "all")],
                storage,
                PROVIDER,
                datetime.now(UTC) + timedelta(seconds=1),
                {},
            )
        return
    result = copy_group(
        conn, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
    )
    assert interleaved
    assert events[-1] == PREFIX + result.version + ".json"
    document = json.loads(storage.read_bytes(events[-1]))
    assert document["snapshot_at_utc"] == result.snapshot_at_utc
    assert len(document["members"]) == 3
    assert {m["dataset_id"] for m in document["closure"]} == {
        "raw.i3_alert_snapshots",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
        "core.feed_endpoints",
        "core.providers",
    }
    with duckdb.connect() as db:
        for member in result.members:
            rows = db.execute(
                "SELECT alert_index FROM read_parquet(?, hive_partitioning=false) "
                "WHERE i3_alert_snapshot_id=?",
                [str(storage.root / member.key), snapshot],
            ).fetchall()
            assert rows == [
                (0,)
            ]  # The concurrent version and all its children are outside the cut.
    parent = next(m for m in document["closure"] if m["dataset_id"] == "raw.i3_alert_snapshots")
    with duckdb.connect() as db:
        payload = db.execute(
            "SELECT raw_payload_json FROM read_parquet(?) WHERE i3_alert_snapshot_id=?",
            [str(storage.root / parent["key"]), snapshot],
        ).fetchone()[0]
        assert json.loads(payload) == {}  # Concurrent parent mutation is outside this same cut too.
    assert conn.execute(
        "SELECT count(*) FROM silver.i3_alerts WHERE provider_id=%s", (PROVIDER,)
    ).fetchone() == (2,)


def test_bundle_closure_is_exact_without_independent_parent_copies(
    alert_seed, tmp_path, real_db_engine
):
    from sqlalchemy import inspect

    from transit_ops.batch.input_sources import fetch_replay_inputs
    from transit_ops.batch.inputs import resolve_inputs
    from transit_ops.batch.replay import validate_parent_rows

    conn, args, snapshot, insert = alert_seed
    root = tmp_path / "archive"
    root.mkdir()
    storage = LocalBronzeStorage("local", root)
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else PROVIDER, "2026-11")
        for r in MEMBERS
    ]
    result = copy_group(
        conn, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
    )
    proof = json.loads(storage.read_bytes(PREFIX + result.version + ".json"))
    with duckdb.connect() as db:
        for parent in proof["closure"]:
            rows = db.execute(
                "SELECT provider_id FROM read_parquet(?)", [str(storage.root / parent["key"])]
            ).fetchall()
            assert rows == (
                [] if parent["dataset_id"] == "raw.ingestion_objects" else [(PROVIDER,)]
            )
    # No independent parent archive copies exist; only the pinned closure can satisfy replay.
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    receipt = fetch_replay_inputs(
        storage,
        inputs,
        PROVIDER,
        datetime.now(UTC) + timedelta(seconds=1),
        lambda _: [InputNeed("silver.i3_alerts", "all")],
        bootstrap_editions=False,
    )
    needs = tuple(InputNeed(n["relation"], n["window"]) for n in receipt["needs"])
    # Use the source's catalog only; validation reads Parquet and never loads or changes this DB.
    validate_parent_rows(resolve_inputs(needs, inputs), inspect(real_db_engine))
