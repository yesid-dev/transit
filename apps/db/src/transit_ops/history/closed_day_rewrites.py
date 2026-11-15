"""Dormant guards; callers own frozen input inventory and transactions.

Untagged changed events from mark_changed/lock_window are window state marks,
not rewrite audits. Reconciliation ignores those marks: changed rewrite audits
carry rewrite.operation_id and phase started/failed/silver_only; completion
processing_evidence carries that same operation_id (control rulings 32/33a).
The caller allocates one fresh operation_id per rewrite, shared across its
windows. This helper refuses same-window reuse; it is not a global allocator.
Transaction retries reuse their admitted ticket with a fresh observer.

LOCK ORDER: caller transaction/provider build lock, then history window sessions
sorted by provider/dataset/window/revision, then affected fact/day locks. Retain
those sessions through finish; never open a second session on a held window.
Close sessions before caller commit; PG window locks last until outer commit.
Preflight is a short committed transaction before Silver; validate ALL selected
windows before execution. Failure audit uses a short transaction after rollback.
rewrite_observer: begin(Connection, GoldBuildContext, tuple[RewriteSource, ...])
/ finish(Connection, same GoldBuildContext, tuple[RewriteCapture, ...]). Revalidate
before facts; record outcomes with window=that_session after facts. No parsing,
projection, commit or rollback. Retries need fresh observers; R2 needs reconciliation.
"""

import json
import re
from collections.abc import Mapping
from contextlib import nullcontext
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import TYPE_CHECKING, Literal, Protocol

from sqlalchemy import Connection

from transit_ops.history.datasets import CaptureSource, get_dataset, utc_day_closes_at
from transit_ops.history.ledger import WindowState
from transit_ops.history.ledger_store import (
    LedgerStore,
    WindowChanged,
    WindowIdentity,
    WindowSession,
)
from transit_ops.history.rewrite_evidence import _provenance, processing_evidence_details

if TYPE_CHECKING:
    from transit_ops.gold.marts import GoldBuildContext


@dataclass(frozen=True)
class RewriteSource:
    identity: WindowIdentity
    capture_id: int
    source_hash: str | None


@dataclass(frozen=True)
class RewriteCapture:
    source: RewriteSource
    row_count: int


class RewriteObserver(Protocol):
    def begin(
        self,
        connection: Connection,
        context: "GoldBuildContext",
        sources: tuple[RewriteSource, ...],
    ) -> None: ...
    def finish(
        self,
        connection: Connection,
        context: "GoldBuildContext",
        captures: tuple[RewriteCapture, ...],
    ) -> None: ...


@dataclass(frozen=True)
class RewriteTicket:
    identity: WindowIdentity
    operation_id: str
    command: str
    capture_ids: tuple[int, ...]
    provenance: Mapping[str, object]
    expected_current_version: int | None
    expected_working_changed_at_utc: datetime | None


class WindowTrimmed(ValueError):
    """Working rows were deliberately removed; replay cannot restore them."""


def _present(state: WindowState | None, identity: WindowIdentity) -> None:
    if state is not None and state.working_state in {"partial", "trimmed"}:
        scope = f"{identity.provider_id}/{identity.dataset_id}/{identity.window_key}"
        raise WindowTrimmed(f"window_trimmed: {scope}; history-restore unavailable in this build")


def _json(value: object) -> None:
    if isinstance(value, str) and re.search(r"[\x00-\x1f\x7f-\x9f]", value):
        raise ValueError("rewrite metadata: forbidden control character")
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("rewrite metadata requires JSON string keys")
            _json(key)
            _json(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _json(item)
    json.dumps(value, allow_nan=False)


def _envelope(ticket: RewriteTicket, edition: Mapping[str, object] | None) -> dict[str, object]:
    stamp = ticket.expected_working_changed_at_utc
    return dict(
        schema=1,
        operation_id=ticket.operation_id,
        expected_current_version=ticket.expected_current_version,
        expected_working_changed_at_utc=None
        if stamp is None
        else stamp.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        edition=None if edition is None else dict(edition),
        provenance=deepcopy(dict(ticket.provenance)),
    )


def begin_rewrite(
    store: LedgerStore,
    identity: WindowIdentity,
    *,
    command: str,
    operation_id: str,
    capture_ids: tuple[int, ...],
    provenance: Mapping[str, object],
    hold_for: timedelta | None = None,
    actor: str | None = None,
) -> RewriteTicket | None:
    """Admit one window; caller commits intent before Silver, never inside this helper."""
    source = get_dataset(identity.dataset_id).source
    if not isinstance(source, CaptureSource) or identity.revision != 0:
        raise ValueError("rewrite_source_missing: expected a capture day at revision 0")
    _json([operation_id, command, dict(provenance), actor])
    try:
        _provenance(provenance, command, {})
    except ValueError as exc:
        raise ValueError(f"rewrite_source_missing: {exc}") from exc
    if not operation_id.strip() or not command.strip():
        raise ValueError("rewrite metadata requires operation_id and command")
    if provenance.get("capture_ids") != list(capture_ids) or any(
        type(i) is not int for i in capture_ids
    ):
        raise ValueError("rewrite_source_missing: exact capture identities required")
    with store.session(identity) as window:
        state, now = window.state(), window.now()
        _present(state, identity)
        if now < utc_day_closes_at(date.fromisoformat(identity.window_key)):
            return None
        for event in window.events():
            previous = event.details.get("rewrite")
            if isinstance(previous, Mapping) and previous.get("operation_id") == operation_id:
                raise ValueError(f"rewrite_operation_id_reused: {operation_id}")
        window.mark_changed(actor=actor)
        changed = window.state()
        ticket = RewriteTicket(
            identity,
            operation_id,
            command,
            capture_ids,
            deepcopy(dict(provenance)),
            None if changed is None else changed.current_version,
            None if changed is None else changed.working_changed_at_utc,
        )
        until = now + max(timedelta(hours=24), hold_for or timedelta(hours=24))
        if state is None or state.hold_until_utc is None or state.hold_until_utc < until:
            window.hold(until_utc=until, reason=command, actor=actor)
        store.record_audit(
            identity,
            "changed",
            {"phase": "started", "rewrite": _envelope(ticket, None)},
            reason=f"{command}: started",
            actor=actor,
        )
        return ticket


def revalidate_rewrite(
    window: WindowSession, ticket: RewriteTicket, capture_ids: tuple[int, ...]
) -> None:
    """Call inside the actual write session BEFORE touching facts or serving state."""
    state = window.state()
    _present(state, ticket.identity)
    if window.identity != ticket.identity or capture_ids != ticket.capture_ids:
        raise ValueError("rewrite_source_changed: frozen selection differs")
    baseline = (
        (None, None) if state is None else (state.current_version, state.working_changed_at_utc)
    )
    if baseline != (ticket.expected_current_version, ticket.expected_working_changed_at_utc):
        raise WindowChanged("rewrite_window_changed: preflight baseline differs")


def record_rewrite_outcome(
    store: LedgerStore,
    ticket: RewriteTicket,
    *,
    phase: Literal["silver_only", "failed", "completed"],
    edition: Mapping[str, object] | None = None,
    rows_by_capture: Mapping[int, int] | None = None,
    actor: str | None = None,
    window: WindowSession | None = None,
) -> None:
    """Reuse a held session; the caller owns the short audit or fact transaction."""
    with store.session(ticket.identity) if window is None else nullcontext(window) as window:
        _present(window.state(), ticket.identity)
        if window.identity != ticket.identity:
            raise ValueError("rewrite_source_changed: wrong session")
        rewrite = _envelope(ticket, edition)
        _json([rewrite, actor])
        if phase == "completed":
            revalidate_rewrite(window, ticket, ticket.capture_ids)
            if (
                edition is None
                or edition.get("provider_id") != ticket.identity.provider_id
                or rows_by_capture is None
                or set(rows_by_capture) != set(ticket.capture_ids)
            ):
                raise ValueError("rewrite_source_missing: edition and exact counts required")
            source = get_dataset(ticket.identity.dataset_id).source
            assert isinstance(source, CaptureSource)
            details = processing_evidence_details(
                command=ticket.command,
                completed_at_utc=window.now(),
                index_family=source.index_family,
                rows_by_capture=rows_by_capture,
                rewrite=rewrite,
            )
            kind: Literal["changed", "processing_evidence"] = "processing_evidence"
        elif phase in {"failed", "silver_only"} and rows_by_capture is None:
            details, kind = {"phase": phase, "rewrite": rewrite}, "changed"
        else:
            raise ValueError("invalid rewrite outcome")
        window.mark_changed(actor=actor)
        store.record_audit(
            ticket.identity, kind, details, reason=f"{ticket.command}: {phase}", actor=actor
        )
