"""Real PostgreSQL is a difference detector; expected values are hand-computed."""

from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text
from test_live_captures import _parse
from test_live_facts import trip_message
from test_live_running import AT, inputs, long_service_case, project, with_frame
from test_live_running import local as local
from test_running_service_clock_real_db import _calendar, _edition, _trip

from transit_ops.live.running import ScheduleInputs, running_trips


@pytest.mark.parametrize(
    "day,hours,at",
    [
        (date(2026, 3, 8), 25, datetime(2026, 3, 9, 5, tzinfo=UTC)),
        (date(2026, 11, 1), 49, datetime(2026, 11, 3, 6, tzinfo=UTC)),
    ],
)
def test_running_0096_same_clock_rows_and_independent_math(
    real_db_engine, seed_provider, local, day, hours, at
):
    provider = "ls36_running_oracle"
    with real_db_engine.connect() as conn, conn.begin() as tx:
        try:
            edition = _edition(conn, seed_provider, provider=provider)
            _calendar(conn, edition, day)
            _trip(conn, edition, start=f"{hours}:00:00", end=f"{hours}:01:00", trip="T")
            base = inputs(local).selected
            base = replace(
                base,
                edition=replace(
                    base.edition, provider_id=provider, dataset_version_id=edition["d"]
                ),
            )
            base = with_frame(base, "edition_routes", [("R", 3)])
            base = with_frame(
                base,
                "edition_trip_service_span",
                [("T", "R", "service", hours * 3600, hours * 3600 + 60)],
            )
            base = with_frame(base, "edition_calendar_dates", [("service", day, 1)])
            selected = ScheduleInputs(base, frozenset({edition["d"]}), (base,))
            ours = running_trips(
                selected, provider_id=provider, timezone="America/Toronto", cycle=at
            )
            pg = tuple(
                conn.execute(
                    text(
                        "SELECT * FROM gold.scheduled_running_trips_at(:p,:at) "
                        "ORDER BY route_id,trip_id"
                    ),
                    {"p": provider, "at": at},
                ).all()
            )
            # Same named T/R row: local noon anchor + 25/49 elapsed hours, inclusive start.
            assert ours == pg == (("R", "T"),)
        finally:
            tx.rollback()


@pytest.mark.parametrize(
    "relationship,skipped,expected_pg", [(0, False, 1), (3, False, 1), (0, True, 1), (7, False, 1)]
)
def test_departure_view_differences_are_classified(
    real_db_engine, local, relationship, skipped, expected_pg
):
    message = trip_message()
    trip = message.entity[0].trip_update
    trip.trip.schedule_relationship = relationship
    stop = trip.stop_time_update[0]
    stop.schedule_relationship = 1 if skipped else 0
    stop.stop_id = "站"
    stop.arrival.time = int(AT.timestamp()) + 90
    parsed = _parse(message)
    ours = project(local, parsed).departures
    with real_db_engine.connect() as conn, conn.begin() as tx:
        try:
            tables = ("rt_feed_snapshots", "rt_trip_updates", "rt_trip_update_stop_times")
            for table in tables:
                conn.execute(
                    text(
                        f"CREATE TEMP TABLE {table} ON COMMIT DROP "
                        f"AS SELECT * FROM silver.{table} WITH NO DATA"
                    )
                )
            conn.execute(
                text(
                    "INSERT INTO pg_temp.rt_feed_snapshots "
                    "(rt_feed_snapshot_id,provider_id,endpoint_key,captured_at_utc,"
                    "source_realtime_snapshot_id) VALUES (42,'network','trip_updates',:at,42)"
                ),
                {"at": AT},
            )
            for table in tables[1:]:
                frame = parsed.frames[table]
                columns = ("rt_feed_snapshot_id", "provider_id", *frame.columns)
                for values in frame.rows:
                    row = dict(zip(columns, (42, "network", *values), strict=True))
                    names = ",".join(columns)
                    placeholders = ",".join(":" + name for name in columns)
                    conn.execute(
                        text(f"INSERT INTO pg_temp.{table} ({names}) VALUES ({placeholders})"), row
                    )
            definition = (
                conn.execute(
                    text(
                        "SELECT pg_get_viewdef('gold.current_stop_next_departures'::regclass,true)"
                    )
                )
                .scalar_one()
                .strip()
                .removesuffix(";")
            )
            # Retarget schemas only: implicit basenames and explicit aliases in
            # the installed definition must continue to resolve to the same rows.
            for table in tables:
                definition = definition.replace("silver." + table, "pg_temp." + table)
            definition = definition.replace("now()", "CAST(:cycle AS timestamptz)")
            pg = conn.execute(text(definition), {"cycle": AT}).mappings().all()
            assert len(pg) == expected_pg
            if relationship in (3, 7) or skipped:
                # R28(b): PG 0093 exposes cancelled/skipped/deleted service. Local correct
                # passenger-service math excludes it. Requires SQL/methodology work
                # by its owner before activation, never imitate it for parity.
                assert ours == ()
            else:
                # R28(c): tuple/Row and UTC serialization normalize identically.
                assert [
                    (r["trip_id"], r["stop_id"], r["predicted_departure_utc"]) for r in ours
                ] == [(r["trip_id"], r["stop_id"], r["predicted_departure_utc"]) for r in pg]
        finally:
            tx.rollback()


def _current_delay_rows(conn, observations, cycle):
    conn.execute(
        text(
            "CREATE TEMP TABLE latest_trip_delay_snapshot ON COMMIT DROP "
            "AS SELECT * FROM gold.latest_trip_delay_snapshot WITH NO DATA"
        )
    )
    conn.execute(
        text("CREATE TEMP TABLE dim_provider (provider_id text, timezone text) ON COMMIT DROP")
    )
    conn.execute(text("INSERT INTO pg_temp.dim_provider VALUES ('network','America/Toronto')"))
    for entity, day, delay, count in observations:
        conn.execute(
            text("""
            INSERT INTO pg_temp.latest_trip_delay_snapshot
                (provider_id,realtime_snapshot_id,entity_index,trip_id,route_id,direction_id,
                 start_date,captured_at_utc,delay_seconds,stop_time_update_count)
            VALUES ('network',42,:entity,'行程','路线',1,:day,:at,:delay,:count)
        """),
            dict(entity=entity, day=day, at=cycle, delay=delay, count=count),
        )
    definition = (
        conn.execute(
            text("SELECT pg_get_viewdef('gold.current_trip_delay_computed'::regclass,true)")
        )
        .scalar_one()
        .strip()
        .removesuffix(";")
    )
    definition = (
        definition.replace("gold.latest_trip_delay_snapshot", "pg_temp.latest_trip_delay_snapshot")
        .replace("gold.dim_provider", "pg_temp.dim_provider")
        .replace("now()", "CAST(:cycle AS timestamptz)")
    )
    return conn.execute(text(definition), {"cycle": cycle}).mappings().all()


def test_current_delay_view_same_named_values_and_clock(real_db_engine, local):
    message = trip_message()
    message.entity.add().CopyFrom(message.entity[0])
    message.entity[1].id = "second"
    message.entity[1].trip_update.stop_time_update[0].arrival.time -= 60
    ours = project(local, _parse(message)).delays[0]
    with real_db_engine.connect() as conn, conn.begin() as tx:
        try:
            # Same named observations: (180+120)/2 = 150, four child observations.
            (pg,) = _current_delay_rows(
                conn, [(0, date(2026, 6, 20), 180, 2), (1, date(2026, 6, 20), 120, 2)], AT
            )
            for row in (ours, pg):
                assert row["avg_delay_seconds"] == Decimal("150.00")
                assert row["max_delay_seconds"] == 180
                assert row["stop_time_observation_count"] == 4
        finally:
            tx.rollback()


def test_49_hour_service_delay_pg_date_cutoff_is_class_b(real_db_engine, local):
    cycle, parsed = long_service_case(local)
    ours = project(local, parsed, cycle).delays
    assert ours[0]["avg_delay_seconds"] == Decimal("90.00")
    assert ours[0]["stop_time_observation_count"] == 2
    with real_db_engine.connect() as conn, conn.begin() as tx:
        try:
            # June20 anchor04Z +49h = June22 05Z; 05:01:30 prediction = +90s.
            pg = _current_delay_rows(conn, [(0, date(2026, 6, 20), 90, 2)], cycle)
            # R28(b): existing SQL's yesterday cutoff drops valid current service.
            # Reconcile the SQL/methodology before activation; never imitate it.
            assert pg == []
        finally:
            tx.rollback()
