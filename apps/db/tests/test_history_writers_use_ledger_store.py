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
    monkeypatch.setattr(seal_captures, "_read_rejection", lambda *a: None)
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


def test_selector_uses_postgres():
    connection = object()
    store = ledger_select.ledger_for(connection)
    assert isinstance(store, PostgresLedger) and store.connection is connection
