from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from test_closed_day_rewrites import ARGS, ID

from transit_ops.history.closed_day_rewrites import (
    WindowTrimmed,
    begin_rewrite,
    record_rewrite_outcome,
    revalidate_rewrite,
)
from transit_ops.history.ledger import HOLD_NO_END
from transit_ops.history.ledger_postgres import PostgresLedger
from transit_ops.history.ledger_store import WindowChanged
from transit_ops.history.rewrite_evidence import decode_processing_evidence


@pytest.fixture
def target(real_db_engine):
    identity = replace(ID, provider_id=uuid4().hex)
    yield real_db_engine, identity
    with real_db_engine.begin() as connection:
        for table in ("history_event", "history_window"):
            connection.execute(
                text(f"DELETE FROM core.{table} WHERE provider_id=:p"), {"p": identity.provider_id}
            )


def admit(target):
    engine, identity = target
    with engine.begin() as connection:
        return begin_rewrite(PostgresLedger(connection), identity, **ARGS)


def test_closed_day_gets_a_durable_started_record_and_twenty_four_hour_hold(target):
    ticket = admit(target)
    engine, identity = target
    with engine.begin() as connection:
        store = PostgresLedger(connection)
        state, events = store.window_state(identity), store.events(identity)
        assert ticket.expected_current_version is None
        assert state.hold_until_utc >= events[-1].at_utc + timedelta(hours=24)
        assert events[-1].kind == "changed" and events[-1].details["phase"] == "started"
        rewrite = events[-1].details["rewrite"]
        assert rewrite["expected_working_changed_at_utc"].endswith("Z")
        assert rewrite["expected_current_version"] is None and rewrite["edition"] is None
        assert "rows_by_capture" not in events[-1].details
        assert store.events(identity, kinds={"processing_evidence"}) == []


@pytest.mark.parametrize("until", [HOLD_NO_END, datetime(2090, 1, 1, tzinfo=UTC)])
def test_existing_indefinite_or_longer_hold_is_not_shortened(target, until):
    engine, identity = target
    with engine.begin() as connection:
        with PostgresLedger(connection).session(identity) as window:
            window.mark_changed()
            window.hold(until_utc=until, reason="operator")
    admit(target)
    with engine.begin() as connection:
        state = PostgresLedger(connection).window_state(identity)
        assert (state.hold_until_utc, state.hold_reason) == (until, "operator")


@pytest.mark.parametrize("change", ["stamp", "version", "selection", "trimmed", "partial"])
def test_window_changed_after_preflight_is_refused_before_writes(target, change):
    ticket = admit(target)
    engine, identity = target
    with engine.connect() as writer, engine.begin() as reader:
        with writer.begin(), PostgresLedger(writer).session(identity) as window:
            if change == "version":
                writer.execute(
                    text("UPDATE core.history_window SET current_version=9 WHERE provider_id=:p"),
                    {"p": identity.provider_id},
                )
            elif change != "selection":
                window.mark_changed()
                if change in {"trimmed", "partial"}:
                    window.set_working_state(change)
        store = PostgresLedger(reader)
        before = store.events(identity)
        with pytest.raises(
            (WindowChanged, WindowTrimmed, ValueError), match="(window_trimmed|changed)"
        ):
            with store.session(identity) as window:
                revalidate_rewrite(window, ticket, (18,) if change == "selection" else (17,))
                pytest.fail("guard allowed a stale write")
        assert store.events(identity) == before


def test_failure_leaves_started_evidence_when_failure_audit_is_unavailable(target, monkeypatch):
    ticket = admit(target)
    engine, identity = target
    with pytest.raises(RuntimeError, match="audit unavailable"), engine.begin() as connection:
        store = PostgresLedger(connection)

        def unavailable(*args, **kwargs):
            raise RuntimeError("audit unavailable")

        monkeypatch.setattr(store, "record_audit", unavailable)
        record_rewrite_outcome(store, ticket, phase="failed")
    with engine.begin() as connection:
        store = PostgresLedger(connection)
        assert [e.details.get("phase") for e in store.events(identity) if "phase" in e.details] == [
            "started"
        ]
        assert (
            store.window_state(identity).working_changed_at_utc
            == ticket.expected_working_changed_at_utc
        )


@pytest.mark.parametrize("rollback", [False, True])
def test_rewrite_records_expected_current_version_without_calling_it_window_sequence(
    target, rollback
):
    ticket = admit(target)
    engine, identity = target
    edition = dict(provider_id=identity.provider_id, dataset_version_id=42, checksum_sha256=None)
    with engine.connect() as connection:
        transaction = connection.begin()
        store = PostgresLedger(connection)
        with store.session(identity) as window:
            revalidate_rewrite(window, ticket, (17,))
            record_rewrite_outcome(
                store,
                ticket,
                phase="completed",
                edition=edition,
                rows_by_capture={17: 0},
                window=window,
            )
        transaction.rollback() if rollback else transaction.commit()
    with engine.begin() as connection:
        events = PostgresLedger(connection).events(identity, kinds={"processing_evidence"})
        if rollback:
            assert events == []
        else:
            details = events[0].details
            assert details["rewrite"]["expected_current_version"] is None
            assert details["rewrite"]["edition"] == edition
            assert decode_processing_evidence(
                details, index_family="realtime_snapshot", sequence=events[0].sequence
            )[1] == {17: 0}
