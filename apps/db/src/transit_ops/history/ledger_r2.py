"""Optimistic window sessions over the private write-ahead ledger.

Adapter-assigned copy times are monotonic per copy; adjustments above five
minutes fail closed. Envelopes retain the session clock. Caller times are only
checked, never adjusted.
"""

import json
from collections.abc import Callable, Collection, Iterator, Mapping
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, fields, replace
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Never, cast, get_args

from transit_ops.control.objects import ConditionalObjects
from transit_ops.history import datasets, ledger
from transit_ops.history.ledger_r2_documents import EventRecord, Transition, WindowDocument
from transit_ops.history.ledger_r2_readers import WindowCursor, events, recover
from transit_ops.history.ledger_r2_transitions import apply_transition
from transit_ops.history.ledger_store import (
    AUDIT_KINDS,
    LedgerStore,
    NewCopy,
    RecordedEvent,
    WindowChanged,
    WindowIdentity,
    validate_new_copy,
)
from transit_ops.history.ledger_store import validate_no_nul as _nul


def _identity(identity: WindowIdentity) -> tuple[str, str, int, str]:
    _nul(asdict(identity))
    ledger._window_start(
        datasets.get_dataset(identity.dataset_id), identity.window_key, identity.revision
    )
    return identity.dataset_id, identity.provider_id, identity.revision, identity.window_key


def _text(value: object) -> None:
    _nul(value)
    if value == "":
        raise ValueError("reason and actor must not be empty")


def _aware(at: datetime) -> datetime:
    if not isinstance(at, datetime) or at.utcoffset() is None:
        raise ValueError("copy time must be an aware datetime")
    return at.astimezone(UTC)


def _audit_kind(kind: ledger.EventKind) -> None:
    if kind not in AUDIT_KINDS:
        raise ValueError(f"record_event refuses lifecycle kind {kind!r}; use its guarded verb")


def project_state(doc: WindowDocument | None) -> ledger.WindowState | None:
    if doc is None:
        return None
    values = {f.name: getattr(doc, f.name) for f in fields(ledger.WindowState)}
    if doc.working_state not in {"partial", "trimmed"}:
        values["remainder_fingerprint"] = None
    return ledger.WindowState(**values)


class LedgerClockSkew(RuntimeError):
    """The session clock is too far behind the copy's stored times."""


def _latest(copy: ledger.ArchiveCopy) -> datetime:
    return max(
        t
        for t in (copy.allocated_at_utc, copy.sealed_at_utc, copy.verified_at_utc)
        if t is not None
    )


class R2Ledger:
    def __init__(
        self,
        objects: ConditionalObjects,
        clock: Callable[[], datetime],
        default_actor: str,
        max_attempts: int,
    ) -> None:
        if not isinstance(default_actor, str):
            raise ValueError("default_actor must be str")
        _text(default_actor or "")
        if type(max_attempts) is not int or not 1 <= max_attempts <= 20:
            raise ValueError("max_attempts must be from 1 to 20")
        self.objects, self.clock = objects, clock
        self.default_actor, self.max_attempts = default_actor, max_attempts

    @contextmanager
    def session(self, identity: WindowIdentity) -> Iterator["_Session"]:
        key = _identity(identity)
        cursor = recover(self.objects, key, max_attempts=self.max_attempts)
        session = _Session(self, identity, cursor, _aware(self.clock()))
        yield session
        if session.failed:
            raise RuntimeError("ledger session failed; all session writes rolled back")
        if session.doc == cursor.doc and not session.records:
            return

        def change(current: WindowCursor, at: datetime) -> Transition:
            if (current.next_seq, current.next_record) != (cursor.next_seq, cursor.next_record):
                raise WindowChanged(f"history window changed: {identity}")
            after = replace(session.doc, seq=current.next_seq) if session.doc else None
            records = tuple(
                EventRecord(**{k: v for k, v in asdict(r).items() if k != "at_utc"})
                for r in session.records
            )
            return Transition(after, records)

        apply_transition(
            self.objects, key, change, clock=session.now, max_attempts=self.max_attempts
        )

    def record_audit(
        self,
        identity: WindowIdentity,
        kind: ledger.EventKind,
        details: Mapping[str, object],
        *,
        reason: str | None = None,
        actor: str | None = None,
    ) -> RecordedEvent:
        key = _identity(identity)
        _audit_kind(kind)
        record = self._event_record(kind, None, actor, reason, details, 1, _aware(self.clock()))
        written = record

        def change(cursor: WindowCursor, at: datetime) -> Transition:
            nonlocal written
            written = replace(record, sequence=cursor.next_record)
            event = EventRecord(**{k: v for k, v in asdict(written).items() if k != "at_utc"})
            after = replace(cursor.doc, seq=cursor.next_seq) if cursor.doc else None
            return Transition(after, (event,))

        apply_transition(
            self.objects, key, change, clock=lambda: record.at_utc, max_attempts=self.max_attempts
        )
        return written

    def _event_record(
        self,
        kind: ledger.EventKind,
        version: int | None,
        actor: str | None,
        reason: str | None,
        details: Mapping[str, object] | None,
        sequence: int,
        at: datetime,
    ) -> RecordedEvent:
        _text(actor)
        _text(reason)
        _nul(details)
        details = json.loads(json.dumps(details or {}, sort_keys=True, allow_nan=False))
        if version is not None and version < 1:
            raise ValueError("content_version must be positive")
        return RecordedEvent(
            sequence,
            kind,
            version,
            reason,
            dict(details or {}),
            self.default_actor if actor is None else actor,
            at,
        )

    def window_state(self, identity: WindowIdentity) -> ledger.WindowState | None:
        doc = recover(self.objects, _identity(identity), max_attempts=self.max_attempts).doc
        return project_state(doc)

    def events(
        self, identity: WindowIdentity, *, kinds: Collection[str] | None = None
    ) -> list[RecordedEvent]:
        return [
            RecordedEvent(**asdict(r))
            for r in events(
                self.objects, _identity(identity), kinds=kinds, max_attempts=self.max_attempts
            )
        ]

    def find_copies(
        self, *, dataset_id: str, provider_id: str, start: date, end: date, revision: int = 0
    ) -> list[ledger.ArchiveCopy]:
        dataset = datasets.get_dataset(dataset_id)
        if start > end:
            raise ValueError("start must not be after end")
        ledger._check_revision(dataset, revision)
        if dataset.archive_grain == "edition":
            return []
        copies: list[ledger.ArchiveCopy] = []
        for offset in range((end - start).days + 1):
            day = start + timedelta(days=offset)
            if dataset.archive_grain == "month" and day.day != 1:
                continue
            window = day.isoformat()[:7] if dataset.archive_grain == "month" else day.isoformat()
            current = recover(
                self.objects,
                (dataset_id, provider_id, revision, window),
                max_attempts=self.max_attempts,
            ).doc
            if current:
                copies.extend(current.copies)
        return sorted(copies, key=lambda c: (c.window_start, c.window_key, c.content_version))


class _Session:
    def __init__(
        self, store: R2Ledger, identity: WindowIdentity, cursor: WindowCursor, now: datetime
    ) -> None:
        self.store, self.identity, self.cursor, self.at = store, identity, cursor, now
        self.doc, self.records = cursor.doc, list[RecordedEvent]()
        self.failed = False
        self.prior = [
            RecordedEvent(**asdict(r))
            for r in events(store.objects, _identity(identity), max_attempts=store.max_attempts)
            if r.sequence < cursor.next_record
        ]

    def now(self) -> datetime:
        self.state()
        return self.at

    def state(self) -> ledger.WindowState | None:
        if self.failed:
            raise RuntimeError("ledger session failed; only exit is permitted")
        return project_state(self.doc)

    def copies(self) -> list[ledger.ArchiveCopy]:
        self.state()
        return deepcopy(list(self.doc.copies)) if self.doc else []

    def events(self, *, kinds: Collection[str] | None = None) -> list[RecordedEvent]:
        self.state()
        return deepcopy([r for r in self.prior + self.records if kinds is None or r.kind in kinds])

    def processing_events(self) -> list[RecordedEvent]:
        return self.events(kinds={"processing_evidence"})

    def record_event(
        self,
        kind: ledger.EventKind,
        *,
        content_version: int | None = None,
        reason: str | None = None,
        details: Mapping[str, object] | None = None,
        actor: str | None = None,
    ) -> None:
        _audit_kind(kind)
        self._record(kind, content_version, actor, reason, details)

    def _record(
        self,
        kind: ledger.EventKind,
        content_version: int | None = None,
        actor: str | None = None,
        reason: str | None = None,
        details: Mapping[str, object] | None = None,
    ) -> None:
        self.records.append(
            self.store._event_record(
                kind,
                content_version,
                actor,
                reason,
                details,
                self.cursor.next_record + len(self.records),
                self.now(),
            )
        )

    def mark_changed(self, *, actor: str | None = None) -> None:
        self._record("changed", actor=actor)
        self.doc = replace(
            self._window(), working_state="present", working_changed_at_utc=self.now()
        )

    def _window(self) -> WindowDocument:
        self.state()
        if self.doc is None:
            start = datasets.window_start(
                datasets.get_dataset(self.identity.dataset_id), self.identity.window_key
            )
            self.doc = WindowDocument(
                *_identity(self.identity),
                start,
                "present",
                self.now(),
                1,
                None,
                None,
                None,
                None,
                None,
                self.cursor.next_seq,
                (),
            )
        return self.doc

    def allocate_version(self, *, above_version: int = 0) -> int:
        if above_version < 0:
            raise ValueError("above_version must be nonnegative")
        doc = self._window()
        version = max(doc.next_version, above_version + 1)
        self.doc = replace(doc, next_version=version + 1)
        return version

    def set_working_state(self, state: ledger.WorkingState) -> None:
        self.state()
        if state not in get_args(ledger.WorkingState):
            raise ValueError("unknown working state")
        if self.doc and self.doc.working_state in {"present", "empty"}:
            self.doc = replace(self.doc, working_state=state)

    def _refuse(self, action: str, version: int) -> Never:
        self.failed = True
        identity = {**asdict(self.identity), "content_version": version}
        verb = "make copy current" if action == "make current" else f"{action} copy"
        raise RuntimeError(f"could not {verb} {identity}")

    def _put(self, copy: ledger.ArchiveCopy) -> None:
        assert self.doc is not None
        copies = {c.content_version: c for c in self.doc.copies}
        copies[copy.content_version] = copy
        self.doc = replace(self.doc, copies=tuple(copies[v] for v in sorted(copies)))

    def insert_allocated_copy(self, copy: NewCopy) -> None:
        validate_new_copy(copy, self.identity)
        _nul(asdict(copy))
        details = json.loads(json.dumps(dict(copy.details), sort_keys=True, allow_nan=False))
        copy = replace(copy, details=details)
        if (
            not self.state()
            or not self.doc
            or copy.content_version >= self.doc.next_version
            or any(c.content_version == copy.content_version for c in self.copies())
        ):
            self._refuse("insert", copy.content_version)
        self._put(
            ledger.ArchiveCopy(
                **asdict(self.identity),
                **asdict(copy),
                allocated_at_utc=self.now(),
                sealed_at_utc=None,
                verified_at_utc=None,
                rejected_at_utc=None,
                reject_reason=None,
                window_start=self.doc.window_start,
                is_current=False,
            )
        )

    def _copy(self, version: int, action: str, actor: str | None) -> ledger.ArchiveCopy:
        _text(actor)
        if version < 1:
            raise ValueError("content_version must be positive")
        copy = next((c for c in self.copies() if c.content_version == version), None)
        if copy is None:
            self._refuse(action, version)
        return copy

    def mark_sealed(self, content_version: int, *, actor: str | None = None) -> None:
        copy = self._copy(content_version, "seal", actor)
        if copy.sealed_at_utc is not None or copy.rejected_at_utc is not None:
            self._refuse("seal", content_version)
        at = max(self.now(), _latest(copy))
        if at - self.now() > timedelta(minutes=5):
            self.failed = True
            raise LedgerClockSkew(f"clock is more than five minutes behind copy {content_version}")
        self._put(replace(copy, sealed_at_utc=at))
        self._record("seal", content_version, actor)

    def mark_rejected(
        self, content_version: int, *, rejected_at: datetime, reason: str, actor: str | None = None
    ) -> None:
        at = _aware(rejected_at)
        _text(reason)
        copy = self._copy(content_version, "reject", actor)
        if copy.rejected_at_utc is not None or copy.verified_at_utc is not None:
            self._refuse("reject", content_version)
        if at < _latest(copy):
            self._refuse("reject", content_version)
        self._put(replace(copy, rejected_at_utc=at, reject_reason=reason))
        self._record("reject", content_version, actor, reason)

    def make_current(
        self, content_version: int, *, verified_at: datetime, actor: str | None = None
    ) -> None:
        at = _aware(verified_at)
        copy = self._copy(content_version, "verify", actor)
        if (
            copy.sealed_at_utc is None
            or copy.verified_at_utc is not None
            or copy.rejected_at_utc is not None
            or at < copy.sealed_at_utc
        ):
            self._refuse("verify", content_version)
        assert self.doc is not None
        previous = self.doc.current_version
        if previous is not None and previous >= content_version:
            self._refuse("make current", content_version)
        self._put(replace(copy, verified_at_utc=at))
        self.doc = replace(
            self.doc,
            current_version=content_version,
            copies=tuple(
                replace(c, is_current=c.content_version == content_version) for c in self.copies()
            ),
        )
        self._record("verify", content_version, actor)
        self._record("current", content_version, actor, details={"previous_version": previous})

    def hold(self, *, until_utc: datetime | None, reason: str, actor: str | None = None) -> None:
        _text(reason)
        _text(actor)
        until = _aware(until_utc) if until_utc is not None else None
        if not self.state() or self.doc is None:
            raise ledger.WindowNotFound(f"history window not found: {asdict(self.identity)}")
        details = (
            {}
            if until is None
            else {
                "until_utc": "infinity"
                if until == ledger.HOLD_NO_END
                else until.isoformat(timespec="microseconds").replace("+00:00", "Z")
            }
        )
        self.doc = replace(self.doc, hold_until_utc=until, hold_reason=reason if until else None)
        self._record(
            "unhold" if until is None else "hold", actor=actor, reason=reason, details=details
        )


if TYPE_CHECKING:
    _ledger_store_contract: LedgerStore = cast(R2Ledger, None)
