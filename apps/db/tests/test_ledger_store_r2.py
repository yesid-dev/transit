import pytest
from ledger_store_contract import (  # noqa: F401
    r2_store,
    test_copy_insertion_refuses_nonzero_revision,
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


def test_clock_actor_and_shared_record_survive_session_commit(store, make_identity):
    identity = make_identity()
    with store.session(identity) as session:
        session.record_event("close_runs")
        (written,) = session.events()
        assert isinstance(written, RecordedEvent)
        assert (written.actor, written.at_utc) == ("writer", session.now())
        assert session.now() == session.now()
    with store.session(identity) as session:
        assert session.events() == [written]


@pytest.mark.parametrize("actor,reason", [("", None), ("bad\0actor", None), (None, "bad\0reason")])
def test_invalid_event_text_is_refused_before_buffering(store, make_identity, actor, reason):
    with store.session(make_identity()) as session:
        with pytest.raises(ValueError):
            session.record_event("close_runs", actor=actor, reason=reason)
        assert session.events() == []
