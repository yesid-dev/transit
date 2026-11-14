import json
from unittest.mock import MagicMock, Mock

import pytest
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.lake.catalog import CatalogTable, read_catalog
from transit_ops.lake.inventory import Inventory, take_inventory


def test_catalog_refuses_writable_connections_before_reading_relations():
    conn = Mock()
    conn.execute.return_value.scalar_one.return_value = "off"
    with pytest.raises(ValueError, match="read_only_required"):
        read_catalog(conn)
    assert conn.execute.call_count == 1


def test_infrastructure_uses_membership_not_a_table_name():
    result = take_inventory(
        [
            CatalogTable("elsewhere.extension_table", "table", (), (), extension="postgis"),
            CatalogTable("public.spatial_ref_sys", "table", (), ()),
            CatalogTable("public.alembic_version", "table", (), ()),
            CatalogTable("repack.view", "view", (), (), extension="pg_repack"),
        ]
    )
    assert result.infrastructure == (
        ("elsewhere.extension_table", "extension:postgis"),
        ("public.alembic_version", "Alembic revision table; maintained by migrations"),
        ("repack.view", "extension:pg_repack"),
    )
    assert result.unclaimed == ("public.spatial_ref_sys",)
    assert not result.complete


@pytest.mark.parametrize("complete", [True, False])
def test_inventory_command_reads_in_a_read_only_transaction(monkeypatch, complete):
    from transit_ops.db import connection
    from transit_ops.lake import catalog, inventory

    engine = MagicMock()
    conn = engine.connect.return_value.__enter__.return_value
    monkeypatch.setattr(connection, "make_engine", lambda settings: engine)
    monkeypatch.setattr(catalog, "read_catalog", lambda c: [] if c is conn else None)
    result = Inventory((), (), (), () if complete else ("public.stray",), (), (), (), ())
    monkeypatch.setattr(inventory, "take_inventory", lambda tables: result)
    invoked = CliRunner().invoke(app, ["lake", "inventory"])
    assert invoked.exit_code == (0 if complete else 1), invoked.output
    assert json.loads(invoked.stdout)["unclaimed"] == ([] if complete else ["public.stray"])
    assert str(conn.execute.call_args.args[0]) == "SET TRANSACTION READ ONLY"
    engine.dispose.assert_called_once()


@pytest.mark.parametrize("stray", [False, True])
def test_stray_view_over_extension_table_makes_complete_catalog_and_cli_fail(monkeypatch, stray):
    from transit_ops.db import connection
    from transit_ops.history.datasets import HISTORY_DATASETS, WORKING_ONLY, TableSource
    from transit_ops.lake import catalog
    from transit_ops.lake.table_schema import Column

    relations = []
    for entry in HISTORY_DATASETS.values():
        source = entry.source
        if isinstance(source, TableSource):
            columns = (
                ()
                if source.window_column is None
                else (Column(source.window_column, "bigint", True),)
            )
            relations.append(CatalogTable(source.table, "table", columns, source.key_columns))
    relations.extend(CatalogTable(t, "table", (), ()) for t in WORKING_ONLY)
    names = """current_i3_alerts current_stop_next_departures dim_provider
        current_trip_delay_computed current_vehicle_map current_vehicle_map_with_status
        fact_stop_time_delay_observation feed_freshness_current i3_alert_history_reporting
        map_route_lines non_responding_current public_route_reliability_daily
        public_stop_delay_daily source_lineage_reporting""".split()
    relations.extend(CatalogTable("gold." + name, "view", (), ()) for name in names)
    relations.append(CatalogTable("public.spatial_ref_sys", "table", (), (), extension="postgis"))
    if stray:
        relations.append(CatalogTable("public.catalog_stray_view", "view", (), ()))
    result = take_inventory(relations)
    monkeypatch.setattr(connection, "make_engine", lambda settings: MagicMock())
    monkeypatch.setattr(catalog, "read_catalog", lambda conn: relations)
    invoked = CliRunner().invoke(app, ["lake", "inventory"])
    assert (result.complete, result.unclaimed, invoked.exit_code) == (
        not stray,
        ("public.catalog_stray_view",) if stray else (),
        1 if stray else 0,
    )
    assert result.views == tuple(sorted("gold." + name for name in names))
    assert json.loads(invoked.stdout)["complete"] is not stray
