"""File checks and typed row proofs; canonical-text verification is still separate."""

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

import duckdb

from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.parquet_codec import connect, read_canonical_csv
from transit_ops.lake.table_schema import TableSchema


@dataclass(frozen=True)
class Expected:
    content_sha256: str
    rows: int
    object_sha256: str | None


@dataclass(frozen=True)
class FileChecks:
    rows: int
    content_sha256: str
    object_sha256: str
    object_bytes: int
    schema_sha256: str
    checked_with: str


@dataclass(frozen=True)
class WindowProof:
    """Typed row equality only; canonical-text checks are still required for verification."""

    rows: int
    content_sha256: str
    object_sha256: str
    object_bytes: int
    schema_sha256: str
    missing_from_copy: int
    extra_in_copy: int
    in_key_order: bool
    checked_with: str

    def to_json(self) -> bytes:
        return json.dumps(
            asdict(self), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()


Reason = Literal[
    "content_digest",
    "object_digest",
    "rows",
    "schema",
    "metadata",
    "types",
    "missing_rows",
    "extra_rows",
    "key_order",
]


class CopyDiffers(ValueError):
    def __init__(self, reason: Reason, detail: str) -> None:
        self.reason, self.detail = reason, detail
        super().__init__(f"{reason}: {detail}")


def _literal_path(path: Path) -> None:
    if any(character in str(path) for character in "*?[]{}"):
        raise ValueError(f"Glob characters in path: {path}")


def _digest(path: Path) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _check_types(connection: duckdb.DuckDBPyConnection, path: Path, schema: TableSchema) -> None:
    physical = connection.execute(
        "SELECT name, type, duckdb_type, logical_type FROM parquet_schema(?) ORDER BY column_id",
        [str(path)],
    ).fetchall()[1:]
    types = schema.duckdb_types()
    if [row[0] for row in physical] != list(types) or [
        duckdb.sqltype(row[2]) for row in physical
    ] != [duckdb.sqltype(value) for value in types.values()]:
        raise CopyDiffers("types", "Parquet column names, order or types differ")
    for row in physical:
        if row[2].startswith("TIMESTAMP") and (
            row[1] != "INT64" or "MICROS=MicroSeconds()" not in (row[3] or "")
        ):
            raise CopyDiffers("types", "Parquet timestamp storage must use microseconds")


def check_window_files(
    csv_path: Path, parquet_path: Path, schema: TableSchema, *, expect: Expected, temp_dir: Path
) -> FileChecks:
    """Check digests, metadata, ordered types and counts, without claiming equality.

    Callers must keep both files unchanged throughout the checks.
    """
    for path in (csv_path, parquet_path, temp_dir):
        _literal_path(path)
    content, _ = _digest(csv_path)
    if content != expect.content_sha256:
        raise CopyDiffers("content_digest", "CSV SHA-256 differs from expected")
    object_sha, object_bytes = _digest(parquet_path)
    if expect.object_sha256 is not None and object_sha != expect.object_sha256:
        raise CopyDiffers("object_digest", "Parquet SHA-256 differs from expected")
    with csv_path.open("rb") as source:
        if (
            source.readline()
            != (",".join(column.name for column in schema.columns) + "\n").encode()
        ):
            raise CopyDiffers("schema", "CSV header differs from schema")
    with connect(temp_dir) as connection:
        try:
            metadata = dict(
                connection.execute(
                    "SELECT key, value FROM parquet_kv_metadata(?)", [str(parquet_path)]
                ).fetchall()
            )
        except duckdb.InvalidInputException as error:
            raise CopyDiffers("metadata", "Unreadable Parquet metadata") from error
        for key, value in {
            b"transit.schema": schema.to_json(),
            b"transit.content_sha256": expect.content_sha256.encode(),
            b"transit.rows": str(expect.rows).encode(),
        }.items():
            if metadata.get(key) != value:
                raise CopyDiffers("metadata", f"{key.decode()} differs from expected")
        _check_types(connection, parquet_path, schema)
        parquet = connection.read_parquet(str(parquet_path), hive_partitioning=False)
        csv = read_canonical_csv(connection, csv_path, schema)
        for name, relation in (("CSV", csv), ("Parquet", parquet)):
            count = int(relation.aggregate("count(*)").fetchall()[0][0])
            if count != expect.rows:
                raise CopyDiffers("rows", f"{name} has {count} rows; expected {expect.rows}")
    return FileChecks(
        expect.rows, content, object_sha, object_bytes, schema.columns_sha256(), duckdb.__version__
    )


def prove_window(
    csv_path: Path, parquet_path: Path, schema: TableSchema, *, expect: Expected, temp_dir: Path
) -> WindowProof:
    """Prove typed row equality; this does not yet verify canonical text."""
    checks = check_window_files(csv_path, parquet_path, schema, expect=expect, temp_dir=temp_dir)
    keys = ['"' + name.replace('"', '""') + '"' for name in schema.primary_key]
    reason: Reason
    with connect(temp_dir) as connection:
        read_canonical_csv(connection, csv_path, schema).create_view("proof_csv")
        connection.read_parquet(str(parquet_path), hive_partitioning=False).create_view(
            "proof_copy"
        )
        for left, right, reason in (
            ("proof_csv", "proof_copy", "missing_rows"),
            ("proof_copy", "proof_csv", "extra_rows"),
        ):
            _check_difference(connection, left, right, keys, reason)
        _check_order(connection, parquet_path, keys)
    # Bind the result to the same bytes checked before the SQL scans (H1).
    if _digest(csv_path)[0] != checks.content_sha256:
        raise CopyDiffers("content_digest", "CSV changed during row checks")
    if _digest(parquet_path) != (checks.object_sha256, checks.object_bytes):
        raise CopyDiffers("object_digest", "Parquet changed during row checks")
    return WindowProof(**asdict(checks), missing_from_copy=0, extra_in_copy=0, in_key_order=True)


def _check_difference(
    connection: duckdb.DuckDBPyConnection,
    left: str,
    right: str,
    keys: list[str],
    reason: Reason,
) -> None:
    key_sql = ", ".join(keys)
    difference = connection.execute(
        f"SELECT count(*) OVER (), {key_sql} FROM "
        f"(SELECT * FROM {left} EXCEPT ALL SELECT * FROM {right}) "
        f"ORDER BY {key_sql} LIMIT 1"
    ).fetchone()
    if difference is not None:
        raise CopyDiffers(reason, f"{difference[0]} rows; first key {difference[1:]!r}"[:500])


def _check_order(connection: duckdb.DuckDBPyConnection, path: Path, keys: list[str]) -> None:
    key_sql = ", ".join(keys)
    null_key = " OR ".join(f"{key} IS NULL" for key in keys)
    difference = connection.execute(
        f"WITH positioned AS (SELECT row({key_sql}) AS key, "
        f"({null_key}) AS null_key, file_row_number AS position "
        "FROM read_parquet(?, hive_partitioning=false, file_row_number=true)), "
        "ordered AS (SELECT *, lag(key) OVER (ORDER BY position) AS previous FROM positioned) "
        "SELECT position FROM ordered WHERE null_key OR (position > 0 AND key <= previous) "
        "ORDER BY position LIMIT 1",
        [str(path)],
    ).fetchone()
    if difference is not None:
        raise CopyDiffers(
            "key_order", f"Non-increasing primary key at file row {difference[0]} (zero-based)"
        )


def read_back(storage: BronzeStorage, key: str, destination: Path) -> tuple[str, int]:
    """Stream into a private file and publish exclusively after a complete read."""
    _literal_path(destination)
    if destination.exists():
        raise FileExistsError(destination)
    digest, size = hashlib.sha256(), 0
    with TemporaryDirectory(prefix=".readback-", dir=destination.parent) as directory:
        temporary = Path(directory) / "object"
        with temporary.open("xb") as target, storage.open_stream(key) as source:
            while chunk := source.read(64 * 1024):
                target.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            target.flush()
            os.fsync(target.fileno())
        os.link(temporary, destination)
    return digest.hexdigest(), size
