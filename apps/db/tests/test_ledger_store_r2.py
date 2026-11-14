import json
from contextlib import nullcontext
from dataclasses import replace
from datetime import date, timedelta

import pytest
from ledger_store_contract import *  # noqa: F403
from ledger_store_contract import new_copy, r2_store
from ledger_store_contract import (  # noqa: F401
    record_audit_kind_refusals as test_record_audit_refuses_lifecycle_kinds,
)
from ledger_store_contract import (  # noqa: F401
    record_audit_round_trip as test_record_audit_preserves_state_and_returns_its_event,
)
from ledger_store_contract import (  # noqa: F401
    record_audit_text_refusals as test_record_audit_refuses_invalid_text,
)

from transit_ops.history import ledger_r2_documents as documents
from transit_ops.history import ledger_r2_transitions as t
from transit_ops.history.ledger_r2 import R2Ledger
from transit_ops.history.ledger_r2_documents import EventRecord
from transit_ops.history.ledger_r2_transitions import LedgerTransitionCommitted
from transit_ops.history.ledger_store import RecordedEvent, WindowChanged, WindowIdentity

store = r2_store


@pytest.fixture
def make_identity():
    return lambda key="2026-11-01": WindowIdentity("capture.trip_updates", "network", key)


@pytest.mark.parametrize("state_exists", [False, True])
def test_second_session_refuses_moved_cursor_without_renumbering(
    store, make_identity, state_exists
):
    identity = make_identity()
    if state_exists:
        with store.session(identity) as session:
            session.mark_changed()
    with pytest.raises(WindowChanged):
        with store.session(identity) as second:
            second.record_event("close_runs", details={"writer": "second"})
            written = second.events()[-1]
            with store.session(identity) as first:
                first.record_event("close_runs", details={"writer": "first"})
    with store.session(identity) as session:
        assert written.sequence == session.events()[-1].sequence
        assert session.events()[-1].details == {"writer": "first"}
        assert all(e.details != {"writer": "second"} for e in session.events())


def test_session_without_records_writes_no_object(store, make_identity):
    with store.session(make_identity()) as session:
        assert session.state() is None
        assert session.events() == []
    assert list(store.objects.list_keys("windows/")) == []
    assert list(store.objects.list_keys("transitions/")) == []


def test_mark_changed_masks_but_retains_trim_fingerprint(store, make_identity):
    def trim(c, at):
        return t.Transition(replace(c.doc, seq=c.next_seq, working_state="partial"), (record,))

    key, identity = ("capture.trip_updates", "network", 0, "2026-11-01"), make_identity()
    with store.session(identity) as s:
        s.mark_changed()
    record = EventRecord("trim", None, "writer", None, {"remainder_fingerprint": "a" * 64})
    t.apply_transition(store.objects, key, trim, clock=store.clock, max_attempts=3)
    with store.session(identity) as s:
        assert s.state().remainder_fingerprint == "a" * 64
        s.mark_changed()
        assert (s.state().working_state, s.state().remainder_fingerprint) == ("present", None)
    assert t.current_window(store.objects, key).remainder_fingerprint == "a" * 64


@pytest.mark.parametrize("actor,reason", [("", None), ("bad\0actor", None), (None, "bad\0reason")])
def test_invalid_event_text_is_refused_before_buffering(store, make_identity, actor, reason):
    with store.session(make_identity()) as session:
        with pytest.raises(ValueError):
            session.record_event("close_runs", actor=actor, reason=reason)
        assert session.events() == []


def test_one_session_writes_one_envelope_with_all_its_records(store, make_identity):
    identity = make_identity()
    with store.session(identity) as session:
        session.insert_allocated_copy(new_copy(session.allocate_version()))
        session.mark_sealed(1)
    key = (identity.dataset_id, identity.provider_id, 0, identity.window_key)
    with store.session(identity) as session:
        session.make_current(1, verified_at=session.now())
    envelopes = [
        json.loads(store.objects.read(k).body)
        for k in sorted(store.objects.list_keys(documents.transitions_prefix(key)))
    ]
    assert [[r["kind"] for r in e["records"]] for e in envelopes] == [
        ["seal"],
        ["verify", "current"],
    ]
    assert envelopes[1]["records"][1]["details"] == {"previous_version": None}


@pytest.mark.parametrize("prior_events", [False, True])
@pytest.mark.parametrize("reader", ["state", "events", "range"])
def test_first_state_after_crash_is_visible_to_each_reader(
    store, make_identity, monkeypatch, prior_events, reader
):
    identity = make_identity()
    if prior_events:
        store.record_audit(identity, "close_runs", {})
    replace_object = store.objects.replace

    def failed_projection(*args, **kwargs):
        raise OSError("projection failed")

    monkeypatch.setattr(store.objects, "replace", failed_projection)
    with pytest.raises(LedgerTransitionCommitted), store.session(identity) as session:
        session.insert_allocated_copy(new_copy(session.allocate_version()))
        session.mark_sealed(1)
    monkeypatch.setattr(store.objects, "replace", replace_object)
    if reader == "state":
        assert store.window_state(identity).next_version == 2
    elif reader == "events":
        assert [e.kind for e in store.events(identity, kinds={"seal"})] == ["seal"]
    else:
        assert [
            c.content_version
            for c in store.find_copies(
                dataset_id=identity.dataset_id,
                provider_id=identity.provider_id,
                start=date(2026, 11, 1),
                end=date(2026, 11, 1),
            )
        ] == [1]


def test_one_day_range_has_bounded_reads_and_no_listing(store, make_identity, monkeypatch):
    for day in range(1, 31):
        with store.session(make_identity(f"2026-11-{day:02}")) as session:
            session.insert_allocated_copy(new_copy(session.allocate_version()))
    read, list_keys = store.objects.read, store.objects.list_keys
    reads, listings = [], []
    monkeypatch.setattr(store.objects, "read", lambda key: (reads.append(key), read(key))[1])
    monkeypatch.setattr(
        store.objects, "list_keys", lambda key: (listings.append(key), list_keys(key))[1]
    )
    assert (
        store.find_copies(
            dataset_id="capture.trip_updates",
            provider_id="network",
            start=date(2026, 11, 15),
            end=date(2026, 11, 15),
        )[0].content_version
        == 1
    )
    assert not listings and len(reads) <= 3


@pytest.mark.parametrize("state_exists", [None, "mark_changed", "allocate_version"])
def test_create_race_refuses_to_renumber_session_records(
    store, make_identity, monkeypatch, state_exists
):
    identity = make_identity()
    if state_exists:
        with store.session(identity) as session:
            getattr(session, state_exists)()
    create = store.objects.create

    def competing(key, payload):
        monkeypatch.setattr(store.objects, "create", create)
        with store.session(identity) as first:
            first.record_event("close_runs", actor="first")
        return create(key, payload)

    monkeypatch.setattr(store.objects, "create", competing)
    with pytest.raises(WindowChanged), store.session(identity) as second:
        second.record_event("close_runs", actor="second")
    assert [r.actor for r in store.events(identity, kinds={"close_runs"})] == ["first"]


def test_clock_actor_and_shared_record_survive_session_commit(store, make_identity):
    stamp, calls = store.clock(), []

    def clock():
        calls.append(True)
        return stamp + timedelta(seconds=len(calls) - 1)

    store.clock = clock
    with store.session(make_identity()) as session:
        session.insert_allocated_copy(new_copy(session.allocate_version()))
        session.mark_sealed(1)
        session.make_current(1, verified_at=session.now())
        written = session.events()
        assert all(isinstance(e, RecordedEvent) and e.actor == "writer" for e in written)
        copy = session.copies()[0]
        assert (copy.allocated_at_utc, copy.sealed_at_utc, copy.verified_at_utc) == (stamp,) * 3
    assert store.events(make_identity()) == written
    assert calls == [True]
    assert [r.at_utc for r in store.events(make_identity())] == [stamp] * 3


@pytest.mark.parametrize("actor", ["", "bad\0actor", 5])
def test_default_actor_is_required_before_any_objects_are_written(store, actor):
    with pytest.raises(ValueError):
        R2Ledger(store.objects, store.clock, actor, 3)
    assert list(store.objects.list_keys("transitions/")) == []


def test_naive_clock_is_refused_before_a_session_writes(store, make_identity):
    store.clock = lambda: new_copy(1).first_time_utc.replace(tzinfo=None)
    with pytest.raises(ValueError, match="aware datetime"), store.session(make_identity()):
        pytest.fail("naive session accepted")
    assert list(store.objects.list_keys("transitions/")) == []


def test_record_audit_returns_its_own_record_after_a_create_race(store, make_identity, monkeypatch):
    monkeypatch.setattr(store, "session", lambda *args: pytest.fail("audit entered a session"))
    create = store.objects.create

    def competing(key, payload):
        monkeypatch.setattr(store.objects, "create", create)
        store.record_audit(make_identity(), "close_runs", {"writer": "first"})
        return create(key, payload)

    monkeypatch.setattr(store.objects, "create", competing)
    event = store.record_audit(make_identity(), "close_runs", {"writer": "second"})
    assert event.sequence == 2 and event.details == {"writer": "second"}
    assert store.events(make_identity())[-1] == event
    assert [e.details for e in store.events(make_identity())] == [
        {"writer": "first"},
        {"writer": "second"},
    ]


@pytest.mark.parametrize("seconds", [1, 300, 301])
def test_seal_adjusts_small_clock_skew_and_refuses_large_skew(store, make_identity, seconds):
    with store.session(make_identity()) as session:
        allocated = session.now()
        session.insert_allocated_copy(new_copy(session.allocate_version()))
    store.clock = lambda: allocated - timedelta(seconds=seconds)
    with pytest.raises(RuntimeError, match="clock") if seconds > 300 else nullcontext() as error:
        with store.session(make_identity()) as session:
            session.mark_sealed(1)
            assert session.copies()[0].sealed_at_utc == allocated
    if error:
        assert error.type.__name__ == "LedgerClockSkew"
    with store.session(make_identity()) as session:
        assert session.copies()[0].state == ("allocated" if error else "sealed")
        assert [e.at_utc for e in session.events()] == (
            [] if error else [allocated - timedelta(seconds=seconds)]
        )
