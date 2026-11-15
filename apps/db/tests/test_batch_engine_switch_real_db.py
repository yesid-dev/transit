import pytest

from transit_ops import pipeline_switches
from transit_ops.batch import switch
from transit_ops.batch.families import registry
from transit_ops.control.switches import PostgresSwitches


def test_unknown_family():
    with pytest.raises(registry.UnknownFamilyError, match="unknown"):
        switch.switch_key("unknown")


def test_engine_transition_and_rollback(real_db_engine, monkeypatch):
    key = switch.switch_key("occupancy_crowding")
    with real_db_engine.connect() as conn:
        store = PostgresSwitches(conn)

        def set_on(on):
            conn.rollback()
            store.set_switch(key, on=on, updated_by="test", reason="engine test")

        try:
            set_on(False)
            assert switch.engine_for(conn, "occupancy_crowding") == "postgres"
            set_on(True)
            assert switch.engine_for(conn, "occupancy_crowding") == "duckdb"
            monkeypatch.setattr(registry, "resolve_builder", lambda _: None)
            with pytest.raises(pipeline_switches.GuardRefused, match="builder"):
                set_on(True)
            set_on(False)
            assert switch.engine_for(conn, "occupancy_crowding") == "postgres"
            conn.rollback()
            with pytest.raises(pipeline_switches.GuardRefused, match="Unknown family"):
                store.set_switch("batch_engine:unknown", on=True, updated_by="test", reason="test")
            conn.rollback()
            assert pipeline_switches.history_daily_guard(conn, "history_daily").allowed
        finally:
            set_on(False)
            with conn.begin():
                conn.exec_driver_sql(
                    "DELETE FROM core.pipeline_switches WHERE switch_key=%s", (key,)
                )
