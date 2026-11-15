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
    with psycopg.connect(**args, autocommit=True) as conn:
        snapshot = None
        try:
            with real_db_engine.begin() as seed:
                seed_provider(seed, PROVIDER, display_name=PROVIDER)
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
                        "INSERT INTO silver.i3_alert_active_periods("
                        "i3_alert_snapshot_id,alert_index,"
                        "period_index) VALUES (%s,%s,0)",
                        (snapshot, index),
                    )

            insert(conn, 0)
            yield conn, args, snapshot, insert
        finally:
            conn.execute("DELETE FROM raw.i3_alert_snapshots WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM raw.ingestion_objects WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM raw.ingestion_runs WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM core.feed_endpoints WHERE provider_id=%s", (PROVIDER,))
            conn.execute("DELETE FROM core.providers WHERE provider_id=%s", (PROVIDER,))
            for table in (
                "raw.i3_alert_snapshots",
                "raw.ingestion_runs",
                "raw.ingestion_objects",
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
    assert sum(m["dataset_id"].endswith("active_periods") for m in document["members"]) == 1
    assert {m["dataset_id"] for m in document["members"]} == set(MEMBERS)
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
            expected = [(0,)] if member.spec.provider_id in (PROVIDER, "_shared") else []
            assert rows == expected  # The concurrent version and its children are outside the cut.
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


def test_closure_explain_uses_parent_indexes_and_no_cte_inner_loop(alert_seed):
    import re

    from psycopg import sql

    from transit_ops.lake.alert_bundle import CLOSURE_RELATIONS, closure_statements

    conn, _, _, _ = alert_seed
    conn.execute(
        """WITH runs AS (
        INSERT INTO raw.ingestion_runs(provider_id,feed_endpoint_id,run_kind,status)
        SELECT %s,feed_endpoint_id,'i3_alerts','succeeded' FROM core.feed_endpoints,
        generate_series(1,20000) WHERE provider_id=%s RETURNING ingestion_run_id,provider_id
    ) INSERT INTO raw.ingestion_objects(provider_id,ingestion_run_id,object_kind,
        storage_backend,storage_path,checksum_sha256,byte_size)
      SELECT provider_id,ingestion_run_id,'i3_alerts','local',
        'alert-plan-' || ingestion_run_id::text, repeat('a',64),1 FROM runs""",
        (PROVIDER, PROVIDER),
    )
    conn.execute(
        """INSERT INTO raw.i3_alert_snapshots(provider_id,feed_endpoint_id,
        ingestion_run_id,ingestion_object_id,raw_payload_json)
        SELECT r.provider_id,r.feed_endpoint_id,r.ingestion_run_id,o.ingestion_object_id,'{}'
        FROM raw.ingestion_runs r JOIN raw.ingestion_objects o USING(ingestion_run_id)
        WHERE r.provider_id=%s""",
        (PROVIDER,),
    )
    conn.execute(
        """INSERT INTO silver.i3_alerts(i3_alert_snapshot_id, alert_index,
        provider_id, captured_at_utc, raw_alert_json, content_hash)
        SELECT i3_alert_snapshot_id,0,provider_id,now(),'{}',repeat('b',64)
        FROM raw.i3_alert_snapshots WHERE provider_id=%s
        ORDER BY i3_alert_snapshot_id DESC LIMIT 2000""",
        (PROVIDER,),
    )
    for table in (
        "raw.ingestion_runs",
        "raw.ingestion_objects",
        "raw.i3_alert_snapshots",
        "silver.i3_alerts",
        "silver.i3_alert_informed_entities",
    ):
        conn.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(*table.split("."))))
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else PROVIDER, "2026-11")
        for r in MEMBERS
    ]

    def assert_plan(plan, relation):
        large = {"ingestion_runs", "ingestion_objects", "i3_alert_snapshots"}

        def nodes(p):
            yield p
            for child in p.get("Plans", []):
                yield from nodes(child)

        for node in nodes(plan):
            assert not (node["Node Type"] == "Seq Scan" and node.get("Relation Name") in large), (
                relation,
                node,
            )
            if relation.startswith("raw.") and node["Node Type"] == "Nested Loop":
                inner = next(p for p in node["Plans"] if p.get("Parent Relationship") == "Inner")
                assert not any(p["Node Type"] == "CTE Scan" for p in nodes(inner)), (relation, node)

    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        conn.execute("SET LOCAL work_mem='16MB'")
        conn.execute("SET LOCAL max_parallel_workers_per_gather=0")
        conn.execute("SET LOCAL jit=off")
        old_plans = []
        for relation, statement in closure_statements(conn, specs).items():
            plan = conn.execute(sql.SQL("EXPLAIN (FORMAT JSON) {}").format(statement)).fetchone()[
                0
            ][0]["Plan"]
            assert_plan(plan, relation)
            # The previous head's exact operator shape must fail on this same seed.
            # Remove only each ARRAY wrapper's second closing parenthesis.
            current = statement.as_string()
            # Restore b3fd103c's whole-row CTEs and direct final CTE read, too.
            current = re.sub(
                r'("bundle_\d+" AS \(SELECT )[^()]+?'
                r'( FROM "(?:silver|raw|core)"\.[^ ]+ ([tp]) WHERE )',
                lambda m: m[1] + m[3] + ".*" + m[2],
                current,
            )
            final = current.rfind(" SELECT p.* FROM ")
            current = (
                current[:final] + f' SELECT * FROM "bundle_{3 + CLOSURE_RELATIONS.index(relation)}"'
            )
            token = "= ANY (ARRAY("
            while token in current:
                start = current.index(token)
                body, depth = start + len(token), 1
                end = body
                while depth:
                    depth += (current[end] == "(") - (current[end] == ")")
                    end += 1
                current = (
                    current[:start] + "IN (" + current[body : end - 1] + ")" + current[end + 1 :]
                )
            old_plans.append(
                (
                    relation,
                    conn.execute("EXPLAIN (FORMAT JSON) " + current).fetchone()[0][0]["Plan"],
                )
            )
    with pytest.raises(AssertionError):
        for relation, plan in old_plans:
            assert_plan(plan, relation)
