import pytest
from sqlalchemy import text

from transit_ops.history.datasets import HISTORY_DATASETS, WORKING_ONLY, validate_declarations
from transit_ops.lake.catalog import read_catalog
from transit_ops.lake.inventory import take_inventory
from transit_ops.lake.table_schema import Column


def test_every_base_table_at_migration_head_is_declared_exactly_once(real_db_engine):
    validate_declarations(HISTORY_DATASETS, WORKING_ONLY)
    with real_db_engine.connect() as conn, conn.begin():
        conn.execute(text("SET TRANSACTION READ ONLY"))
        catalog = read_catalog(conn)
        result = take_inventory(catalog)
        assert result.complete, result
        assert set(result.copied + result.working_only) == {
            table.name
            for table in catalog
            if table.kind in {"table", "partitioned"}
            and table.name not in dict(result.infrastructure)
            and table.partition_root is None
        }
        assert dict(result.infrastructure)["public.spatial_ref_sys"] == "extension:postgis"


def test_catalog_reader_refuses_a_writable_transaction(real_db_engine):
    with real_db_engine.connect() as conn, conn.begin():
        conn.execute(text("SET TRANSACTION READ WRITE"))
        with pytest.raises(ValueError, match="read_only_required"):
            read_catalog(conn)


def test_catalog_preserves_columns_keys_and_names_stray_tables(real_db_engine):
    with real_db_engine.connect() as conn:
        try:
            conn.exec_driver_sql("CREATE SCHEMA catalog_probe")
            conn.exec_driver_sql("CREATE TABLE public.catalog_stray (id bigint PRIMARY KEY)")
            conn.exec_driver_sql("""CREATE TABLE catalog_probe.stray (
                z numeric(9,2), a bigint NOT NULL, gone text, b text NOT NULL,
                PRIMARY KEY (b, a))""")
            conn.exec_driver_sql("ALTER TABLE catalog_probe.stray DROP COLUMN gone")
            conn.exec_driver_sql(
                "CREATE VIEW catalog_probe.visible AS SELECT a FROM catalog_probe.stray"
            )
            conn.exec_driver_sql("""CREATE TABLE catalog_probe.root (id bigint PRIMARY KEY)
                PARTITION BY RANGE (id)""")
            conn.exec_driver_sql("""CREATE TABLE catalog_probe.child PARTITION OF catalog_probe.root
                FOR VALUES FROM (0) TO (10)""")
            conn.commit()
            conn.exec_driver_sql("SET TRANSACTION READ ONLY")
            catalog = read_catalog(conn)
            tables = {table.name: table for table in catalog}
            assert tables["catalog_probe.stray"].columns == (
                Column("z", "numeric(9,2)", False),
                Column("a", "bigint", True),
                Column("b", "text", True),
            )
            assert tables["catalog_probe.stray"].primary_key == ("b", "a")
            assert tables["catalog_probe.child"].partition_root == "catalog_probe.root"
            result = take_inventory(catalog)
            assert not result.complete
            assert result.unclaimed == (
                "catalog_probe.root",
                "catalog_probe.stray",
                "public.catalog_stray",
            )
            assert "catalog_probe.visible" in result.views
        finally:
            conn.rollback()
            conn.exec_driver_sql("DROP SCHEMA IF EXISTS catalog_probe CASCADE")
            conn.exec_driver_sql("DROP TABLE IF EXISTS public.catalog_stray")
            conn.commit()
