import hashlib
from datetime import date

import pytest
from test_batch_checkpoints import DAY, result

from transit_ops.batch.checkpoints import CheckpointStore
from transit_ops.batch.shadow import ShadowRefused, shadow_key, write_shadow
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.objects import ObjectKeyTaken


def test_shadow_create_only_and_conflict(tmp_path):
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(result(), DAY)
    tables = write_tables(tmp_path / "tables")
    original = (tables / "gold.sample.parquet").read_bytes()
    root = tmp_path / "objects"
    root.mkdir()
    storage = LocalBronzeStorage("local", root)
    receipt = write_shadow(checkpoint, storage, tables_dir=tables)
    prefix = f"shadow/v1/sample_family/sample/2026-11-12/{checkpoint.build_id}/"
    assert {item.key.removeprefix(prefix) for item in receipt.objects} == {
        "manifest.json",
        "outputs.json",
        "bodies/v2/body.json",
        "tables/gold.sample.parquet",
    }
    for item in receipt.objects:
        body = storage.read_bytes(item.key)
        assert (item.size, item.sha256) == (len(body), hashlib.sha256(body).hexdigest())
    before = {p: p.stat().st_mtime_ns for p in root.rglob("*")}
    assert write_shadow(checkpoint, storage, tables_dir=tables) == receipt
    assert {p: p.stat().st_mtime_ns for p in root.rglob("*")} == before
    (tables / "gold.sample.parquet").unlink()
    write_tables(tables, compression="zstd")
    with pytest.raises(ObjectKeyTaken):
        write_shadow(checkpoint, storage, tables_dir=tables)
    assert storage.read_bytes(prefix + "tables/gold.sample.parquet") == original
    assert (checkpoint.path / "manifest.json").is_file()


@pytest.mark.parametrize(
    "family,provider,name",
    [
        ("../bad", "sample", "manifest.json"),
        ("sample", "Sample", "manifest.json"),
        ("sample", "sample", "../outside"),
        ("sample", "sample", "public/v2.json"),
    ],
)
def test_shadow_refuses_unsafe_keys(family, provider, name):
    with pytest.raises(ShadowRefused):
        shadow_key(family, provider, date(2026, 11, 12), "a" * 64, name)


def test_shadow_exports_typed_empty_tables_before_session_closes(tmp_path):
    import duckdb

    from transit_ops.batch.build import FamilyOutput, TableRows
    from transit_ops.batch.run import run_family
    from transit_ops.batch.shadow import ShadowBuilder
    from transit_ops.sql_registry import named_query

    class Builder:
        family_id = "sample_family"
        tables = ("gold.sample",)
        published_keys = ()
        variants = {}

        def inputs(self, request):
            return ()

        def build(self, session, request):
            session.execute(named_query("test.shadow.schema", "CREATE SCHEMA gold"))
            session.execute(
                named_query(
                    "test.shadow.table",
                    "CREATE TABLE gold.sample (id INTEGER, value DECIMAL(12,4))",
                )
            )
            return FamilyOutput(
                {"gold.sample": TableRows("gold.sample", ("id", "value"), ("id",), ())}, {}
            )

    tables = tmp_path / "tables"
    tables.mkdir()
    exporter = ShadowBuilder(Builder(), tables)
    run_family(
        exporter, result().manifest, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
    )
    with duckdb.connect() as conn:
        relation = conn.read_parquet(str(tables / "gold.sample.parquet"))
        assert [str(t) for t in relation.types] == ["INTEGER", "DECIMAL(12,4)"]
        assert relation.fetchall() == []


def write_tables(root, value="1.50", compression="snappy"):
    import duckdb

    root.mkdir(exist_ok=True)
    path = root / "gold.sample.parquet"
    with duckdb.connect() as conn:
        conn.execute("CREATE TABLE t(id INTEGER, value DECIMAL(12,2))")
        conn.execute("INSERT INTO t VALUES (1, ?)", [value])
        conn.execute(f"COPY t TO ? (FORMAT PARQUET, COMPRESSION {compression})", [str(path)])
    return root


@pytest.mark.parametrize("damage", ["body", "table"])
def test_shadow_must_refuse_files_that_disagree_with_checkpoint(tmp_path, damage):
    from test_batch_checkpoints import replay

    from transit_ops.batch.checkpoints import accept

    build = result()
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    accept(checkpoint, replay(build))
    tables = write_tables(tmp_path / "tables", "9.99" if damage == "table" else "1.50")
    if damage == "body":
        (checkpoint.path / "bodies/v2/body.json").write_bytes(b'{"changed":true}')
    root = tmp_path / "objects"
    root.mkdir()
    with pytest.raises(ShadowRefused):
        write_shadow(checkpoint, LocalBronzeStorage("local", root), tables_dir=tables)
    assert not list(root.rglob("accepted.json"))


def test_shadow_checks_acceptance_metadata_before_upload(tmp_path):
    import json

    from test_batch_checkpoints import replay

    from transit_ops.batch.checkpoints import accept

    build = result()
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    accept(checkpoint, replay(build))
    path = checkpoint.path / "accepted.json"
    data = json.loads(path.read_bytes())
    data["build_id"] = "b" * 64
    path.write_text(json.dumps(data))
    tables = write_tables(tmp_path / "tables")
    root = tmp_path / "objects"
    root.mkdir()
    with pytest.raises(ShadowRefused, match="acceptance"):
        write_shadow(checkpoint, LocalBronzeStorage("local", root), tables_dir=tables)
    assert list(root.iterdir()) == []


def test_shadow_uploads_the_validated_private_copies(tmp_path):
    from test_batch_checkpoints import replay

    from transit_ops.batch.checkpoints import accept

    build = result()
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    accept(checkpoint, replay(build))
    original_acceptance = (checkpoint.path / "accepted.json").read_bytes()
    tables = write_tables(tmp_path / "tables")
    original_table = (tables / "gold.sample.parquet").read_bytes()
    root = tmp_path / "objects"
    root.mkdir()

    class MutatingStorage(LocalBronzeStorage):
        def put_if_absent(self, path, key):
            outcome = super().put_if_absent(path, key)
            (checkpoint.path / "bodies/v2/body.json").write_bytes(b"changed")
            (tables / "gold.sample.parquet").write_bytes(b"changed")
            (checkpoint.path / "accepted.json").write_bytes(b"changed")
            return outcome

    storage = MutatingStorage("local", root)
    receipt = write_shadow(checkpoint, storage, tables_dir=tables)
    for item in receipt.objects:
        expected = (
            original_acceptance
            if item.key.endswith("/accepted.json")
            else original_table
            if item.key.endswith(".parquet")
            else None
        )
        if expected is not None:
            assert storage.read_bytes(item.key) == expected
    body = next(item.key for item in receipt.objects if "/bodies/" in item.key)
    assert storage.read_bytes(body) == b"{}"


def test_shadow_export_handles_empty_then_exact_text_rows(tmp_path):
    import duckdb

    from transit_ops.batch.build import FamilyOutput, TableRows
    from transit_ops.batch.run import run_family
    from transit_ops.batch.shadow import ShadowBuilder
    from transit_ops.sql_registry import named_query

    class Builder:
        family_id = "sample_family"
        tables = ("gold.text_sample",)
        published_keys = ()
        variants = {}

        def inputs(self, request):
            return ()

        def build(self, session, request):
            session.execute(named_query("test.shadow.text_schema", "CREATE SCHEMA gold"))
            session.execute(
                named_query(
                    "test.shadow.text_table",
                    "CREATE TABLE gold.text_sample(id INTEGER, value DECIMAL(12,2))",
                )
            )
            if populated:
                session.execute(
                    named_query(
                        "test.shadow.text_insert", "INSERT INTO gold.text_sample VALUES (1, 1.50)"
                    )
                )
            rows = session.execute(
                named_query(
                    "test.shadow.text_read",
                    "SELECT id, value::TEXT AS value FROM gold.text_sample ORDER BY id",
                )
            )
            return FamilyOutput(
                {
                    "gold.text_sample": TableRows(
                        "gold.text_sample", rows.columns, ("id",), tuple(map(tuple, rows))
                    )
                },
                {},
            )

    for populated in (False, True):
        tables = tmp_path / str(populated)
        tables.mkdir()
        run_family(
            ShadowBuilder(Builder(), tables),
            result().manifest,
            inputs_root=tmp_path,
            workdir=tmp_path,
            code_commit="a" * 40,
        )
        with duckdb.connect() as conn:
            rows = conn.read_parquet(str(tables / "gold.text_sample.parquet")).fetchall()
            assert rows == ([(1, "1.50")] if populated else [])
