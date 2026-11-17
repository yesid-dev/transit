import subprocess
import sys
from contextlib import closing
from pathlib import Path
from queue import Empty, Queue
from threading import Thread

import pytest
from test_live_local_file import SETTINGS

from transit_ops.live.local_file import (
    LocalFile,
    LocalFileLocked,
    LocalFileMismatch,
    LocalFileUnreadable,
    PathReservation,
)

CHILD = """
import sys
from pathlib import Path
from transit_ops.live.local_file import PathReservation
with PathReservation(Path(sys.argv[1])):
    print('ready', flush=True)
    sys.stdin.read()
    raise AssertionError('parent must terminate fixture')
"""


def kill_after_ready(command):
    child = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    messages = Queue()
    thread = Thread(target=lambda: messages.put(child.stdout.readline()), daemon=True)
    thread.start()
    try:
        try:
            message = messages.get(timeout=30)
        except Empty:
            pytest.fail("owned fixture did not reach bounded handshake")
        assert child.poll() is None, "fixture exited before parent termination"
        yield message
    finally:
        child.kill()
        child.wait(timeout=30)
        _, errors = child.communicate(timeout=30)
        thread.join(timeout=1)
    assert not errors, errors
    assert not thread.is_alive()


@pytest.mark.parametrize("contents", [None, b"corrupt original"])
def test_process_reservation_blocks_normal_open_before_touching_missing_or_corrupt_db(
    tmp_path, contents
):
    path = tmp_path / "worker.duckdb"
    if contents is not None:
        path.write_bytes(contents)
    from contextlib import contextmanager

    with contextmanager(kill_after_ready)([sys.executable, "-c", CHILD, str(path)]) as message:
        assert message.strip() == "ready"
        with pytest.raises(LocalFileLocked):
            LocalFile.open(path, provider_id="network", settings=SETTINGS)
        assert path.read_bytes() == contents if contents is not None else not path.exists()
        lock_stat = Path(str(path) + ".owner.lock").stat()
    with PathReservation(path):
        assert Path(str(path) + ".owner.lock").stat().st_ino == lock_stat.st_ino
    if contents is None:
        LocalFile.open(path, provider_id="network", settings=SETTINGS).close()
    else:
        with pytest.raises(LocalFileUnreadable):
            LocalFile.open(path, provider_id="network", settings=SETTINGS)
        assert path.read_bytes() == contents


def test_normal_process_owner_blocks_cold_reservation(tmp_path):
    path = tmp_path / "worker.duckdb"
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)):
        result = subprocess.run(
            [sys.executable, "-c", CHILD, str(path)], capture_output=True, text=True, timeout=30
        )
        assert result.returncode != 0
        assert "LocalFileLocked" in result.stderr
        assert "ready" not in result.stdout


def test_alias_and_borrowed_lifetime_remain_exclusive(tmp_path):
    path = tmp_path / "worker.duckdb"
    (tmp_path / "sub").mkdir()
    alias = tmp_path / "sub" / ".." / path.name
    with PathReservation(alias) as reservation:
        assert reservation.path == path.resolve()
        local = LocalFile.open(
            path, provider_id="network", settings=SETTINGS, reservation=reservation
        )
        with pytest.raises(LocalFileLocked, match="borrowed_handle"):
            reservation.close()
        with pytest.raises(LocalFileLocked):
            LocalFile.open(alias, provider_id="network", settings=SETTINGS)
        local.close()
        with pytest.raises(LocalFileLocked):
            PathReservation(path)
        with closing(
            LocalFile.open(alias, provider_id="network", settings=SETTINGS, reservation=reservation)
        ):
            pass
    LocalFile.open(path, provider_id="network", settings=SETTINGS).close()


@pytest.mark.parametrize("failure", ["connect", "initialize"])
def test_failed_open_releases_kernel_and_same_process_reservation(tmp_path, failure):
    path = tmp_path / "worker.duckdb"
    if failure == "connect":
        path.write_bytes(b"bad file")
        error = LocalFileUnreadable
    else:
        LocalFile.open(path, provider_id="network", settings=SETTINGS).close()
        error = LocalFileMismatch
    with pytest.raises(error):
        LocalFile.open(path, provider_id="other", settings=SETTINGS)
    with PathReservation(path):
        pass
    result = subprocess.run(
        [sys.executable, "-c", CHILD.replace("sys.stdin.read()", "sys.exit(0)"), str(path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ready"
