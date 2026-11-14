from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from transit_ops.snapshots import builders
from transit_ops.sql_registry import query_name

IDS = ["a", "B", "é", "_", "10", "9"]
BINARY = ["10", "9", "B", "_", "a", "é"]
STAMP = datetime(2026, 7, 21, tzinfo=UTC)
PROVIDER = "history_total_order_test"


class OrderedConnection:
    """Observe real SQL rows at the builder's connection interface."""

    def __init__(self, conn):
        self.conn = conn
        self.rows = {}

    def execute(self, statement, params=None):
        result = self.conn.execute(statement, params)
        frozen = result.freeze()
        self.rows[query_name(statement)] = frozen().mappings().all()
        return frozen()


@pytest.fixture
def conn(real_db_engine, seed_provider, capsys):
    with real_db_engine.connect() as connection, connection.begin() as transaction:
        seed_provider(connection, PROVIDER, display_name="History order fixture", timezone="UTC")
        with capsys.disabled():
            print(
                "CI database collation:",
                connection.execute(
                    text("SELECT datcollate FROM pg_database WHERE datname = current_database()")
                ).scalar_one(),
            )
        yield connection
        transaction.rollback()


def nonbinary_inputs(conn):
    # Transactional views expose identical rows with a deliberately nonbinary text collation.
    columns = conn.execute(
        text("""
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'gold' ORDER BY table_name, ordinal_position
    """)
    ).all()
    conn.execute(text("ALTER SCHEMA gold RENAME TO history_order_original"))
    conn.execute(text("CREATE SCHEMA gold"))
    tables = {}
    for table, column, kind in columns:
        expression = f'"{column}"'
        if kind == "text":
            expression += ' COLLATE "und-x-icu"'
        tables.setdefault(table, []).append(f'{expression} AS "{column}"')
    for table, expressions in tables.items():
        projection = ", ".join(expressions)
        conn.execute(
            text(
                f'CREATE VIEW gold."{table}" AS SELECT {projection} '
                f'FROM history_order_original."{table}"'
            )
        )


def insert(conn, table, values):
    columns = ", ".join(values)
    binds = ", ".join(f":{key}" for key in values)
    conn.execute(text(f"INSERT INTO gold.{table} ({columns}) VALUES ({binds})"), values)


def seed_entities(conn, kind):
    field = "route_id" if kind == "line" else "stop_id"
    prefix = "route" if kind == "line" else "stop"
    tables = [
        f"{prefix}_delay_spine",
        f"{prefix}_delay_percentile_daily",
        f"{prefix}_occupancy_band_daily",
    ]
    if kind == "line":
        tables += [
            "route_cancellation_daily",
            "route_service_span_daily",
            "route_skipped_stop_daily",
        ]
    for entity_id in IDS:
        for table in tables:
            values = dict(
                provider_id=PROVIDER,
                provider_local_date="2026-07-20",
                built_at_utc=STAMP,
                **{field: entity_id},
            )
            if table.endswith("delay_spine"):
                values.update(observation_count=1, sum_delay_seconds=60, severe_delay_count=0)
                if kind == "line":
                    values.update(hour_of_day_local=8, direction_id=0, delay_observation_count=1)
                else:
                    values.update(route_id="route")
            elif table.endswith("percentile_daily"):
                values.update(delay_observation_count=1, p50_delay_seconds=60, p90_delay_seconds=60)
            elif table.endswith("occupancy_band_daily"):
                values.update(observation_count=1, empty_count=1)
            elif table == "route_cancellation_daily":
                values.update(total_trip_days=1, canceled_trip_days=0)
            elif table == "route_service_span_daily":
                values.update(trip_count=1)
            else:
                values.update(stop_time_update_count=1, skipped_stop_count=0)
            insert(conn, table, values)


@pytest.mark.parametrize("kind", ["line", "stop"])
def test_entity_history_sql_orders_every_metric_and_inventory_in_binary_order(conn, kind):
    seed_entities(conn, kind)
    field = "route_id" if kind == "line" else "stop_id"
    nonbinary_inputs(conn)
    observed = OrderedConnection(conn)
    build = getattr(builders, f"build_{kind}_history_plan")
    list(
        build(
            observed, provider_id=PROVIDER, generated_utc=STAMP.isoformat(), as_of_utc=STAMP
        ).iter_partition_items()
    )
    family = "lines" if kind == "line" else "stops"
    metrics = ["ids", "delay", "percentiles", "occupancy"]
    if kind == "line":
        metrics += ["cancellation", "service_span", "skipped_stops"]
    for metric in metrics:
        assert [row[field] for row in observed.rows[f"history.{family}.{metric}.inner"]] == BINARY


def seed_names(conn):
    for entity_id in IDS:
        for kind in ("route", "stop"):
            for start, end in (("2026-07-01", "2026-07-10"), ("2026-07-10", None)):
                values = dict(
                    provider_id=PROVIDER,
                    valid_from_utc=start,
                    valid_to_utc=end,
                    **{f"{kind}_id": entity_id},
                )
                values["route_long_name" if kind == "route" else "stop_name"] = entity_id
                insert(conn, f"dim_{kind}_history", values)


def test_hotspot_sql_orders_names_and_tied_daily_keys(conn):
    seed_names(conn)
    for entity_id in IDS:
        insert(
            conn,
            "route_delay_spine",
            dict(
                provider_id=PROVIDER,
                route_id=entity_id,
                provider_local_date="2026-07-20",
                hour_of_day_local=8,
                direction_id=0,
                delay_observation_count=1,
                sum_delay_seconds=60,
                built_at_utc=STAMP,
            ),
        )
        for route_id in ("a", "B"):
            insert(
                conn,
                "stop_delay_spine",
                dict(
                    provider_id=PROVIDER,
                    stop_id=entity_id,
                    route_id=route_id,
                    provider_local_date="2026-07-20",
                    observation_count=1,
                    sum_delay_seconds=60,
                    built_at_utc=STAMP,
                ),
            )
    nonbinary_inputs(conn)
    observed = OrderedConnection(conn)
    list(
        builders.build_hotspots_history_plan(
            observed, provider_id=PROVIDER, as_of_utc=STAMP
        ).iter_days()
    )
    assert [
        (r["entity_kind"], r["entity_id"]) for r in observed.rows["history.hotspots.names"]
    ] == [(kind, entity_id) for kind in ("route", "stop") for entity_id in BINARY for _ in range(2)]
    assert [r["route_id"] for r in observed.rows["history.hotspots.route_daily"]] == BINARY
    assert [
        (r["stop_id"], r["route_id"]) for r in observed.rows["history.hotspots.stop_daily"]
    ] == [(entity_id, route_id) for entity_id in BINARY for route_id in ("B", "a")]


def test_repeat_offender_sql_orders_names_and_tied_daily_keys(conn):
    seed_names(conn)
    for entity_id in IDS:
        for route_id in ("a", "B"):
            insert(
                conn,
                "repeat_offender_daily_spine",
                dict(
                    provider_id=PROVIDER,
                    entity_kind="trip",
                    entity_id=entity_id,
                    route_id=route_id,
                    provider_local_date="2026-07-20",
                    observation_count=1,
                    sum_delay_seconds=60,
                    built_at_utc=STAMP,
                ),
            )
    nonbinary_inputs(conn)
    observed = OrderedConnection(conn)
    list(
        builders.build_repeat_offenders_history_plan(
            observed, provider_id=PROVIDER, as_of_utc=STAMP
        ).iter_days()
    )
    assert [r["entity_id"] for r in observed.rows["history.repeat_offenders.names"]] == [
        entity_id for entity_id in BINARY for _ in range(2)
    ]
    assert [
        (r["entity_id"], r["route_id"]) for r in observed.rows["history.repeat_offenders.daily"]
    ] == [(entity_id, route_id) for entity_id in BINARY for route_id in ("B", "a")]
