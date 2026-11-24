import json
import os
import re
from dataclasses import dataclass
from datetime import date
from hashlib import file_digest
from pathlib import Path
from stat import S_ISREG
from typing import Self

import duckdb

from transit_engine.clean_manifest import (
    ALERT_VERSION,
    ALERTS,
    STOP_EVENTS,
    TRIP_DAYS,
    file_identities,
)

DEFAULT_CLEANING_VERSION = 9
CITY = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
_PUNCTUALITY_FILES = (STOP_EVENTS, TRIP_DAYS)


def env_int(name: str, default: int, *, minimum: int = 1) -> int:
    value = int(os.environ.get(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


@dataclass(frozen=True)
class CheckedDay:
    files: tuple[str, ...] | None
    settled: bool
    unmeasured_reason: str | None = None
    tables: tuple[str, ...] = ()


@dataclass(frozen=True)
class Store:
    root: str
    cleaning_version: int = DEFAULT_CLEANING_VERSION
    memory_mib: int = 256
    threads: int = 1
    s3_endpoint: str | None = None

    @classmethod
    def from_env(cls) -> Self:
        root = os.environ.get("ENGINE_CLEAN_ROOT", "./clean-days")
        endpoint = os.environ.get("ENGINE_S3_ENDPOINT")
        if root.startswith("s3://"):
            if not re.fullmatch(r"s3://[a-z0-9][a-z0-9.-]*(/[a-zA-Z0-9._/-]+)?/?", root):
                raise ValueError("ENGINE_CLEAN_ROOT must be an s3://bucket[/prefix] URL")
            if not endpoint or not re.fullmatch(r"[a-zA-Z0-9.-]+(?::[0-9]+)?", endpoint):
                raise ValueError("ENGINE_S3_ENDPOINT must be an HTTPS host without a scheme")
            if not all(
                os.environ.get(key) for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
            ):
                raise ValueError("S3 requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY")
        else:
            root = Path(root).resolve().as_posix()
            endpoint = None
        return cls(
            root,
            env_int("ENGINE_CLEANING_VERSION", DEFAULT_CLEANING_VERSION),
            env_int("ENGINE_QUERY_MEMORY_MIB", 256),
            env_int("ENGINE_QUERY_THREADS", 1),
            endpoint,
        )

    def connect(self) -> duckdb.DuckDBPyConnection:
        conn = duckdb.connect(
            config={
                "threads": self.threads,
                "memory_limit": f"{self.memory_mib} MiB",
                "max_temp_directory_size": "0 bytes",
                "autoload_known_extensions": False,
                "autoinstall_known_extensions": False,
            },
        )
        if self.s3_endpoint:
            try:
                conn.execute("LOAD httpfs")
                conn.execute(
                    """
                    CREATE SECRET clean_days (
                        TYPE s3, KEY_ID ?, SECRET ?, SESSION_TOKEN ?,
                        ENDPOINT ?, REGION 'auto', URL_STYLE 'path', USE_SSL true, SCOPE ?
                    )
                    """,
                    [
                        os.environ["AWS_ACCESS_KEY_ID"],
                        os.environ["AWS_SECRET_ACCESS_KEY"],
                        os.environ.get("AWS_SESSION_TOKEN", ""),
                        self.s3_endpoint,
                        f"{self.root.rstrip('/')}/",
                    ],
                )
            except Exception:
                conn.close()
                raise
        return conn

    def files(
        self,
        conn: duckdb.DuckDBPyConnection,
        city: str,
        day: date,
        tables: tuple[str, ...] = _PUNCTUALITY_FILES,
        *,
        allow_untracked_alerts: bool = False,
        receipts: dict[str, bytes] | None = None,
    ) -> tuple[str, ...] | None:
        """An empty alert path represents an explicit not-tracked receipt when allowed."""
        return self._checked_files(
            conn,
            city,
            day,
            tables,
            verify_digests=False,
            allow_untracked_alerts=allow_untracked_alerts,
            receipts=receipts,
        ).files

    def query_day(
        self,
        conn: duckdb.DuckDBPyConnection,
        city: str,
        day: date,
        tables: tuple[str, ...],
        *,
        preferred_tables: tuple[str, ...] = (),
        allow_untracked_alerts: bool = False,
        receipts: dict[str, bytes] | None = None,
    ) -> CheckedDay:
        """Validate query inputs, preferring an alternate set when the receipt lists it."""
        return self._checked_files(
            conn,
            city,
            day,
            tables,
            verify_digests=False,
            preferred_tables=preferred_tables,
            allow_untracked_alerts=allow_untracked_alerts,
            check_all=True,
            receipts=receipts,
        )

    def verify(self, conn: duckdb.DuckDBPyConnection, city: str, day: date) -> bool:
        """Audit the query inputs and any tracked alerts against their full SHA-256 digests."""
        return (
            self._checked_files(
                conn, city, day, _PUNCTUALITY_FILES, verify_digests=True
            ).files is not None
        )

    def _checked_files(
        self,
        conn: duckdb.DuckDBPyConnection,
        city: str,
        day: date,
        tables: tuple[str, ...],
        *,
        verify_digests: bool,
        preferred_tables: tuple[str, ...] = (),
        allow_untracked_alerts: bool = False,
        receipts: dict[str, bytes] | None = None,
        check_all: bool = False,
    ) -> CheckedDay:
        if not CITY.fullmatch(city):
            raise ValueError("Invalid city")
        directory = f"{self.root.rstrip('/')}/{city}/{day.isoformat()}/v{self.cleaning_version}"
        marker = f"{directory}/manifest.json"
        present: set[str] = set()
        if self.s3_endpoint:
            # A signed list distinguishes absent data from an access failure.
            present = {
                row[0]
                for row in conn.execute("SELECT file FROM glob(?)", [f"{directory}/*"]).fetchall()
            }
            if marker not in present:
                return CheckedDay(None, False)
            manifest = conn.execute("SELECT content FROM read_blob(?)", [marker]).fetchone()
            if manifest is None:
                return CheckedDay(None, False)
            payload: bytes = manifest[0]
        else:
            try:
                payload = Path(marker).read_bytes()
            except (FileNotFoundError, IsADirectoryError):
                return CheckedDay(None, False)
        identities = file_identities(payload, city, day.isoformat(), str(self.cleaning_version))
        if identities is None:
            return CheckedDay(None, False)
        if not identities:
            return CheckedDay(None, True, json.loads(payload)["status"])
        if preferred_tables and all(name in identities for name in preferred_tables):
            tables = preferred_tables
        checked_paths = {}
        supported = True
        for name in tables:
            if name in identities:
                checked_paths[name] = f"{directory}/{name}"
            elif not (
                name == ALERTS
                and allow_untracked_alerts
                and self.cleaning_version >= ALERT_VERSION
            ):
                supported = False
        if ALERTS in identities:
            checked_paths[ALERTS] = f"{directory}/{ALERTS}"
        if not check_all and not supported:
            return CheckedDay(None, False)

        def matches(name: str) -> bool:
            path = f"{directory}/{name}"
            return (not self.s3_endpoint or path in present) and self._matches_file(
                conn, path, identities[name], verify_digests
            )

        if not all(matches(name) for name in checked_paths):
            return CheckedDay(None, False)
        settled = not check_all or all(
            matches(name) for name in identities if name not in checked_paths
        )
        files = tuple(checked_paths.get(name, "") for name in tables) if supported else None
        if files is not None and receipts is not None:
            receipts[day.isoformat()] = payload
        return CheckedDay(files, settled, tables=tables)

    def _matches_file(
        self,
        conn: duckdb.DuckDBPyConnection,
        path: str,
        identity: tuple[str, int],
        verify_digests: bool,
    ) -> bool:
        digest, size = identity
        if self.s3_endpoint:
            # With only size projected, httpfs uses HEAD and skips the body.
            projection = "size, sha256(content)" if verify_digests else "size"
            expected = (size, digest) if verify_digests else (size,)
            actual = conn.execute(f"SELECT {projection} FROM read_blob(?)", [path]).fetchone()
            return actual == expected
        try:
            parquet = Path(path)
            info = parquet.stat()
            if not S_ISREG(info.st_mode) or info.st_size != size:
                return False
            if verify_digests:
                with parquet.open("rb") as stream:
                    return file_digest(stream, "sha256").hexdigest() == digest
        except (FileNotFoundError, IsADirectoryError):
            return False
        return True
