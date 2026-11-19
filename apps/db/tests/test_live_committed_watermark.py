"""A real restart verifies committed rows against the worker's durable watermark (ruling 12)."""

import logging
import shutil
import subprocess
import sys
from contextlib import closing
from dataclasses import replace
from pathlib import Path

import pytest
from live_watermark_probe_fixture import CYCLE, DEATH
from test_live_identity import write_seed_and_floors
from test_live_local_file import SETTINGS
from test_live_recording import MANIFEST, RECORD, configured

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live import admission, watermark
from transit_ops.live.admission import (
    DATABASE_VANISHED,
    DURABLE_WATERMARK,
    WORKER_REOPEN_POINT,
    classify_restart,
    read_restart_records,
    restart_evidence_path,
)
from transit_ops.live.identity import IdentityAllocator, verify_identity_floors
from transit_ops.live.local_file import LocalFile
from transit_ops.live.recording import Recorder
from transit_ops.live.recovery import open_worker_file
from transit_ops.live.segments import export_segment
from transit_ops.live.watermark import (
    committed_watermark_path,
    invalid_marker_path,
    verify_committed,
    write_committed_watermark,
)
from transit_ops.live.worker_state import worker_state_scope
from transit_ops.static.alert_state import seed_alert_state


def run_until_death(path, stage):
    script = Path(__file__).with_name("live_watermark_probe_fixture.py")
    child = subprocess.run(
        [sys.executable, str(script), str(path), stage],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert child.returncode == DEATH, (
        f"exit {child.returncode}\nstdout:\n{child.stdout}\nstderr:\n{child.stderr}"
    )


def worker_reopen(path):
    """The worker loop's own reopen; returns its one restart record."""
    evidence = restart_evidence_path(path)
    open_worker_file(
        path, provider_id="network", settings=SETTINGS, restart_evidence=evidence
    ).close()
    (record,) = read_restart_records(evidence.read_text(encoding="utf-8").splitlines())
    assert (record.point, record.reopened, record.refusal) == (WORKER_REOPEN_POINT, True, None)
    return record


@pytest.mark.parametrize("stage", ["unmarked", "marked"])
def test_a_worker_killed_before_or_after_its_watermark_write_is_verified_recovered(tmp_path, stage):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "first")
    run_until_death(path, stage)

    record = worker_reopen(path)
    assert (record.verified_by, record.committed_rows_lost) == (DURABLE_WATERMARK, 0)
    assert classify_restart(record, 20) == "recovered"


def test_a_file_restored_behind_its_watermark_lost_committed_rows(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "first")
    older = tmp_path / "older"
    older.mkdir()
    traces = (path, Path(str(path) + ".wal"))
    for trace in traces:
        if trace.exists():
            shutil.copy2(trace, older / trace.name)
    run_until_death(path, "marked")
    for trace in traces:  # Exactly the older copy: its file and WAL, or no WAL.
        trace.unlink(missing_ok=True)
        if (older / trace.name).exists():
            shutil.copy2(older / trace.name, trace)

    record = worker_reopen(path)
    assert record.verified_by == DURABLE_WATERMARK
    assert record.committed_rows_lost is not None and record.committed_rows_lost > 0
    assert classify_restart(record, 20) == "lost_committed_row"


@pytest.mark.parametrize(
    ("damage", "name"),
    [
        (lambda p: p.unlink(), "missing"),
        (lambda p: p.write_bytes(p.read_bytes()[:-9]), "torn"),
        (lambda p: p.write_bytes(p.read_bytes().replace(b"network", b"other")), "provider"),
        (lambda p: p.write_bytes(p.read_bytes().replace(b'"format": 3', b'"format": 2')), "format"),
    ],
)
def test_a_reopen_without_a_sound_watermark_is_unmeasured_never_a_pass(
    tmp_path, caplog, damage, name
):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "first")
    damage(committed_watermark_path(path))

    with caplog.at_level(logging.WARNING, logger="transit_ops.live.watermark"):
        record = worker_reopen(path)
    assert (record.verified_by, record.committed_rows_lost) == (None, None)
    assert classify_restart(record, 20) == "measurement_unavailable"
    assert f"live_committed_watermark_unavailable:{name}" in caplog.text


def test_a_failed_watermark_write_is_logged_and_leaves_the_gap_unmeasured(
    tmp_path, monkeypatch, caplog
):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "first")
    run_until_death(path, "unmarked")

    def refuse(*args):
        raise PermissionError("held by a scanner")

    with closing(open_worker_file(path, provider_id="network", settings=SETTINGS)) as local:
        monkeypatch.setattr(watermark.os, "replace", refuse)
        with caplog.at_level(logging.ERROR, logger="transit_ops.live.watermark"):
            written = write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
    monkeypatch.undo()
    assert not written
    assert "live_committed_watermark_unwritable:PermissionError" in caplog.text
    # The previous watermark no longer witnesses this cycle's commits, so it is gone.
    assert not committed_watermark_path(path).exists()
    assert classify_restart(worker_reopen(path), 20) == "measurement_unavailable"


def test_a_watermark_held_open_by_another_process_is_invalidated_not_trusted(
    tmp_path, monkeypatch, caplog
):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "first")
    run_until_death(path, "unmarked")
    held = committed_watermark_path(path)
    unlink = Path.unlink

    def refuse_replace(*args):
        raise PermissionError("sharing violation")

    def refuse_held(self, missing_ok=False):
        if self == held:  # Windows refuses both while another process holds it open.
            raise PermissionError("sharing violation")
        return unlink(self, missing_ok=missing_ok)

    with closing(open_worker_file(path, provider_id="network", settings=SETTINGS)) as local:
        monkeypatch.setattr(watermark.os, "replace", refuse_replace)
        monkeypatch.setattr(Path, "unlink", refuse_held)
        assert not write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
        monkeypatch.undo()
    assert held.is_file()  # The stale watermark survived, but the marker overrules it.
    with caplog.at_level(logging.WARNING, logger="transit_ops.live.watermark"):
        assert classify_restart(worker_reopen(path), 20) == "measurement_unavailable"
    assert "live_committed_watermark_unavailable:invalidated" in caplog.text

    # Only a later successful write witnesses the file again and clears the marker.
    with closing(open_worker_file(path, provider_id="network", settings=SETTINGS)) as local:
        assert write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
    assert not invalid_marker_path(path).exists()
    path.with_name(path.name + ".restarts.jsonl").unlink()
    assert classify_restart(worker_reopen(path), 20) == "recovered"


@pytest.mark.parametrize(
    "lose",
    [
        "UPDATE segment_exports SET completed=false",
        "DELETE FROM segment_exports",
        "UPDATE recording_coverage SET terminal_recorded=false",
        "UPDATE recording_cursor SET covered_through=NULL",
        "UPDATE local_applications SET status='ready'",
    ],
)
def test_losing_the_cycles_last_flag_or_export_commit_is_lost_committed_row(tmp_path, lose):
    path = tmp_path / "segments.duckdb"
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id="network")
        recorder.initialize(initial_run_id=0, seed_sha256="a" * 64)
        recorder.record(replace(RECORD, processing=()))
        local.connection.execute("INSERT INTO recording_coverage VALUES (7, true)")
        local.connection.execute("UPDATE recording_cursor SET covered_through=7")
        local.connection.execute("INSERT INTO local_applications VALUES ('feed', 1, 'failed', 'x')")
        assert export_segment(local, storage) is not None  # Ends with completed=true.
        assert write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
        assert verify_committed(path, local, provider_id="network") == 0
        local.connection.execute(lose)  # The WAL tail that held this commit is gone.
        assert verify_committed(path, local, provider_id="network") >= 1


def test_a_removed_files_watermark_records_its_loss_once_and_never_witnesses_the_new_file(
    tmp_path,
):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "first")
    run_until_death(path, "marked")
    stale = committed_watermark_path(path).read_bytes()
    for trace in (path, Path(str(path) + ".wal")):
        trace.unlink(missing_ok=True)
    # Live ruling 26a: the worker loop records the loss, then recreates the removed file.
    (record,) = vanished_reopen(path)
    assert classify_restart(record, 20) == "lost_committed_row"
    assert invalid_marker_path(path).exists() and not committed_watermark_path(path).exists()
    committed_watermark_path(path).write_bytes(stale)  # Even if it came back.
    restart_evidence_path(path).unlink()
    assert classify_restart(worker_reopen(path), 20) == "measurement_unavailable"


def committed_file(path):
    """A worker file with one committed recorder state and its sound watermark."""
    with closing(open_worker_file(path, provider_id="network", settings=SETTINGS)) as local:
        Recorder(local, provider_id="network").initialize(initial_run_id=0, seed_sha256="a" * 64)
        assert write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
    Path(str(path) + ".wal").unlink(missing_ok=True)


def vanished_reopen(path):
    """The worker loop's reopen of a removed file; returns every restart record."""
    evidence = restart_evidence_path(path)
    open_worker_file(
        path, provider_id="network", settings=SETTINGS, restart_evidence=evidence
    ).close()
    return read_restart_records(evidence.read_text(encoding="utf-8").splitlines())


def test_a_vanished_file_under_a_sound_watermark_is_a_loss_recorded_before_recreation(
    tmp_path, monkeypatch
):
    path = tmp_path / "provider-network.duckdb"
    committed_file(path)
    path.unlink()
    append = admission.append_restart_record

    def append_before_recreation(evidence, observation):
        assert not path.exists()  # Recorded before the worker recreates its file...
        assert committed_watermark_path(path).is_file()  # ...and invalidates the watermark.
        assert not invalid_marker_path(path).exists()
        append(evidence, observation)

    monkeypatch.setattr(admission, "append_restart_record", append_before_recreation)
    (record,) = vanished_reopen(path)
    assert (record.point, record.reopened, record.wal_present) == (
        WORKER_REOPEN_POINT,
        False,
        False,
    )
    assert record.refusal == DATABASE_VANISHED
    assert record.verified_by == DURABLE_WATERMARK
    assert record.committed_rows_lost is not None and record.committed_rows_lost >= 1
    assert classify_restart(record, 20) == "lost_committed_row"
    assert path.is_file() and invalid_marker_path(path).exists()
    assert not committed_watermark_path(path).exists()


@pytest.mark.parametrize(
    "unsound",
    [
        lambda p: committed_watermark_path(p).unlink(),
        lambda p: invalid_marker_path(p).write_bytes(b""),
        lambda p: committed_watermark_path(p).write_bytes(b'{"format": 3'),
        lambda p: committed_watermark_path(p).write_bytes(
            committed_watermark_path(p).read_bytes().replace(b"network", b"other")
        ),
        lambda p: committed_watermark_path(p).write_bytes(
            committed_watermark_path(p).read_bytes().replace(b'"format": 3', b'"format": 2')
        ),
    ],
    ids=["no-watermark", "invalid-marker", "torn", "other-provider", "older-format"],
)
def test_a_vanished_file_without_a_sound_watermark_stays_unmeasured(tmp_path, unsound):
    path = tmp_path / "provider-network.duckdb"
    committed_file(path)
    worker_reopen(path)  # An earlier restart: its record is the only trace once both go.
    path.unlink()
    unsound(path)

    first, record = vanished_reopen(path)
    assert classify_restart(first, 20) == "recovered"
    assert (record.reopened, record.refusal) == (False, DATABASE_VANISHED)
    assert (record.verified_by, record.committed_rows_lost) == (None, None)
    assert classify_restart(record, 20) == "measurement_unavailable"
    assert path.is_file() and not committed_watermark_path(path).exists()


def test_initial_creation_is_not_a_restart(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    open_worker_file(
        path, provider_id="network", settings=SETTINGS, restart_evidence=restart_evidence_path(path)
    ).close()
    assert not restart_evidence_path(path).exists()


def test_a_missing_database_with_its_wal_present_still_refuses(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    committed_file(path)
    path.unlink()
    Path(str(path) + ".wal").write_bytes(b"wal")
    with pytest.raises(FileNotFoundError, match="recovery_database_missing_with_wal"):
        vanished_reopen(path)
    (record,) = read_restart_records(
        restart_evidence_path(path).read_text(encoding="utf-8").splitlines()
    )
    assert classify_restart(record, 20) == "database_missing_with_wal"
    assert not path.exists() and committed_watermark_path(path).is_file()


@pytest.mark.parametrize(
    "lose",
    [
        "UPDATE local_identity_reservations SET recorded=false WHERE attempt_key='vehicles'",
        "DELETE FROM local_identity_reservations WHERE attempt_key='vehicles'",
        *(
            f"UPDATE local_identity_namespaces SET next_id=next_id-1 WHERE namespace='{namespace}'"
            for namespace in ("ingestion_object", "realtime_snapshot", "alert_snapshot")
        ),
    ],
    ids=["recorded-flag", "reservation-row", "ingestion_object", "realtime_snapshot", "alert"],
)
def test_losing_one_identity_commit_alone_is_lost_committed_row(tmp_path, lose):
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(tmp_path)
    floors = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    path = tmp_path / "identity.duckdb"
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        Recorder(local, provider_id="network").initialize(initial_run_id=0, seed_sha256="a" * 64)
        seed_alert_state(local, seed)
        allocator = IdentityAllocator(local, provider_id="network")
        allocator.initialize(floors, floors_sha256=floors_sha, seed=seed)
        for attempt, endpoint, family in (
            ("vehicles", "vehicle_positions", "realtime_snapshot"),
            ("alerts", "alerts", "alert_snapshot"),
        ):
            allocator.reserve(
                attempt_key=attempt,
                endpoint_key=endpoint,
                index_family=family,
                outcome="stored",
                request_digest="d" * 64,
            )
            allocator.mark_recorded(attempt, request_digest="d" * 64)
        assert write_committed_watermark(path, local, provider_id="network", cycle_at=CYCLE)
        assert verify_committed(path, local, provider_id="network") == 0
        local.connection.execute(lose)  # Only this commit's WAL tail is gone.
        assert verify_committed(path, local, provider_id="network") >= 1


def test_only_the_worker_loop_marks_its_cycles_and_a_failed_mark_never_fails_one(tmp_path, caplog):
    settings = configured(tmp_path)
    database = tmp_path / "provider-network.duckdb"
    scope = dict(settings=settings, engine=None, manifest=MANIFEST, resolver=None)
    with worker_state_scope(**scope) as state:  # A one-shot cycle writes nothing.
        state.mark_committed(CYCLE)
    assert not committed_watermark_path(database).exists()

    with worker_state_scope(**scope, record_restart=True) as state:
        state.mark_committed(CYCLE)
    assert committed_watermark_path(database).is_file()
    with worker_state_scope(**scope, record_restart=True) as state:
        assert classify_restart(worker_reopen_record(database), 20) == "recovered"
        committed_watermark_path(database).unlink()
        committed_watermark_path(database).mkdir()  # A directory cannot be replaced.
        with caplog.at_level(logging.ERROR, logger="transit_ops.live.watermark"):
            state.mark_committed(CYCLE)
    assert "live_committed_watermark_unwritable:" in caplog.text


def worker_reopen_record(database):
    lines = restart_evidence_path(database).read_text(encoding="utf-8").splitlines()
    return read_restart_records(lines)[-1]
