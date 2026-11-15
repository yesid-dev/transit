"""Build checked local packs from working objects and archived capture bytes."""

import hashlib
from collections.abc import Callable, Generator, Iterable
from contextlib import closing
from dataclasses import dataclass, replace
from pathlib import Path

from transit_ops.history.capture_union import union_capture_record
from transit_ops.history.ledger import ArchiveCopy
from transit_ops.history.manifest import Manifest, encode_manifest
from transit_ops.history.pack import (
    BinaryReader,
    BinaryWriter,
    PackCorrupt,
    PackedCapture,
    PackResult,
    read_pack,
    write_pack,
)
from transit_ops.history.poll_record import PollRecord, PollRecordInvalid, ordered_record
from transit_ops.ingestion.storage import BronzeStorageResolver

OBJECT_ABSENT = "object_absent"
OBJECT_MISMATCH = "object_mismatch"
Writer = Callable[[Iterable[bytes], BinaryWriter], PackResult | None]


@dataclass(frozen=True)
class LocalPack:
    record: PollRecord
    pack: PackResult | None
    path: Path | None


def _check_source(record: PollRecord, copy: ArchiveCopy, current: Manifest) -> None:
    if (
        (copy.provider_id, copy.dataset_id, copy.window_key, copy.revision, copy.content_version)
        != (
            current.provider_id,
            "capture." + current.endpoint_key,
            current.utc_date.isoformat(),
            0,
            current.content_version,
        )
        or copy.state != "verified"
        or copy.manifest_sha256 != hashlib.sha256(encode_manifest(current)).hexdigest()
        or (copy.content_sha256, copy.poll_record_sha256)
        != (current.content_sha256, current.poll_record_sha256)
        or (
            current.pack is not None
            and (copy.storage_path, copy.byte_size, copy.sha256)
            != (current.pack.path, current.pack.byte_size, current.pack.sha256)
        )
    ):
        raise PollRecordInvalid("union pack source identity differs")
    union_capture_record(current, record)
    keys = {(c.index_family, c.capture_row_id) for c in record.captures}
    if any((c.index_family, c.capture_row_id) not in keys for c in current.captures):
        raise PollRecordInvalid("union pack is missing an archived capture")


class _HashedSource:
    def __init__(self, source: BinaryReader) -> None:
        self.source = source
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size: int = -1) -> bytes:
        data = self.source.read(size)
        self.digest.update(data)
        self.size += len(data)
        return data


def _archived(
    storage: BronzeStorageResolver, copy: ArchiveCopy, current: Manifest
) -> Generator[bytes, None, None]:
    if current.pack is None:
        return
    entries = []
    for c in current.captures:
        if c.packed:
            assert c.stream is not None and c.offset is not None
            entries.append(PackedCapture(c.stream, c.offset, c.byte_size, c.sha256))
    archive = storage(copy.storage_backend)
    try:
        with archive.open_stream(current.pack.path) as stream:
            source = _HashedSource(stream)
            yield from read_pack(source, current.streams, entries)
            if (
                source.read(1)
                or source.size != current.pack.byte_size
                or source.digest.hexdigest() != current.pack.sha256
            ):
                raise PackCorrupt("archive pack checksum or size differs")
    except Exception as exc:
        if not archive.exists(current.pack.path):
            raise PackCorrupt("archive pack is absent") from exc
        raise


def _union_payloads(
    record: PollRecord,
    storage: BronzeStorageResolver,
    current_copy: ArchiveCopy,
    current: Manifest,
    missing: dict[tuple[str, int], str],
) -> Generator[bytes, None, None]:
    old = iter(c for c in current.captures if c.packed)
    packed_keys = {(c.index_family, c.capture_row_id) for c in current.captures if c.packed}
    expected = next(old, None)
    with closing(_archived(storage, current_copy, current)) as archived:
        for capture in record.captures:
            if expected is not None and (capture.index_family, capture.capture_row_id) == (
                expected.index_family,
                expected.capture_row_id,
            ):
                yield next(archived)
                expected = next(old, None)
            else:
                if (capture.index_family, capture.capture_row_id) in packed_keys:
                    raise PackCorrupt("archive capture order differs")
                yield from _checked_captures(replace(record, captures=(capture,)), storage, missing)
        if expected is not None or next(archived, None) is not None:
            raise PackCorrupt("archive captures were not exhausted")


def pack_union_day(
    record: PollRecord,
    storage: BronzeStorageResolver,
    *,
    current_copy: ArchiveCopy,
    current: Manifest,
    directory: Path,
) -> LocalPack:
    record = ordered_record(record)
    _check_source(record, current_copy, current)
    if any(c.packed or c.stream is not None or c.offset is not None for c in record.captures):
        raise ValueError("expected a union record without packed coordinates")
    missing: dict[tuple[str, int], str] = {}
    payloads = _union_payloads(record, storage, current_copy, current, missing)
    return _pack_day(record, payloads, missing, directory, recover=True)


def _checked_captures(
    record: PollRecord,
    storage: BronzeStorageResolver,
    missing: dict[tuple[str, int], str],
) -> Generator[bytes, None, None]:
    for capture in record.captures:
        store, payload = storage(capture.storage_backend), bytearray()
        reason = None
        try:
            with store.open_stream(capture.storage_path) as source:
                while chunk := source.read(64 * 1024):
                    payload.extend(chunk)
        except Exception:
            if store.exists(capture.storage_path):
                raise
            reason = OBJECT_ABSENT
        if reason is None and (
            len(payload) != capture.byte_size
            or hashlib.sha256(payload).hexdigest() != capture.sha256
        ):
            reason = OBJECT_MISMATCH
        if reason is not None:
            missing[capture.index_family, capture.capture_row_id] = reason
        else:
            yield bytes(payload)
        del payload


def _packed_record(
    record: PollRecord,
    pack: PackResult | None,
    missing: dict[tuple[str, int], str],
    *,
    recover: bool = False,
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
            if (poll.index_family, poll.capture_row_id) == key
            and (poll.status == "stored" or recover and poll.status == "capture_missing")
        ]
        if len(matches) != 1:
            raise PollRecordInvalid(f"capture {key} needs exactly one stored poll")
        i = matches[0]
        if polls[i].status == "stored":
            polls[i] = replace(polls[i], status="capture_missing", missing_reason=reason)
    if recover:
        packed = {(c.index_family, c.capture_row_id) for c in captures if c.packed}
        polls = [
            replace(p, status="stored", missing_reason=None)
            if (p.index_family, p.capture_row_id) in packed
            else p
            for p in polls
        ]
    return ordered_record(replace(record, captures=tuple(captures), polls=tuple(polls)))


def _pack_working_day(
    record: PollRecord,
    storage: BronzeStorageResolver,
    *,
    directory: Path,
    writer: Writer = write_pack,
) -> LocalPack:
    record = ordered_record(record)
    if any(c.packed or c.stream is not None or c.offset is not None for c in record.captures):
        raise ValueError("expected a working poll record without packed captures")
    missing: dict[tuple[str, int], str] = {}
    return _pack_day(
        record, _checked_captures(record, storage, missing), missing, directory, writer
    )


def pack_working_day(
    record: PollRecord, storage: BronzeStorageResolver, *, directory: Path
) -> LocalPack:
    return _pack_working_day(record, storage, directory=directory)


def _pack_day(
    record: PollRecord,
    payloads: Generator[bytes, None, None],
    missing: dict[tuple[str, int], str],
    directory: Path,
    writer: Writer = write_pack,
    *,
    recover: bool = False,
) -> LocalPack:
    path = directory / f"{record.feed_day.utc_date.isoformat()}.pack.xz"
    out = path.open("xb")
    try:
        with closing(payloads), out:
            pack = writer(payloads, out)
        if pack is None:
            path.unlink()
        else:
            with path.open("rb") as source:
                for _ in read_pack(source, pack.streams, pack.captures):
                    pass
        return LocalPack(
            _packed_record(record, pack, missing, recover=recover), pack, path if pack else None
        )
    except BaseException:
        path.unlink(missing_ok=True)
        raise
