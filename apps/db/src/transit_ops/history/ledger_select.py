"""Select the ledger backend for history callers.

PostgreSQL writes are durable at outer commit; R2 writes at successful session
exit. A PostgreSQL rollback cannot undo R2 writes. Callers may rely on neither
coupling. WindowChanged from an R2 session propagates without retry here.
"""

from sqlalchemy import Connection

from transit_ops.history.ledger_postgres import PostgresLedger
from transit_ops.history.ledger_store import LedgerStore


def ledger_for(connection: Connection) -> LedgerStore:
    return PostgresLedger(connection)
