"""Typed table copies retaining the canonical CSV content digest."""

import hashlib
import json
import os
from collections.abc import Mapping
from contextlib import ExitStack
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final, Literal

import duckdb

from transit_ops.lake import wide_rows
from transit_ops.lake.csv_validation import csv_options, validate_csv
from transit_ops.lake.table_schema import TableSchema


class CsvHeaderMismatch(ValueError):
    """The CSV header differs from the ordered schema."""


class RequiredValueMissing(ValueError):
    """A required column contains NULL."""


@dataclass(frozen=True)
class ParquetCodec:
    compression: Literal["zstd"] = "zstd"
    level: int = 9
    row_group_rows: int = 122_880


DEFAULT_CODEC: Final = ParquetCodec()
MAX_ROW_GROUP_ROWS: Final = 122_880
MEMORY_LIMIT = "256MiB"


@dataclass(frozen=True)
class WrittenWindow:
    path: Path
    rows: int
    byte_size: int
    sha256: str
    content_sha256: str
    content_bytes: int
    schema: TableSchema
    codec: ParquetCodec
    writer_version: str

    def details(self) -> dict[str, object]:
        return dict(
            codec="parquet",
            codec_params=asdict(self.codec),
            writer="duckdb",
            writer_version=self.writer_version,
            schema_sha256=self.schema.columns_sha256(),
            content_digest="canonical_csv_sha256",
        )


def connect(temp_dir: Path) -> duckdb.DuckDBPyConnection:
    connection = duckdb.connect(
        database=":memory:",
        config={
            "threads": 1,
            "preserve_insertion_order": True,
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "temp_directory": str(temp_dir),
            "memory_limit": MEMORY_LIMIT,
            "max_temp_directory_size": "20GiB",
        },
    )
    try:
        connection.execute("SET TimeZone='UTC'")
    except Exception:
        connection.close()
        raise
    return connection


def read_canonical_csv(
    connection: duckdb.DuckDBPyConnection,
    csv_path: Path,
    schema: TableSchema,
    *,
    layout: wide_rows.Layout | None = None,
    validate: bool = True,
) -> duckdb.DuckDBPyRelation:
    """The typed CSV rows in order, read from the part files when a wide layout is given."""
    _literal_path(csv_path)
    if validate:
        validate_csv(connection, csv_path, schema)
    return connection.sql(
        # Serial vector batching preserves legacy Parquet row-group boundaries
        # and object bytes when the CSV buffer is smaller than the input.
        f"SELECT * FROM read_csv(?, columns=?, {csv_options(csv_path)}, parallel=false)",
        params=[
            [str(part) for part in layout.parts] if layout else str(csv_path),
            schema.duckdb_types(),
        ],
    )


def _digest(path: Path, header: bytes | None = None) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        if header is not None:
            first = source.readline()
            if first != header:
                raise CsvHeaderMismatch(f"Expected header {header!r}, got {first!r}")
            digest.update(first)
            size += len(first)
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _metadata(
    metadata: Mapping[str, str], schema: TableSchema, content: str, count: int, codec: ParquetCodec
) -> dict[str, str]:
    return dict(
        metadata,
        **{
            "transit.schema": schema.to_json().decode(),
            "transit.content_sha256": content,
            "transit.rows": str(count),
            "transit.codec": json.dumps(asdict(codec), sort_keys=True, separators=(",", ":")),
        },
    )


def _readback(connection: duckdb.DuckDBPyConnection, path: Path, schema: TableSchema) -> int:
    written = connection.read_parquet(str(path), hive_partitioning=False)
    for column in schema.columns:
        name = '"' + column.name.replace('"', '""') + '"'
        if (
            column.not_null
            and written.filter(f"{name} IS NULL").aggregate("count(*)").fetchall()[0][0]
        ):
            raise RequiredValueMissing(column.name)
    return int(written.aggregate("count(*)").fetchall()[0][0])


def _literal_path(path: Path) -> None:
    if any(character in str(path) for character in "*?[]{}"):
        raise ValueError(f"Glob characters in path: {path}")


def write_window(
    csv_path: Path,
    schema: TableSchema,
    parquet_path: Path,
    *,
    metadata: Mapping[str, str],
    temp_dir: Path,
    codec: ParquetCodec = DEFAULT_CODEC,
    validate_csv_input: bool = True,
) -> WrittenWindow:
    # Preserve the existing layout (and object digest), while preventing callers
    # from expanding the writer's per-group buffering without a bound.
    if type(codec.row_group_rows) is not int or not 1 <= codec.row_group_rows <= MAX_ROW_GROUP_ROWS:
        raise ValueError(f"row_group_rows must be between 1 and {MAX_ROW_GROUP_ROWS}")
    for path in (csv_path, parquet_path, temp_dir):
        _literal_path(path)
    if parquet_path.exists():
        raise FileExistsError(parquet_path)
    with TemporaryDirectory(prefix=".transit-", dir=parquet_path.parent) as directory:
        output = Path(directory) / "window.parquet"
        if any(key.startswith("transit.") for key in metadata):
            raise ValueError("Caller metadata cannot use the transit. prefix")
        content, content_bytes = _digest(
            csv_path, (",".join(column.name for column in schema.columns) + "\n").encode()
        )
        # Ordinary windows keep the requested size and so their exact legacy bytes. A
        # wide window (see wide_rows) is read through byte-targeted part files, one row
        # group each; the largest group's row count is recorded in the codec facts.
        requested_rows = codec.row_group_rows
        with ExitStack() as stack:
            layout = stack.enter_context(
                wide_rows.window_layout(csv_path, temp_dir, requested_rows)
            )
            if layout is not None:
                codec = replace(codec, row_group_rows=layout.row_group_rows)
            connection = stack.enter_context(connect(temp_dir))
            relation = read_canonical_csv(
                connection, csv_path, schema, layout=layout, validate=validate_csv_input
            )
            count = relation.aggregate("count(*)").fetchall()[0][0]
            kv = _metadata(metadata, schema, content, count, codec)
            relation.create_view("window_rows")
            connection.execute(
                "COPY (SELECT * FROM window_rows) TO ? (FORMAT parquet, "
                "COMPRESSION zstd, COMPRESSION_LEVEL ?, ROW_GROUP_SIZE ?, KV_METADATA ?)",
                [
                    str(output),
                    codec.level,
                    # Every part is one source chunk, so a group of one closes after each.
                    1 if layout is not None else codec.row_group_rows,
                    dict(sorted(kv.items())),
                ],
            )
            count = _readback(connection, output, schema)
        sha256, byte_size = _digest(output)
        os.link(output, parquet_path)
        return WrittenWindow(
            parquet_path,
            count,
            byte_size,
            sha256,
            content,
            content_bytes,
            schema,
            codec,
            duckdb.__version__,
        )
