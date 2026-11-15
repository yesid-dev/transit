from datetime import date

from sqlalchemy import text
from test_warm_rollups import FakeConnection, FakeEngine, FakeMissingDayRow, IterableResult
from test_warm_rollups_seed_guard_real_db import _TxEngine

from transit_ops.control.switches import PostgresSwitches
from transit_ops.gold import rollups
from transit_ops.gold.rollups import build_warm_rollups


def test_postgres_skip_preserves_other_tables(real_db_engine, seed_provider):
    with real_db_engine.connect() as conn, conn.begin() as transaction:
        seed_provider(conn, "engine_skip_seed", display_name="Engine skip seed")
        engine = _TxEngine(conn)
        before = build_warm_rollups("engine_skip_seed", engine=engine)
        tables = ("route_service_span_daily", "route_skipped_stop_daily")
        for table in tables:
            conn.execute(
                text(
                    f"INSERT INTO gold.{table} (provider_id,provider_local_date,route_id) "
                    "VALUES ('engine_skip_seed','2026-01-01','sentinel')"
                )
            )
        stored = {
            table: conn.execute(
                text(f"SELECT * FROM gold.{table} WHERE provider_id='engine_skip_seed'")
            ).all()
            for table in tables
        }
        conn.execute(
            text(
                "INSERT INTO core.pipeline_switches "
                "(switch_key,enabled,updated_at_utc,updated_by,reason) "
                "VALUES ('batch_engine:span_skipped_stops',true,now(),'test','test') "
                "ON CONFLICT (switch_key) DO UPDATE SET enabled=true"
            )
        )
        after = build_warm_rollups("engine_skip_seed", engine=engine)
        for table in tables:
            assert (
                conn.execute(
                    text(f"SELECT * FROM gold.{table} WHERE provider_id='engine_skip_seed'")
                ).all()
                == stored[table]
            )
        for left, right in zip(
            before.completed_stage_receipts, after.completed_stage_receipts, strict=True
        ):
            assert left.rows == right.rows
            if right.table in {"route_service_span_daily", "route_skipped_stop_daily"}:
                assert right.status == "skipped_engine_duckdb"
            else:
                assert right.status == "completed"
        conn.execute(
            text(
                "UPDATE core.pipeline_switches SET enabled=false "
                "WHERE switch_key='batch_engine:span_skipped_stops'"
            )
        )
        restored = build_warm_rollups("engine_skip_seed", engine=engine)
        assert all(r.status == "completed" for r in restored.completed_stage_receipts)
        transaction.rollback()


def test_table_ownership_is_exclusive_and_registered():
    from transit_ops.batch.families.ownership import TABLE_OWNERS
    from transit_ops.batch.families.registry import FAMILIES

    expected = {
        "route_spine_hours": "trip_delay_summary_5m route_delay_hourly route_delay_spine",
        "stop_spine_hours": "stop_delay_spine stop_delay_shift_daily stop_delay_hourly",
        "percentiles_histograms": "route_delay_percentile_daily stop_delay_percentile_daily",
        "cancellations_service_states": "route_scheduled_trips_daily route_cancellation_daily",
        "headways": (
            "route_headway_by_shift route_headway_by_direction_shift route_headway_shift_daily"
        ),
        "span_skipped_stops": "route_service_span_daily route_skipped_stop_daily",
        "occupancy_crowding": (
            "route_occupancy_band_daily route_occupancy_band_hourly "
            "stop_occupancy_band_daily route_delay_by_crowding_daily"
        ),
        "repeat_offenders": (
            "repeat_offender_daily_spine repeat_offender repeated_problem_route_stop"
        ),
        "receipts": "citizen_accountability_daily",
    }
    assert dict(TABLE_OWNERS) == {
        f"gold.{table}": family for family, tables in expected.items() for table in tables.split()
    }
    assert set(TABLE_OWNERS.values()) <= FAMILIES.keys()


def test_switched_stages_skip_and_rollback(monkeypatch):
    enabled = frozenset()
    monkeypatch.setattr(PostgresSwitches, "enabled", lambda _: enabled)

    class SourceConnection(FakeConnection):
        def execute(self, statement, params=None):
            if statement is rollups.SELECT_AVAILABLE_PERCENTILE_DAYS:
                return IterableResult([FakeMissingDayRow(date(2026, 3, 24), 20260324)])
            return super().execute(statement, params)

    def build():
        return build_warm_rollups(
            "seed",
            engine=FakeEngine(
                SourceConnection(
                    rebuild_missing_days=[FakeMissingDayRow(date(2026, 3, 24), 20260324)]
                )
            ),
        )

    baseline = build()
    enabled = frozenset({"batch_engine:span_skipped_stops"})
    switched = build()
    for before, after in zip(
        baseline.completed_stage_receipts, switched.completed_stage_receipts, strict=True
    ):
        expected = (
            "skipped_engine_duckdb"
            if after.table in {"route_service_span_daily", "route_skipped_stop_daily"}
            else "completed"
        )
        assert after.display_dict()["status"] == expected
        if expected == "skipped_engine_duckdb":
            assert before.rows == 1
            assert after.rows == 0
        else:
            assert after.rows == before.rows
    enabled = frozenset()
    restored = build()
    assert restored.built_route_service_span_days == restored.built_route_skipped_stop_days == 1
    assert all(r.display_dict()["status"] == "completed" for r in restored.completed_stage_receipts)
