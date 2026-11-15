from uuid import uuid4

import pytest
from gc_marks_contract import check_marks
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


def test_committed_writer_invalidates_other_connection(real_db_engine, seed_provider):
    p, q = "gc_" + uuid4().hex, "gc_" + uuid4().hex
    with real_db_engine.connect() as first, real_db_engine.connect() as second:
        seed_provider(first, p, display_name="GC race")
        seed_provider(first, q, display_name="GC seed")
        check_marks(PostgresGcMarks(first), PostgresGcMarks(first), p, q)
        first.commit()
        try:
            stale, winner = PostgresGcMarks(first), PostgresGcMarks(second)
            stale.load(p)
            expected = stale.version(p)
            first.rollback()
            marks = winner.load(q)
            winner.load(p)
            winner.replace(p, marks, expected=winner.version(p))
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
