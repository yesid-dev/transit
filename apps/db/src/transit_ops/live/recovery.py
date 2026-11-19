"""Explicit local recovery entry points; DuckDB owns WAL replay."""

import json
import os
import shutil
from collections.abc import Callable
from contextlib import ExitStack, closing
from dataclasses import asdict, dataclass, fields
from datetime import UTC, datetime
from functools import partial
from hashlib import file_digest, sha256
from pathlib import Path
from typing import Any

import duckdb

from transit_ops.history.poll_record import CaptureEntry
from transit_ops.ingestion.i3 import extract_i3_metadata, extract_service_alerts_metadata
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.live import facts
from transit_ops.live.captures import CaptureRef, Frame, ParsePolicy, parse_capture
from transit_ops.live.compare import canonical_row
from transit_ops.live.edition import EDITION_TABLES, create_edition_tables
from transit_ops.live.local_file import SCHEMA_VERSION, LocalFile, PathReservation
from transit_ops.live.recording import Recorder
from transit_ops.live.segments import SEGMENT_FORMAT_VERSION, Segment, read_segment
from transit_ops.live.settings import LaneSettings
from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import TABLES as ALERT_TABLES
from transit_ops.static.alert_seed_contract import AlertSeed
from transit_ops.static.alert_state import seed_alert_state

CHECKPOINT_TABLES = (
    "recording_cursor",
    "recording_coverage",
    "recording_cadence",
    "local_applications",
    "local_serving",
    "segment_fact_members",
    "segment_exports",
    "segment_clock",
)


class RecoveryRefused(ValueError):
    """Inputs or candidate disagree; this alone does not diagnose a DuckDB failure."""


@dataclass(frozen=True)
class ReplayStep:
    endpoint_key: str
    capture_row_id: int
    edition: tuple[Frame, ...] | None = None


@dataclass(frozen=True)
class ColdInputs:
    """Caller supplies a trusted cut digest and all sources certified by that cut.

    No object listing, current edition query, latest-row inference or wall clock
    can establish completeness. Checkpoint frames carry the original recorder,
    serving and segment metadata omitted by segment format 2. Alert history names
    every successful post-seed application in original chronological order.
    """

    provider_id: str
    timezone: str
    policy: ParsePolicy
    inventory: tuple[Segment, ...]
    cut: bytes
    cut_sha256: str
    edition_source: tuple[Frame, ...]
    alert_seed: bytes
    alert_history: tuple[tuple[str, int], ...]
    checkpoint: tuple[Frame, ...]
    applications: tuple[ReplayStep, ...] = ()


@dataclass(frozen=True)
class Candidate:
    path: Path
    provider_id: str
    cut_sha256: str
    state_sha256: str
    file_sha256: str


def frames_sha256(frames: tuple[Frame, ...]) -> str:
    value = [
        (f.table, f.columns, sorted(canonical_row(row) for row in f.rows))
        for f in sorted(frames, key=lambda f: f.table)
    ]
    return sha256(_json(value)).hexdigest()


def _replay_digest(inputs: ColdInputs) -> str:
    return sha256(
        _json(
            [
                (
                    s.endpoint_key,
                    s.capture_row_id,
                    frames_sha256(s.edition) if s.edition is not None else None,
                )
                for s in inputs.applications
            ]
        )
    ).hexdigest()


def _json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")


def _read_frame(local: LocalFile, table: str) -> Frame:
    schema = local.connection.execute(f"DESCRIBE {table}").fetchall()
    columns = tuple(c[0] for c in schema)
    selections = ", ".join(
        f'CAST("{name}" AS TIMESTAMP) AS "{name}"'
        if kind == "TIMESTAMP WITH TIME ZONE"
        else f'"{name}"'
        for name, kind, *_ in schema
    )
    cursor = local.connection.execute(f"SELECT {selections} FROM {table} ORDER BY ALL")
    rows = tuple(
        tuple(v.replace(tzinfo=UTC) if isinstance(v, datetime) else v for v in row)
        for row in cursor.fetchall()
    )
    return Frame(table, columns, rows)


def _state(local: LocalFile) -> tuple[Frame, ...]:
    names = (
        "meta",
        *CHECKPOINT_TABLES,
        *EDITION_TABLES,
        *ALERT_TABLES,
        "alert_seed_checkpoint",
        "polls",
        "captures",
        "processing",
        *facts._DEFINITIONS,
    )
    return tuple(_read_frame(local, name) for name in names)


def _insert(local: LocalFile, frame: Frame) -> None:
    _check_columns(local, frame)
    if frame.rows:
        try:
            local.connection.executemany(
                f"INSERT INTO {frame.table} VALUES ({','.join('?' for _ in frame.columns)})",
                frame.rows,
            )
        except duckdb.Error as exc:
            raise RecoveryRefused(f"recovery_rows_refused:{frame.table}") from exc


def _check_columns(local: LocalFile, frame: Frame) -> None:
    actual = tuple(
        c[0] for c in local.connection.execute(f"SELECT * FROM {frame.table} LIMIT 0").description
    )
    if frame.columns != actual or any(len(r) != len(actual) for r in frame.rows):
        raise RecoveryRefused(f"recovery_columns_mismatch:{frame.table}")


def _validated_cut(inputs: ColdInputs) -> tuple[dict[str, Any], AlertSeed]:
    if sha256(inputs.cut).hexdigest() != inputs.cut_sha256:
        raise RecoveryRefused("recovery_cut_digest_mismatch")
    try:
        cut = json.loads(inputs.cut)
        seed = AlertSeed.from_json(inputs.alert_seed)
        expected = dict(
            version=1,
            schema_version=SCHEMA_VERSION,
            provider_id=inputs.provider_id,
            inventory=[asdict(s) for s in inputs.inventory],
            edition_sha256=frames_sha256(inputs.edition_source),
            checkpoint_sha256=frames_sha256(inputs.checkpoint),
            alert_seed_sha256=sha256(inputs.alert_seed).hexdigest(),
            alert_history_sha256=sha256(_json(inputs.alert_history)).hexdigest(),
            context_sha256=sha256(_json((inputs.timezone, asdict(inputs.policy)))).hexdigest(),
            replay_sha256=_replay_digest(inputs),
        )
        if not isinstance(cut, dict) or set(cut) != {
            *expected,
            "last_seq",
            "window_start",
            "window_end",
            "state_sha256",
        }:
            raise RecoveryRefused("recovery_cut_incomplete")
        if (
            any(_json(cut[k]) != _json(v) for k, v in expected.items())
            or seed.provider_id != inputs.provider_id
        ):
            raise RecoveryRefused("recovery_input_identity_mismatch")
        start, end = (datetime.fromisoformat(cut[k]) for k in ("window_start", "window_end"))
        if (
            start.utcoffset() is None
            or end.utcoffset() is None
            or not seed.snapshot_at <= start <= end
        ):
            raise RecoveryRefused("recovery_window_coverage_missing")
        first = 1
        for segment in inputs.inventory:
            if segment.provider_id != inputs.provider_id or segment.first_seq != first:
                raise RecoveryRefused("recovery_segment_inventory_gap")
            first = segment.last_seq + 1
        if not inputs.inventory or type(cut["last_seq"]) is not int or first != cut["last_seq"] + 1:
            raise RecoveryRefused("recovery_segment_inventory_incomplete")
        return cut, seed
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, RecoveryRefused):
            raise
        raise RecoveryRefused("recovery_cut_invalid") from exc


def _load_sources(local: LocalFile, inputs: ColdInputs, storage: BronzeStorage) -> dict[str, Frame]:
    if {f.table for f in inputs.edition_source} != set(EDITION_TABLES):
        raise RecoveryRefused("recovery_edition_incomplete")
    if {f.table for f in inputs.checkpoint} != set(CHECKPOINT_TABLES):
        raise RecoveryRefused("recovery_checkpoint_incomplete")
    if len(inputs.edition_source) != len(EDITION_TABLES) or len(inputs.checkpoint) != len(
        CHECKPOINT_TABLES
    ):
        raise RecoveryRefused("recovery_duplicate_source_table")
    create_edition_tables(local.connection)
    for frame in inputs.checkpoint:
        _check_columns(local, frame)
    _replace_edition(local, inputs.edition_source, inputs.provider_id)
    if local.connection.execute("SELECT provider_id FROM edition_meta").fetchall() != [
        (inputs.provider_id,)
    ]:
        raise RecoveryRefused("recovery_edition_provider_mismatch")
    for table in ("edition_stop_times", "edition_trips"):
        if not local.connection.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone():
            raise RecoveryRefused("recovery_edition_empty")
    combined: dict[str, Frame] = {}
    for segment in inputs.inventory:
        for name, frame in read_segment(local, storage, segment).items():
            previous = combined.get(name)
            combined[name] = Frame(
                name, frame.columns, (previous.rows if previous else ()) + frame.rows
            )
    with local.transaction():
        for name in ("polls", "captures", "processing"):
            _insert(local, combined[name])
    return combined


def _replace_edition(local: LocalFile, frames: tuple[Frame, ...], provider: str) -> None:
    if len(frames) != len(EDITION_TABLES) or {f.table for f in frames} != set(EDITION_TABLES):
        raise RecoveryRefused("recovery_application_edition_incomplete")
    with local.transaction() as conn:
        for frame in frames:
            conn.execute(f"DELETE FROM {frame.table}")
            _insert(local, frame)
        if conn.execute("SELECT provider_id FROM edition_meta").fetchall() != [(provider,)]:
            raise RecoveryRefused("recovery_application_edition_provider_mismatch")


def _captures(
    local: LocalFile, cut: dict[str, Any], resolver: Callable[[CaptureEntry], bytes]
) -> dict[tuple[str, int], tuple[CaptureEntry, bytes]]:
    frame = _read_frame(local, "captures")
    result = {}
    names = {f.name for f in fields(CaptureEntry)}
    start, end = (datetime.fromisoformat(cut[k]) for k in ("window_start", "window_end"))
    for row in frame.rows:
        values: dict[str, Any] = dict(zip(frame.columns, row, strict=True))
        capture = CaptureEntry(**{k: v for k, v in values.items() if k in names})
        if capture.index_family not in ("realtime_snapshot", "alert_snapshot"):
            raise RecoveryRefused("recovery_capture_namespace_mismatch")
        if not start <= capture.captured_at_utc <= end:
            raise RecoveryRefused("recovery_capture_outside_coverage")
        try:
            payload = resolver(capture)
        except (LookupError, OSError) as exc:
            raise RecoveryRefused("recovery_retained_bytes_unavailable") from exc
        if len(payload) != capture.byte_size or sha256(payload).hexdigest() != capture.sha256:
            raise RecoveryRefused("recovery_retained_bytes_mismatch")
        endpoint = str(values["endpoint_key"])
        key = endpoint, capture.capture_row_id
        if key in result:
            raise RecoveryRefused("recovery_capture_namespace_collision")
        if (capture.index_family == "realtime_snapshot") != (
            endpoint in ("vehicle_positions", "trip_updates")
        ):
            raise RecoveryRefused("recovery_capture_namespace_mismatch")
        result[key] = capture, payload
    return result


def _replay(
    local: LocalFile,
    inputs: ColdInputs,
    captures: dict[tuple[str, int], tuple[CaptureEntry, bytes]],
) -> None:
    apps = next(f for f in inputs.checkpoint if f.table == "local_applications")
    succeeded = {
        (str(r[0]), r[1]) for r in apps.rows if r[2] == "succeeded" and isinstance(r[1], int)
    }
    if not succeeded <= captures.keys():
        raise RecoveryRefused("recovery_application_capture_missing")
    alert_keys = succeeded - {k for k in succeeded if k[0] in ("vehicle_positions", "trip_updates")}
    if set(inputs.alert_history) != alert_keys or len(inputs.alert_history) != len(alert_keys):
        raise RecoveryRefused("recovery_alert_history_incomplete")
    ordered = sorted(alert_keys, key=lambda k: (captures[k][0].captured_at_utc, k))
    if list(inputs.alert_history) != ordered:
        raise RecoveryRefused("recovery_alert_history_order")
    steps = [(s.endpoint_key, s.capture_row_id) for s in inputs.applications]
    if set(steps) != succeeded or len(steps) != len(succeeded):
        raise RecoveryRefused("recovery_application_provenance_incomplete")
    if [k for k in steps if k in alert_keys] != ordered:
        raise RecoveryRefused("recovery_alert_replay_order")
    recorder = Recorder(local, provider_id=inputs.provider_id)
    for step in inputs.applications:
        endpoint, identity = step.endpoint_key, step.capture_row_id
        if endpoint == "trip_updates":
            if step.edition is None:
                raise RecoveryRefused("recovery_application_edition_missing")
            _replace_edition(local, step.edition, inputs.provider_id)
        capture, payload = captures[(endpoint, identity)]
        operation = partial(_apply_retained, local, inputs, endpoint, capture, payload)
        recorder.apply(endpoint, identity, operation, capture=capture)
        if recorder.apply(endpoint, identity, operation, capture=capture):
            raise RecoveryRefused("recovery_application_not_idempotent")
    _replace_edition(local, inputs.edition_source, inputs.provider_id)


def _apply_retained(
    local: LocalFile, inputs: ColdInputs, endpoint: str, capture: CaptureEntry, payload: bytes
) -> object:
    if endpoint in ("vehicle_positions", "trip_updates"):
        parsed = parse_capture(
            payload,
            CaptureRef.from_entry(capture, provider_id=inputs.provider_id, endpoint_key=endpoint),
            inputs.policy,
        )
        return facts.apply_capture(local, parsed, provider_timezone=inputs.timezone)
    metadata = (
        extract_service_alerts_metadata if endpoint == "service_alerts" else extract_i3_metadata
    )(payload, provider_id=inputs.provider_id)
    result = apply_alert_snapshot(
        local,
        RawI3AlertSnapshot(
            capture.capture_row_id,
            inputs.provider_id,
            inputs.timezone,
            capture.captured_at_utc,
            metadata.raw_payload_json,
        ),
        loaded_at_utc=capture.captured_at_utc,
    )
    if result.skipped_older_capture:
        raise RecoveryRefused("recovery_alert_older_than_seed")
    return result


def _restore_checkpoint(local: LocalFile, inputs: ColdInputs, cut: dict[str, Any]) -> None:
    with local.transaction() as conn:
        for frame in inputs.checkpoint:
            conn.execute(f"DELETE FROM {frame.table}")
            _insert(local, frame)
        if conn.execute("SELECT provider_id FROM recording_cursor").fetchall() != [
            (inputs.provider_id,)
        ]:
            raise RecoveryRefused("recovery_cursor_missing_or_provider_mismatch")
        if conn.execute("SELECT next_seq FROM segment_clock").fetchall() != [
            (cut["last_seq"] + 1,)
        ]:
            raise RecoveryRefused("recovery_segment_clock_mismatch")
        sequences = conn.execute(
            "SELECT segment_seq FROM polls UNION ALL SELECT segment_seq FROM captures "
            "UNION ALL SELECT segment_seq FROM processing UNION ALL "
            "SELECT segment_seq FROM segment_fact_members"
        ).fetchall()
        values = [r[0] for r in sequences]
        if len(values) != cut["last_seq"] or set(values) != set(range(1, cut["last_seq"] + 1)):
            raise RecoveryRefused("recovery_sequence_coverage_missing")
        missing = conn.execute(
            "SELECT ingestion_run_id FROM captures UNION SELECT ingestion_run_id FROM polls "
            "UNION SELECT ingestion_run_id FROM processing WHERE ingestion_run_id IS NOT NULL "
            "EXCEPT SELECT ingestion_run_id FROM recording_coverage"
        ).fetchall()
        if missing:
            raise RecoveryRefused("recovery_run_coverage_missing")
        _verify_provenance(local, inputs)


def _verify_provenance(local: LocalFile, inputs: ColdInputs) -> None:
    conn = local.connection
    if conn.execute("SELECT seed_sha256 FROM recording_cursor").fetchall() != [
        (sha256(inputs.alert_seed).hexdigest(),)
    ]:
        raise RecoveryRefused("recovery_cursor_seed_mismatch")
    if conn.execute(
        "SELECT 1 FROM local_serving s LEFT JOIN captures c USING(endpoint_key,capture_row_id) "
        "LEFT JOIN local_applications a USING(endpoint_key,capture_row_id) "
        "WHERE c.capture_row_id IS NULL OR a.status IS DISTINCT FROM 'succeeded' "
        "OR s.captured_at_utc IS DISTINCT FROM c.captured_at_utc "
        "OR s.feed_timestamp_utc IS DISTINCT FROM c.feed_timestamp_utc LIMIT 1"
    ).fetchone():
        raise RecoveryRefused("recovery_serving_provenance_mismatch")
    if conn.execute(
        "SELECT 1 FROM segment_fact_members m FULL JOIN fact_processing f "
        "USING(provider_id,endpoint_key,capture_row_id,application_sha256) "
        "WHERE m.provider_id IS NULL OR f.provider_id IS NULL LIMIT 1"
    ).fetchone():
        raise RecoveryRefused("recovery_fact_membership_mismatch")
    expected = {(s.first_seq, s.last_seq): s.content_sha256 for s in inputs.inventory}
    rows = conn.execute("SELECT first_seq,last_seq,manifest FROM segment_exports").fetchall()
    if {(r[0], r[1]) for r in rows} != set(expected) or len(rows) != len(expected):
        raise RecoveryRefused("recovery_export_inventory_mismatch")
    for first, last, document in rows:
        manifest = json.loads(document)
        if (
            manifest.get("provider"),
            manifest.get("first"),
            manifest.get("last"),
            manifest.get("content_sha256"),
            manifest.get("version"),
        ) != (inputs.provider_id, first, last, expected[first, last], SEGMENT_FORMAT_VERSION):
            raise RecoveryRefused("recovery_export_identity_mismatch")


def reconstruct(
    candidate: Path,
    *,
    owned_directory: Path,
    inputs: ColdInputs,
    storage: BronzeStorage,
    resolver: Callable[[CaptureEntry], bytes],
    settings: LaneSettings,
) -> Candidate:
    """Build only a separate, fully verified candidate; failures retain that evidence."""
    cut, seed = _validated_cut(inputs)
    candidate = _owned_path(candidate, owned_directory)
    with PathReservation(candidate) as reservation:
        if candidate.exists() or Path(str(candidate) + ".wal").exists():
            raise FileExistsError(str(candidate))
        return _build_candidate(
            candidate, inputs, cut, seed, storage, resolver, settings, reservation
        )


def _build_candidate(
    candidate: Path,
    inputs: ColdInputs,
    cut: dict[str, Any],
    seed: AlertSeed,
    storage: BronzeStorage,
    resolver: Callable[[CaptureEntry], bytes],
    settings: LaneSettings,
    reservation: PathReservation,
) -> Candidate:
    with closing(
        LocalFile.open(
            candidate, provider_id=inputs.provider_id, settings=settings, reservation=reservation
        )
    ) as local:
        seed_alert_state(local, seed)
        expected = _load_sources(local, inputs, storage)
        _replay(local, inputs, _captures(local, cut, resolver))
        local.verify_fact_tables(facts._DEFINITIONS)
        for name in facts._DEFINITIONS:
            if frames_sha256((_read_frame(local, name),)) != frames_sha256((expected[name],)):
                raise RecoveryRefused(f"recovery_fact_replay_mismatch:{name}")
        _restore_checkpoint(local, inputs, cut)
        local.verify_shape()
        if frames_sha256(_state(local)) != cut["state_sha256"]:
            raise RecoveryRefused("recovery_candidate_state_mismatch")
    with closing(
        LocalFile.open(
            candidate,
            provider_id=inputs.provider_id,
            settings=settings,
            reservation=reservation,
            existing_only=True,
        )
    ) as local:
        if frames_sha256(_state(local)) != cut["state_sha256"]:
            raise RecoveryRefused("recovery_candidate_reopen_mismatch")
    with candidate.open("rb") as source:
        digest = file_digest(source, "sha256").hexdigest()
    return Candidate(candidate, inputs.provider_id, inputs.cut_sha256, cut["state_sha256"], digest)


def _owned_path(path: Path, directory: Path) -> Path:
    directory, path = directory.resolve(strict=True), path.resolve()
    if path == directory or not path.is_relative_to(directory):
        raise RecoveryRefused("recovery_path_outside_owned_directory")
    return path


def _digest(path: Path) -> str | None:
    if not path.exists():
        return None
    try:
        with path.open("rb") as source:
            return file_digest(source, "sha256").hexdigest()
    except OSError as exc:
        raise RecoveryRefused(f"recovery_evidence_unreadable:{path.name}") from exc


def _expect_digest(path: Path, expected: str | None) -> None:
    if _digest(path) != expected:
        raise RecoveryRefused(f"recovery_file_digest_mismatch:{path.name}")


def _write_synced(path: Path, payload: bytes) -> None:
    with path.open("xb") as target:
        target.write(payload)
        target.flush()
        os.fsync(target.fileno())


def _backup_file(source: Path, target: Path, expected: str | None) -> None:
    _expect_digest(source, expected)
    if expected is not None:
        with source.open("rb") as original, target.open("xb") as backup:
            shutil.copyfileobj(original, backup, length=64 * 1024)
            backup.flush()
            os.fsync(backup.fileno())
    _expect_digest(target, expected)


def _replace_owned(source: Path, target: Path, directory: Path) -> None:
    source, target = _owned_path(source, directory), _owned_path(target, directory)
    try:
        os.replace(source, target)
    except OSError as exc:
        raise RecoveryRefused("recovery_atomic_replace_refused") from exc


def _verify_candidate(
    candidate: Candidate, settings: LaneSettings, reservation: PathReservation
) -> None:
    _expect_digest(candidate.path, candidate.file_sha256)
    if Path(str(candidate.path) + ".wal").exists():
        raise RecoveryRefused("recovery_candidate_has_uncheckpointed_wal")
    with closing(
        LocalFile.open(
            candidate.path,
            provider_id=candidate.provider_id,
            settings=settings,
            reservation=reservation,
            existing_only=True,
        )
    ) as local:
        if frames_sha256(_state(local)) != candidate.state_sha256:
            raise RecoveryRefused("recovery_candidate_state_mismatch")
    _expect_digest(candidate.path, candidate.file_sha256)


def _check_adoption_paths(candidate: Path, original: Path, backup: Path, directory: Path) -> None:
    inputs = [
        _owned_path(Path(str(path) + suffix), directory)
        for path in (candidate, original)
        for suffix in ("", ".wal", ".recovery-pending", ".owner.lock")
    ]
    outputs = [
        _owned_path(backup / name, directory)
        for name in ("database", "wal", "manifest.json", "detached-wal")
    ]
    files = inputs + outputs
    overlap = len(set(files)) != len(files) or any(
        a != b and a.is_relative_to(b) for a in files for b in files
    )
    if overlap or any(
        p == backup or p.is_relative_to(backup) or backup.is_relative_to(p) for p in inputs
    ):
        raise RecoveryRefused("recovery_adoption_paths_collide")


def adopt(
    candidate: Candidate,
    *,
    original: Path,
    backup: Path,
    owned_directory: Path,
    original_sha256: str | None,
    wal_sha256: str | None,
    settings: LaneSettings,
) -> None:
    """Explicit atomic replacement with verified evidence and durable refusal on interruption.

    Only cooperating owners share this reservation. A pending marker blocks normal
    opens after interruption; repeating this exact operation validates the backup
    before finishing. Existing/partial backup directories are never overwritten.
    Kernel locks release on process death; evidence/markers are never evicted by age.
    """
    original = _owned_path(original, owned_directory)
    backup = _owned_path(backup, owned_directory)
    path = _owned_path(candidate.path, owned_directory)
    if path != candidate.path or len({path, original, backup}) != 3:
        raise RecoveryRefused("recovery_adoption_paths_collide")
    _check_adoption_paths(path, original, backup, owned_directory)
    candidate = Candidate(
        path,
        candidate.provider_id,
        candidate.cut_sha256,
        candidate.state_sha256,
        candidate.file_sha256,
    )
    plan = _adoption_plan(candidate, original, backup, original_sha256, wal_sha256)
    with ExitStack() as stack:
        reservations = {
            p: stack.enter_context(PathReservation(p)) for p in sorted((path, original))
        }
        _adopt_reserved(
            candidate,
            original,
            backup,
            owned_directory,
            original_sha256,
            wal_sha256,
            settings,
            reservations[path],
            plan,
        )


def _adoption_plan(
    candidate: Candidate,
    original: Path,
    backup: Path,
    original_sha: str | None,
    wal_sha: str | None,
) -> bytes:
    return _json(
        dict(
            version=1,
            candidate={**asdict(candidate), "path": str(candidate.path)},
            original=str(original),
            backup=str(backup),
            original_sha256=original_sha,
            wal_sha256=wal_sha,
        )
    )


def _verify_backup(
    backup: Path, original_sha: str | None, wal_sha: str | None, plan: bytes
) -> None:
    if (backup / "manifest.json").read_bytes() != plan:
        raise RecoveryRefused("recovery_backup_manifest_mismatch")
    _expect_digest(backup / "database", original_sha)
    _expect_digest(backup / "wal", wal_sha)


def _adopt_reserved(
    candidate: Candidate,
    original: Path,
    backup: Path,
    directory: Path,
    original_sha: str | None,
    wal_sha: str | None,
    settings: LaneSettings,
    reservation: PathReservation,
    plan: bytes,
) -> None:
    marker = _owned_path(Path(str(original) + ".recovery-pending"), directory)
    wal = _owned_path(Path(str(original) + ".wal"), directory)
    detached = _owned_path(backup / "detached-wal", directory)
    if marker.exists():
        if marker.read_bytes() != plan:
            raise RecoveryRefused("recovery_pending_operation_mismatch")
        _verify_backup(backup, original_sha, wal_sha, plan)
        if _digest(original) == candidate.file_sha256 and not wal.exists():
            marker.unlink()
            return
    else:
        _expect_digest(original, original_sha)
        _expect_digest(wal, wal_sha)
        _verify_candidate(candidate, settings, reservation)
        backup.mkdir()
        _backup_file(original, _owned_path(backup / "database", directory), original_sha)
        _backup_file(wal, _owned_path(backup / "wal", directory), wal_sha)
        _write_synced(_owned_path(backup / "manifest.json", directory), plan)
        _verify_backup(backup, original_sha, wal_sha, plan)
        _write_synced(marker, plan)
    _expect_digest(original, original_sha)
    _verify_candidate(candidate, settings, reservation)
    if wal.exists():
        _expect_digest(wal, wal_sha)
        if detached.exists():
            raise RecoveryRefused("recovery_detached_wal_already_exists")
        _replace_owned(wal, detached, directory)
    elif wal_sha is not None:
        _expect_digest(detached, wal_sha)
    _replace_owned(candidate.path, original, directory)
    _expect_digest(original, candidate.file_sha256)
    marker.unlink()


def reopen(path: Path, *, provider_id: str, settings: LaneSettings) -> LocalFile:
    """Acquire an existing worker file through its resource and ownership boundary."""
    return LocalFile.open(path, provider_id=provider_id, settings=settings, existing_only=True)


def open_worker_file(
    path: Path,
    *,
    provider_id: str,
    settings: LaneSettings,
    restart_evidence: Path | None = None,
) -> LocalFile:
    """Allow initial creation, but never initialize over an orphaned DuckDB WAL.

    Existing files retain LocalFile's named locked/unreadable/schema refusals.
    An unreadable file alone does not establish that DuckDB WAL replay failed.
    This function owns only the returned handle; callers close it in finally.

    With ``restart_evidence``, opening an existing file, its WAL or a pending adoption is
    a reopen: one restart record is appended there whatever the outcome, and a record
    that cannot be written is logged, never raised. Initial creation is not a restart.
    """
    open_file = partial(LocalFile.open, path, provider_id=provider_id, settings=settings)
    traces = (path, *(Path(str(path) + s) for s in (".wal", ".recovery-pending")))
    if restart_evidence is None or not any(p.exists() for p in traces):
        return open_file()
    from transit_ops.live.admission import recorded_reopen

    return recorded_reopen(open_file, path, provider_id=provider_id, evidence=restart_evidence)
