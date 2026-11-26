from __future__ import annotations

import pytest
import real_db_seed as db_seed
from sqlalchemy import text
from test_departure_capture_order_real_db import _later_inserted_snapshot
from test_snapshots_live_departures_real_db import (
    ENDPOINT_ID,
    PROVIDER,
    RAW_SNAP_ID,
    RUN_ID,
    _add_delay_snapshot,
    _add_trip_update,
    _stop,
)
from test_snapshots_live_departures_real_db import conn as conn

from transit_ops.snapshots.builders import build_vehicles
from transit_ops.snapshots.builders.live import _VEHICLES_SQL


def test_vehicles_publish_in_binary_id_order_with_stable_ties(conn):
    # Reverse binary order, including case, duplicate ids and a missing id.
    for entity_index, vehicle_id in [(5, None), (4, "v1"), (3, "V2"), (2, "V1"), (1, "V1")]:
        conn.execute(
            text("""
            INSERT INTO gold.latest_vehicle_snapshot
                (provider_id, realtime_snapshot_id, entity_index, snapshot_date_key,
                 snapshot_local_date, feed_timestamp_utc, captured_at_utc,
                 vehicle_id, trip_id, route_id, latitude, longitude)
            VALUES (:p, :s, :i, to_char(now(), 'YYYYMMDD')::int, now()::date, now(), now(),
                    :v, 'ordering-trip', :route, 45.5, -73.6)
            """),
            {
                "p": PROVIDER,
                "s": RAW_SNAP_ID,
                "i": entity_index,
                "v": vehicle_id,
                "route": str(entity_index),
            },
        )
    # The status view can fan out one entity into distinct delay groups.
    for entity_index, direction, delay in [(11, 1, 240), (10, 0, 120)]:
        _add_delay_snapshot(
            conn,
            entity_index=entity_index,
            trip_id="ordering-trip",
            route_id="51",
            direction_id=direction,
            delay_seconds=delay,
        )

    result = build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture")

    assert [(v.id, v.route, v.delay_min) for v in result.vehicles] == [
        ("V1", "1", 2),
        ("V1", "1", 4),
        ("V1", "2", 2),
        ("V1", "2", 4),
        ("V2", "3", 2),
        ("V2", "3", 4),
        ("v1", "4", 2),
        ("v1", "4", 4),
        ("None", "5", 2),
        ("None", "5", 4),
    ]


def _vehicle(
    connection, *, stop=None, trip="capture-order-trip", capture_minutes=0, provider=PROVIDER
):
    connection.execute(
        text("""
        INSERT INTO gold.latest_vehicle_snapshot
            (provider_id, realtime_snapshot_id, entity_index, snapshot_date_key,
             snapshot_local_date, feed_timestamp_utc, captured_at_utc,
             vehicle_id, trip_id, route_id, stop_id, latitude, longitude)
        VALUES (:p, :s, 99, to_char(now(), 'YYYYMMDD')::int, now()::date, now(),
                now()+make_interval(mins=>:capture), 'vehicle', :trip, '51', :stop, 45.5, -73.6)
        """),
        {"p": provider, "s": RAW_SNAP_ID, "stop": stop, "trip": trip, "capture": capture_minutes},
    )


@pytest.mark.parametrize(
    ("position_stop", "trip", "minutes", "expected"),
    [
        ("position-stop", "capture-order-trip", [5, 10], "position-stop"),
        ("position-stop", None, [5], "position-stop"),
        (None, "capture-order-trip", [-1, 0, 5], "stop-1"),
        (None, None, [5], None),
        (None, "capture-order-trip", [-10, -1], None),
        (None, "missing-trip", [5], None),
        (None, "capture-order-trip", [], None),
    ],
)
def test_vehicle_next_stop(conn, position_stop, trip, minutes, expected):
    _vehicle(conn, stop=position_stop, trip=trip)
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    for i, mins in enumerate(minutes):
        _stop(conn, entity_index=0, stu_index=i, stop_id=f"stop-{i}", seq=i + 1, mins=mins)
    db_seed.dataset_versions(
        conn, {"d": 990501, "p": PROVIDER, "e": ENDPOINT_ID, "r": RUN_ID, "h": "next-stop"}
    )
    conn.execute(
        text("""
        INSERT INTO gold.dim_stop
            (provider_id, dataset_version_id, stop_id, stop_name, stop_lat, stop_lon)
        VALUES (:p, 990501, 'position-stop', 'Position stop', 45.5, -73.6),
               (:p, 990501, 'stop-1', 'Trip update stop', 45.6, -73.7)
    """),
        {"p": PROVIDER},
    )
    result = build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture")
    coordinates = {"position-stop": (45.5, -73.6), "stop-1": (45.6, -73.7)}
    v = result.vehicles[0]
    assert (v.next_stop_lat, v.next_stop_lon) == coordinates.get(expected, (None, None))
    assert len(result.vehicles) == 1
    assert result.vehicles[0].next_stop == expected


def test_vehicle_next_stop_uses_capture_time_and_arrival_only_prediction(conn):
    _vehicle(conn, capture_minutes=-5)
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    _stop(conn, entity_index=0, stu_index=0, stop_id="arrival-stop", seq=1, mins=-2)
    conn.execute(
        text("""
        UPDATE silver.rt_trip_update_stop_times
        SET arrival_time_utc=departure_time_utc, departure_time_utc=NULL
        WHERE provider_id=:p
    """),
        {"p": PROVIDER},
    )
    result = build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture")
    assert result.vehicles[0].next_stop == "arrival-stop"


def test_vehicle_next_stop_uses_stop_sequence_not_prediction_order(conn):
    _vehicle(conn)
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    _stop(conn, entity_index=0, stu_index=0, stop_id="later-in-trip", seq=3, mins=1)
    _stop(conn, entity_index=0, stu_index=1, stop_id="first-upcoming", seq=2, mins=5)
    _stop(conn, entity_index=0, stu_index=2, stop_id="past", seq=1, mins=-1)
    result = build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture")
    assert result.vehicles[0].next_stop == "first-upcoming"


@pytest.mark.parametrize("missing", ["stop_id", "departure_time_utc"])
def test_vehicle_next_stop_requires_stop_id_and_prediction(conn, missing):
    _vehicle(conn)
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    _stop(conn, entity_index=0, stu_index=0, stop_id="unknown-stop", seq=1, mins=5)
    conn.execute(
        text(f"UPDATE silver.rt_trip_update_stop_times SET {missing}=NULL WHERE provider_id=:p"),
        {"p": PROVIDER},
    )
    result = build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture")
    assert result.vehicles[0].next_stop is None


@pytest.mark.parametrize("newer_minutes", [-10, 10])
def test_vehicle_next_stop_uses_latest_capture_not_largest_snapshot_id(conn, newer_minutes):
    _vehicle(conn)
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    _stop(conn, entity_index=0, stu_index=0, stop_id="current-stop", seq=1, mins=20)
    _later_inserted_snapshot(conn, capture_minutes=newer_minutes, departure_minutes=5)
    result = build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture")
    assert result.vehicles[0].next_stop == ("current-stop" if newer_minutes < 0 else "S1")


def test_vehicle_next_stop_does_not_resurrect_stops_after_empty_latest_feed(conn):
    _vehicle(conn)
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    _stop(conn, entity_index=0, stu_index=0, stop_id="old-stop", seq=1, mins=20)
    _later_inserted_snapshot(conn, capture_minutes=10, departure_minutes=None)
    assert (
        build_vehicles(conn, provider_id=PROVIDER, generated_utc="fixture").vehicles[0].next_stop
        is None
    )


@pytest.mark.parametrize(
    ("relation", "equality_prefix"),
    [
        ("silver.rt_trip_updates", ("provider_id", "trip_id")),
        ("silver.rt_trip_update_stop_times", ("rt_feed_snapshot_id", "entity_index")),
        ("gold.dim_stop", ("provider_id", "stop_id")),
    ],
)
def test_vehicle_next_stop_index_paths_are_available(
    conn, record_property, relation, equality_prefix
):
    # Check eligibility, not which path wins a cost comparison. The lateral
    # lookup equates these leading columns; its time/stop filters are residuals.
    # Catalog metadata is independent of leftover rows, ANALYZE and fleet order.
    indexes = (
        conn.execute(
            text("""
        SELECT index_class.relname AS name,
               ARRAY(
                   SELECT attribute.attname::text
                   FROM unnest(idx.indkey) WITH ORDINALITY AS key(attnum, position)
                   JOIN pg_attribute AS attribute
                     ON attribute.attrelid = idx.indrelid AND attribute.attnum = key.attnum
                   WHERE key.position <= idx.indnkeyatts
                   ORDER BY key.position
               ) AS columns
        FROM pg_index AS idx
        JOIN pg_class AS index_class ON index_class.oid = idx.indexrelid
        JOIN pg_am AS method ON method.oid = index_class.relam
        WHERE idx.indrelid = to_regclass(:relation)
          AND idx.indisvalid AND idx.indisready AND idx.indislive
          AND idx.indpred IS NULL AND idx.indexprs IS NULL
          AND method.amname = 'btree'
        """),
            {"relation": relation},
        )
        .mappings()
        .all()
    )
    record_property("next_stop_index_paths", str([dict(index) for index in indexes]))
    assert any(
        tuple(index["columns"][: len(equality_prefix)]) == equality_prefix for index in indexes
    ), f"No usable B-tree on {relation} with equality prefix {equality_prefix}: {indexes}"


def test_vehicle_next_stop_lookup_can_use_stop_times_primary_key(conn, record_property):
    _add_trip_update(conn, entity_index=0, trip_id="capture-order-trip", route_id="51")
    _stop(conn, entity_index=0, stu_index=0, stop_id="next-stop", seq=1, mins=5)
    # A real trip-updates snapshot carries many entities, not one. The filler
    # entities share the snapshot and the provider, so the provider/stop index
    # that also matches this lookup crosses every entity, while the primary
    # key (rt_feed_snapshot_id, entity_index, ...) reaches only the looked-up
    # entity. One lone row ties the two index costs and the planner's pick
    # followed whatever statistics the surrounding CI run happened to have.
    for entity_index in range(1, 26):
        _add_trip_update(
            conn, entity_index=entity_index, trip_id=f"filler-trip-{entity_index}", route_id="51"
        )
        _stop(
            conn,
            entity_index=entity_index,
            stu_index=0,
            stop_id=f"filler-stop-{entity_index}",
            seq=1,
            mins=5,
        )
    # Analyze only what this transaction seeded, so the cost comparison below
    # runs on fixed statistics instead of ambient CI table state.
    conn.execute(text("ANALYZE silver.rt_trip_update_stop_times"))
    # Derive the actual stop-times predicates, ordering and LIMIT from production.
    # Bind the outer-row values so neither fleet ordering nor join costing can
    # influence this check. Changed fragment boundaries fail instead of drifting.
    sql = " ".join(str(_VEHICLES_SQL).split())
    _, start, lookup = sql.partition("JOIN silver.rt_trip_update_stop_times AS stu ON ")
    assert start
    lookup, end, _ = lookup.partition(") AS upcoming ON true")
    assert end
    lookup = lookup.replace(" WHERE ", " AND ", 1)
    for column, value in {
        "rtu.rt_feed_snapshot_id": ":snapshot_id",
        "rtu.entity_index": "CAST(:entity_index AS integer)",
        "rtu.provider_id": ":provider_id",
        "cvm.stop_id": "CAST(:position_stop_id AS text)",
        "cvm.trip_id": "CAST(:trip_id AS text)",
        "cvm.captured_at_utc": ":captured_at",
    }.items():
        lookup = lookup.replace(column, value)
    conn.execute(text("SET LOCAL enable_seqscan = off"))
    plan = conn.execute(
        text(
            "EXPLAIN (FORMAT JSON) SELECT stu.stop_id "
            "FROM silver.rt_trip_update_stop_times AS stu WHERE " + lookup
        ),
        {
            "snapshot_id": conn.execute(
                text(
                    "SELECT rt_feed_snapshot_id FROM silver.rt_feed_snapshots "
                    "WHERE provider_id = :p"
                ),
                {"p": PROVIDER},
            ).scalar_one(),
            "entity_index": 0,
            "provider_id": PROVIDER,
            "position_stop_id": None,
            "trip_id": "capture-order-trip",
            "captured_at": conn.execute(text("SELECT now()")).scalar_one(),
        },
    ).scalar_one()
    record_property("next_stop_lookup_plan", str(plan))

    def indexes(node):
        found = {node["Index Name"]} if "Index Name" in node else set()
        for child in node.get("Plans", []):
            found.update(indexes(child))
        return found

    assert "pk_silver_rt_trip_update_stop_times" in indexes(plan[0]["Plan"])


@pytest.mark.parametrize("provider", ["stm_coords_test", "octranspo_coords_test"])
@pytest.mark.parametrize(
    "coords", [(45.501234, -73.601234), (None, None), (45.5, None), (None, -73.6)]
)
def test_next_stop_coordinates_join_only_provider_current_stops(
    conn, seed_provider, provider, coords
):
    seed_provider(conn, provider, display_name=provider)
    # A foreign provider with the same stop id must never supply coordinates.
    for p, dataset, lat, lon in [
        (PROVIDER, 990501, 10, 20),
        (provider, 990502, coords[0], coords[1]),
    ]:
        db_seed.dataset_versions(
            conn, {"d": dataset, "p": p, "e": ENDPOINT_ID, "r": RUN_ID, "h": "next-stop"}
        )
        conn.execute(
            text("""
            INSERT INTO gold.dim_stop
                (provider_id, dataset_version_id, stop_id, stop_name, stop_lat, stop_lon)
            VALUES (:p, :d, 'position-stop', 'Stop', :lat, :lon)
        """),
            {"p": p, "d": dataset, "lat": lat, "lon": lon},
        )
    _vehicle(conn, provider=provider, stop="position-stop", trip=None)
    v = build_vehicles(conn, provider_id=provider, generated_utc="fixture").vehicles[0]
    expected = tuple(round(c, 5) for c in coords) if None not in coords else (None, None)
    assert (v.next_stop_lat, v.next_stop_lon) == expected
    conn.execute(text("DELETE FROM gold.dim_stop WHERE provider_id=:p"), {"p": provider})
    v = build_vehicles(conn, provider_id=provider, generated_utc="fixture").vehicles[0]
    assert v.next_stop == "position-stop"
    assert (v.next_stop_lat, v.next_stop_lon) == (None, None)
