"""Installed PG departure math and production builders are difference detectors.

Only disposable guarded real_db_engine is used. Retarget installed view sources
to tiny transport frames and replace now() with the identical explicit cycle.
R28(b) cancelled/skipped/deleted differences are asserted, never normalized away.
The accepted LS3.6 long-service SQL cutoff evidence remains applicable.
"""

import json

import pytest
from sqlalchemy import text
from test_live_builders_movement import build, future_message
from test_live_captures import _parse
from test_live_facts import parsed_vehicle, vehicle_message
from test_live_running import AT
from test_live_running import local as local

from transit_ops.live.facts import apply_capture
from transit_ops.snapshots.builders import live
from transit_ops.snapshots.builders._helpers import _iso
from transit_ops.snapshots.serialization import snapshot_json_bytes


def _departure_view(conn, parsed):
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
            conn.execute(
                text(
                    f"INSERT INTO pg_temp.{table} ({','.join(columns)}) "
                    f"VALUES ({','.join(':' + c for c in columns)})"
                ),
                row,
            )
    definition = (
        conn.execute(
            text("SELECT pg_get_viewdef('gold.current_stop_next_departures'::regclass,true)")
        )
        .scalar_one()
        .strip()
        .removesuffix(";")
    )
    for table in tables:
        definition = definition.replace("silver." + table, "pg_temp." + table)
    definition = definition.replace("now()", "CAST(:cycle AS timestamptz)")
    conn.execute(
        text("CREATE TEMP TABLE current_stop_next_departures ON COMMIT DROP AS " + definition),
        {"cycle": AT},
    )


class LocalSources:
    """Run unchanged production builder SQL on isolated sources and one clock."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, query, params):
        sql = str(query).replace("gold.", "pg_temp.").replace("silver.", "pg_temp.")
        sql = sql.replace("now()", "CAST(:cycle AS timestamptz)")
        return self.conn.execute(text(sql), {**params, "cycle": AT})


@pytest.mark.parametrize("removed", [False, True])
def test_actual_three_key_bytes_maps_and_classified_pg_difference(real_db_engine, local, removed):
    message = future_message()
    message.entity[0].trip_update.stop_time_update[0].stop_id = "站"
    if removed:
        message.entity[0].trip_update.trip.schedule_relationship = 3
    parsed = _parse(message)
    vehicles = vehicle_message()
    del vehicles.entity[1:]
    vehicles.entity[0].vehicle.ClearField("stop_id")
    apply_capture(local, parsed_vehicle(vehicles), provider_timezone="America/Toronto")
    ours = build(local, parsed)
    with real_db_engine.connect() as conn, conn.begin() as tx:
        try:
            _departure_view(conn, parsed)
            # Independent +690s calculation: 08:00 EDT =12Z; prediction12:11:30Z.
            conn.execute(
                text(
                    "CREATE TEMP TABLE current_trip_delay_computed "
                    "(provider_id text,trip_id text,route_id text,avg_delay_seconds numeric) "
                    "ON COMMIT DROP"
                )
            )
            if not removed:
                conn.execute(
                    text(
                        "INSERT INTO pg_temp.current_trip_delay_computed "
                        "VALUES ('network','行程','路线',690)"
                    )
                )
            for table in (
                "current_vehicle_map_with_status",
                "latest_vehicle_snapshot",
                "dim_stop",
                "realtime_serving_state",
            ):
                conn.execute(
                    text(
                        f"CREATE TEMP TABLE {table} ON COMMIT DROP "
                        f"AS SELECT * FROM gold.{table} WITH NO DATA"
                    )
                )
            conn.execute(
                text(
                    "INSERT INTO pg_temp.current_vehicle_map_with_status "
                    "(provider_id,realtime_snapshot_id,entity_index,vehicle_id,trip_id,route_id,"
                    "latitude,longitude,captured_at_utc,trip_avg_delay_seconds,status_band) "
                    "VALUES ('network',42,0,'bus-0','行程','路线',45.5,-73.5,:at,:delay,:band)"
                ),
                {
                    "at": AT,
                    "delay": None if removed else 690,
                    "band": "Inconnu / Unknown" if removed else "Critique / Severe",
                },
            )
            conn.execute(
                text(
                    "INSERT INTO pg_temp.latest_vehicle_snapshot "
                    "(provider_id,realtime_snapshot_id,entity_index,bearing,speed,occupancy_status,"
                    "position_timestamp_utc) "
                    "VALUES ('network',42,0,123.4,10,2,to_timestamp(1781956800))"
                )
            )
            if not removed:
                conn.execute(
                    text(
                        "INSERT INTO pg_temp.dim_stop "
                        "(provider_id,stop_id,stop_lat,stop_lon) "
                        "VALUES ('network','站',45.5,-73.5)"
                    )
                )
            source = LocalSources(conn)
            pg = {
                name: snapshot_json_bytes(
                    builder(source, provider_id="network", generated_utc=_iso(AT))
                )
                for name, builder in (
                    ("vehicles.json", live.build_vehicles),
                    ("trips.json", live.build_trips),
                    ("stop_departures.json", live.build_stop_departures),
                )
            }
            differences = {key for key in ours if ours[key] != pg[key]}
            if removed:
                assert differences == {"vehicles.json", "trips.json", "stop_departures.json"}
                assert json.loads(ours["trips.json"])["trips"] == {}
                assert json.loads(pg["trips.json"])["trips"]["行程"]["stops"]
                # R28(b): installed departure view includes cancelled service.
                # Production vehicle SQL likewise exposes its cancelled next stop.
                # SQL/public methodology reconciliation remains preactivation work.
            else:
                assert differences == set()  # No representation normalization needed.
                assert json.loads(ours["trips.json"])["trips"]["行程"]["delay_min"] == 12
        finally:
            tx.rollback()
