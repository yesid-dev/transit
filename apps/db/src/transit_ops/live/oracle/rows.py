"""Detached cycle evidence, restricted to facts and alert parity state.

No static source-member wall-clock first/last-seen columns are in this contract.
Dates and timestamps retain driver types; JSONB is PostgreSQL text for comparison.
"""

from dataclasses import dataclass

from sqlalchemy import Connection, text

from transit_ops.static.alert_seed_contract import KEYS, SCHEMAS, TABLES


@dataclass(frozen=True)
class TableRows:
    table: str
    columns: tuple[str, ...]
    types: tuple[str, ...]
    key_columns: tuple[int, ...]
    rows: tuple[tuple[object, ...], ...]


_COMMON = dict(
    provider_id="text",
    realtime_snapshot_id="bigint",
    entity_index="integer",
    snapshot_date_key="integer",
    snapshot_local_date="date",
    feed_timestamp_utc="timestamp with time zone",
    captured_at_utc="timestamp with time zone",
)
_TRIP = _COMMON | dict(
    entity_id="text",
    trip_id="text",
    route_id="text",
    direction_id="integer",
    start_date="date",
    vehicle_id="text",
    trip_schedule_relationship="integer",
    delay_seconds="integer",
    stop_time_update_count="integer",
    delay_stop_id="text",
    delay_stop_sequence="integer",
    skipped_stop_count="integer",
    occupancy_status="integer",
)
_VEHICLE = _COMMON | dict(
    position_timestamp_utc="timestamp with time zone",
    entity_id="text",
    vehicle_id="text",
    trip_id="text",
    route_id="text",
    stop_id="text",
    current_stop_sequence="integer",
    current_status="integer",
    occupancy_status="integer",
    latitude="double precision",
    longitude="double precision",
    bearing="double precision",
    speed="double precision",
)


def _read(
    connection: Connection,
    provider_id: str,
    table: str,
    schema: dict[str, str],
    keys: tuple[str, ...],
) -> TableRows:
    columns = tuple(schema)
    projection = ", ".join(
        f't."{c}"::text AS "{c}"' if kind == "jsonb" else f't."{c}"' for c, kind in schema.items()
    )
    scope = (
        "t.provider_id=:provider_id"
        if "provider_id" in schema
        else (
            "EXISTS (SELECT 1 FROM silver.i3_alerts a WHERE a.provider_id=:provider_id "
            "AND (a.i3_alert_snapshot_id, a.alert_index)="
            "(t.i3_alert_snapshot_id, t.alert_index))"
        )
    )
    result = connection.execute(
        text(
            f"SELECT {projection} FROM {table} t WHERE {scope} ORDER BY "
            + ", ".join(f't."{c}"' for c in keys)
        ),
        {"provider_id": provider_id},
    )
    return TableRows(
        table,
        columns,
        tuple(schema.values()),
        tuple(columns.index(c) for c in keys),
        tuple(tuple(r) for r in result),
    )


def read_cycle_rows(
    connection: Connection,
    *,
    provider_id: str,
) -> tuple[tuple[TableRows, ...], tuple[TableRows, ...]]:
    """Read one committed cycle before any later capture can mutate its state.

    Alert state includes closed versions, children and observations, separately
    from Gold facts. Raw captures and static seed bookkeeping are not evidence.
    SQL identifiers come only from the declared contracts, never caller input.
    """
    facts = tuple(
        _read(
            connection,
            provider_id,
            table,
            schema,
            ("provider_id", "realtime_snapshot_id", "entity_index"),
        )
        for table, schema in (
            ("gold.fact_trip_delay_snapshot", _TRIP),
            ("gold.fact_vehicle_snapshot", _VEHICLE),
        )
    )
    alerts = tuple(
        _read(connection, provider_id, table, SCHEMAS[table], tuple(KEYS[table]))
        for table in TABLES[:5]
    )
    return facts, alerts
