"""Build and verify a local pack from a working poll record."""

import gzip
import hashlib
import json
import re
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import TypedDict

from sqlalchemy import Connection, text

from transit_ops.history import datasets, ledger, ledger_select
from transit_ops.history.ledger_store import NewCopy, WindowIdentity, WindowSession
from transit_ops.history.manifest import (
    Manifest,
    build_manifest,
    encode_manifest,
    read_copy_manifest,
)
from transit_ops.history.pack import PackResult, read_pack, write_pack
from transit_ops.history.poll_record import (
    CaptureEntry,
    PollRecord,
    PollRecordInvalid,
    canonical_json,
    ordered_record,
)
from transit_ops.history.working_captures import read_working_day, rows_fingerprint
from transit_ops.ingestion.storage import BronzeStorage, BronzeStorageResolver, ObjectAlreadyExists

OBJECT_ABSENT = "object_absent"
OBJECT_MISMATCH = "object_mismatch"


class WindowNotClosed(ValueError):
    """The feed-day is still within its capture window."""


class CopyContentMissing(ValueError):
    """Working rows no longer hold all content of the current copy."""


def _reusable_copy(
    window: ledger.WindowState | None, copies: list[ledger.ArchiveCopy], fingerprint: str
) -> ledger.ArchiveCopy | None:
    if window is None:
        return None
    if window.working_state in ("partial", "trimmed"):
        raise NotImplementedError(
            "sealing a day whose working rows were trimmed is not built: "
            "the new version must hold the old copy's content and the new rows together"
        )
    current = next((c for c in copies if c.content_version == window.current_version), None)
    if (
        current is not None
        and current.details["rows_fingerprint"] == fingerprint
        and current.verified_at_utc is not None
        and window.working_changed_at_utc.astimezone(UTC) <= current.verified_at_utc.astimezone(UTC)
    ):
        return current
    waiting = max(
        (
            c
            for c in copies
            if c.state == "sealed"
            and (window.current_version is None or c.content_version > window.current_version)
        ),
        key=lambda c: c.content_version,
        default=None,
    )
    if (
        waiting is not None
        and waiting.details["rows_fingerprint"] == fingerprint
        and window.working_changed_at_utc.astimezone(UTC)
        <= waiting.allocated_at_utc.astimezone(UTC)
    ):
        return waiting
    return None


def _require_content(current: Manifest, record: PollRecord) -> None:
    day = record.feed_day
    label = f"{day.provider_id}/{day.endpoint_key}/{day.utc_date}"
    polls = {p.ingestion_run_id for p in record.polls}
    for poll in current.polls:
        if poll.ingestion_run_id not in polls:
            raise CopyContentMissing(f"{label}: missing poll {poll.ingestion_run_id}")
    captures = {(c.index_family, c.capture_row_id) for c in record.captures}
    for capture in current.captures:
        key = (capture.index_family, capture.capture_row_id)
        if key not in captures:
            raise CopyContentMissing(f"{label}: missing capture {key}")


def _read_day(
    connection: Connection,
    storage: BronzeStorageResolver,
    provider_id: str,
    endpoint_key: str,
    utc_date: date,
) -> tuple[int, str, PollRecord, str] | ledger.ArchiveCopy:
    with connection.begin():
        connection.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        now = connection.execute(text("SELECT now()")).scalar_one()
        closes = datasets.utc_day_closes_at(utc_date)
        if now < closes:
            raise WindowNotClosed(f"{provider_id}/{endpoint_key}/{utc_date} closes at {closes}")
        feed = connection.execute(
            text(
                "SELECT feed_endpoint_id, feed_kind FROM core.feed_endpoints "
                "WHERE provider_id=:provider_id AND endpoint_key=:endpoint_key"
            ),
            dict(provider_id=provider_id, endpoint_key=endpoint_key),
        ).one_or_none()
        if feed is None:
            raise LookupError(f"feed not found: {provider_id}/{endpoint_key}")
        window = ledger_select.ledger_for(connection).window_state(WindowIdentity(
            dataset_id="capture." + endpoint_key,
            provider_id=provider_id,
            window_key=utc_date.isoformat(),
        ))
        copies = ledger_select.ledger_for(connection).find_copies(
            dataset_id="capture." + endpoint_key,
            provider_id=provider_id,
            start=utc_date,
            end=utc_date,
        )
        fingerprint = rows_fingerprint(
            connection, provider_id=provider_id, endpoint_key=endpoint_key, utc_date=utc_date
        )
        reusable = _reusable_copy(window, copies, fingerprint)
        if reusable is not None:
            return reusable
        record = _changed_record(
            connection, storage, window, copies, provider_id, endpoint_key, utc_date
        )
        return feed.feed_endpoint_id, feed.feed_kind, record, fingerprint


def _changed_record(
    connection: Connection,
    storage: BronzeStorageResolver,
    window: ledger.WindowState | None,
    copies: list[ledger.ArchiveCopy],
    provider_id: str,
    endpoint_key: str,
    utc_date: date,
) -> PollRecord:
    current = next(
        (c for c in copies if window and c.content_version == window.current_version), None
    )
    manifest = read_copy_manifest(storage, current) if current else None
    record = read_working_day(
        connection,
        provider_id=provider_id,
        endpoint_key=endpoint_key,
        utc_date=utc_date,
        current=manifest,
    )
    if manifest is not None:
        _require_content(manifest, record)
    return record


def _insert_allocated(
    window: WindowSession, manifest: Manifest, data: bytes, archive_backend: str, fingerprint: str
) -> None:
    pack = manifest.pack
    copy = NewCopy(
        content_version=manifest.content_version,
        schema_version=datasets.get_dataset("capture." + manifest.endpoint_key).schema_version,
        storage_backend=archive_backend,
        storage_path=pack.path if pack else None,
        manifest_path=_prefix(manifest.provider_id, manifest.endpoint_key, manifest.utc_date)
        + f"{manifest.content_version}.manifest.json.gz",
        byte_size=pack.byte_size if pack else None,
        sha256=pack.sha256 if pack else None,
        manifest_sha256=hashlib.sha256(data).hexdigest(),
        record_count=manifest.capture_count,
        poll_count=manifest.poll_count,
        source_bytes=manifest.source_bytes,
        content_sha256=manifest.content_sha256,
        poll_record_sha256=manifest.poll_record_sha256,
        first_time_utc=manifest.first_time_utc,
        last_time_utc=manifest.last_time_utc,
        details=dict(
            rows_fingerprint=fingerprint,
            declared_interval_seconds=manifest.declared_interval_seconds,
            observed_interval_ms=manifest.observed_interval_ms,
        ),
    )
    window.insert_allocated_copy(copy)


def _prefix(provider_id: str, endpoint_key: str, utc_date: date) -> str:
    return (
        f"archive/v1/captures/{provider_id}/{endpoint_key}/"
        f"{utc_date:%Y/%m}/{utc_date.isoformat()}.c"
    )


def _allocation_state(window: WindowSession, record: PollRecord) -> int | None:
    state = window.state()
    assert state is not None
    supersedes = state.current_version
    empty = not record.polls and not record.processing
    if not empty or supersedes is None:
        window.set_working_state("empty" if empty else "present")
    return supersedes


def _allocate(
    connection: Connection,
    local: "LocalPack",
    feed_id: int,
    feed_kind: str,
    highest: int,
    archive_backend: str,
    sealed_by: str,
    fingerprint: str,
) -> tuple[Manifest, bytes]:
    key = local.record.feed_day
    identity = WindowIdentity(
        dataset_id="capture." + key.endpoint_key,
        provider_id=key.provider_id,
        window_key=key.utc_date.isoformat(),
    )
    with connection.begin(), ledger_select.ledger_for(connection).session(identity) as window:
        version = window.allocate_version(above_version=highest)
        supersedes = _allocation_state(window, local.record)
        sealed_at = window.now()
        pack_key = _prefix(key.provider_id, key.endpoint_key, key.utc_date) + f"{version}.pack.xz"
        manifest = build_manifest(
            local.record,
            feed_endpoint_id=feed_id,
            feed_kind=feed_kind,
            content_version=version,
            supersedes=supersedes,
            pack_path=pack_key if local.pack else None,
            pack=local.pack,
            sealed_at_utc=sealed_at,
            sealed_by=sealed_by,
        )
        data = encode_manifest(manifest)
        _insert_allocated(window, manifest, data, archive_backend, fingerprint)
    return manifest, data


class _CopyIdentity(TypedDict):
    dataset_id: str
    provider_id: str
    revision: int
    window_key: str
    content_version: int


def _copy_identity(copy: ledger.ArchiveCopy) -> _CopyIdentity:
    return dict(
        dataset_id=copy.dataset_id,
        provider_id=copy.provider_id,
        revision=copy.revision,
        window_key=copy.window_key,
        content_version=copy.content_version,
    )


class _MarkedRejected(RuntimeError):
    pass


def _window_identity(copy: ledger.ArchiveCopy) -> WindowIdentity:
    return WindowIdentity(copy.dataset_id, copy.provider_id, copy.window_key, copy.revision)


def _rejection_path(copy: ledger.ArchiveCopy) -> str:
    day = date.fromisoformat(copy.window_key)
    endpoint = copy.dataset_id.removeprefix("capture.")
    return _prefix(copy.provider_id, endpoint, day) + f"{copy.content_version}.rejected.json.gz"


def _read_rejection(
    storage: BronzeStorageResolver, copy: ledger.ArchiveCopy
) -> tuple[datetime, str] | None:
    archive, key = storage(copy.storage_backend), _rejection_path(copy)
    if not archive.exists(key):
        return None
    with archive.open_stream(key) as stream:
        marker = json.loads(gzip.decompress(stream.read()))
    if any(marker[k] != v for k, v in _copy_identity(copy).items()):
        raise ValueError("rejection marker identity differs")
    stamp, reason = datetime.fromisoformat(marker["rejected_at_utc"]), marker["reason"]
    if stamp.utcoffset() is None or not isinstance(reason, str) or not reason:
        raise ValueError("invalid rejection marker time or reason")
    return stamp, reason


def _mark_sealed(
    connection: Connection,
    storage: BronzeStorageResolver,
    copy: ledger.ArchiveCopy,
    actor: str | None,
) -> None:
    identity = _copy_identity(copy)
    with connection.begin(), ledger_select.ledger_for(connection).session(
        _window_identity(copy)
    ) as window:
        marker = _reconcile_rejection(window, storage, copy, actor)
        if marker is None:
            window.mark_sealed(copy.content_version, actor=actor)
    if marker is not None:
        raise _MarkedRejected(f"could not seal copy {identity}: {marker[1]}")


def reconcile_rejection_marker(
    connection: Connection,
    storage: BronzeStorageResolver,
    copy: ledger.ArchiveCopy,
    *,
    actor: str | None = None,
) -> tuple[datetime, str] | None:
    """Reconcile a marker; WindowChanged propagates without retry.

    PostgreSQL persists at outer commit, R2 at session exit. Callers may rely on
    neither coupling; PostgreSQL rollback cannot undo R2 writes.
    """
    with ledger_select.ledger_for(connection).session(_window_identity(copy)) as window:
        return _reconcile_rejection(window, storage, copy, actor)


def _reconcile_rejection(
    window: WindowSession, storage: BronzeStorageResolver, copy: ledger.ArchiveCopy,
    actor: str | None,
) -> tuple[datetime, str] | None:
    marker = _read_rejection(storage, copy)
    version = copy.content_version
    if marker is not None:
        current = next((c for c in window.copies() if c.content_version == version), None)
        if current is not None and current.rejected_at_utc is None:
            window.mark_rejected(version, rejected_at=marker[0], reason=marker[1], actor=actor)
    return marker


def _write_rejection_marker(
    storage: BronzeStorageResolver,
    copy: ledger.ArchiveCopy,
    data: bytes,
) -> None:
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "rejected.json.gz"
        path.write_bytes(data)
        try:
            storage(copy.storage_backend).put_if_absent(path, _rejection_path(copy))
        except ObjectAlreadyExists:
            pass


def reject_capture_copy(
    connection: Connection,
    storage: BronzeStorageResolver,
    copy: ledger.ArchiveCopy,
    *,
    reason: str,
    actor: str | None = None,
) -> bool:
    """WindowChanged propagates without retry.

    PostgreSQL persists at outer commit, R2 at session exit. Callers may rely on
    neither coupling; PostgreSQL rollback cannot undo R2 writes.
    """
    with connection.begin(), ledger_select.ledger_for(connection).session(
        _window_identity(copy)
    ) as window:
        version = copy.content_version
        current = next((c for c in window.copies() if c.content_version == version), None)
        fields = ("sealed_at_utc", "rejected_at_utc", "verified_at_utc")
        if current is None or any(
            (getattr(current, k) is None) != (getattr(copy, k) is None) for k in fields
        ):
            return False
        rejected_at = window.now()
        data = canonical_json(
            dict(_copy_identity(copy), reason=reason, rejected_at_utc=rejected_at)
        )
        _write_rejection_marker(storage, copy, gzip.compress(data, compresslevel=9, mtime=0))
        marker = _read_rejection(storage, copy)
        assert marker is not None
        window.mark_rejected(version, rejected_at=marker[0], reason=marker[1], actor=actor)
    return True


def _object_matches(
    archive: BronzeStorage,
    key: str | None,
    size: int | None,
    sha256: str | None,
) -> bool:
    if key is None:
        return False
    digest, length = hashlib.sha256(), 0
    try:
        with archive.open_stream(key) as source:
            while chunk := source.read(64 * 1024):
                length += len(chunk)
                digest.update(chunk)
    except Exception:
        if not archive.exists(key):
            return False
        raise
    return (size is None or length == size) and digest.hexdigest() == sha256


def _day_copies(
    connection: Connection, provider: str, endpoint: str, day: date
) -> list[ledger.ArchiveCopy]:
    with connection.begin():
        return ledger_select.ledger_for(connection).find_copies(
            dataset_id="capture." + endpoint, provider_id=provider, start=day, end=day
        )


def _repair_allocated(
    connection: Connection,
    storage: BronzeStorageResolver,
    provider: str,
    endpoint: str,
    day: date,
    actor: str | None,
) -> None:
    for copy in _day_copies(connection, provider, endpoint, day):
        if copy.state != "allocated":
            continue
        archive = storage(copy.storage_backend)
        manifest_ok = _object_matches(archive, copy.manifest_path, None, copy.manifest_sha256)
        pack_ok = copy.manifest_path is not None and (
            copy.storage_path is None
            or _object_matches(archive, copy.storage_path, copy.byte_size, copy.sha256)
        )
        if manifest_ok and pack_ok:
            try:
                _mark_sealed(connection, storage, copy, actor)
            except _MarkedRejected:
                pass
        else:
            reject_capture_copy(connection, storage, copy, reason="incomplete_write", actor=actor)


def _put_checked(
    connection: Connection,
    storage: BronzeStorageResolver,
    copy: ledger.ArchiveCopy,
    path: Path,
    key: str,
    size: int,
    sha256: str,
    actor: str | None,
) -> None:
    archive = storage(copy.storage_backend)
    try:
        archive.put_if_absent(path, key)
    except ObjectAlreadyExists:
        if not _object_matches(archive, key, size, sha256):
            reject_capture_copy(connection, storage, copy, reason="key_taken", actor=actor)
            raise


def _highest_version(archive: BronzeStorage, prefix: str) -> int:
    pattern = re.compile(re.escape(prefix) + r"([1-9][0-9]*)\..+")
    return max(
        (int(match[1]) for key in archive.list_keys(prefix) if (match := pattern.fullmatch(key))),
        default=0,
    )


def _write_objects(
    connection: Connection,
    storage: BronzeStorageResolver,
    copy: ledger.ArchiveCopy,
    local: "LocalPack",
    directory: Path,
    data: bytes,
    actor: str | None,
) -> None:
    if copy.storage_path is not None:
        assert local.path is not None and copy.byte_size is not None and copy.sha256 is not None
        _put_checked(
            connection,
            storage,
            copy,
            local.path,
            copy.storage_path,
            copy.byte_size,
            copy.sha256,
            actor,
        )
    path = directory / "manifest.json.gz"
    path.write_bytes(data)
    assert copy.manifest_path is not None
    _put_checked(
        connection,
        storage,
        copy,
        path,
        copy.manifest_path,
        len(data),
        hashlib.sha256(data).hexdigest(),
        actor,
    )


def seal_capture_day(
    connection: Connection,
    storage: BronzeStorageResolver,
    *,
    provider_id: str,
    endpoint_key: str,
    utc_date: date,
    archive_backend: str,
    sealed_by: str,
    actor: str | None = None,
) -> ledger.ArchiveCopy:
    """WindowChanged propagates without retry.

    PostgreSQL persists at outer commit, R2 at session exit. Callers may rely on
    neither coupling; PostgreSQL rollback cannot undo R2 writes.
    """
    if not sealed_by or actor == "" or archive_backend not in ("local", "s3"):
        raise ValueError("invalid sealed_by, actor or archive_backend")
    if connection.in_transaction():
        raise ValueError("seal requires a connection without a transaction")
    _repair_allocated(connection, storage, provider_id, endpoint_key, utc_date, actor)
    day = _read_day(connection, storage, provider_id, endpoint_key, utc_date)
    if isinstance(day, ledger.ArchiveCopy):
        return day
    feed_id, feed_kind, record, fingerprint = day
    with tempfile.TemporaryDirectory() as folder:
        directory = Path(folder)
        local = pack_working_day(record, storage, directory=directory)
        archive = storage(archive_backend)
        prefix = _prefix(provider_id, endpoint_key, utc_date)
        highest = _highest_version(archive, prefix)
        manifest, data = _allocate(
            connection, local, feed_id, feed_kind, highest, archive_backend, sealed_by, fingerprint
        )
        copy = next(
            c
            for c in _day_copies(connection, provider_id, endpoint_key, utc_date)
            if c.content_version == manifest.content_version
        )
        _write_objects(connection, storage, copy, local, directory, data, actor)
        _mark_sealed(connection, storage, copy, actor)
    return next(
        c
        for c in _day_copies(connection, provider_id, endpoint_key, utc_date)
        if c.content_version == manifest.content_version
    )


@dataclass(frozen=True)
class LocalPack:
    record: PollRecord
    pack: PackResult | None
    path: Path | None


def _read_capture(capture: CaptureEntry, store: BronzeStorage) -> bytes | None:
    try:
        with store.open_stream(capture.storage_path) as source:
            payload = bytearray()
            while chunk := source.read(64 * 1024):
                payload.extend(chunk)
    except Exception:
        if not store.exists(capture.storage_path):
            return None
        raise
    return bytes(payload)


def _checked_captures(
    record: PollRecord,
    storage: BronzeStorageResolver,
    missing: dict[tuple[str, int], str],
) -> Iterator[bytes]:
    for capture in record.captures:
        payload = _read_capture(capture, storage(capture.storage_backend))
        reason = None
        if payload is None:
            reason = OBJECT_ABSENT
        elif (
            len(payload) != capture.byte_size
            or hashlib.sha256(payload).hexdigest() != capture.sha256
        ):
            reason = OBJECT_MISMATCH
        if reason is not None:
            missing[capture.index_family, capture.capture_row_id] = reason
        else:
            assert payload is not None
            yield payload
        del payload


def _packed_record(
    record: PollRecord, pack: PackResult | None, missing: dict[tuple[str, int], str]
) -> PollRecord:
    entries = iter(pack.captures if pack else ())
    captures = []
    for capture in record.captures:
        if (capture.index_family, capture.capture_row_id) not in missing:
            entry = next(entries)
            if (entry.byte_size, entry.sha256) != (capture.byte_size, capture.sha256):
                raise RuntimeError("packed capture differs from its row")
            capture = replace(capture, packed=True, stream=entry.stream, offset=entry.offset)
        captures.append(capture)
    polls = list(record.polls)
    for key, reason in missing.items():
        matches = [
            i
            for i, poll in enumerate(polls)
            if (poll.index_family, poll.capture_row_id) == key and poll.status == "stored"
        ]
        if len(matches) != 1:
            raise PollRecordInvalid(f"capture {key} needs exactly one stored poll")
        i = matches[0]
        polls[i] = replace(polls[i], status="capture_missing", missing_reason=reason)
    return ordered_record(replace(record, captures=tuple(captures), polls=tuple(polls)))


def pack_working_day(
    record: PollRecord, storage: BronzeStorageResolver, *, directory: Path
) -> LocalPack:
    record = ordered_record(record)
    if any(c.packed or c.stream is not None or c.offset is not None for c in record.captures):
        raise ValueError("expected a working poll record without packed captures")
    path = directory / f"{record.feed_day.utc_date.isoformat()}.pack.xz"
    out = path.open("xb")
    try:
        missing: dict[tuple[str, int], str] = {}
        with out:
            pack = write_pack(_checked_captures(record, storage, missing), out)
        if pack is None:
            path.unlink()
        else:
            with path.open("rb") as source:
                for _ in read_pack(source, pack.streams, pack.captures):
                    pass
        return LocalPack(_packed_record(record, pack, missing), pack, path if pack else None)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
