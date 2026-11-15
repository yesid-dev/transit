"""Disposable bounded Parquet payload scan; cache state is uncontrolled."""

import hashlib
import importlib
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from duckdb import DuckDBPyConnection

    from transit_ops.history.seal_captures import LocalPack

from transit_ops.history.pack import PackCorrupt, read_pack
from transit_ops.history.poll_record import CaptureEntry

_BATCH_BYTES = 8 * 1024 * 1024


def _metadata(capture: CaptureEntry) -> tuple[int, str, str, int]:
    stamp = capture.captured_at_utc.isoformat()
    return capture.capture_row_id, stamp, capture.sha256, capture.byte_size


def _prepare(
    connection: "DuckDBPyConnection",
    local: "LocalPack",
    directory: Path,
    captures: list[CaptureEntry],
) -> int:
    assert local.path is not None and local.pack is not None
    shard_count = 0
    connection.execute(
        "CREATE TABLE captures (ordinal BIGINT, identity BIGINT, "
        "captured VARCHAR, digest VARCHAR, size BIGINT, payload BLOB)"
    )

    def flush() -> None:
        nonlocal shard_count
        path = directory / f"captures-{shard_count:06d}.parquet"
        connection.execute("COPY captures TO ? (FORMAT PARQUET)", [str(path)])
        shard_count += 1
        connection.execute("DELETE FROM captures")
        connection.commit()

    size = batch_count = 0
    with local.path.open("rb") as source:
        for ordinal, payload in enumerate(
            read_pack(source, local.pack.streams, local.pack.captures)
        ):
            if size and size + len(payload) > _BATCH_BYTES:
                flush()
                size = batch_count = 0
            values = (ordinal, *_metadata(captures[ordinal]), payload)
            connection.execute("INSERT INTO captures VALUES (?, ?, ?, ?, ?, ?)", values)
            size += len(payload)
            batch_count += 1
            # Empty captures also need a count bound.
            if size >= _BATCH_BYTES or batch_count >= 128:
                flush()
                size = batch_count = 0
    if batch_count:
        flush()
    return shard_count


def _scan(
    connection: "DuckDBPyConnection",
    directory: Path,
    shard_count: int,
    captures: list[CaptureEntry],
) -> tuple[int, int]:
    count = size = 0
    for shard in range(shard_count):
        path = directory / f"captures-{shard:06d}.parquet"
        cursor = connection.execute("SELECT * FROM read_parquet(?) ORDER BY ordinal", [str(path)])
        while rows := cursor.fetchmany(1):
            for row in rows:
                if count >= len(captures):
                    raise PackCorrupt("Parquet capture count differs")
                expected, payload = captures[count], row[-1]
                if (
                    row[:-1] != (count, *_metadata(expected))
                    or len(payload) != expected.byte_size
                    or hashlib.sha256(payload).hexdigest() != expected.sha256
                ):
                    raise PackCorrupt("Parquet payload differs from packed capture")
                count += 1
                size += len(payload)
    if count != len(captures):
        raise PackCorrupt("Parquet capture count differs")
    return count, size


def benchmark(local: "LocalPack", directory: Path) -> dict[str, object]:
    fields = """duckdb_version duckdb_reason duckdb_prepare_seconds duckdb_read_seconds
                duckdb_capture_count duckdb_byte_count""".split()
    result: dict[str, object] = dict.fromkeys(fields)
    result.update(
        duckdb_status="not_applicable", duckdb_basis="local_parquet_capture_bytes_with_checksum"
    )
    if local.pack is None:
        return result
    try:
        duckdb = importlib.import_module("duckdb")
    except ModuleNotFoundError as error:
        if error.name != "duckdb":
            raise
        result.update(
            duckdb_status="deferred",
            duckdb_reason="DuckDB is not installed; read timing is a later addition.",
        )
        return result
    config = {
        "memory_limit": "128MiB",
        "max_temp_directory_size": "4GiB",
        "threads": "1",
        "temp_directory": str(directory / "duckdb-spill"),
        "enable_external_access": "true",
        "autoinstall_known_extensions": "false",
        "autoload_known_extensions": "false",
    }
    start = monotonic()
    captures = [c for c in local.record.captures if c.packed]
    with duckdb.connect(database=":memory:", config=config) as connection:
        shard_count = _prepare(connection, local, directory, captures)
    prepared = monotonic() - start
    with duckdb.connect(database=":memory:", config=config) as connection:
        start = monotonic()
        count, size = _scan(connection, directory, shard_count, captures)
        elapsed = monotonic() - start
    result.update(
        duckdb_status="measured",
        duckdb_version=duckdb.__version__,
        duckdb_prepare_seconds=prepared,
        duckdb_read_seconds=elapsed,
        duckdb_capture_count=count,
        duckdb_byte_count=size,
    )
    return result
