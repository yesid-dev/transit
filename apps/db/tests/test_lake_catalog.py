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
