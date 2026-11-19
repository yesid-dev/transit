"""The paired shadow's PostgreSQL reader against the migrated schema."""

from transit_ops.live.facts import TRIP_COLUMNS, VEHICLE_COLUMNS
from transit_ops.live.shadow import ALERTS, postgres_rows
from transit_ops.static.alert_seed_contract import SCHEMAS


def test_reader_matches_local_relations_and_reads_only_the_cycle(real_db_engine):
    read = postgres_rows(real_db_engine, "shadow-reader-absent")
    evidence = read((1, 2), True)
    rows = evidence.tables
    assert evidence.now.utcoffset() is not None
    assert rows["fact_trip_delay_snapshot"].columns == tuple(n for n, _ in TRIP_COLUMNS)
    assert rows["fact_vehicle_snapshot"].columns == tuple(n for n, _ in VEHICLE_COLUMNS)
    assert rows[ALERTS].columns == tuple(SCHEMAS[ALERTS])
    assert all(table.rows == () for table in rows.values())
    assert ALERTS not in read((), False).tables
