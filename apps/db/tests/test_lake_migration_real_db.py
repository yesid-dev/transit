import json
import re
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
        key = ("provider_id", "edition_id", "id") if grain == "edition" else ("provider_id", "id")
        declarations[name] = datasets.HistoryDataset(
            name,
            datasets.TableSource(name, column, key, None, 0),
            grain,
            None,
            (),
            1,
        )
        source.execute(
            f"CREATE TABLE {name} (provider_id text NOT NULL, id bigint NOT NULL, "
            "day date, edition_id bigint, PRIMARY KEY(" + ",".join(key) + "))"
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
        (
            names[1],
            "b" * 64 + f".v{source.execute(f'SELECT edition_id FROM {names[1]}').fetchone()[0]}",
        ),
    ]
    assert source.execute(f"SELECT * FROM {names[0]} ORDER BY id").fetchall() == before
    assert not list(tmp_path.iterdir())
    filtered = plan(source, names[:1], [provider])
    assert {w.spec.dataset_id for w in filtered.windows} == {names[0]}
    with source.transaction():
        with pytest.raises(MigrationRefused, match="not_read_only"):
            plan(source, names)


def test_repeated_content_editions_plan_copy_and_resume(source, history, real_db_engine, tmp_path):
    names, provider = history
    table = names[1]
    original = source.execute(f"SELECT edition_id FROM {table}").fetchone()[0]
    source.execute(
        "UPDATE core.dataset_versions SET checksum_sha256=NULL WHERE dataset_version_id=%s",
        (original,),
    )
    repeated = source.execute(
        "INSERT INTO core.dataset_versions "
        "(provider_id,feed_endpoint_id,source_ingestion_run_id,content_hash,checksum_sha256) "
        "SELECT provider_id,feed_endpoint_id,source_ingestion_run_id,content_hash,NULL "
        "FROM core.dataset_versions WHERE dataset_version_id=%s RETURNING dataset_version_id",
        (original,),
    ).fetchone()[0]
    try:
        source.execute(f"INSERT INTO {table} VALUES (%s,2,NULL,%s)", (provider, repeated))
        planned = plan(source, [table], [provider])
        assert {w.spec.window_key for w in planned.windows} == {
            "b" * 64 + f".v{original}",
            "b" * 64 + f".v{repeated}",
        }
        root = tmp_path / "objects"
        root.mkdir()
        storage = LocalBronzeStorage("local", root)

        def connect():
            return psycopg.connect(**guarded_connect_kwargs(real_db_engine.url), autocommit=True)

        for expected in ("copied", "already_copied"):
            records = []
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
            assert result.outcomes == {"edition": {expected: 2}}
        import duckdb

        for key in storage.list_keys("archive/"):
            if key.endswith(".parquet"):
                with duckdb.connect() as conn:
                    rows = conn.execute(
                        "SELECT edition_id FROM read_parquet(?)", [str(storage.root / key)]
                    ).fetchall()
                assert rows == [(repeated if f".v{repeated}." in key else original,)]
    finally:
        source.execute(f"DELETE FROM {table} WHERE edition_id=%s", (repeated,))
        source.execute("DELETE FROM core.dataset_versions WHERE dataset_version_id=%s", (repeated,))


def test_copy_prune_first_registry_resume_and_replay_old_and_new_bootstrap(
    source, history, real_db_engine, tmp_path
):
    import duckdb

    from transit_ops.batch.build import InputNeed
    from transit_ops.batch.input_sources import edition_mapping, fetch_replay_inputs
    from transit_ops.lake.edition_assignments import stored_assignments
    from transit_ops.lake.edition_identity import assignment_json
    from transit_ops.lake.migration import MigrationPlan, PlannedWindow
    from transit_ops.lake.table_export import WindowSpec

    names, provider = history
    table = names[1]
    original = source.execute(f"SELECT edition_id FROM {table}").fetchone()[0]
    repeated = source.execute(
        "INSERT INTO core.dataset_versions "
        "(provider_id,feed_endpoint_id,source_ingestion_run_id,content_hash) "
        "SELECT provider_id,feed_endpoint_id,source_ingestion_run_id,content_hash "
        "FROM core.dataset_versions WHERE dataset_version_id=%s RETURNING dataset_version_id",
        (original,),
    ).fetchone()[0]
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    assigned = {original: "b" * 64, repeated: "b" * 64 + f".v{repeated}"}

    def connect():
        return psycopg.connect(**guarded_connect_kwargs(real_db_engine.url), autocommit=True)

    def copy_specs(specs):
        inventory = plan(source, [table], [provider]).inventory
        packet = MigrationPlan(inventory, tuple(PlannedWindow(s, "closed") for s in specs), ())
        result = run_migration(
            packet,
            connect,
            storage,
            work_dir=tmp_path,
            copied_by="a" * 40,
            statement_timeout_s=60,
            not_after=datetime(2099, 1, 1, tzinfo=UTC),
            log=lambda _: None,
        )
        assert result.failure is None
        return result

    try:
        source.execute(f"INSERT INTO {table} VALUES (%s,2,NULL,%s)", (provider, repeated))
        editions = [
            WindowSpec(table, provider, window, edition_assignments=assignment_json(assigned))
            for window in assigned.values()
        ]
        # A legacy bare-digest owner, followed by its qualified duplicate.
        copy_specs(
            editions
            + [
                WindowSpec(
                    "core.dataset_versions",
                    provider,
                    "2026-10",
                    edition_assignments=assignment_json(assigned),
                )
            ]
        )
        original_bytes = {k: storage.read_bytes(k) for k in storage.list_keys("archive/")}
        source.execute(f"DELETE FROM {table} WHERE edition_id=%s", (original,))
        source.execute("DELETE FROM core.dataset_versions WHERE dataset_version_id=%s", (original,))
        planned = plan_migration(
            source,
            today_utc=date(2026, 11, 15),
            include_open=False,
            datasets=[table],
            providers=[provider],
            statement_timeout_s=60,
            storage=storage,
        )
        assert [w.spec.window_key for w in planned.windows] == [assigned[repeated]]
        resumed = copy_specs([planned.windows[0].spec])
        assert resumed.outcomes == {"edition": {"already_copied": 1}}
        copy_specs(
            [
                WindowSpec(
                    "core.dataset_versions",
                    provider,
                    "2026-11",
                    edition_assignments=assignment_json(stored_assignments(storage, provider)),
                )
            ]
        )
        for month, ids in ((10, (original, repeated)), (11, (repeated,))):
            root = tmp_path / f"replay-{month}"
            root.mkdir()
            needs = [InputNeed("core.dataset_versions", "all")]
            needs += [InputNeed(table, f"edition:{ident}") for ident in ids]
            fetch_replay_inputs(
                storage,
                root,
                provider,
                datetime(2026, month, 25, tzinfo=UTC),
                lambda mapping, needs=needs: needs,
            )
            for ident in ids:
                with duckdb.connect() as conn:
                    actual = conn.execute(
                        "SELECT edition_id FROM read_parquet(?)",
                        [str(root / table / f"edition={ident}.parquet")],
                    ).fetchall()
                assert actual == [(ident,)]
            local = edition_mapping(root / "core.dataset_versions" / "all.parquet", provider)
            assert repeated in local
        assert all(storage.read_bytes(k) == value for k, value in original_bytes.items())
    finally:
        source.execute(f"DELETE FROM {table} WHERE edition_id=%s", (repeated,))
        source.execute("DELETE FROM core.dataset_versions WHERE dataset_version_id=%s", (repeated,))


@pytest.mark.parametrize("edition_first", [False, True])
def test_edition_planner_queries_have_index_backed_explain_shapes(
    source, history, monkeypatch, edition_first
):
    names, provider = history
    table = names[1]
    if edition_first:
        from dataclasses import replace

        key = ("edition_id", "provider_id", "id")
        source.execute(f"ALTER TABLE {table} DROP CONSTRAINT {table.split('.')[1]}_pkey")
        source.execute(f"ALTER TABLE {table} ADD PRIMARY KEY (edition_id,provider_id,id)")
        source.execute(
            f"ALTER TABLE {table} ADD FOREIGN KEY (provider_id) "
            "REFERENCES core.providers(provider_id)"
        )
        declared = datasets.get_dataset(table)
        declarations = {
            **datasets.HISTORY_DATASETS,
            table: replace(declared, source=replace(declared.source, key_columns=key)),
        }
        monkeypatch.setattr(datasets, "HISTORY_DATASETS", declarations)
        monkeypatch.setattr(inventory, "HISTORY_DATASETS", declarations)
    original = source.execute(f"SELECT edition_id FROM {table}").fetchone()[0]
    versions = [
        r[0]
        for r in source.execute(
            "INSERT INTO core.dataset_versions "
            "(provider_id,feed_endpoint_id,source_ingestion_run_id,content_hash) "
            "SELECT provider_id,feed_endpoint_id,source_ingestion_run_id,repeat('d',64) "
            "FROM core.dataset_versions CROSS JOIN generate_series(1,512) "
            "WHERE dataset_version_id=%s RETURNING dataset_version_id",
            (original,),
        ).fetchall()
    ]
    try:
        source.execute(
            f"INSERT INTO {table}(provider_id,id,edition_id) "
            "SELECT %s, n, v FROM unnest(%s::bigint[]) v CROSS JOIN generate_series(1,16) n",
            (provider, versions),
        )
        source.execute(f"ANALYZE {table}")
        source.execute("ANALYZE core.dataset_versions")
        queries = []

        class Recording:
            def __getattr__(self, name):
                return getattr(source, name)

            def execute(self, query, values=None):
                statement = query.as_string() if hasattr(query, "as_string") else str(query)
                if table.replace(".", '"."') in statement:
                    queries.append((statement, values))
                return source.execute(query, values)

        plan(Recording(), [table], [provider])
        assert queries
        assert any("LEFT JOIN core.dataset_versions" in q for q, _ in queries)
        assert source.execute("SHOW enable_seqscan").fetchone() == ("on",)
        controls_checked = False
        successor_checked = False
        for statement, values in queries:
            assert "min(" not in statement.lower()
            explained = source.execute("EXPLAIN (FORMAT JSON) " + statement, values).fetchone()[0]
            assert_bounded_edition_plan(
                explained[0]["Plan"],
                table,
                edition_first,
                lookup="EXISTS" in statement or "LEFT JOIN" in statement,
                edition_prefix="edition_id" in statement,
            )
            if "LEFT JOIN" in statement and not controls_checked:
                # Adversarial SQL controls stay in memory. Both must fail the
                # same plan assertion at ordinary optimizer settings.
                nonsargable = statement.replace(
                    't."edition_id"=%s', 't."edition_id"::text=%s::text'
                )
                bad = source.execute("EXPLAIN (FORMAT JSON) " + nonsargable, values).fetchone()[0]
                with pytest.raises(AssertionError):
                    assert_bounded_edition_plan(bad[0]["Plan"], table, edition_first, lookup=True)
                unbounded = statement[: statement.index("WHERE")] + "LIMIT 1"
                bad = source.execute("EXPLAIN (FORMAT JSON) " + unbounded).fetchone()[0]
                with pytest.raises(AssertionError):
                    assert_bounded_edition_plan(bad[0]["Plan"], table, edition_first, lookup=True)
                controls_checked = True
            if "WITH RECURSIVE keys" in statement and not successor_checked:
                nonsargable = re.sub(
                    r"WHERE ROW\((.*?)\) > ROW\((.*?)\)",
                    r"WHERE ROW(\1)::text > ROW(\2)::text",
                    statement,
                )
                assert nonsargable != statement
                bad = source.execute("EXPLAIN (FORMAT JSON) " + nonsargable, values).fetchone()[0]
                with pytest.raises(AssertionError):
                    assert_bounded_edition_plan(
                        bad[0]["Plan"],
                        table,
                        edition_first,
                        lookup=False,
                        edition_prefix="edition_id" in statement,
                    )
                successor_checked = True
        assert controls_checked
        assert successor_checked
    finally:
        source.execute(f"DELETE FROM {table} WHERE edition_id=ANY(%s)", (versions,))
        source.execute(
            "DELETE FROM core.dataset_versions WHERE dataset_version_id=ANY(%s)", (versions,)
        )


def assert_bounded_edition_plan(root, table, edition_first, *, lookup, edition_prefix=True):
    def nodes(node, limited=False, branch=None):
        yield node, limited, branch
        for index, child in enumerate(node.get("Plans", [])):
            child_branch = (
                ("anchor" if index == 0 else "recursive")
                if node["Node Type"] == "Recursive Union"
                else branch
            )
            yield from nodes(child, limited or node["Node Type"] == "Limit", child_branch)

    table_nodes = [
        (n, limited, branch)
        for n, limited, branch in nodes(root)
        if n.get("Relation Name") == table.split(".")[1]
    ]
    assert table_nodes, root
    for node, limited, branch in table_nodes:
        assert node["Node Type"] in {"Index Scan", "Index Only Scan", "Bitmap Heap Scan"}, root
        condition = node.get("Index Cond", "")
        if lookup:
            assert "edition_id" in condition and "=" in condition, root
            if not edition_first:
                assert "provider_id" in condition, root
        elif condition:
            # The recursive successor must advance the entire PK prefix.
            assert ">" in condition, root
            if edition_prefix:
                assert "edition_id" in condition, root
                if not edition_first:
                    assert "provider_id" in condition, root
            else:
                assert "provider_id" in condition, root
        else:
            # Only the legitimate first-key ORDER BY ... LIMIT 1 can be unbound.
            assert limited and branch == "anchor", root
    if lookup and any(n.get("Relation Name") == "dataset_versions" for n, _, _ in nodes(root)):
        registry = [n for n, _, _ in nodes(root) if n.get("Relation Name") == "dataset_versions"]
        assert registry and all(
            "dataset_version_id" in n.get("Index Cond", "") and "=" in n["Index Cond"]
            for n in registry
        ), root


@pytest.mark.parametrize("edition_first", [False, True])
def test_edition_plan_refuses_an_unbounded_recursive_successor(edition_first):
    scan = {"Node Type": "Index Only Scan", "Relation Name": "editions"}
    anchor = {"Node Type": "Limit", "Plans": [scan]}
    successor = {
        "Node Type": "Limit",
        "Plans": [{**scan, "Filter": "edition_id > keys.edition_id"}],
    }
    root = {"Node Type": "Recursive Union", "Plans": [anchor, successor]}
    with pytest.raises(AssertionError):
        assert_bounded_edition_plan(root, "silver.editions", edition_first, lookup=False)
    successor["Plans"][0]["Index Cond"] = (
        "ROW(edition_id, provider_id) > ROW(keys.edition_id, keys.provider_id)"
        if edition_first
        else "ROW(provider_id, edition_id) > ROW(keys.provider_id, keys.edition_id)"
    )
    assert_bounded_edition_plan(root, "silver.editions", edition_first, lookup=False)


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


def test_session_lock_refuses_a_second_migration(source, real_db_engine, history):
    from transit_ops.lake.migration import MigrationRefused, migration_lock

    with psycopg.connect(**guarded_connect_kwargs(real_db_engine.url), autocommit=True) as other:
        with migration_lock(source):
            names, provider = history
            plan(source, names, [provider])
            assert other.execute(
                "SELECT state, backend_xmin FROM pg_stat_activity WHERE pid=%s",
                (source.info.backend_pid,),
            ).fetchone() == ("idle", None)
            with pytest.raises(MigrationRefused, match="migration_running"):
                with migration_lock(other):
                    pytest.fail("second migration acquired the session lock")
        with migration_lock(other):
            assert other.execute("SELECT 1").fetchone() == (1,)


def test_revision_bounds_use_each_declared_revision(source, history, monkeypatch):
    from dataclasses import replace

    names, provider = history
    table = names[0]
    source.execute(f"ALTER TABLE {table} ADD COLUMN revision int NOT NULL DEFAULT 0")
    source.execute(f"ALTER TABLE {table} DROP CONSTRAINT {table.split('.')[1]}_pkey")
    source.execute(f"ALTER TABLE {table} ADD PRIMARY KEY (provider_id, revision, id)")
    source.execute(f"UPDATE {table} SET revision=7 WHERE id=1")
    declared = datasets.get_dataset(table)
    updated = replace(
        declared,
        source=replace(
            declared.source,
            revision_column="revision",
            key_columns=("provider_id", "revision", "id"),
        ),
    )
    declarations = {**datasets.HISTORY_DATASETS, table: updated}
    monkeypatch.setattr(datasets, "HISTORY_DATASETS", declarations)
    monkeypatch.setattr(inventory, "HISTORY_DATASETS", declarations)
    result = plan(source, [table], [provider])
    assert [(w.spec.window_key, w.spec.revision) for w in result.windows] == [
        ("2026-05", 0),
        ("2026-06", 7),
    ]


@pytest.mark.parametrize("edition_first", [False, True])
def test_unregistered_edition_refuses_instead_of_dropping_history(
    source,
    history,
    monkeypatch,
    edition_first,
):
    from dataclasses import replace

    names, provider = history
    if edition_first:
        table = names[1]
        key = ("edition_id", "provider_id", "id")
        source.execute(f"ALTER TABLE {table} DROP CONSTRAINT {table.split('.')[1]}_pkey")
        source.execute(f"ALTER TABLE {table} ADD PRIMARY KEY (edition_id,provider_id,id)")
        declared = datasets.get_dataset(table)
        declarations = {
            **datasets.HISTORY_DATASETS,
            table: replace(declared, source=replace(declared.source, key_columns=key)),
        }
        monkeypatch.setattr(datasets, "HISTORY_DATASETS", declarations)
        monkeypatch.setattr(inventory, "HISTORY_DATASETS", declarations)
    source.execute(f"UPDATE {names[1]} SET edition_id=-1")
    with pytest.raises(MigrationRefused, match="edition_identity") as error:
        plan(source, [names[1]], [provider])
    assert names[1] in str(error.value)
    assert "-1" in str(error.value)


@pytest.mark.parametrize("table_index", [0, 2])
def test_unregistered_provider_refuses_instead_of_dropping_history(source, history, table_index):
    names, provider = history
    unknown = "missing-" + uuid4().hex
    source.execute(f"UPDATE {names[table_index]} SET provider_id=%s", (unknown,))
    with pytest.raises(MigrationRefused, match="unknown_provider") as error:
        plan(source, [names[table_index]], [provider])
    assert names[table_index] in str(error.value)
    assert unknown in str(error.value)


def test_ledger_provider_without_leading_index_refuses(source):
    unknown = "missing-" + uuid4().hex
    source.execute(
        "INSERT INTO core.history_window "
        "(dataset_id,provider_id,window_key,working_state,working_changed_at_utc) "
        "VALUES ('review.dataset',%s,'2026-11','present',now())",
        (unknown,),
    )
    try:
        with pytest.raises(MigrationRefused, match="unknown_provider") as error:
            plan(source, ["core.history_window"])
        assert unknown in str(error.value)
        assert "core.history_window" in str(error.value)
    finally:
        source.execute("DELETE FROM core.history_window WHERE provider_id=%s", (unknown,))
