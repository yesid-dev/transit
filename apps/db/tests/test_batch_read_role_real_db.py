"""Grant variants and a SELECT-only role, transactionally confined to a disposable DB."""

from uuid import uuid4

import pytest
from psycopg import sql

from transit_ops.batch.daily_inputs import assert_read_role


@pytest.mark.parametrize(
    "grant",
    [
        None,
        "member_writer",
        "member_super",
        "column_insert",
        "column_update",
        "trigger",
        "sequence_usage",
        "sequence_update",
        "database_create",
    ],
)
def test_catalog_guard_select_only_and_reachable_write_capabilities(real_db_engine, grant):
    raw = real_db_engine.raw_connection()
    conn = raw.driver_connection
    token = uuid4().hex
    role, member = "read_guard_" + token, "write_guard_" + token
    table, sequence = "guard_table_" + token, "guard_seq_" + token
    ident = sql.Identifier
    try:
        name = conn.execute("SELECT current_database()").fetchone()[0]
        conn.execute(sql.SQL("REVOKE CREATE ON DATABASE {} FROM PUBLIC").format(ident(name)))
        conn.execute("REVOKE CREATE ON SCHEMA core,raw,silver,gold FROM PUBLIC")
        conn.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOINHERIT").format(ident(role)))
        conn.execute(sql.SQL("CREATE TABLE core.{} (a integer, b integer)").format(ident(table)))
        conn.execute(sql.SQL("CREATE SEQUENCE core.{}").format(ident(sequence)))
        conn.execute(
            sql.SQL("GRANT USAGE ON SCHEMA core,raw,silver,gold TO {}").format(ident(role))
        )
        conn.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA core,raw,silver,gold TO {}").format(
                ident(role)
            )
        )
        if grant in {"member_writer", "member_super"}:
            conn.execute(
                sql.SQL("CREATE ROLE {} NOLOGIN {}").format(
                    ident(member),
                    sql.SQL("SUPERUSER" if grant == "member_super" else "NOSUPERUSER"),
                )
            )
            if grant == "member_writer":
                conn.execute(
                    sql.SQL("GRANT INSERT ON core.{} TO {}").format(ident(table), ident(member))
                )
            conn.execute(
                sql.SQL("GRANT {} TO {} WITH INHERIT FALSE").format(ident(member), ident(role))
            )
        elif grant in {"column_insert", "column_update"}:
            privilege = sql.SQL("INSERT" if grant == "column_insert" else "UPDATE")
            conn.execute(
                sql.SQL("GRANT {} (a) ON core.{} TO {}").format(
                    privilege, ident(table), ident(role)
                )
            )
        elif grant == "trigger":
            conn.execute(
                sql.SQL("GRANT TRIGGER ON core.{} TO {}").format(ident(table), ident(role))
            )
        elif grant in {"sequence_usage", "sequence_update"}:
            privilege = sql.SQL("USAGE" if grant == "sequence_usage" else "UPDATE")
            conn.execute(
                sql.SQL("GRANT {} ON SEQUENCE core.{} TO {}").format(
                    privilege, ident(sequence), ident(role)
                )
            )
        elif grant == "database_create":
            conn.execute(
                sql.SQL("GRANT CREATE ON DATABASE {} TO {}").format(ident(name), ident(role))
            )
        conn.execute(sql.SQL("SET LOCAL ROLE {}").format(ident(role)))
        if grant is None:
            assert_read_role(conn)
        else:
            with pytest.raises(ValueError, match="role_can_write"):
                assert_read_role(conn)
    finally:
        # PostgreSQL roles, grants and test relations all roll back together.
        conn.rollback()
        raw.close()
