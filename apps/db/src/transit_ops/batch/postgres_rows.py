"""Read comparison values without losing PostgreSQL's printed representations."""

from collections.abc import Sequence
from datetime import date
from typing import Any

from psycopg import Connection as PgConnection
from sqlalchemy import Connection, bindparam, text

from transit_ops.batch.build import TableRows


def _catalog(conn: Connection, parts: list[str]) -> Sequence[Any]:
    driver = conn.connection.driver_connection
    if not isinstance(driver, PgConnection):
        raise ValueError(f"{'.'.join(parts)}: psycopg connection required")
    if driver.autocommit:
        raise ValueError(f"{'.'.join(parts)}: DBAPI autocommit refused")
    conn.exec_driver_sql(
        "SELECT set_config(name,value,true) FROM (VALUES ('TimeZone','UTC'),"
        "('DateStyle','ISO,YMD'),('IntervalStyle','iso_8601'),"
        "('extra_float_digits','1'),('bytea_output','hex')) settings(name,value)"
    )
    return conn.execute(
        text("""
            WITH RECURSIVE column_types AS (
                SELECT a.attname, t.oid, t.typtype, t.typbasetype
                FROM pg_catalog.pg_attribute a
                JOIN pg_catalog.pg_class r ON r.oid = a.attrelid
                JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
                JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
                WHERE n.nspname = :schema AND r.relname = :table
                  AND a.attnum > 0 AND NOT a.attisdropped
                UNION ALL
                SELECT c.attname, b.oid, b.typtype, b.typbasetype
                FROM column_types c
                JOIN pg_catalog.pg_type b ON b.oid = c.typbasetype
                WHERE c.typtype = 'd'
            )
            SELECT c.column_name, c.data_type, c.numeric_precision,
                   EXISTS (SELECT 1 FROM column_types t WHERE t.attname = c.column_name
                           AND t.typtype IN ('r', 'm')) AS is_range
            FROM information_schema.columns c
            WHERE c.table_schema = :schema AND c.table_name = :table
            ORDER BY c.ordinal_position
        """),
        dict(schema=parts[0], table=parts[1]),
    ).all()


def read_table_rows(
    conn: Connection,
    relation: str,
    key: Sequence[str],
    *,
    provider_id: str,
    local_dates: Sequence[date] | None,
    date_column: str = "provider_local_date",
) -> TableRows:
    parts = relation.split(".")
    if len(parts) != 2 or not all(parts):
        raise ValueError(f"schema-qualified relation required: {relation}")
    catalog = _catalog(conn, parts)
    columns = tuple(str(row[0]) for row in catalog)
    required = {*key, "provider_id"} | ({date_column} if local_dates is not None else set())
    if not columns or not key or required - set(columns):
        raise ValueError(f"{relation}: missing columns {sorted(required - set(columns))}")
    quote = conn.dialect.identifier_preparer.quote_identifier
    expressions = []
    for name, kind, precision, is_range in catalog:
        if is_range or kind == "USER-DEFINED":
            raise ValueError(f"{relation}.{name}: unsupported PostgreSQL type: {kind}")
        column = quote(name)
        exact_text = kind in {"ARRAY", "json", "jsonb", "interval", "time with time zone"}
        exact_text |= kind == "numeric" and precision is None
        expressions.append(f"{column}::text AS {column}" if exact_text else column)
    where = f"{quote('provider_id')} = :provider_id"
    params: dict[str, Any] = {"provider_id": provider_id}
    if local_dates:
        where += f" AND {quote(date_column)} IN :local_dates"
        params["local_dates"] = tuple(local_dates)
    elif local_dates is not None:
        # An untyped empty expanding bind becomes an INTEGER subquery on PostgreSQL.
        where += " AND false"
    # Dynamic identifiers share one diagnostic name, not one registered SQL body.
    statement = text(
        "-- q:batch.postgres_rows.read\n"
        f"SELECT {', '.join(expressions)} FROM {'.'.join(map(quote, parts))} WHERE {where}"
    )
    if local_dates:
        statement = statement.bindparams(bindparam("local_dates", expanding=True))
    indexes = tuple(columns.index(name) for name in key)
    rows = [tuple(row) for row in conn.execute(statement, params)]
    for name, index in zip(key, indexes, strict=True):
        if any(row[index] is None for row in rows):
            raise ValueError(f"{relation}.{name}: NULL key refused")
    rows.sort(key=lambda row: tuple(row[index] for index in indexes))
    return TableRows(relation, columns, tuple(key), tuple(rows))
