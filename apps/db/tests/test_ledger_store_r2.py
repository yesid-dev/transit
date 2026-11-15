from contextlib import nullcontext
from dataclasses import replace
from datetime import timedelta

import pytest
from ledger_store_contract import (  # noqa: F401
    new_copy,
    r2_store,
    test_copy_insertion_refuses_nonzero_revision,
    test_copy_time_order_is_refused_at_the_verb,
    test_details_are_owned_json_values,
    test_existing_copy_version_is_create_only,
    test_hold_with_no_end_reads_back_as_hold_no_end,
    test_invalid_new_copy_is_refused_before_writing,
    test_make_current_never_moves_the_current_version_back,
    test_missing_copy_value_stays_missing_while_zero_stays_zero,
    test_optional_copy_digests_and_local_storage_are_accepted,
    test_seal_refuses_a_rejected_copy_and_reject_refuses_a_verified_copy,
    test_undeclared_dataset_and_misfit_key_are_refused_before_any_write,
    test_working_state_changes_only_from_present_or_empty,
)

from transit_ops.history import ledger_r2_transitions as t
from transit_ops.history.ledger_r2_documents import EventRecord
from transit_ops.history.ledger_store import WindowChanged, WindowIdentity

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
