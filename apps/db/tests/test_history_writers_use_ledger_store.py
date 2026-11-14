import gzip
import json
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace as NS

import pytest
from history_fixtures import scripted_feed_day
from test_verify_read_back import _store

from transit_ops.history import ledger_select, seal_captures, verify
from transit_ops.history.ledger_postgres import PostgresLedger
from transit_ops.history.ledger_store import WindowChanged, WindowIdentity


@pytest.fixture
def verification(monkeypatch, tmp_path):
    storage, copy, _, record, _, _ = _store(
        tmp_path, *scripted_feed_day(endpoint_key="trip_updates")
    )
    copy = replace(copy, dataset_id="capture.trip_updates")
    now = datetime(2026, 1, 4, tzinfo=UTC)
    calls = []
    state = NS(current_version=None, working_state="present")

    class Store:
        conflict = False

        @contextmanager
        def session(self, identity):
            calls.append(("enter", identity))
            yield self
            if self.conflict:
                raise WindowChanged("concurrent change")
            calls.append("exit")

        def window_state(self, identity):
            return state

        def state(self):
            return state

        def copies(self):
            return [self.copy]

        def find_copies(self, **kwargs):
            return self.copies()

        def now(self):
            return now

        def make_current(self, version, *, verified_at, actor):
            calls.append(("make_current", version, verified_at, actor))
            self.copy = replace(self.copy, verified_at_utc=verified_at, is_current=True)

    store = Store()
    store.copy = copy
    monkeypatch.setattr(ledger_select, "ledger_for", lambda c: store)
    monkeypatch.setattr(verify, "read_working_day", lambda *a, **kw: record)
    monkeypatch.setattr(verify, "rows_fingerprint", lambda *a, **kw: "f" * 64)
    return NS(
        connection=NS(begin=nullcontext, in_transaction=lambda: False),
        storage=storage,
        copy=copy,
        store=store,
        calls=calls,
        now=now,
    )


def test_verify_uses_the_session_clock(verification):
    v = verification
    result = verify.verify_capture_copy(v.connection, v.storage, v.copy, actor="checker")
    assert result.copy.is_current and result.copy.verified_at_utc == v.now
    assert v.calls == [
        ("enter", WindowIdentity("capture.trip_updates", "network", "2026-01-02")),
        ("make_current", 1, v.now, "checker"),
        "exit",
    ]


def test_verify_propagates_window_changed_without_retry(verification):
    v = verification
    v.store.conflict = True
    with pytest.raises(WindowChanged, match="concurrent change"):
        verify.verify_capture_copy(v.connection, v.storage, v.copy)
    assert v.calls == [
        ("enter", WindowIdentity("capture.trip_updates", "network", "2026-01-02")),
        ("make_current", 1, v.now, None),
    ]


def test_verify_reconciles_a_marker_in_its_existing_session(verification, tmp_path):
    v = verification
    marker = dict(
        dataset_id=v.copy.dataset_id,
        provider_id=v.copy.provider_id,
        revision=0,
        window_key=v.copy.window_key,
        content_version=1,
        reason="stale",
        rejected_at_utc=v.now.isoformat(),
    )
    path = tmp_path / "rejection.json.gz"
    path.write_bytes(gzip.compress(json.dumps(marker).encode()))
    v.storage("local").put_if_absent(
        path, "archive/v1/captures/network/trip_updates/2026/01/2026-01-02.c1.rejected.json.gz"
    )

    def rejected(version, *, rejected_at, reason, actor):
        v.calls.append(("mark_rejected", version, rejected_at, reason, actor))
        v.store.copy = replace(v.copy, rejected_at_utc=rejected_at, reject_reason=reason)

    v.store.mark_rejected = rejected
    result = verify.verify_capture_copy(v.connection, v.storage, v.copy, actor="checker")
    assert result.outcome == "rejected"
    assert v.calls == [
        ("enter", WindowIdentity("capture.trip_updates", "network", "2026-01-02")),
        ("mark_rejected", 1, v.now, "stale", "checker"),
        "exit",
    ]


def test_selector_uses_postgres():
    connection = object()
    store = ledger_select.ledger_for(connection)
    assert isinstance(store, PostgresLedger) and store.connection is connection


def test_seal_allocates_then_seals_in_separate_sessions(verification, monkeypatch):
    from dataclasses import asdict

    v = verification
    record, _ = scripted_feed_day(endpoint_key="trip_updates")
    record = replace(record, polls=(), captures=(), processing=())
    monkeypatch.setattr(
        seal_captures, "_read_day", lambda *a: (1, "trip_updates", record, "f" * 64)
    )
    monkeypatch.setattr(seal_captures, "_write_objects", lambda *a: None)
    v.store.allocate_version = lambda **kw: v.calls.append("allocate_version") or 1
    v.store.set_working_state = lambda value: v.calls.append(("set_working_state", value))

    def insert(copy):
        v.calls.append("insert_allocated_copy")
        v.store.copy = replace(v.copy, **asdict(copy), sealed_at_utc=None)

    def sealed(version, **kw):
        v.calls.append(("mark_sealed", version))
        v.store.copy = replace(v.store.copy, sealed_at_utc=v.now)

    v.store.insert_allocated_copy, v.store.mark_sealed = insert, sealed
    result = seal_captures.seal_capture_day(
        v.connection,
        v.storage,
        provider_id="network",
        endpoint_key="trip_updates",
        utc_date=record.feed_day.utc_date,
        archive_backend="local",
        sealed_by="checkpoint",
    )
    assert result.state == "sealed" and result.poll_count == 0
    identity = WindowIdentity("capture.trip_updates", "network", "2026-01-02")
    assert v.calls == [
        ("enter", identity),
        "allocate_version",
        ("set_working_state", "empty"),
        "insert_allocated_copy",
        "exit",
        ("enter", identity),
        ("mark_sealed", 1),
        "exit",
    ]


def test_reject_records_the_marker_with_the_session_clock(verification):
    v = verification

    def rejected(version, *, rejected_at, reason, actor):
        v.calls.append(("mark_rejected", version, rejected_at, reason, actor))

    v.store.mark_rejected = rejected
    assert seal_captures.reject_capture_copy(
        v.connection, v.storage, v.copy, reason="stale", actor="checker"
    )
    assert v.calls == [
        ("enter", WindowIdentity("capture.trip_updates", "network", "2026-01-02")),
        ("mark_rejected", 1, v.now, "stale", "checker"),
        "exit",
    ]


@pytest.mark.parametrize("payload", ["object", "pairs", "scalar"])
def test_working_evidence_is_validated_as_stored(verification, monkeypatch, payload):
    from transit_ops.history import working_captures as working
    from transit_ops.history.ledger_store import RecordedEvent
    from transit_ops.history.poll_record import PollRecordInvalid

    v = verification
    record, _ = scripted_feed_day(endpoint_key="trip_updates")
    capture = replace(record.captures[1], packed=False, stream=None, offset=None)
    monkeypatch.setattr(
        working, "_feed", lambda *a: dict(feed_endpoint_id=1, refresh_interval_seconds=30)
    )
    monkeypatch.setattr(working, "_captures", lambda *a: (capture,))
    monkeypatch.setattr(working, "_silver_loads", lambda *a: ())
    monkeypatch.setattr(working, "_fact_counts", lambda *a: {})
    v.connection.execute = lambda *a: NS(mappings=lambda: [])
    events = [
        RecordedEvent(
            i,
            "processing_evidence",
            None,
            None,
            dict(
                command="facts",
                completed_at_utc="2026-01-04T00:00:00.000000Z",
                index_family="realtime_snapshot",
                rows_by_capture={"1": count},
            ),
            "checker",
            v.now,
        )
        for i, count in ((1, 0), (2, 2))
    ]
    v.store.events = lambda identity, **kw: v.calls.append((identity, kw)) or events
    if payload != "object":
        details = list(events[0].details.items()) if payload == "pairs" else 7
        events[0] = replace(events[0], sequence=41, details=details)

    def read():
        return working.read_working_day(
            v.connection,
            provider_id="network",
            endpoint_key="trip_updates",
            utc_date=record.feed_day.utc_date,
        )

    if payload != "object":
        with pytest.raises(PollRecordInvalid, match="event 41: invalid keys"):
            read()
        return
    result = read()
    assert [(p.rows, p.attribution, p.completed_at_utc) for p in result.processing] == [
        (2, "recorded", v.now)
    ]
    assert v.calls == [
        (
            WindowIdentity("capture.trip_updates", "network", "2026-01-02"),
            dict(kinds={"processing_evidence"}),
        )
    ]
