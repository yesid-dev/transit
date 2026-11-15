import hashlib
import json
from functools import partial

import duckdb
import pytest
from test_lake_table_export_real_db import owned as owned
from test_lake_table_export_real_db import source as source
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.table_copy import ServerChanged, copy_table_window

copy = partial(copy_table_window, copied_by="a" * 40, statement_timeout_s=60)


@pytest.fixture
def archive(tmp_path):
    root = tmp_path / "objects"
    root.mkdir()
    return LocalBronzeStorage("local", root)


def run(source, archive, owned, tmp_path, name):
    work = tmp_path / name
    work.mkdir()
    return copy(source, archive, owned, work_dir=work)


def test_copies_a_month_window_and_writes_its_proof_and_schema(source, owned, archive, tmp_path):
    result = run(source, archive, owned, tmp_path, "first")
    assert result.outcome == "copied"
    receipt = json.loads(archive.read_bytes(result.proof_key))
    payload = archive.read_bytes(result.key)
    assert receipt["object_sha256"] == hashlib.sha256(payload).hexdigest()
    assert receipt["object_bytes"] == len(payload)
    expected = b"provider_id,revision,service_date,value\np,2,2026-11-01,old\n"
    assert receipt["content_sha256"] == hashlib.sha256(expected).hexdigest()
    assert receipt["proof"]["verified"] is True
    assert json.loads(archive.read_bytes(receipt["schema_key"]))
    with duckdb.connect() as connection:
        rows = connection.read_parquet(str(archive.root / result.key), hive_partitioning=False)
        assert rows.project("value").fetchall() == [("old",)]
    assert not list((tmp_path / "first").iterdir())


def test_second_run_is_already_copied_and_writes_nothing(source, owned, archive, tmp_path):
    first = run(source, archive, owned, tmp_path, "first")
    before = {key: archive.read_bytes(key) for key in archive.list_keys("archive/")}
    second = run(source, archive, owned, tmp_path, "second")
    assert (second.outcome, second.key) == ("already_copied", first.key)
    assert before == {key: archive.read_bytes(key) for key in archive.list_keys("archive/")}


def test_changed_rows_give_version_two_and_keep_version_one(source, owned, archive, tmp_path):
    first = run(source, archive, owned, tmp_path, "first")
    original = archive.read_bytes(first.key)
    source.execute(f"UPDATE {owned.dataset_id} SET value='new'")
    second = run(source, archive, owned, tmp_path, "second")
    assert second.key.endswith(".c2.s1.parquet")
    assert archive.read_bytes(first.key) == original


def test_new_column_gives_schema_version_two(source, owned, archive, tmp_path):
    run(source, archive, owned, tmp_path, "first")
    source.execute(f"ALTER TABLE {owned.dataset_id} ADD COLUMN extra text")
    result = run(source, archive, owned, tmp_path, "second")
    assert result.key.endswith(".c2.s2.parquet")


def test_rows_changed_between_export_and_recheck_stop_the_copy(
    source, owned, archive, tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "transit_ops.lake.table_copy.recheck_window", lambda *a, **k: ("b" * 64, 0, 0)
    )
    with pytest.raises(ServerChanged):
        run(source, archive, owned, tmp_path, "changed")
    assert not list(archive.list_keys("archive/"))


def test_local_only_writes_no_object(source, owned, archive, tmp_path):
    result = run(source, None, owned, tmp_path, "local")
    assert result.outcome == "local_only"
    assert result.key is None
    assert json.loads((tmp_path / "local/proof.json").read_bytes())["verified"] is True
    assert (tmp_path / "local/window.parquet").is_file()
    assert not list(archive.list_keys("archive/"))


def test_cli_export_table_local_only_prints_one_json_line(source, owned, tmp_path, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    monkeypatch.setattr("psycopg.connect", lambda *a, **k: nullcontext(source))
    monkeypatch.setattr(
        "transit_ops.settings.get_settings",
        lambda: SimpleNamespace(
            DATABASE_URL="postgresql://unused/test", GOLD_REPORTING_OPEN_WINDOW_DAYS=10
        ),
    )
    result = CliRunner().invoke(
        app,
        [
            "lake",
            "export-table",
            "--dataset",
            owned.dataset_id,
            "--provider",
            "p",
            "--window",
            "2026-11",
            "--revision",
            "2",
            "--work-dir",
            str(tmp_path),
            "--copied-by",
            "a" * 40,
            "--statement-timeout-s",
            "60",
        ],
    )
    assert result.exit_code == 0, result.output
    assert len(result.stdout.splitlines()) == 1
    assert json.loads(result.stdout)["outcome"] == "local_only"


@pytest.mark.parametrize("verified", [None, False, "true", 1])
def test_unverified_receipt_never_counts_as_already_copied(tmp_path, verified):
    from transit_ops.lake.archive_keys import proof_key, resolve_copy_version, table_copy_key

    storage = LocalBronzeStorage("local", tmp_path)
    args = ("core.providers", "_shared", 0, "month", "2026-11")
    path = tmp_path / proof_key(table_copy_key(*args, 1, 1))
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"content_sha256": "a" * 64, "proof": {"verified": verified}}))
    result = resolve_copy_version(storage, *args, "a" * 64, schema_version=1)
    assert (result.version, result.key) == (2, None)


def test_cli_refuses_invalid_copied_by_before_connecting(tmp_path):
    result = CliRunner().invoke(
        app,
        [
            "lake",
            "export-table",
            "--dataset",
            "core.providers",
            "--provider",
            "_shared",
            "--window",
            "2026-11",
            "--work-dir",
            str(tmp_path),
            "--copied-by",
            "bad",
            "--statement-timeout-s",
            "60",
        ],
    )
    assert result.exit_code == 1
    assert "copied_by" in result.output


@pytest.fixture
def seeded_export(monkeypatch):
    from transit_ops.lake import table_copy
    from transit_ops.lake.table_export import ExportedWindow, WindowSpec
    from transit_ops.lake.table_schema import TableSchema

    spec = WindowSpec("gold.network_vehicle_day", "network", "2026-11", 2)
    schema = TableSchema.from_columns(
        [
            ("provider_id", "text", True),
            ("revision", "integer", True),
            ("service_date", "date", True),
            ("value", "text", True),
        ],
        ["provider_id", "revision", "service_date"],
    )
    payload = b"provider_id,revision,service_date,value\nnetwork,2,2026-11-01,old\n"
    digest = hashlib.sha256(payload).hexdigest()

    def export(connection, actual_spec, destination, **kwargs):
        with destination.open("xb") as stream:
            stream.write(payload)
        return ExportedWindow(
            actual_spec,
            destination,
            digest,
            len(payload),
            1,
            schema,
            table_copy._copy_start(),
            "test",
        )

    def recheck(connection, actual_spec, *, expected_schema, **kwargs):
        assert expected_schema == schema
        return digest, len(payload), 1

    monkeypatch.setattr("transit_ops.lake.table_copy.export_window", export)
    monkeypatch.setattr("transit_ops.lake.table_copy.recheck_window", recheck)
    return spec


def test_seed_copy_upload_readback_receipt_and_deduplication(seeded_export, archive, tmp_path):
    first = run(None, archive, seeded_export, tmp_path, "first")
    assert first.key.endswith("/2026-11.c1.s1.parquet")
    receipt = json.loads(archive.read_bytes(first.proof_key))
    assert receipt["proof"]["verified"] is True
    assert receipt["source"]["copied_by"] == "a" * 40
    second = run(None, archive, seeded_export, tmp_path, "second")
    assert (second.outcome, second.key) == ("already_copied", first.key)


def test_seed_local_copy_and_unknown_files_are_preserved(seeded_export, tmp_path):
    result = run(None, None, seeded_export, tmp_path, "local")
    assert result.outcome == "local_only"
    work = tmp_path / "local"
    before = {p.name: p.read_bytes() for p in work.iterdir()}
    with pytest.raises(ValueError, match="empty"):
        copy(None, None, seeded_export, work_dir=work)
    assert before == {p.name: p.read_bytes() for p in work.iterdir()}


def test_seed_changed_source_never_publishes(seeded_export, archive, tmp_path, monkeypatch):
    monkeypatch.setattr(
        "transit_ops.lake.table_copy.recheck_window", lambda *a, **k: ("b" * 64, 0, 0)
    )
    with pytest.raises(ServerChanged):
        run(None, archive, seeded_export, tmp_path, "changed")
    assert not list((tmp_path / "changed").iterdir())
    assert not list(archive.list_keys("archive/"))


def test_seed_unverified_proof_never_publishes(seeded_export, archive, tmp_path, monkeypatch):
    from dataclasses import replace

    from transit_ops.lake.parquet_verify import prove_window
    from transit_ops.lake.table_copy import UnverifiedCopy

    monkeypatch.setattr(
        "transit_ops.lake.table_copy.prove_window",
        lambda *a, **k: replace(prove_window(*a, **k), verified=False),
    )
    with pytest.raises(UnverifiedCopy, match="verified"):
        run(None, archive, seeded_export, tmp_path, "unverified")
    assert not list(archive.list_keys("archive/"))


def test_seed_corrupted_readback_has_no_receipt_and_keeps_local_proof(seeded_export, tmp_path):
    from transit_ops.lake.parquet_verify import CopyDiffers

    class CorruptingStorage(LocalBronzeStorage):
        def put_if_absent(self, path, key):
            result = super().put_if_absent(path, key)
            if key.endswith(".parquet"):
                (self.root / key).write_bytes(b"corrupted")
            return result

    storage = CorruptingStorage("local", tmp_path / "objects")
    storage.root.mkdir(exist_ok=True)
    with pytest.raises(CopyDiffers, match="object_digest"):
        run(None, storage, seeded_export, tmp_path, "corrupt")
    assert not any(key.endswith(".proof.json") for key in storage.list_keys("archive/"))
    assert json.loads((tmp_path / "corrupt/proof.json").read_bytes())["verified"] is True


def test_failed_local_publish_removes_only_its_own_files(seeded_export, tmp_path, monkeypatch):
    import os

    link = os.link
    work = tmp_path / "failed"

    def fail(source, destination):
        if destination == work / "window.parquet":
            raise OSError("publish failed")
        return link(source, destination)

    monkeypatch.setattr("transit_ops.lake.table_copy.os.link", fail)
    with pytest.raises(OSError, match="publish failed"):
        run(None, None, seeded_export, tmp_path, "failed")
    assert not list(work.iterdir())


def test_dedup_proof_describes_the_existing_object(seeded_export, tmp_path, monkeypatch):
    from transit_ops.lake import table_copy as tc
    from transit_ops.lake.parquet_codec import ParquetCodec

    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir(exist_ok=True)
    writer = tc.write_window
    # An existing legitimate copy has a different writer encoding.
    with monkeypatch.context() as patch:
        patch.setattr(
            tc, "write_window", lambda *a, **kw: writer(*a, **kw, codec=ParquetCodec(level=1))
        )
        first = run(None, storage, seeded_export, tmp_path, "old_writer")
    archived = storage.read_bytes(first.key)
    assert first.proof.object_sha256 == hashlib.sha256(archived).hexdigest()
    result = run(None, storage, seeded_export, tmp_path, "current_writer")
    assert result.outcome == "already_copied"
    assert result.key == first.key
    assert storage.read_bytes(result.key) == archived
    assert result.proof.object_sha256 == hashlib.sha256(archived).hexdigest(), (
        "already_copied returns the discarded local file's digest, not the existing object's",
        result.proof.object_sha256,
        hashlib.sha256(archived).hexdigest(),
    )
    assert result.proof == first.proof


def test_local_archive_bytes_are_synced_before_evidence_is_deleted(
    seeded_export, tmp_path, monkeypatch
):
    import os

    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir(exist_ok=True)
    synced_inodes = set()
    fsync = os.fsync

    def record(fd):
        synced_inodes.add(os.fstat(fd).st_ino)
        return fsync(fd)

    monkeypatch.setattr(os, "fsync", record)
    result = run(None, storage, seeded_export, tmp_path, "work")
    assert not list((tmp_path / "work").iterdir())
    receipt = json.loads(storage.read_bytes(result.proof_key))
    unsynced = [
        key
        for key in (result.key, result.proof_key, receipt["schema_key"])
        if (storage.root / key).stat().st_ino not in synced_inodes
    ]
    assert not unsynced, ("Evidence deleted with archive files never fsynced", unsynced)


@pytest.mark.parametrize("kind", ["schema", "parquet", "receipt"])
def test_archive_file_sync_failure_keeps_local_evidence(seeded_export, tmp_path, monkeypatch, kind):
    import os

    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir(exist_ok=True)
    fsync = os.fsync

    def fail_archive_sync(fd):
        for path in storage.root.rglob(".transit-bronze-*.tmp"):
            if path.stat().st_ino == os.fstat(fd).st_ino:
                payload = path.read_bytes()
                actual = (
                    "parquet"
                    if payload.startswith(b"PAR1")
                    else "receipt"
                    if json.loads(payload).get("kind") == "table_copy"
                    else "schema"
                )
                if actual == kind:
                    raise OSError("archive file sync failed")
        return fsync(fd)

    monkeypatch.setattr(os, "fsync", fail_archive_sync)
    with pytest.raises(OSError, match="archive file sync failed"):
        run(None, storage, seeded_export, tmp_path, "work")
    assert {p.name for p in (tmp_path / "work").iterdir()} == {
        "window.csv",
        "window.parquet",
        "proof.json",
    }
    assert not any(k.endswith(".proof.json") for k in storage.list_keys("archive/"))
    assert not list(storage.root.rglob(".transit-bronze-*.tmp"))


def test_archive_directories_are_synced_before_local_cleanup(seeded_export, tmp_path, monkeypatch):
    import os
    import stat

    if os.name == "nt":
        pytest.skip("Windows does not support directory fsync")
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir(exist_ok=True)
    synced_directories = set()
    fsync = os.fsync

    def record(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            synced_directories.add(os.fstat(fd).st_ino)
        return fsync(fd)

    monkeypatch.setattr(os, "fsync", record)
    result = run(None, storage, seeded_export, tmp_path, "work")
    receipt = json.loads(storage.read_bytes(result.proof_key))
    for key in (result.key, result.proof_key, receipt["schema_key"]):
        for directory in (storage.root / key).parents:
            assert directory.stat().st_ino in synced_directories
            if directory == storage.root:
                break


def test_archive_directory_sync_failure_keeps_local_evidence(seeded_export, tmp_path, monkeypatch):
    import os
    import stat

    if os.name == "nt":
        pytest.skip("Windows does not support directory fsync")
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir(exist_ok=True)
    fsync = os.fsync

    def fail_archive_directory(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            directories = [storage.root, *storage.root.rglob("*")]
            if any(p.is_dir() and p.stat().st_ino == os.fstat(fd).st_ino for p in directories):
                raise OSError("archive directory sync failed")
        return fsync(fd)

    monkeypatch.setattr(os, "fsync", fail_archive_directory)
    with pytest.raises(OSError, match="archive directory sync failed"):
        run(None, storage, seeded_export, tmp_path, "work")
    assert {p.name for p in (tmp_path / "work").iterdir()} == {
        "window.csv",
        "window.parquet",
        "proof.json",
    }
    assert not list(storage.list_keys("archive/"))


def test_retry_syncs_ancestors_left_by_failed_publication(tmp_path, monkeypatch):
    import os
    from pathlib import Path
    from types import SimpleNamespace

    from transit_ops.ingestion import storage as module

    root = tmp_path / "objects"
    source = tmp_path / "source"
    source.write_bytes(b"archive")
    storage = module.LocalBronzeStorage("local", root)
    storage.root.mkdir(exist_ok=True)
    directories = {}
    synced = set()
    fail_once = True

    def open_directory(path, flags):
        descriptor = -len(directories) - 1
        directories[descriptor] = Path(path)
        return descriptor

    def fsync(descriptor):
        nonlocal fail_once
        if descriptor in directories:
            synced.add(directories[descriptor])
        elif fail_once:
            fail_once = False
            raise OSError("injected archive file sync failure")
        else:
            os.fsync(descriptor)

    # Model only POSIX directory handles; keep real native file I/O and links.
    proxy = SimpleNamespace(
        name="posix",
        O_RDONLY=0,
        O_DIRECTORY=0,
        open=open_directory,
        close=lambda fd: None,
        fsync=fsync,
        link=os.link,
    )
    monkeypatch.setattr(module, "os", proxy)
    with pytest.raises(OSError, match="injected"):
        storage.put_if_absent(source, "archive/nested/object")
    assert source.exists()
    assert (root / "archive/nested").is_dir()
    assert not (root / "archive/nested/object").exists()
    storage.put_if_absent(source, "archive/nested/object")
    assert not source.exists()
    required = {root, root / "archive", root / "archive/nested"}
    assert required == synced, f"Successful retry omitted directory syncs: {required - synced}"


@pytest.mark.parametrize("failure", ["file", "directory"])
def test_native_retry_syncs_existing_archive_ancestors(tmp_path, monkeypatch, failure):
    import os
    import stat

    from transit_ops.ingestion import storage as module

    if os.name == "nt":
        pytest.skip("Windows does not support directory fsync")
    root = tmp_path / "objects"
    source = tmp_path / "source"
    source.write_bytes(b"archive")
    storage = LocalBronzeStorage("local", root)
    storage.root.mkdir(exist_ok=True)
    synced = set()
    fsync = os.fsync
    fail_once = True

    def sync_or_fail(fd):
        nonlocal fail_once
        info = os.fstat(fd)
        directory = stat.S_ISDIR(info.st_mode)
        if fail_once and directory == (failure == "directory"):
            fail_once = False
            raise OSError("injected archive sync failure")
        fsync(fd)
        if directory:
            synced.add((info.st_dev, info.st_ino))

    monkeypatch.setattr(module.os, "fsync", sync_or_fail)
    with pytest.raises(OSError, match="injected"):
        storage.put_if_absent(source, "archive/nested/object")
    assert source.exists()
    assert (root / "archive/nested").is_dir()
    assert not (root / "archive/nested/object").exists()
    synced.clear()
    storage.put_if_absent(source, "archive/nested/object")
    assert not source.exists()
    assert storage.read_bytes("archive/nested/object") == b"archive"
    for path in (root, root / "archive", root / "archive/nested"):
        info = path.stat()
        assert (info.st_dev, info.st_ino) in synced


@pytest.fixture
def boundary_synced(monkeypatch):
    """Model directory handles only; file and link operations remain native."""
    import os
    from pathlib import Path
    from types import SimpleNamespace

    from transit_ops.ingestion import storage as module

    handles, paths = {}, set()

    def open_dir(path, flags):
        fd = -len(handles) - 1
        handles[fd] = Path(path).absolute()
        return fd

    def sync(fd):
        if fd in handles:
            paths.add(handles[fd])
        else:
            os.fsync(fd)

    monkeypatch.setattr(
        module,
        "os",
        SimpleNamespace(
            name="posix",
            O_RDONLY=0,
            O_DIRECTORY=0,
            open=open_dir,
            close=lambda fd: None,
            fsync=sync,
            link=os.link,
        ),
    )
    return paths


def test_missing_root_is_refused_without_creating_ancestors(tmp_path, boundary_synced):
    root = tmp_path / "new-parent" / "objects"
    source = tmp_path / "source"
    source.write_bytes(b"archive")
    store = LocalBronzeStorage("local", root)
    with pytest.raises(ValueError, match="archive_root_missing"):
        store.put_if_absent(source, "archive/object")
    assert source.read_bytes() == b"archive"
    assert set(tmp_path.iterdir()) == {source}
    assert not boundary_synced


@pytest.mark.parametrize(
    "key",
    [
        "absolute",
        "../outside/object",
        "a/../../outside",
        "a/../object",
        "",
        ".",
        "a/..\\outside",
    ],
)
def test_escaping_destination_is_refused_without_mutation(tmp_path, boundary_synced, key):
    root = tmp_path / "inside" / "objects"
    root.mkdir(parents=True)
    source = tmp_path / "source"
    source.write_bytes(b"archive")
    store = LocalBronzeStorage("local", root)
    destination = str(tmp_path / "outside/object") if key == "absolute" else key
    before = set(tmp_path.rglob("*"))
    with pytest.raises(ValueError, match="invalid_archive_destination"):
        store.put_if_absent(source, destination)
    assert set(tmp_path.rglob("*")) == before
    assert source.read_bytes() == b"archive"
    assert not boundary_synced


def test_relative_root_syncs_only_the_provisioned_root(tmp_path, monkeypatch, boundary_synced):
    from pathlib import Path

    (tmp_path / "objects").mkdir()
    monkeypatch.chdir(tmp_path)
    source = tmp_path / "source"
    source.write_bytes(b"archive")
    store = LocalBronzeStorage("local", Path("objects"))
    store.put_if_absent(source, "archive/object")
    assert store.read_bytes("archive/object") == b"archive"
    assert boundary_synced == {tmp_path / "objects", tmp_path / "objects/archive"}


def test_symlink_destination_outside_root_is_refused(tmp_path, boundary_synced):
    root, outside = tmp_path / "objects", tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    try:
        (root / "escape").symlink_to(outside, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"Native symlink unavailable: {error}")
    source = tmp_path / "source"
    source.write_bytes(b"archive")
    with pytest.raises(ValueError, match="invalid_archive_destination"):
        LocalBronzeStorage("local", root).put_if_absent(source, "escape/object")
    assert source.read_bytes() == b"archive"
    assert not list(outside.iterdir())
    assert not boundary_synced
