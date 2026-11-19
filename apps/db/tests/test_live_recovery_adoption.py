import json
import subprocess
import sys
from contextlib import closing, contextmanager
from dataclasses import asdict, replace
from hashlib import sha256
from pathlib import Path

import pytest
from cold_recovery_fixture import cold as cold
from cold_recovery_fixture import cold_templates as cold_templates
from test_live_local_file import SETTINGS
from test_live_path_reservation import kill_after_ready

from transit_ops.live.local_file import LocalFileLocked, LocalFileMismatch
from transit_ops.live.recovery import RecoveryRefused, adopt, reopen


def prepared(cold, tmp_path):
    *_, candidate = cold(built=True)
    original = tmp_path / "failed.duckdb"
    original.write_bytes(b"failed original")
    wal = Path(str(original) + ".wal")
    wal.write_bytes(b"retained failed WAL")
    options = dict(
        original=original,
        backup=tmp_path / "evidence",
        owned_directory=tmp_path,
        original_sha256=sha256(original.read_bytes()).hexdigest(),
        wal_sha256=sha256(wal.read_bytes()).hexdigest(),
        settings=SETTINGS,
    )
    return candidate, options


def test_adoption_preserves_verified_original_and_wal_then_opens_candidate(cold, tmp_path):
    candidate, options = prepared(cold, tmp_path)
    original, backup = options["original"], options["backup"]
    adopt(candidate, **options)
    assert (backup / "database").read_bytes() == b"failed original"
    assert (backup / "wal").read_bytes() == b"retained failed WAL"
    assert (backup / "detached-wal").read_bytes() == b"retained failed WAL"
    assert not Path(str(original) + ".wal").exists()
    assert not candidate.path.exists()
    with closing(reopen(original, provider_id="network", settings=SETTINGS)) as local:
        assert (
            local.connection.execute("SELECT count(*) FROM fact_vehicle_snapshot").fetchone()[0] > 0
        )
    assert not Path(str(original) + ".recovery-pending").exists()


def test_explicit_adoption_can_restore_a_missing_target(cold, tmp_path):
    *_, candidate = cold(built=True)
    original = tmp_path / "missing.duckdb"
    adopt(
        candidate,
        original=original,
        backup=tmp_path / "evidence",
        owned_directory=tmp_path,
        original_sha256=None,
        wal_sha256=None,
        settings=SETTINGS,
    )
    with closing(reopen(original, provider_id="network", settings=SETTINGS)):
        pass
    assert not (tmp_path / "evidence" / "database").exists()


@pytest.mark.parametrize(
    "collision",
    [
        "candidate_wal",
        "candidate_marker",
        "candidate_lock",
        "original_wal",
        "original_marker",
        "original_lock",
        "backup_wal",
        "database",
        "wal",
        "manifest.json",
        "detached-wal",
    ],
)
def test_adoption_rejects_entire_sidecar_footprint_before_mutation(cold, tmp_path, collision):
    original, backup = tmp_path / "failed.duckdb", tmp_path / "evidence"
    suffixes = {"wal": ".wal", "marker": ".recovery-pending", "lock": ".owner.lock"}
    name = "candidate.duckdb"
    if collision.startswith("candidate_"):
        name = original.name + suffixes[collision.removeprefix("candidate_")]
    elif collision in ("database", "wal", "manifest.json", "detached-wal"):
        backup.mkdir()
        name = str(Path("evidence") / collision)
    *_, candidate = cold(built=True, name=name)
    if collision.startswith("original_"):
        original = Path(str(candidate.path) + suffixes[collision.removeprefix("original_")])
    original.write_bytes(b"failed original")
    wal = Path(str(original) + ".wal")
    if wal != candidate.path:
        wal.write_bytes(b"retained WAL")
    if collision == "backup_wal":
        backup = wal
    before = adoption_files(tmp_path)
    with pytest.raises(RecoveryRefused, match="recovery_adoption_paths_collide"):
        adopt(
            candidate,
            original=original,
            backup=backup,
            owned_directory=tmp_path,
            original_sha256=sha256(original.read_bytes()).hexdigest(),
            wal_sha256=sha256(wal.read_bytes()).hexdigest(),
            settings=SETTINGS,
        )
    assert adoption_files(tmp_path) == before
    assert candidate.path.is_file()


def adoption_files(directory):
    return {
        p.relative_to(directory): (None if p.is_dir() else sha256(p.read_bytes()).hexdigest())
        for p in directory.rglob("*")
    }


@pytest.mark.parametrize("failure", ["original", "candidate", "outside", "backup"])
def test_adoption_refuses_drift_and_unsafe_targets_without_losing_original(cold, tmp_path, failure):
    candidate, options = prepared(cold, tmp_path)
    original = options["original"]
    before = original.read_bytes()
    if failure == "original":
        options["original_sha256"] = "0" * 64
    elif failure == "candidate":
        candidate = replace(candidate, file_sha256="0" * 64)
    elif failure == "outside":
        options["original"] = tmp_path.parent / "outside.duckdb"
    else:
        options["backup"].mkdir()
    with pytest.raises((RecoveryRefused, FileExistsError)):
        adopt(candidate, **options)
    assert original.read_bytes() == before
    assert candidate.path.exists()


CHILD = """
import json, sys
from pathlib import Path
from transit_ops.live import recovery
from transit_ops.live.recovery import Candidate
from transit_ops.live.settings import LaneSettings
data = json.loads(sys.argv[1])
candidate = Candidate(**{**data['candidate'], 'path': Path(data['candidate']['path'])})
original = Path(data['original'])
replace = recovery._replace_owned
def observed(source, target, directory):
    replace(source, target, directory)
    selected = data['stage'] == 'detached' and target.name == 'detached-wal'
    if selected or (data['stage'] == 'replaced' and target == original):
        print('ready', flush=True)
        sys.stdin.read()
        raise AssertionError('parent must kill adoption fixture')
recovery._replace_owned = observed
recovery.adopt(candidate, original=original, backup=Path(data['backup']),
    owned_directory=original.parent, original_sha256=data['original_sha256'],
    wal_sha256=data['wal_sha256'],
    settings=LaneSettings(duckdb_memory_limit_mb=64, duckdb_threads=1, temp_dir_max_mb=32))
"""


@pytest.mark.parametrize("stage", ["detached", "replaced"])
def test_real_process_interruption_preserves_evidence_and_requires_explicit_finish(
    cold, tmp_path, stage
):
    candidate, options = prepared(cold, tmp_path)
    original, backup = options["original"], options["backup"]
    arguments = dict(
        candidate={**asdict(candidate), "path": str(candidate.path)},
        original=str(original),
        backup=str(backup),
        stage=stage,
        original_sha256=options["original_sha256"],
        wal_sha256=options["wal_sha256"],
    )
    with contextmanager(kill_after_ready)(
        [sys.executable, "-c", CHILD, json.dumps(arguments)]
    ) as message:
        assert message.strip() == "ready"
        with pytest.raises(LocalFileLocked):
            reopen(original, provider_id="network", settings=SETTINGS)
    with pytest.raises(LocalFileMismatch, match="recovery_adoption_pending"):
        reopen(original, provider_id="network", settings=SETTINGS)
    assert (backup / "database").read_bytes() == b"failed original"
    assert (backup / "wal").read_bytes() == b"retained failed WAL"
    adopt(candidate, **options)
    with closing(reopen(original, provider_id="network", settings=SETTINGS)):
        pass


def test_real_owner_refuses_adoption_before_creating_backup(cold, tmp_path):
    candidate, options = prepared(cold, tmp_path)
    # The normal owner and cold adoption contend on the same path reservation.
    original = tmp_path / "source.duckdb"
    options.update(
        original=original,
        original_sha256=sha256(original.read_bytes()).hexdigest(),
        wal_sha256=None,
    )
    with closing(reopen(original, provider_id="network", settings=SETTINGS)):
        with pytest.raises(LocalFileLocked):
            adopt(candidate, **options)
        arguments = dict(
            candidate={**asdict(candidate), "path": str(candidate.path)},
            original=str(original),
            backup=str(options["backup"]),
            stage="unused",
            original_sha256=options["original_sha256"],
            wal_sha256=None,
        )
        child = subprocess.run(
            [sys.executable, "-c", CHILD, json.dumps(arguments)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert child.returncode != 0
        assert "LocalFileLocked" in child.stderr
    assert not options["backup"].exists()
    assert candidate.path.exists()


@pytest.mark.skipif(sys.platform != "win32", reason="requires native Windows file-sharing behavior")
def test_windows_locked_original_refuses_before_backup_or_replace(cold, tmp_path):
    import duckdb

    candidate, options = prepared(cold, tmp_path)
    original = tmp_path / "source.duckdb"
    before = original.read_bytes()
    options.update(original=original, original_sha256=sha256(before).hexdigest(), wal_sha256=None)
    with duckdb.connect(str(original)):
        with pytest.raises(RecoveryRefused, match="evidence_unreadable") as error:
            adopt(candidate, **options)
        assert isinstance(error.value.__cause__, PermissionError)
    assert original.read_bytes() == before
    assert not options["backup"].exists()
    assert candidate.path.exists()
    assert not Path(str(original) + ".recovery-pending").exists()
