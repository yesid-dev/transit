"""Catalog value types shared by the reader and pure inventory comparison."""

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import Connection, text

from transit_ops.lake.table_schema import Column as Column


@dataclass(frozen=True)
class CatalogTable:
    name: str
    kind: Literal["table", "partitioned", "view", "materialized_view", "foreign", "other"]
    columns: tuple[Column, ...]
    primary_key: tuple[str, ...]
    extension: str | None = None
    partition_root: str | None = None


_RELATIONS = text("""
        SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relkind, e.extname,
            CASE WHEN c.relispartition THEN
                (SELECT rn.nspname || '.' || r.relname FROM pg_catalog.pg_class r
                 JOIN pg_catalog.pg_namespace rn ON rn.oid = r.relnamespace
                 WHERE r.oid = pg_catalog.pg_partition_root(c.oid)) END AS root
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass
            AND d.objid = c.oid AND d.objsubid = 0 AND d.deptype = 'e'
            AND d.refclassid = 'pg_catalog.pg_extension'::regclass
        LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND left(n.nspname, 8) <> 'pg_toast'
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY n.nspname, c.relname
""")


def read_catalog(connection: Connection) -> list[CatalogTable]:
    """Read data relations in the caller's read-only transaction, without changing it."""
    if connection.execute(text("SHOW transaction_read_only")).scalar_one() != "on":
        raise ValueError("read_only_required")
    relations = connection.execute(_RELATIONS).mappings().all()
    kinds: dict[
        str, Literal["table", "partitioned", "view", "materialized_view", "foreign", "other"]
    ] = {
        "r": "table",
        "p": "partitioned",
        "v": "view",
        "m": "materialized_view",
        "f": "foreign",
    }
    result = []
    for row in relations:
        columns = connection.execute(
            text("""
            SELECT attname, pg_catalog.format_type(atttypid, atttypmod), attnotnull
            FROM pg_catalog.pg_attribute
            WHERE attrelid = :oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum
        """),
            {"oid": row["oid"]},
        )
        key = connection.execute(
            text("""
            SELECT a.attname FROM pg_catalog.pg_index i
            CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, n)
            JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            WHERE i.indrelid = :oid AND i.indisprimary AND k.n <= i.indnkeyatts ORDER BY k.n
        """),
            {"oid": row["oid"]},
        ).scalars()
        result.append(
            CatalogTable(
                row["name"],
                kinds[row["relkind"]],
                tuple(Column(*column) for column in columns),
                tuple(key),
                row["extname"],
                row["root"],
            )
        )
    return result
