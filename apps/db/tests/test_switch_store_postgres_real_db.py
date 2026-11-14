from uuid import uuid4

from sqlalchemy import text
from switch_store_contract import check_refusals, check_transitions

from transit_ops import pipeline_switches as pg
from transit_ops.control.switches import PostgresSwitches


def test_contract(real_db_engine, monkeypatch):
    calls, key = [], "test:" + uuid4().hex
    monkeypatch.setattr(
        pg, "_guards", {"test:": lambda c, k: (calls.append(k), pg.GuardResult(True))[1]}
    )
    with real_db_engine.connect() as connection:
        adapter = PostgresSwitches(connection)

        class Store:
            def __getattr__(self, name):
                def call(*args, **kwargs):
                    try:
                        return getattr(adapter, name)(*args, **kwargs)
                    finally:
                        connection.rollback()

                return call

        try:
            check_transitions(Store(), key, calls)
            check_refusals(Store())
        finally:
            with connection.begin():
                connection.execute(
                    text("DELETE FROM core.pipeline_switches WHERE switch_key=:key"), {"key": key}
                )
