"""Interrupt the DuckDB connections owned by a disconnected request."""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock

import duckdb


class QueryAbandoned(Exception):
    pass


class QueryCancellation:
    def __init__(self) -> None:
        self._lock = Lock()
        self._stopped = False
        self._connections: set[duckdb.DuckDBPyConnection] = set()

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            for conn in self._connections:
                conn.interrupt()

    def check(self) -> None:
        with self._lock:
            if self._stopped:
                raise QueryAbandoned

    @contextmanager
    def track(self, conn: duckdb.DuckDBPyConnection) -> Iterator[None]:
        with self._lock:
            if self._stopped:
                raise QueryAbandoned
            self._connections.add(conn)
        try:
            yield
        finally:
            with self._lock:
                self._connections.remove(conn)


current_query: ContextVar[QueryCancellation | None] = ContextVar("current_query", default=None)


def check_query() -> None:
    if (cancellation := current_query.get()) is not None:
        cancellation.check()


@contextmanager
def track_connection(conn: duckdb.DuckDBPyConnection) -> Iterator[duckdb.DuckDBPyConnection]:
    with conn:
        cancellation = current_query.get()
        if cancellation is None:
            yield conn
        else:
            with cancellation.track(conn):
                yield conn
