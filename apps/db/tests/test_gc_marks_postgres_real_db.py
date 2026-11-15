from types import SimpleNamespace
from uuid import uuid4

import pytest
from gc_marks_contract import KEY, check_marks, check_refusals, seed_mark
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from transit_ops.control.historic_gc_marks import HistoricGcLaneRequired, PostgresGcMarks
from transit_ops.control.objects import ObjectConflict
from transit_ops.providers.live_policy import sync_live_policy
from transit_ops.snapshots.publication_lane import acquire_publication_lane


def test_contract(real_db_engine, seed_provider):
    with real_db_engine.connect() as conn, conn.begin():
        p, q = "gc_" + uuid4().hex, "gc_" + uuid4().hex
        seed_provider(conn, p, display_name="GC test")
        seed_provider(conn, q, display_name="GC other")
        acquire_publication_lane(conn, provider_id=p, tier="historic")
        acquire_publication_lane(conn, provider_id=q, tier="historic")
        check_marks(PostgresGcMarks(conn), PostgresGcMarks(conn), p, q)
        conn.rollback()


def test_committed_writer_invalidates_other_connection(real_db_engine, seed_provider):
    p, q = "gc_" + uuid4().hex, "gc_" + uuid4().hex
    with real_db_engine.connect() as first, real_db_engine.connect() as second:
        seed_provider(first, p, display_name="GC race")
        seed_provider(first, q, display_name="GC seed")
        acquire_publication_lane(first, provider_id=p, tier="historic")
        acquire_publication_lane(first, provider_id=q, tier="historic")
        check_marks(PostgresGcMarks(first), PostgresGcMarks(first), p, q)
        first.commit()
        try:
            stale, winner = PostgresGcMarks(first), PostgresGcMarks(second)
            stale.load(p)
            expected = stale.version(p)
            first.rollback()
            marks = winner.load(q)
            winner.load(p)
            acquire_publication_lane(second, provider_id=p, tier="historic")
            winner.replace(p, marks, expected=winner.version(p))
            second.commit()
            acquire_publication_lane(first, provider_id=p, tier="historic")
            with pytest.raises(ObjectConflict):
                stale.replace(p, {}, expected=expected)
            first.rollback()
            assert winner.load(p) == marks
            second.rollback()
        finally:
            first.rollback()
            second.rollback()
            first.execute(
                text("DELETE FROM core.snapshot_historic_gc_marks WHERE provider_id IN (:p, :q)"),
                {"p": p, "q": q},
            )
            first.execute(
                text("DELETE FROM core.providers WHERE provider_id IN (:p, :q)"), {"p": p, "q": q}
            )
            first.commit()


@pytest.mark.parametrize(
    "fault", ["backwards_time", "bad_scan_id", "negative_size", "boolean_size", "bad_key"]
)
def test_invalid_replacement_keeps_prior_set(real_db_engine, seed_provider, fault):
    with real_db_engine.connect() as conn, conn.begin():
        p = "gc_" + uuid4().hex
        seed_provider(conn, p, display_name="GC refusal")
        acquire_publication_lane(conn, provider_id=p, tier="historic")
        check_refusals(PostgresGcMarks(conn), p, fault)
        conn.rollback()


@pytest.mark.parametrize("operation", ["replace", "clear", "clear_empty"])
@pytest.mark.parametrize(
    "held", ["none", "wrong_provider", "wrong_tier", "other_backend", "shared"]
)
def test_mutation_requires_own_historic_lane(real_db_engine, seed_provider, operation, held):
    with real_db_engine.connect() as conn, real_db_engine.connect() as other:
        p = "gc_" + uuid4().hex
        seed_provider(conn, p, display_name="GC lane")
        if held == "wrong_provider":
            acquire_publication_lane(conn, provider_id=p + "_other", tier="historic")
        elif held == "wrong_tier":
            acquire_publication_lane(conn, provider_id=p, tier="live")
        elif held == "other_backend":
            acquire_publication_lane(other, provider_id=p, tier="historic")
        elif held == "shared":
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock_shared("
                    "hashtext('transit.snapshot_publish:' || :provider_id), hashtext('historic'))"
                ),
                {"provider_id": p},
            )
        store = PostgresGcMarks(conn)
        assert store.load(p) == {}
        with pytest.raises(HistoricGcLaneRequired, match="historic publication lane"):
            if operation == "replace":
                store.replace(p, {}, expected=store.version(p))
            else:
                store.clear(p, [KEY] if operation == "clear" else [])
        assert store.load(p) == {}
        conn.rollback()
        other.rollback()


def test_repeatable_read_clear_after_policy_update_commits(real_db_engine, seed_provider):
    p = "gc_" + uuid4().hex
    with real_db_engine.begin() as setup:
        seed_provider(setup, p, display_name="GC policy race")
    try:
        with real_db_engine.connect().execution_options(isolation_level="REPEATABLE READ") as first:
            with real_db_engine.connect() as second:
                acquire_publication_lane(first, provider_id=p, tier="historic")
                store = PostgresGcMarks(first)
                assert store.load(p) == {}
                manifest = SimpleNamespace(
                    provider=SimpleNamespace(provider_id=p),
                    realtime=SimpleNamespace(lines_without_live_data=[]),
                )
                sync_live_policy(second, manifest)
                second.commit()
                store.clear(p, [KEY])
                first.commit()
    finally:
        with real_db_engine.begin() as cleanup:
            cleanup.execute(text("DELETE FROM core.providers WHERE provider_id=:p"), {"p": p})


def test_unseeded_provider_keeps_main_behavior(real_db_engine):
    with real_db_engine.connect() as conn:
        p = "gc_" + uuid4().hex
        acquire_publication_lane(conn, provider_id=p, tier="historic")
        store = PostgresGcMarks(conn)
        assert store.load(p) == {}
        store.replace(p, {}, expected=store.version(p))
        store.clear(p, [KEY])
        with pytest.raises(IntegrityError):
            with conn.begin_nested():
                store.replace(p, {KEY: seed_mark()}, expected=store.version(p))
        assert store.load(p) == {}
        conn.rollback()
