"""Single-writer disposable live state and its durable local poll record."""

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Final, get_args, get_type_hints

import duckdb

from transit_ops.history.poll_record import CaptureEntry, PollEntry, ProcessingEntry
from transit_ops.live.settings import LaneSettings

# Before activation, earlier formats are refused without migration or automatic rebuild.
SCHEMA_VERSION: Final = 5
_TYPES = {int: "BIGINT", bool: "BOOLEAN", str: "VARCHAR", datetime: "TIMESTAMP"}
_OWNERS: set[Path] = set()
_OWNER_LOCK = RLock()


class LocalFileLocked(RuntimeError):
    pass


class LocalFileMismatch(RuntimeError):
    pass


class LocalFileUnreadable(RuntimeError):
    pass


def connect_live(
    path: Path | None, *, temp_directory: Path, memory_limit_mb: int, threads: int, temp_max_mb: int
) -> duckdb.DuckDBPyConnection:
    if any(type(v) is not int or v <= 0 for v in (memory_limit_mb, threads, temp_max_mb)):
        raise ValueError("explicit positive memory, thread and temp limits required")
    try:
        conn = duckdb.connect(
            str(path) if path is not None else ":memory:",
            config={
                "integer_division": True,
                "default_null_order": "nulls_last_on_asc_first_on_desc",
                "preserve_insertion_order": True,
                "autoinstall_known_extensions": False,
                "autoload_known_extensions": False,
                "memory_limit": f"{memory_limit_mb}MB",
                "threads": threads,
                "temp_directory": str(temp_directory),
                "max_temp_directory_size": f"{temp_max_mb}MB",
            },
        )
    except duckdb.Error as exc:
        if "could not set lock" in str(exc).lower() or "being used by another process" in str(exc):
            raise LocalFileLocked(str(path)) from exc
        raise LocalFileUnreadable(str(path)) from exc
    try:
        conn.execute("SET GLOBAL TimeZone = 'UTC'")
        conn.execute("SET max_temp_directory_size = ?", [f"{temp_max_mb}MB"])
        if conn.execute("SELECT current_setting('default_collation')").fetchone() != ("",):
            raise ValueError("live requires binary collation")
        conn.execute("SET lock_configuration = true")
        return conn
    except BaseException:
        conn.close()
        raise


class LocalFile:
    """Own one worker thread's connection; release it explicitly with close."""

    def __init__(self, connection: duckdb.DuckDBPyConnection):
        self.connection = connection
        self._path: Path | None = None
        self._active = self._failed = False

    @classmethod
    def open(cls, path: Path, *, provider_id: str, settings: LaneSettings) -> "LocalFile":
        memory, threads, temp = (
            settings.duckdb_memory_limit_mb,
            settings.duckdb_threads,
            settings.temp_dir_max_mb,
        )
        if memory is None or threads is None or temp is None:
            raise ValueError("explicit memory, thread and temp limits required")
        with _OWNER_LOCK:
            path = path.resolve()
            if path in _OWNERS:
                raise LocalFileLocked(str(path))
            conn = connect_live(
                path,
                temp_directory=path.with_suffix(".tmp"),
                memory_limit_mb=memory,
                threads=threads,
                temp_max_mb=temp,
            )
            local = cls(conn)
            local._path = path
            _OWNERS.add(path)
            try:
                local._initialize(provider_id)
                return local
            except BaseException as exc:
                local.close()
                if isinstance(exc, duckdb.Error):
                    raise LocalFileUnreadable(str(path)) from exc
                raise

    def _initialize(self, provider: str) -> None:
        tables = {"meta": "schema_version INTEGER, provider_id VARCHAR"}
        tables.update(
            {
                "recording_cursor": "provider_id VARCHAR PRIMARY KEY, "
                "initial_run_id BIGINT NOT NULL, "
                "after_run_id BIGINT NOT NULL, sweep_last_run_id BIGINT NOT NULL, "
                "seed_sha256 VARCHAR NOT NULL, covered_through BIGINT, "
                "sweep_enumerated BOOLEAN NOT NULL",
                "recording_coverage": "ingestion_run_id BIGINT PRIMARY KEY "
                "CHECK(ingestion_run_id > 0), terminal_recorded BOOLEAN NOT NULL",
                "local_applications": "endpoint_key VARCHAR NOT NULL, "
                "capture_row_id BIGINT NOT NULL, "
                "status VARCHAR NOT NULL, error_message VARCHAR, "
                "PRIMARY KEY(endpoint_key, capture_row_id)",
                "recording_cadence": "endpoint_key VARCHAR PRIMARY KEY, "
                "declared_interval_seconds BIGINT",
                "local_serving": "endpoint_key VARCHAR PRIMARY KEY, "
                "capture_row_id BIGINT NOT NULL, "
                "captured_at_utc TIMESTAMP NOT NULL, feed_timestamp_utc TIMESTAMP NOT NULL",
                "segment_clock": "next_seq BIGINT NOT NULL CHECK(next_seq > 0)",
                "segment_exports": "first_seq BIGINT PRIMARY KEY, last_seq BIGINT NOT NULL, "
                "manifest VARCHAR NOT NULL, completed BOOLEAN NOT NULL",
                "segment_fact_members": "provider_id VARCHAR NOT NULL, "
                "endpoint_key VARCHAR NOT NULL, "
                "capture_row_id BIGINT NOT NULL, application_sha256 VARCHAR NOT NULL, "
                "segment_seq BIGINT NOT NULL, "
                "PRIMARY KEY(provider_id, endpoint_key, capture_row_id)",
            }
        )
        for table, kind, key in (
            ("polls", PollEntry, "ingestion_run_id"),
            ("captures", CaptureEntry, "capture_row_id"),
            ("processing", ProcessingEntry, "ingestion_run_id"),
        ):
            columns = [
                f'"{name}" {_TYPES[(get_args(t) or (t,))[0]]}'
                for name, t in get_type_hints(kind).items()
            ]
            tables[table] = (
                f"{', '.join(columns)}, endpoint_key VARCHAR, segment_seq BIGINT, "
                f"PRIMARY KEY(index_family, {key})"
            )
        with self.transaction() as conn:
            existing = conn.execute(
                "SELECT table_name FROM duckdb_tables() "
                "WHERE database_name=current_database() AND schema_name='main' AND NOT temporary"
            ).fetchall()
            fresh = not existing
            if not fresh and ("meta",) in existing:
                version = conn.execute("SELECT schema_version FROM meta").fetchall()
                if version != [(SCHEMA_VERSION,)]:
                    raise LocalFileMismatch(
                        f"{self._path}: meta schema version {version!r} refused; "
                        f"requires {SCHEMA_VERSION}"
                    )
            for table, definition in tables.items():
                if not fresh and (table,) not in existing:
                    raise LocalFileMismatch(f"{self._path}: {table} table missing")
                conn.execute(f"CREATE TEMP TABLE _local_expected ({definition})")
                expected = _table_shape(conn, "_local_expected")
                if fresh:
                    conn.execute(f"CREATE TABLE {table} ({definition})")
                if _table_shape(conn, table) != expected:
                    raise LocalFileMismatch(f"{self._path}: {table} table shape differs")
                conn.execute("DROP TABLE _local_expected")
            if fresh:
                conn.execute("INSERT INTO meta VALUES (?, ?)", [SCHEMA_VERSION, provider])
                conn.execute("INSERT INTO segment_clock VALUES (1)")
            if conn.execute("SELECT * FROM meta").fetchall() != [(SCHEMA_VERSION, provider)]:
                raise LocalFileMismatch(f"{self._path}: meta provider or schema version differs")

    def verify_shape(self) -> None:
        """Recheck exact base/segment shapes and collations without changing state.

        Requiring existing metadata prevents initialization's fresh-file branch;
        the shared verifier can only create and drop its temporary shape probes.
        """
        with self.transaction() as conn:
            try:
                rows = conn.execute("SELECT schema_version, provider_id FROM meta").fetchall()
            except duckdb.Error as exc:
                raise LocalFileMismatch("meta table missing or incompatible") from exc
            if len(rows) != 1 or rows[0][0] != SCHEMA_VERSION:
                raise LocalFileMismatch("meta schema version differs")
            self._initialize(rows[0][1])

    @contextmanager
    def transaction(self) -> Iterator[duckdb.DuckDBPyConnection]:
        outer = not self._active
        if outer:
            self.connection.execute("BEGIN")
        self._active = True
        try:
            yield self.connection
            if outer:
                if self._failed:
                    raise RuntimeError("transaction aborted")
                # DuckDB accepts COMMIT on an aborted transaction as a silent rollback.
                self.connection.execute("SELECT 1")
                self.connection.execute("COMMIT")
        except BaseException:
            self._failed = True
            if outer:
                self.connection.execute("ROLLBACK")
            raise
        finally:
            if outer:
                self._active = self._failed = False

    def verify_fact_tables(self, definitions: dict[str, str]) -> None:
        """Create the fact extension atomically, or verify every existing table.

        A partially present extension is incompatible; rebuild disposable state
        from retained evidence. Verification also runs before identical retries.
        """
        with self.transaction() as conn:
            existing = {
                r[0]
                for r in conn.execute(
                    "SELECT table_name FROM duckdb_tables() WHERE schema_name='main' "
                    "AND database_name=current_database() AND NOT temporary"
                ).fetchall()
            }
            fresh = not existing.intersection(definitions)
            for table, definition in definitions.items():
                if not fresh and table not in existing:
                    raise LocalFileMismatch(f"{table}: fact table missing")
                conn.execute(f"CREATE TEMP TABLE _fact_expected ({definition})")
                if fresh:
                    conn.execute(f"CREATE TABLE {table} ({definition})")
                if _table_shape(conn, table) != _table_shape(conn, "_fact_expected"):
                    raise LocalFileMismatch(f"{table}: fact table shape differs")
                conn.execute("DROP TABLE _fact_expected")

    def record_polls(self, polls: Sequence[PollEntry], *, endpoint_key: str) -> int:
        return self._record("polls", "ingestion_run_id", polls, endpoint_key)

    def require_committed(self) -> None:
        """External durability work cannot observe an enclosing uncommitted write."""
        if self._active:
            raise LocalFileMismatch("segment_requires_committed_transaction")

    def next_segment_sequence(self) -> int:
        """Allocate a local record/application sequence inside the owning transaction."""
        rows = self.connection.execute(
            "UPDATE segment_clock SET next_seq=next_seq+1 RETURNING next_seq-1"
        ).fetchall()
        if len(rows) != 1:
            raise LocalFileMismatch("segment_clock_invalid")
        return int(rows[0][0])

    def record_captures(self, captures: Sequence[CaptureEntry], *, endpoint_key: str) -> int:
        return self._record("captures", "capture_row_id", captures, endpoint_key)

    def record_processing(self, entries: Sequence[ProcessingEntry], *, endpoint_key: str) -> int:
        """Store failed Silver attempts; provenance validation belongs to LocalPollRecords."""
        with self.transaction():
            if any(e.stage != "silver_load" or e.status != "failed" for e in entries):
                raise ValueError("only failed Silver attempts are durable local processing records")
            return self._record("processing", "ingestion_run_id", entries, endpoint_key)

    def _record(
        self,
        table: str,
        key: str,
        entries: Sequence[PollEntry] | Sequence[CaptureEntry] | Sequence[ProcessingEntry],
        endpoint: str,
    ) -> int:
        inserted = 0
        with self.transaction() as conn:
            for entry in entries:
                values = {**asdict(entry), "endpoint_key": endpoint}
                # UTC microseconds avoid DuckDB's optional timezone decoding dependency.
                for name, value in values.items():
                    if isinstance(value, datetime):
                        if value.utcoffset() is None:
                            raise ValueError(f"{name} must be timezone-aware")
                        values[name] = value.astimezone(UTC).replace(tzinfo=None)
                columns = ", ".join(f'"{name}"' for name in values)
                identity = (entry.index_family, values[key])
                rows = conn.execute(
                    f"SELECT {columns} FROM {table} WHERE index_family = ? AND {key} = ?", identity
                ).fetchall()
                if rows and rows != [tuple(values.values())]:
                    raise LocalFileMismatch(f"{table} key {identity!r} differs")
                if not rows:
                    values["segment_seq"] = self.next_segment_sequence()
                    columns += ', "segment_seq"'
                    placeholders = ", ".join("?" for _ in values)
                    conn.execute(
                        f"INSERT INTO {table} ({columns}) VALUES ({placeholders})",
                        list(values.values()),
                    )
                    inserted += 1
        return inserted

    def close(self) -> None:
        with _OWNER_LOCK:
            self.connection.close()
            if self._path is not None:
                _OWNERS.remove(self._path)
                self._path = None


def _table_shape(conn: duckdb.DuckDBPyConnection, table: str) -> tuple[object, ...]:
    rendered = conn.execute(
        "SELECT sql FROM duckdb_tables() WHERE table_name=? AND schema_name='main' "
        "AND database_name IN (current_database(), 'temp')",
        [table],
    ).fetchone()
    if rendered is None:
        raise LocalFileMismatch(f"{table}: table definition missing")
    return (
        # The catalog-rendered body retains collations omitted by pragma_table_info.
        rendered[0].split("(", 1)[1],
        conn.execute("SELECT * FROM pragma_table_info(?)", [table]).fetchall(),
        conn.execute(
            "SELECT constraint_type, constraint_text FROM duckdb_constraints() "
            "WHERE table_name=? AND schema_name='main' "
            "AND database_name IN (current_database(), 'temp') "
            "ORDER BY constraint_type, constraint_text",
            [table],
        ).fetchall(),
        conn.execute(
            "SELECT expressions FROM duckdb_indexes() "
            "WHERE table_name=? AND schema_name='main' AND is_unique "
            "AND database_name IN (current_database(), 'temp') "
            "ORDER BY expressions",
            [table],
        ).fetchall(),
    )
