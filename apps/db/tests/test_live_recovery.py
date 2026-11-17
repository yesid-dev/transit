import json
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from queue import Empty, Queue
from threading import Thread

import pytest
from live_recovery_fixture import apply, record, snapshot
from test_live_local_file import SETTINGS

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live import recovery
from transit_ops.live.local_file import (
    LocalFile,
    LocalFileLocked,
    LocalFileMismatch,
    LocalFileUnreadable,
)
from transit_ops.live.recording import Recorder
from transit_ops.live.segments import export_segment, read_segment


def test_explicit_reopen_cannot_fabricate_missing_state(tmp_path):
    path = tmp_path / "missing.duckdb"
    with pytest.raises(FileNotFoundError):
        with closing(recovery.reopen(path, provider_id="network", settings=SETTINGS)):
            pytest.fail("explicit reopen fabricated an empty worker file")
    assert not path.exists()


def test_initial_creation_refuses_orphan_wal_without_changing_evidence(tmp_path):
    path = tmp_path / "missing.duckdb"
    wal = Path(str(path) + ".wal")
    wal.write_bytes(b"retained orphan evidence")
    with pytest.raises(FileNotFoundError, match="recovery_database_missing_with_wal"):
        recovery.open_worker_file(path, provider_id="network", settings=SETTINGS)
    assert wal.read_bytes() == b"retained orphan evidence"
    assert not path.exists()


def test_reopen_preserves_named_refusals_and_never_closes_borrowed_owner(tmp_path):
    path = tmp_path / "worker.duckdb"
    with closing(
        recovery.open_worker_file(path, provider_id="network", settings=SETTINGS)
    ) as owner:
        with pytest.raises(LocalFileLocked):
            recovery.reopen(path, provider_id="network", settings=SETTINGS)
        assert owner.connection.execute("SELECT provider_id FROM meta").fetchone() == ("network",)
    with pytest.raises(LocalFileMismatch):
        recovery.reopen(path, provider_id="other", settings=SETTINGS)
    with closing(recovery.reopen(path, provider_id="network", settings=SETTINGS)):
        pass


def test_unreadable_original_is_preserved_and_not_called_failed_wal_replay(tmp_path):
    path = tmp_path / "failed.duckdb"
    original = b"unreadable original fixture"
    path.write_bytes(original)
    with pytest.raises(LocalFileUnreadable):
        recovery.reopen(path, provider_id="network", settings=SETTINGS)
    assert path.read_bytes() == original
    assert sorted(p.name for p in tmp_path.iterdir()) == [path.name, path.name + ".owner.lock"]


def killed_fixture(path, stage):
    script = Path(__file__).with_name("live_recovery_fixture.py")
    child = subprocess.Popen(
        [sys.executable, str(script), str(path), stage],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    messages = Queue()
    thread = Thread(target=lambda: messages.put(child.stdout.readline()), daemon=True)
    thread.start()
    try:
        try:
            marker = messages.get(timeout=30)
        except Empty:
            pytest.fail("restart fixture did not reach its bounded handshake")
        assert child.poll() is None, "fixture exited before the parent could kill it"
    finally:
        child.kill()
        # Windows TerminateProcess is asynchronous. Keep stdin open until death;
        # communicate() would otherwise deliver EOF to a still-running fixture.
        child.wait(timeout=30)
        _, errors = child.communicate(timeout=30)
        thread.join(timeout=1)
    assert not thread.is_alive(), errors
    assert marker, errors or "restart fixture exited before its handshake"
    assert not errors, errors
    expected = json.loads(marker)["ready"]
    assert child.returncode != 0, errors
    return expected


@pytest.mark.parametrize("stage", ["precommit", "postcommit", "pending"])
def test_real_process_reopen_keeps_exact_committed_state_and_retry(tmp_path, stage):
    path = tmp_path / "worker.duckdb"
    LocalFile.open(path, provider_id="network", settings=SETTINGS).close()
    expected = killed_fixture(path, stage)
    assert Path(str(path) + ".wal").is_file(), "fixture must exercise actual DuckDB WAL"
    with closing(recovery.reopen(path, provider_id="network", settings=SETTINGS)) as local:
        assert snapshot(local) == expected, "committed evidence lost or uncommitted state recovered"
        recorder = Recorder(local, provider_id="network")
        assert not apply(local, recorder, 42)
        recorder.record(record(42))
        assert snapshot(local) == expected, "identical retry changed committed evidence"
        assert 44 in recorder._due_runs(10), "outstanding coverage obligation disappeared"
        if stage == "pending":
            verify_pending_retry(local, tmp_path)


def verify_pending_retry(local, tmp_path):
    pending = local.connection.execute("SELECT * FROM segment_exports").fetchone()
    assert pending and pending[3] is False
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    recorder = Recorder(local, provider_id="network")
    recorder.record(record(43))
    recovered = export_segment(local, storage)
    assert (recovered.first_seq, recovered.last_seq) == pending[:2]
    manifest = json.loads(pending[2])
    assert recovered.content_sha256 == manifest["content_sha256"]
    frames = read_segment(local, storage, recovered)
    assert frames["captures"].column("capture_row_id") == [42]
    following = export_segment(local, storage)
    assert following.first_seq == recovered.last_seq + 1
    assert export_segment(local, storage) is None
