"""Prove a Parquet window retains canonical CSV text and typed rows."""

import hashlib
import json
import math
import os
import struct
from dataclasses import asdict, dataclass
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

import duckdb

from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake import wide_rows
from transit_ops.lake.csv_validation import csv_options, fetch_rows
from transit_ops.lake.parquet_codec import MAX_ROW_GROUP_ROWS, connect, read_canonical_csv
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
    """A copy checked for typed equality, key order and canonical text."""

    rows: int
    content_sha256: str
    object_sha256: str
    object_bytes: int
    schema_sha256: str
    missing_from_copy: int
    extra_in_copy: int
    in_key_order: bool
    checked_with: str
    verified: bool

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
    "canonical_text",
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
    with wide_rows.window_layout(csv_path, temp_dir, MAX_ROW_GROUP_ROWS) as layout:
        return _check_files(csv_path, parquet_path, schema, expect, temp_dir, layout)


def _check_files(
    csv_path: Path,
    parquet_path: Path,
    schema: TableSchema,
    expect: Expected,
    temp_dir: Path,
    layout: wide_rows.Layout | None,
) -> FileChecks:
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
        csv = read_canonical_csv(connection, csv_path, schema, layout=layout)
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
    """Verify canonical text after typed equality and strict key order.

    A wide window (see ``wide_rows``) is checked one part-file slice at a time: each
    slice of CSV rows against the same positions of the copy, so no scan holds more than
    a few megabytes of wide rows. A copy passes exactly when it passes the whole-window
    checks; only the reason reported for a failing wide copy can differ.
    """
    for path in (csv_path, parquet_path, temp_dir):
        _literal_path(path)
    keys = ['"' + name.replace('"', '""') + '"' for name in schema.primary_key]
    with wide_rows.window_layout(csv_path, temp_dir, MAX_ROW_GROUP_ROWS) as layout:
        checks = _check_files(csv_path, parquet_path, schema, expect, temp_dir, layout)
        with connect(temp_dir) as connection:
            mapped = _positioned_copy(connection, parquet_path, schema)
            if layout is None:
                read_canonical_csv(connection, csv_path, schema).create_view("proof_csv")
                connection.read_parquet(str(parquet_path), hive_partitioning=False).create_view(
                    "proof_copy"
                )
                _check_differences(connection, keys)
                _check_order(connection, schema, mapped)
                _check_text(connection, csv_path, csv_path, schema, mapped)
            else:
                _check_slices(connection, csv_path, schema, keys, mapped, layout)
    # Bind the result to the same bytes checked before the SQL scans (H1).
    if _digest(csv_path)[0] != checks.content_sha256:
        raise CopyDiffers("content_digest", "CSV changed during row checks")
    if _digest(parquet_path) != (checks.object_sha256, checks.object_bytes):
        raise CopyDiffers("object_digest", "Parquet changed during row checks")
    return WindowProof(
        **asdict(checks), missing_from_copy=0, extra_in_copy=0, in_key_order=True, verified=True
    )


def _check_differences(connection: duckdb.DuckDBPyConnection, keys: list[str]) -> None:
    reason: Reason
    for left, right, reason in (
        ("proof_csv", "proof_copy", "missing_rows"),
        # Equal counts make a nonempty reverse difference unreachable after the first passes.
        ("proof_copy", "proof_csv", "extra_rows"),
    ):
        _check_difference(connection, left, right, keys, reason)


def _check_slices(
    connection: duckdb.DuckDBPyConnection,
    csv_path: Path,
    schema: TableSchema,
    keys: list[str],
    mapped: dict[str, str],
    layout: wide_rows.Layout,
) -> None:
    types = schema.duckdb_types()
    options = csv_options(csv_path)
    names = ", ".join(f'{mapped[name]} AS "{name}"' for name in types)
    for part, start, end in layout.spans():
        # The whole CSV was validated by the file checks; a part is a slice of those bytes.
        connection.sql(
            f"SELECT * FROM read_csv(?, columns=?, {options}, parallel=false)",
            params=[str(part), types],
        ).create_view("proof_csv", replace=True)
        connection.sql(
            f"SELECT {names} FROM proof_positioned "
            f"WHERE file_row_number >= {start} AND file_row_number < {end}"
        ).create_view("proof_copy", replace=True)
        _check_differences(connection, keys)
    _check_order(connection, schema, mapped)
    for part, start, end in layout.spans():
        _check_text(connection, csv_path, part, schema, mapped, start, end)


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


def _positioned_copy(
    connection: duckdb.DuckDBPyConnection, path: Path, schema: TableSchema
) -> dict[str, str]:
    types = schema.duckdb_types()
    mapped = {name: f"_proof_column_{index}" for index, name in enumerate(types)}
    columns = [
        {"name": mapped[name], "type": kind, "default_value": None} for name, kind in types.items()
    ]
    connection.sql(
        "SELECT * FROM read_parquet(?, hive_partitioning=false, "
        "schema=map(?, ?), file_row_number=true)",
        params=[str(path), list(types), columns],
    ).create_view("proof_positioned")
    return mapped


def _check_order(
    connection: duckdb.DuckDBPyConnection, schema: TableSchema, mapped: dict[str, str]
) -> None:
    keys = [mapped[name] for name in schema.primary_key]
    key_sql = ", ".join(keys)
    null_key = " OR ".join(f"{key} IS NULL" for key in keys)
    difference = connection.execute(
        f"WITH positioned AS (SELECT row({key_sql}) AS key, "
        f"({null_key}) AS null_key, file_row_number AS position "
        "FROM proof_positioned), "
        "ordered AS (SELECT *, lag(key) OVER (ORDER BY position) AS previous FROM positioned) "
        "SELECT position FROM ordered WHERE null_key OR (position > 0 AND key <= previous) "
        "ORDER BY position LIMIT 1",
    ).fetchone()
    if difference is not None:
        raise CopyDiffers(
            "key_order", f"Non-increasing primary key at file row {difference[0]} (zero-based)"
        )


def _shortest_decimal(value: float, code: str) -> Decimal:
    center = Fraction(abs(value))
    bits = struct.pack(code, abs(value))
    integer, width = int.from_bytes(bits, "big"), len(bits)
    lower = struct.unpack(code, (integer - 1).to_bytes(width, "big"))[0]
    upper = struct.unpack(code, (integer + 1).to_bytes(width, "big"))[0]
    low = (center + Fraction(lower)) / 2
    high = (center + Fraction(upper)) / 2 if math.isfinite(upper) else center * 2 - low
    # repr is shortest already, unless its decimal lands exactly on a midpoint.
    text = repr(abs(value))
    if code == "!d" and low < Fraction(text) < high:
        return Decimal(text)
    exponent = Decimal(text).adjusted()
    while Fraction(10) ** exponent > center:
        exponent -= 1
    for precision in range(1, 10 if code == "!f" else 18):
        unit = Fraction(10) ** (exponent - precision + 1)
        quotient = center / unit
        inside = [i for i in (math.floor(quotient), math.ceil(quotient)) if low < i * unit < high]
        if inside:
            closest = min(inside, key=lambda i: (abs(i * unit - center), i % 2))
            return Decimal(f"{closest}e{exponent - precision + 1}")
    raise ValueError("No shortest-precise float representation")


def _float_text(value: float, kind: str) -> str:
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "-Infinity" if value < 0 else "Infinity"
    code, threshold = ("!f", 6) if kind == "FLOAT" else ("!d", 15)
    bits = struct.pack(code, value)
    if not any(bits[1:]) and bits[0] in (0, 128):
        return "-0" if bits[0] else "0"
    decimal = _shortest_decimal(value, code).normalize()
    sign = "-" if value < 0 else ""
    exponent = decimal.adjusted()
    if -4 <= exponent < threshold:
        return sign + format(decimal, "f")
    mantissa, power = format(decimal, "e").split("e")
    return f"{sign}{mantissa}e{int(power):+03d}"


def _same_text(text: str | None, value: object, kind: str, nan_bits: dict[str, bytes]) -> bool:
    if kind in {"FLOAT", "DOUBLE"} and isinstance(value, float):
        code = "!f" if kind == "FLOAT" else "!d"
        if math.isnan(value) and struct.pack(code, value) != nan_bits[kind]:
            return False
        value = _float_text(value, kind)
    elif kind.startswith("DECIMAL") and isinstance(value, str):
        if value.startswith("."):
            value = "0" + value
        elif value.startswith("-."):
            value = "-0" + value[1:]
    return text == value


def _check_text(
    connection: duckdb.DuckDBPyConnection,
    csv_path: Path,
    source_path: Path,
    schema: TableSchema,
    mapped: dict[str, str],
    start: int | None = None,
    end: int | None = None,
) -> None:
    """Compare canonical text of ``source_path`` (the CSV or one part) with the copy.

    ``start`` and ``end`` select the file rows of the copy that a part covers.
    """
    types = schema.duckdb_types()
    canonical_nan = connection.execute("SELECT 'NaN'::FLOAT, 'NaN'::DOUBLE").fetchone()
    assert canonical_nan is not None
    nan_bits = {
        kind: struct.pack(code, value)
        for kind, code, value in zip(("FLOAT", "DOUBLE"), ("!f", "!d"), canonical_nan, strict=True)
    }
    expressions = []
    for name, kind in types.items():
        column = mapped[name]
        if kind == "BOOLEAN":
            expressions.append(f"CASE {column} WHEN true THEN 't' WHEN false THEN 'f' END")
        elif kind in {"FLOAT", "DOUBLE"}:
            expressions.append(column)
        else:
            expressions.append(f"CAST({column} AS VARCHAR)")
    with connection.cursor() as source, connection.cursor() as copy:
        source.execute(
            f"SELECT * FROM read_csv(?, columns=?, {csv_options(csv_path)})",
            [str(source_path), dict.fromkeys(types, "VARCHAR")],
        )
        copy.execute("SET TimeZone='UTC'")
        window = (
            ""
            if start is None
            else f" WHERE file_row_number >= {start} AND file_row_number < {end}"
        )
        copy.execute(
            f"SELECT {', '.join(expressions)} FROM proof_positioned{window} "
            "ORDER BY file_row_number"
        )
        position = start or 0
        # Both cursors hold a batch of text at once: bound it by the widest record.
        while batch := source.fetchmany(fetch_rows(csv_path)):
            copied = copy.fetchmany(len(batch))
            for original, restored in zip(batch, copied, strict=True):
                for (name, kind), text, value in zip(
                    types.items(), original, restored, strict=True
                ):
                    if not _same_text(text, value, kind, nan_bits):
                        raise CopyDiffers(
                            "canonical_text",
                            (
                                f"Column {name!r}, file row {position} (zero-based): "
                                "text or IEEE bits differ"
                            )[:500],
                        )
                position += 1


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
