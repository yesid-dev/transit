"""Compare catalog relations with history declarations without database access."""

from collections.abc import Sequence
from dataclasses import dataclass

from transit_ops.history.datasets import HISTORY_DATASETS, WORKING_ONLY, TableSource
from transit_ops.lake.catalog import CatalogTable

INFRASTRUCTURE = {"public.alembic_version": "Alembic revision table; maintained by migrations"}

@dataclass(frozen=True)
class Inventory:
    copied: tuple[str, ...]
    working_only: tuple[str, ...]
    views: tuple[str, ...]
    unclaimed: tuple[str, ...]
    missing: tuple[str, ...]
    key_mismatch: tuple[str, ...]
    window_mismatch: tuple[str, ...]
    unsupported: tuple[str, ...]
    infrastructure: tuple[tuple[str, str], ...] = ()
    partitions: tuple[tuple[str, str], ...] = ()

    @property
    def complete(self) -> bool:
        return not any(
            (
                self.unclaimed,
                self.missing,
                self.key_mismatch,
                self.window_mismatch,
                self.unsupported,
            )
        )


def take_inventory(catalog: Sequence[CatalogTable]) -> Inventory:
    copied = {
        entry.source.table: entry.source
        for entry in HISTORY_DATASETS.values()
        if isinstance(entry.source, TableSource)
    }
    working = {table for entry in WORKING_ONLY.values() for table in entry.tables}
    infrastructure = {
        table.name: (
            f"extension:{table.extension}" if table.extension else INFRASTRUCTURE[table.name]
        )
        for table in catalog
        if table.name not in copied
        and table.name not in working
        and (table.extension or table.name in INFRASTRUCTURE)
    }
    partitions = {table.name: table.partition_root for table in catalog if table.partition_root}
    catalog = [t for t in catalog if t.name not in infrastructure and t.name not in partitions]
    tables = {table.name: table for table in catalog if table.kind in {"table", "partitioned"}}
    present = tables.keys()
    keys, windows = [], []
    for name in sorted(present & copied.keys()):
        source, table = copied[name], tables[name]
        if source.key_columns != table.primary_key:
            keys.append(name)
        if source.window_column is not None:
            types = {column.name: column.pg_type for column in table.columns}
            if types.get(source.window_column) not in {
                "date",
                "timestamp with time zone",
                "bigint",
            }:
                windows.append(name)
    return Inventory(
        copied=tuple(sorted(present & copied.keys())),
        working_only=tuple(sorted(present & working)),
        views=tuple(sorted(table.name for table in catalog if table.kind == "view")),
        unclaimed=tuple(sorted(present - copied.keys() - working)),
        missing=tuple(sorted((copied.keys() | working) - present)),
        key_mismatch=tuple(keys),
        window_mismatch=tuple(windows),
        unsupported=tuple(
            sorted(
                table.name
                for table in catalog
                if table.kind not in {"table", "partitioned", "view"}
            )
        ),
        infrastructure=tuple(sorted(infrastructure.items())),
        partitions=tuple(sorted(partitions.items())),
    )
