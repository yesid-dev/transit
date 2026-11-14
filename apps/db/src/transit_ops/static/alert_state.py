"""Atomic, one-time bootstrap of a worker's local alert state."""

import json
import re

import duckdb

from transit_ops.live.local_file import LocalFile
from transit_ops.static.alert_seed import AlertSeed, AlertSeedInvalid
from transit_ops.static.alert_seed_contract import KEYS, REQUIRED, SCHEMAS

_TYPES = {
    "text": "VARCHAR",
    "jsonb": "VARCHAR",
    "bigint": "BIGINT",
    "integer": "INTEGER",
    "boolean": "BOOLEAN",
    "date": "DATE",
    "timestamp with time zone": "TIMESTAMPTZ",
}
_CHECKPOINT = "main.alert_seed_checkpoint"


class AlertStateConflict(ValueError):
    pass


def _definitions() -> dict[str, str]:
    definitions = {}
    for name, schema in SCHEMAS.items():
        required = KEYS[name] + REQUIRED[name]
        columns = [
            f'"{c}" {_TYPES[t]}' + (" NOT NULL" if c in required else "") for c, t in schema.items()
        ]
        definitions[name] = ", ".join(columns + [f"PRIMARY KEY ({', '.join(KEYS[name])})"])
    definitions[_CHECKPOINT] = (
        "provider_id VARCHAR PRIMARY KEY, sha256 VARCHAR NOT NULL, global_max_snapshot_id BIGINT"
    )
    return definitions


def _column_properties(duck: duckdb.DuckDBPyConnection, name: str) -> list[tuple[object, ...]]:
    schema, table = name.split(".")
    rendered = duck.execute(
        "SELECT sql, table_oid, database_name FROM duckdb_tables() "
        "WHERE database_name IN (current_database(), 'temp') AND schema_name=? AND table_name=?",
        [schema, table],
    ).fetchone()
    if rendered is None:
        raise AlertStateConflict(f"{name}: table definition missing")
    properties = duck.execute(
        "SELECT column_name, column_default, is_generated, generation_expression, "
        "(SELECT list(expression ORDER BY expression) FROM duckdb_constraints() k "
        "WHERE k.database_name=c.database_name AND k.table_oid=c.table_oid "
        "AND constraint_type='CHECK' AND list_contains(k.constraint_column_names, c.column_name)) "
        "FROM duckdb_columns() c WHERE table_oid=? AND database_name=? ORDER BY column_index",
        [rendered[1], rendered[2]],
    ).fetchall()
    result = []
    for column, *values in properties:
        # Match only the named column's rendered type/collation, never table constraints.
        pattern = rf'(?:\(|,\s*)"?{re.escape(column)}"?\s+\w+(?:\s+COLLATE\s+([\w."]+))?'
        match = re.search(pattern, rendered[0])
        if match is None:
            raise AlertStateConflict(f"{name}: column definition missing: {column}")
        result.append((column, (match[1] or "").replace('"', "").lower(), *values))
    return result


def _shape(duck: duckdb.DuckDBPyConnection, name: str) -> tuple[object, ...]:
    schema, table = name.split(".")
    return (
        _column_properties(duck, name),
        duck.execute("SELECT * FROM pragma_table_info(?)", [name]).fetchall(),
        duck.execute(
            "SELECT constraint_type, constraint_text FROM duckdb_constraints() "
            "WHERE database_name IN (current_database(), 'temp') AND schema_name=? "
            "AND table_name=? ORDER BY constraint_type, constraint_text",
            [schema, table],
        ).fetchall(),
        duck.execute(
            "SELECT expressions FROM duckdb_indexes() WHERE database_name=current_database() "
            "AND schema_name=? AND table_name=? AND is_unique ORDER BY expressions",
            [schema, table],
        ).fetchall(),
    )


def create_alert_tables(duck: duckdb.DuckDBPyConnection) -> None:
    """Create a complete empty schema, or verify it; caller owns the transaction."""
    definitions = _definitions()
    existing = {
        f"{s}.{t}"
        for s, t in duck.execute(
            "SELECT schema_name, table_name FROM duckdb_tables() "
            "WHERE database_name=current_database() AND NOT temporary"
        ).fetchall()
    } & definitions.keys()
    if existing and existing != definitions.keys():
        raise AlertStateConflict("incomplete alert schema")
    for schema in ("silver", "raw"):
        duck.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    for name, ddl in definitions.items():
        if not existing:
            duck.execute(f"CREATE TABLE {name} ({ddl})")
        duck.execute(f"CREATE TEMP TABLE _alert_expected ({ddl})")
        try:
            if _shape(duck, name) != _shape(duck, "main._alert_expected"):
                raise AlertStateConflict(f"{name}: table shape differs")
        finally:
            duck.execute("DROP TABLE _alert_expected")


def seed_alert_state(local: LocalFile, seed: AlertSeed) -> None:
    """Validate and import once; matching digest is a no-op even after live updates.

    alert_seed_checkpoint retains the nullable global_max_snapshot_id for the
    allocator. It covers both first-capture and message provenance snapshot ids.
    JSON is stored as text to preserve PostgreSQL's exported jsonb key order.
    """
    try:
        payload = seed.to_json()
        verified = AlertSeed.from_json(payload)
        digest = json.loads(payload)["sha256"]
        with local.transaction() as duck:
            if duck.execute("SELECT provider_id FROM meta").fetchall() != [(verified.provider_id,)]:
                raise AlertStateConflict("worker provider differs from seed")
            create_alert_tables(duck)
            checkpoint = (verified.provider_id, digest, verified.global_max_snapshot_id)
            previous = duck.execute(f"SELECT * FROM {_CHECKPOINT}").fetchall()
            if previous:
                if previous != [checkpoint]:
                    raise AlertStateConflict("different alert seed already installed")
                return
            if any(duck.execute(f"SELECT 1 FROM {n} LIMIT 1").fetchone() for n in SCHEMAS):
                raise AlertStateConflict("alert store is not empty")
            for name, table in verified.tables.items():
                columns = ", ".join(f'"{c}"' for c in table.columns)
                marks = ", ".join("?" for _ in table.columns)
                if table.rows:
                    duck.executemany(
                        f"INSERT INTO {name} ({columns}) VALUES ({marks})",
                        [[r[c] for c in table.columns] for r in table.rows],
                    )
            duck.execute(f"INSERT INTO {_CHECKPOINT} VALUES (?, ?, ?)", checkpoint)
    except (AlertSeedInvalid, duckdb.Error) as exc:
        raise AlertStateConflict(str(exc)) from exc
