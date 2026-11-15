from uuid import uuid4

import pytest
from gc_marks_contract import KEEP, check_marks, check_refusals
from sqlalchemy import text

from transit_ops.control.historic_gc_marks import PostgresGcMarks
from transit_ops.control.objects import ObjectConflict


def test_contract(real_db_engine, seed_provider):
    with real_db_engine.connect() as conn, conn.begin():
        p, q = "gc_" + uuid4().hex, "gc_" + uuid4().hex
        seed_provider(conn, p, display_name="GC test")
        seed_provider(conn, q, display_name="GC other")
        check_marks(PostgresGcMarks(conn), PostgresGcMarks(conn), p, q)
        conn.rollback()


@pytest.mark.parametrize("mutation", ["set", "empty", "clear_cycle", "replace_cycle"])
def test_committed_writer_invalidates_other_connection(real_db_engine, seed_provider, mutation):
    p, q = "gc_" + uuid4().hex, "gc_" + uuid4().hex
    with real_db_engine.connect() as first, real_db_engine.connect() as second:
        seed_provider(first, p, display_name="GC race")
        seed_provider(first, q, display_name="GC seed")
        check_marks(PostgresGcMarks(first), PostgresGcMarks(first), p, q)
        if mutation != "set":
            PostgresGcMarks(first).clear(p, [KEEP])
        first.commit()
        try:
            stale, winner = PostgresGcMarks(first), PostgresGcMarks(second)
            stale.load(p)
            expected = stale.version(p)
            first.rollback()
            marks = winner.load(q)
            winner.load(p)
            if mutation == "empty":
                marks = {}
            winner.replace(p, marks, expected=winner.version(p))
            if mutation.endswith("cycle"):
                second.commit()
                winner.load(p)
                if mutation == "clear_cycle":
                    winner.clear(p, list(marks))
                else:
                    winner.replace(p, {}, expected=winner.version(p))
                marks = {}
            second.commit()
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
        check_refusals(PostgresGcMarks(conn), p, fault)
        conn.rollback()
