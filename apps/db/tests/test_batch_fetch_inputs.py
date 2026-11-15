import hashlib
import json
import os
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from transit_ops.batch.build import BuildRequest, InputNeed
from transit_ops.batch.engine import InputRefused
from transit_ops.batch.fetch_inputs import InputDigestMismatch, fetch_inputs
from transit_ops.batch.inputs import resolve_inputs
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.parquet_verify import Expected, prove_window
from transit_ops.lake.table_schema import TableSchema


@pytest.fixture
def archive(tmp_path):
    root = tmp_path / "archive"
    root.mkdir()
    storage = LocalBronzeStorage("local", root)
    csv = tmp_path / "window.csv"
    csv.write_bytes(b"id,value\n1,hello\n")
    schema = TableSchema.from_columns([("id", "integer", True), ("value", "text", False)], ["id"])
    written = write_window(csv, schema, tmp_path / "window.parquet", metadata={}, temp_dir=tmp_path)
    proof = prove_window(
        csv,
        written.path,
        schema,
        expect=Expected(hashlib.sha256(csv.read_bytes()).hexdigest(), 1, written.sha256),
        temp_dir=tmp_path,
    )
    payload = written.path.read_bytes()
    key = "rescue/v1/parquet/window.parquet"
    storage.put_if_absent(written.path, key)
    receipt = dict(
        key=key,
        object_sha256=proof.object_sha256,
        object_bytes=proof.object_bytes,
        proof=asdict(proof),
    )
    return storage, key, payload, receipt


def fetch(archive, root, needs=None):
    storage, key, _, receipt = archive
    return fetch_inputs(
        needs or (InputNeed("gold.fact_vehicle_snapshot", "2026-11-12"),),
        storage,
        root,
        key_for=lambda _: key,
        expected_sha256=lambda _: receipt["object_sha256"],
        receipt_for=lambda _: receipt,
    )


def test_fetches_verified_bytes_at_layout_paths_and_resumes_without_storage(archive, tmp_path):
    root = tmp_path / "inputs"
    needs = (
        InputNeed("gold.fact_vehicle_snapshot", "2026-11-12"),
        InputNeed("silver.trips", "edition:7"),
        InputNeed("gold.example", "local:2026-11-12"),
    )
    receipts = fetch(archive, root, needs)
    paths = [
        root / "gold.fact_vehicle_snapshot/2026-11-12.parquet",
        root / "silver.trips/edition=7.parquet",
        root / "gold.example/local=2026-11-12.parquet",
    ]
    assert [r.path for r in receipts] == paths
    assert all(p.read_bytes() == archive[2] for p in paths)
    assert all(r.sha256 == hashlib.sha256(archive[2]).hexdigest() for r in receipts)
    assert all(r.byte_size == len(archive[2]) and not r.reused for r in receipts)
    assert {item.relation for item in resolve_inputs(needs, root)} == {n.relation for n in needs}
    before = [p.stat().st_mtime_ns for p in paths]
    archive[0].delete_object(archive[1])
    assert all(r.reused for r in fetch(archive, root, needs))
    assert [p.stat().st_mtime_ns for p in paths] == before


def test_wrong_download_digest_leaves_no_final_or_partial(archive, tmp_path):
    storage, key, _, _ = archive
    (storage.root / key).write_bytes(b"corrupt")
    root = tmp_path / "inputs"
    with pytest.raises(InputDigestMismatch, match="gold.fact_vehicle_snapshot"):
        fetch(archive, root)
    assert not list(root.rglob("*.parquet"))
    assert not list(root.rglob(".fetch-*"))


def test_existing_wrong_bytes_are_preserved(archive, tmp_path):
    root = tmp_path / "inputs"
    path = root / "gold.fact_vehicle_snapshot/2026-11-12.parquet"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"existing")
    with pytest.raises(InputDigestMismatch):
        fetch(archive, root)
    assert path.read_bytes() == b"existing"


@pytest.mark.parametrize("race", [False, True])
def test_stream_failure_or_racing_writer_never_exposes_partial_bytes(archive, tmp_path, race):
    storage, key, payload, receipt = archive
    root = tmp_path / "inputs"
    path = root / "gold.fact_vehicle_snapshot/2026-11-12.parquet"

    class InterruptedStorage(LocalBronzeStorage):
        @contextmanager
        def open_stream(self, storage_path, *, byte_range=None):
            assert storage_path == key
            assert not path.exists()
            with super().open_stream(storage_path) as source:
                if race:
                    path.write_bytes(b"racing writer")
                    yield source
                else:
                    yield SimpleNamespace(read=self.fail)

        def fail(self, size):
            raise OSError("stream interrupted")

    fault_archive = InterruptedStorage("local", storage.root), key, payload, receipt
    with pytest.raises(InputDigestMismatch if race else OSError):
        fetch(fault_archive, root)
    assert path.read_bytes() == b"racing writer" if race else not path.exists()
    assert not list(root.rglob(".fetch-*"))


@pytest.mark.parametrize("fault", ["unverified", "missing", "truthy", "key", "digest", "size"])
def test_refuses_inconsistent_or_unverified_receipts_before_writing(archive, tmp_path, fault):
    receipt = archive[3]
    if fault == "unverified":
        receipt["proof"]["verified"] = False
    elif fault == "missing":
        del receipt["proof"]["verified"]
    elif fault == "truthy":
        receipt["proof"]["verified"] = 1
    elif fault == "key":
        receipt["key"] = "other.parquet"
    elif fault == "digest":
        receipt["proof"]["object_sha256"] = "0" * 64
    else:
        receipt["object_bytes"] += 1
    root = tmp_path / "inputs"
    with pytest.raises(ValueError, match="receipt"):
        fetch(archive, root)
    assert not root.exists()


def test_replay_needs_are_the_literal_sorted_union_of_families_and_inventory():
    from transit_ops.batch.fetch_inputs import needs_for_replay

    request = BuildRequest(
        "example", (date(2026, 11, 12),), datetime(2026, 11, 14, tzinfo=UTC), 14, 3, "UTC"
    )
    observed = []

    def first(req):
        observed.append(req)
        return (
            InputNeed("silver.trips", "edition:7"),
            InputNeed("gold.fact_vehicle_snapshot", "2026-11-12"),
        )

    def second(req):
        observed.append(req)
        return (InputNeed("core.providers", "all"), InputNeed("silver.trips", "edition:7"))

    result = needs_for_replay(
        (SimpleNamespace(inputs=first), SimpleNamespace(inputs=second)),
        request,
        postgres_needs=(InputNeed("silver.trips", "edition:8"), InputNeed("core.providers", "all")),
    )
    assert result == (
        InputNeed("core.providers", "all"),
        InputNeed("gold.fact_vehicle_snapshot", "2026-11-12"),
        InputNeed("silver.trips", "edition:7"),
        InputNeed("silver.trips", "edition:8"),
    )
    assert observed == [request, request]


def test_existing_same_size_mutation_during_hash_is_refused(archive, tmp_path, monkeypatch):
    root = tmp_path / "inputs"
    path = fetch(archive, root)[0].path
    csv = tmp_path / "replacement.csv"
    csv.write_bytes(b"id,value\n1,world\n")
    schema = TableSchema.from_columns([("id", "integer", True), ("value", "text", False)], ["id"])
    replacement = write_window(
        csv, schema, tmp_path / "replacement.parquet", metadata={}, temp_dir=tmp_path
    ).path.read_bytes()
    assert len(replacement) == len(archive[2]) and replacement != archive[2]
    original_open = Path.open
    mutated = []

    class RacingReader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def readinto(self, buffer):
            count = self.stream.readinto(buffer)
            if count and not mutated:
                with original_open(path, "wb") as writer:
                    writer.write(replacement)
                mutated.append(True)
            return count

    def racing_open(self, mode="r", *args, **kwargs):
        stream = original_open(self, mode, *args, **kwargs)
        return RacingReader(stream) if self == path and mode == "rb" else stream

    monkeypatch.setattr(Path, "open", racing_open)
    with pytest.raises(InputRefused, match="changed.*gold.fact_vehicle_snapshot"):
        fetch(archive, root)
    assert mutated


def test_matching_writer_resumes_before_publisher_cleanup(archive, tmp_path, monkeypatch):
    root = tmp_path / "inputs"
    real_link = os.link
    outcomes = []

    def link_and_interleave(source, target):
        real_link(source, target)
        outcomes.extend(fetch(archive, root))

    monkeypatch.setattr(os, "link", link_and_interleave)
    outer = fetch(archive, root)
    assert outer[0].path.read_bytes() == archive[2]
    assert outcomes[0].reused
    assert outer[0].path.stat().st_nlink == 1


def test_hard_exit_after_publish_remains_resumable(archive, tmp_path):
    storage, _, payload, receipt = archive
    root = tmp_path / "inputs"
    receipt_file = tmp_path / "receipt.json"
    receipt_file.write_text(json.dumps(receipt), encoding="utf-8")
    child_code = """
import json, os, sys
from pathlib import Path
from transit_ops.batch.build import InputNeed
from transit_ops.batch.fetch_inputs import fetch_inputs
from transit_ops.ingestion.storage import LocalBronzeStorage
archive_root, inputs_root, receipt_file = map(Path, sys.argv[1:])
r = json.loads(receipt_file.read_text(encoding='utf-8'))
real_link = os.link
def publish_then_exit(source, destination):
    real_link(source, destination)
    os._exit(97)
os.link = publish_then_exit
fetch_inputs(
    (InputNeed('gold.fact_vehicle_snapshot', '2026-11-12'),),
    LocalBronzeStorage('local', archive_root), inputs_root,
    key_for=lambda _: r['key'], expected_sha256=lambda _: r['object_sha256'],
    receipt_for=lambda _: r,
)
"""
    child = subprocess.run(
        [sys.executable, "-c", child_code, str(storage.root), str(root), str(receipt_file)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert child.returncode == 97, child.stderr
    path = root / "gold.fact_vehicle_snapshot/2026-11-12.parquet"
    assert path.read_bytes() == payload and path.stat().st_nlink == 2
    assert list(root.rglob(".fetch-*/input.parquet"))
    storage.delete_object(receipt["key"])
    resumed = fetch(archive, root)[0]
    assert resumed.reused and resumed.sha256 == hashlib.sha256(payload).hexdigest()
    assert path.stat().st_nlink == 1


@pytest.mark.parametrize("alias_kind", ["foreign", "different", "three_links"])
def test_unowned_or_ambiguous_links_stay_refused(archive, tmp_path, alias_kind):
    root = tmp_path / "inputs"
    path = fetch(archive, root)[0].path
    alias = path.parent / (".foreign" if alias_kind == "foreign" else ".fetch-orphan")
    alias.mkdir()
    temporary = alias / "input.parquet"
    os.link(path, tmp_path / "foreign.parquet" if alias_kind == "different" else temporary)
    if alias_kind == "different":
        temporary.write_bytes(archive[2])
    elif alias_kind == "three_links":
        os.link(path, tmp_path / "third.parquet")
    with pytest.raises(InputRefused, match="multiply-linked"):
        fetch(archive, root)
    assert path.read_bytes() == archive[2]
    assert temporary.exists() or alias_kind == "foreign"
