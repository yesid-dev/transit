"""Combine archived and working feed-day metadata without reading capture bytes."""

from dataclasses import asdict, replace
from datetime import UTC

from transit_ops.history.manifest import Manifest
from transit_ops.history.poll_record import (
    CaptureEntry,
    FeedDayKey,
    PollEntry,
    PollRecord,
    PollRecordInvalid,
    ProcessingEntry,
    canonical_json,
    observed_interval_ms,
    ordered_record,
)


def _identity(day: FeedDayKey) -> str:
    return f"{day.provider_id}/{day.endpoint_key}/{day.utc_date}"


def _source(capture: CaptureEntry) -> bytes:
    value = asdict(capture)
    for field in ("packed", "stream", "offset"):
        del value[field]
    return canonical_json(value)


def _polls(current: Manifest, working: PollRecord) -> tuple[PollEntry, ...]:
    polls = {p.ingestion_run_id: p for p in current.polls}
    packed = {(c.index_family, c.capture_row_id) for c in current.captures if c.packed}
    for poll in working.polls:
        old = polls.get(poll.ingestion_run_id)
        if old is not None:
            fields = ("run_kind", "requested_at_utc", "started_at_utc", "index_family")
            if any(
                canonical_json(getattr(old, f)) != canonical_json(getattr(poll, f)) for f in fields
            ) or (old.capture_row_id is not None and old.capture_row_id != poll.capture_row_id):
                raise PollRecordInvalid(
                    f"{_identity(working.feed_day)}: conflicting poll "
                    f"{poll.ingestion_run_id} source"
                )
            # Raw rows do not establish that previously missing bytes are now usable.
            if (old.index_family, old.capture_row_id) in packed:
                poll = replace(poll, status="stored", missing_reason=None)
            elif old.status == "capture_missing":
                poll = replace(poll, status=old.status, missing_reason=old.missing_reason)
        polls[poll.ingestion_run_id] = poll
    return tuple(polls.values())


def _gold(old: ProcessingEntry, fresh: ProcessingEntry, day: FeedDayKey) -> ProcessingEntry:
    before, after = old.completed_at_utc, fresh.completed_at_utc
    if before is not None and after is not None:
        before, after = before.astimezone(UTC), after.astimezone(UTC)
        if before == after and canonical_json(asdict(old)) != canonical_json(asdict(fresh)):
            raise PollRecordInvalid(
                f"{_identity(day)}: conflicting gold_facts "
                f"{fresh.index_family}/{fresh.capture_row_id} at {after.isoformat()}"
            )
        return fresh if after > before else old
    if before is not None:
        return old
    if after is not None:
        return fresh
    return old if fresh.status == "not_observed" else fresh


def _processing(current: Manifest, working: PollRecord) -> tuple[ProcessingEntry, ...]:
    keyed: dict[tuple[str, str, int], ProcessingEntry] = {}
    unattributed: dict[bytes, ProcessingEntry] = {}
    for entry in (*current.processing, *working.processing):
        identity = entry.ingestion_run_id if entry.stage == "silver_load" else entry.capture_row_id
        if identity is None:
            unattributed[canonical_json(asdict(entry))] = entry
            continue
        key = (entry.stage, entry.index_family, identity)
        old = keyed.get(key)
        keyed[key] = (
            _gold(old, entry, working.feed_day)
            if old is not None and entry.stage == "gold_facts"
            else entry
        )
    return (*keyed.values(), *unattributed.values())


def union_capture_record(current: Manifest, working: PollRecord) -> PollRecord:
    """Return an unpacked union; the manifest retains archived byte provenance.

    Source conflicts refuse by feed-day and capture identity. Missing-byte evidence
    remains until a packer verifies recovery; this pure operation cannot verify bytes.
    """
    day = FeedDayKey(
        current.provider_id, current.endpoint_key, current.index_family, current.utc_date
    )
    if day != working.feed_day:
        raise PollRecordInvalid(f"{_identity(day)}: working record describes another feed-day")
    ordered_record(working)
    ordered_record(
        PollRecord(
            day,
            current.polls,
            current.captures,
            current.processing,
            current.declared_interval_seconds,
            current.observed_interval_ms,
        )
    )
    captures = {(c.index_family, c.capture_row_id): c for c in current.captures}
    for capture in working.captures:
        key = (capture.index_family, capture.capture_row_id)
        old = captures.get(key)
        if old is not None and _source(old) != _source(capture):
            raise PollRecordInvalid(
                f"{_identity(day)}: conflicting capture {key[0]}/{key[1]} source metadata or bytes"
            )
        captures.setdefault(key, capture)
    polls = _polls(current, working)
    return ordered_record(
        PollRecord(
            day,
            polls,
            tuple(replace(c, packed=False, stream=None, offset=None) for c in captures.values()),
            _processing(current, working),
            current.declared_interval_seconds,
            observed_interval_ms(p.started_at_utc for p in polls),
        )
    )
