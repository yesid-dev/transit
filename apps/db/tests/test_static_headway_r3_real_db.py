from datetime import date

import pytest
import real_db_seed as db_seed
from sqlalchemy import event, text

from transit_ops.snapshots.builders import build_route
from transit_ops.snapshots.builders._helpers import StaticScheduleContext, _static_schedule_context
from transit_ops.snapshots.builders.static_headway_r3 import build_route_headways_r3
from transit_ops.snapshots.serialization import snapshot_json_bytes

PROVIDER = "first_stop_test"
VERSION = 971_001


@pytest.fixture()
def conn(real_db_engine, seed_provider):
    with real_db_engine.connect() as connection, connection.begin() as transaction:
        for provider, version in ((PROVIDER, VERSION), ("first_stop_other", VERSION + 1)):
            seed_provider(connection, provider, display_name="First-stop regression")
            params = dict(p=provider, e=version, r=version, d=version, h=str(version))
            db_seed.feed_endpoints(
                connection,
                params,
                endpoint_key="'static_schedule'",
                feed_kind="'static_schedule'",
                source_format="'gtfs_schedule_zip'",
            )
            db_seed.ingestion_runs(connection, params, run_kind="'static_schedule'")
            db_seed.dataset_versions(connection, params)
            if provider == PROVIDER:
                db_seed.dataset_versions(
                    connection, {**params, "d": VERSION + 2, "h": "old"}, is_current="false"
                )
        for provider, version in (
            (PROVIDER, VERSION),
            ("first_stop_other", VERSION + 1),
            (PROVIDER, VERSION + 2),
        ):
            params = dict(p=provider, v=version)
            connection.execute(
                text("""
                INSERT INTO silver.routes (provider_id, dataset_version_id, route_id, route_type)
                VALUES (:p, :v, 'R', 3), (:p, :v, 'empty', 0)
            """),
                params,
            )
            connection.execute(
                text("""
                INSERT INTO silver.stops (provider_id, dataset_version_id, stop_id)
                VALUES (:p, :v, 'S')
            """),
                params,
            )
        try:
            yield connection
        finally:
            transaction.rollback()


def trip(conn, name, departure, *, sequence=2, version=VERSION, provider=PROVIDER, service="W"):
    params = dict(p=provider, v=version, trip=name, departure=departure, seq=sequence, svc=service)
    conn.execute(
        text("""
        INSERT INTO silver.trips
            (provider_id, dataset_version_id, trip_id, route_id, service_id, direction_id)
        VALUES (:p, :v, :trip, 'R', :svc, 0)
    """),
        params,
    )
    conn.execute(
        text("""
        INSERT INTO silver.stop_times
            (provider_id, dataset_version_id, trip_id, stop_sequence, stop_id, departure_time)
        VALUES (:p, :v, :trip, :seq, 'S', :departure)
    """),
        params,
    )


def read(conn, route_id=None, context=None):
    return build_route_headways_r3(
        conn,
        provider_id=PROVIDER,
        route_id=route_id,
        static_context=context or StaticScheduleContext(VERSION, ("W",)),
    )


def test_first_stop_headway_includes_trips_starting_at_sequence_two(conn):
    for name, departure in (("a", "08:00:00"), ("b", "08:10:00"), ("c", "08:20:00")):
        trip(conn, name, departure)
    context = StaticScheduleContext(VERSION, ("W",))
    legacy = build_route(
        conn, provider_id=PROVIDER, route_id="R", generated_utc="t", static_context=context
    )
    before = snapshot_json_bytes(legacy)
    statements = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(conn, "before_cursor_execute", capture)
    try:
        result = read(conn)
    finally:
        event.remove(conn, "before_cursor_execute", capture)
    assert len(statements) == 1
    assert result["R"].model_dump() == {
        "headway": [{"shift": "am_peak", "window": "06:00–09:00", "headway_min": 10.0}]
    }
    assert read(conn, "R") == result
    assert read(conn, "empty")["empty"].headway is None
    assert legacy.service_periods == []
    assert (
        snapshot_json_bytes(
            build_route(
                conn, provider_id=PROVIDER, route_id="R", generated_utc="t", static_context=context
            )
        )
        == before
    )


def test_first_stop_is_chosen_before_filtering_null_departures(conn):
    trip(conn, "a", None)
    conn.execute(
        text("""
        INSERT INTO silver.stop_times
            (provider_id, dataset_version_id, trip_id, stop_sequence, stop_id, departure_time)
        VALUES (:p, :v, 'a', 3, 'S', '08:00:00')
    """),
        dict(p=PROVIDER, v=VERSION),
    )
    assert read(conn)["R"].headway is None


def test_headways_are_scoped_to_provider_and_edition(conn):
    for name, departure in (("a", "08:00:00"), ("b", "08:10:00")):
        trip(conn, name, departure)
        trip(conn, name, "08:05:00", version=VERSION + 1, provider="first_stop_other")
        trip(conn, name, "08:02:00", version=VERSION + 2)
    assert read(conn)["R"].headway[0].headway_min == 10.0
    assert (
        build_route_headways_r3(
            conn,
            provider_id="first_stop_other",
            static_context=StaticScheduleContext(VERSION, ("W",)),
        )
        == {}
    )


def test_headways_keep_overnight_and_calendar_exception_service(conn):
    for name, departure, service in (
        ("a", "23:50:00", "added"),
        ("b", "24:10:00", "added"),
        ("c", "23:55:00", "removed"),
    ):
        trip(conn, name, departure, service=service)
    conn.execute(
        text("""
        INSERT INTO silver.calendar_dates
            (provider_id, dataset_version_id, service_id, service_date, exception_type)
        VALUES (:p, :v, 'added', :d, 1), (:p, :v, 'removed', :d, 2)
    """),
        dict(p=PROVIDER, v=VERSION, d=date(2026, 6, 1)),
    )
    context = _static_schedule_context(conn, provider_id=PROVIDER)
    assert context.weekday_services == ("added",)
    assert read(conn, context=context)["R"].model_dump() == {
        "headway": [{"shift": "night", "window": "23:00–06:00", "headway_min": 20.0}]
    }
