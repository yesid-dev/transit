"""Convert closed rescue CSVs into create-only, readback-proven Parquet copies."""

import gzip
import hashlib
import json
import os
import re
import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory, mkdtemp
from typing import Any, Final

from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import validate_provider_id
from transit_ops.lake.objects import PutOutcome, put_create_only
from transit_ops.lake.parquet_codec import WrittenWindow, write_window
from transit_ops.lake.parquet_verify import (
    CopyDiffers,
    Expected,
    WindowProof,
    prove_window,
    read_back,
)
from transit_ops.lake.table_schema import TableSchema

RESCUE_TABLES: Final = ("fact_trip_delay_snapshot", "fact_vehicle_snapshot")
RESCUE_PRIMARY_KEY: Final = ("provider_id", "realtime_snapshot_id", "entity_index")


@dataclass(frozen=True)
class ConvertedTable:
    table: str
    key: str
    outcome: PutOutcome
    proof: WindowProof


@dataclass(frozen=True)
class ConvertedDay:
    provider_id: str
    utc_day: date
    receipt_key: str
    receipt_outcome: PutOutcome
    tables: tuple[ConvertedTable, ...]


class RescueNotConvertible(ValueError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise RescueNotConvertible(reason)


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _receipt(
    storage: BronzeStorage,
    prefix: str,
    provider: str,
    day: date,
    expected: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], str]:
    if not storage.exists(prefix + "receipt.json"):
        raise RescueNotConvertible("receipt_missing")
    data = storage.read_bytes(prefix + "receipt.json")
    try:
        receipt = json.loads(data)
    except (ValueError, UnicodeError) as error:
        raise RescueNotConvertible("unknown_format") from error
    _require(isinstance(receipt, dict), "unknown_format")
    _require(
        type(receipt.get("format_version")) is int and receipt["format_version"] == 1,
        "unknown_format",
    )
    _require(receipt.get("status") == "closed_emergency_snapshot", "not_closed")
    _require(
        receipt.get("provider") == provider and receipt.get("day") == day.isoformat(), "identity"
    )
    tables = receipt.get("tables")
    _require(isinstance(tables, dict) and set(tables) == set(RESCUE_TABLES), "unexpected_tables")
    for table, record in tables.items():
        _require(
            isinstance(record, dict) and record.get("key") == prefix + table + ".csv.gz",
            "unexpected_tables",
        )
    if expected is not None:
        try:
            recorded = expected[f"{provider}-{day.isoformat()}"]["tables"]
            for table, record in tables.items():
                for field in ("csv_sha256", "object_sha256", "rows", "csv_bytes"):
                    _require(
                        type(recorded[table][field]) is type(record[field])
                        and recorded[table][field] == record[field],
                        "record_mismatch",
                    )
        except (KeyError, TypeError) as error:
            raise RescueNotConvertible("record_mismatch") from error
    return receipt, hashlib.sha256(data).hexdigest()


def _publish_stream(
    source: Any,
    destination: Path,
    expected: tuple[str, int] | None = None,
    reason: str = "content_digest",
) -> None:
    digest, size = hashlib.sha256(), 0
    with TemporaryDirectory(prefix=".rescue-", dir=destination.parent) as directory:
        temporary = Path(directory) / "complete"
        with temporary.open("xb") as target:
            while chunk := source.read(64 * 1024):
                target.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            target.flush()
            os.fsync(target.fileno())
        if expected is not None:
            _require((digest.hexdigest(), size) == expected, reason)
        os.link(temporary, destination)


def _prepare(
    storage: BronzeStorage,
    record: Mapping[str, Any],
    table: str,
    folder: Path,
    metadata: Mapping[str, str],
) -> tuple[Path, TableSchema, WrittenWindow]:
    schema = TableSchema.from_columns(record["schema"], RESCUE_PRIMARY_KEY)
    _require(schema.columns_sha256() == record.get("schema_sha256"), "schema_digest")
    compressed, csv, parquet = (folder / (table + suffix) for suffix in (".gz", ".csv", ".parquet"))
    with storage.open_stream(record["key"]) as source:
        _publish_stream(
            source, compressed, (record["object_sha256"], record["object_bytes"]), "object_digest"
        )
    try:
        with gzip.open(compressed, "rb") as source:
            _publish_stream(source, csv, (record["csv_sha256"], record["csv_bytes"]))
    except (OSError, EOFError) as error:
        raise RescueNotConvertible("content_digest") from error
    written = write_window(csv, schema, parquet, metadata=metadata, temp_dir=folder)
    proof = prove_window(
        csv,
        parquet,
        schema,
        expect=Expected(record["csv_sha256"], record["rows"], written.sha256),
        temp_dir=folder,
    )
    if not proof.verified:
        raise CopyDiffers("canonical_text", "local copy is not verified")
    return csv, schema, written


def _upload(
    storage: BronzeStorage,
    key: str,
    csv: Path,
    schema: TableSchema,
    written: WrittenWindow,
    folder: Path,
    rows: int,
) -> ConvertedTable:
    upload = written.path.with_suffix(".upload")
    with written.path.open("rb") as source:
        _publish_stream(source, upload, (written.sha256, written.byte_size), "object_digest")
    outcome = put_create_only(storage, upload, key, expected=(written.sha256, written.byte_size))
    downloaded = written.path.with_suffix(".readback")
    read_back(storage, key, downloaded)
    proof = prove_window(
        csv,
        downloaded,
        schema,
        expect=Expected(written.content_sha256, rows, written.sha256),
        temp_dir=folder,
    )
    if not proof.verified:
        raise CopyDiffers("canonical_text", "stored copy is not verified")
    return ConvertedTable(written.path.stem, key, outcome, proof)


def _prepare_tables(
    storage: BronzeStorage,
    receipt: Mapping[str, Any],
    folder: Path,
    receipt_sha: str,
    provider_id: str,
    utc_day: date,
) -> dict[str, tuple[Path, TableSchema, WrittenWindow]]:
    prepared = {}
    for table in RESCUE_TABLES:
        record = receipt["tables"][table]
        prepared[table] = _prepare(
            storage,
            record,
            table,
            folder,
            {
                "source.key": record["key"],
                "source.object_sha256": record["object_sha256"],
                "source.receipt_sha256": receipt_sha,
                "provider_id": provider_id,
                "utc_day": utc_day.isoformat(),
                "table": table,
            },
        )
    return prepared


def _copy_tables(
    storage: BronzeStorage,
    receipt: Mapping[str, Any],
    prepared: Mapping[str, tuple[Path, TableSchema, WrittenWindow]],
    target_prefix: str,
    folder: Path,
) -> tuple[list[ConvertedTable], dict[str, Any]]:
    results, records = [], {}
    for table in RESCUE_TABLES:
        csv, schema, written = prepared[table]
        record = receipt["tables"][table]
        result = _upload(
            storage,
            target_prefix + table + ".parquet",
            csv,
            schema,
            written,
            folder,
            record["rows"],
        )
        results.append(result)
        records[table] = dict(
            key=result.key,
            source_key=record["key"],
            source_object_sha256=record["object_sha256"],
            content_sha256=record["csv_sha256"],
            rows=result.proof.rows,
            schema_sha256=schema.columns_sha256(),
            object_sha256=result.proof.object_sha256,
            object_bytes=result.proof.object_bytes,
            details=written.details(),
            proof=json.loads(result.proof.to_json()),
        )
    return results, records


def convert_rescued_day(
    storage: BronzeStorage,
    *,
    provider_id: str,
    utc_day: date,
    work_dir: Path,
    converted_by: str,
    expected: Mapping[str, Any] | None = None,
) -> ConvertedDay:
    """Check both source tables before upload; retain local evidence until receipt success.

    The caller supplies an existing empty work directory. Failed runs keep their
    private day directory; retry with a fresh work directory. No object is deleted.
    """
    validate_provider_id(provider_id)
    _require(bool(re.fullmatch(r"[0-9a-fA-F]{40}", converted_by)), "converted_by")
    _require(work_dir.is_dir() and not any(work_dir.iterdir()), "work_dir")
    _require(not any(c in str(work_dir) for c in "*?[]{}"), "work_dir")
    source_prefix = f"rescue/v1/facts/{provider_id}/{utc_day.isoformat()}/"
    target_prefix = f"rescue/v1/parquet/{provider_id}/{utc_day.isoformat()}/"
    receipt, receipt_sha = _receipt(storage, source_prefix, provider_id, utc_day, expected)
    folder = Path(mkdtemp(prefix="rescue-", dir=work_dir))
    prepared = _prepare_tables(storage, receipt, folder, receipt_sha, provider_id, utc_day)
    results, records = _copy_tables(storage, receipt, prepared, target_prefix, folder)
    output = dict(
        format_version=1,
        kind="rescue_parquet",
        provider=provider_id,
        day=utc_day.isoformat(),
        source_prefix=source_prefix,
        source_receipt_sha256=receipt_sha,
        converted_by=converted_by,
        tables=records,
    )
    local_receipt = folder / "receipt.json"
    _publish_stream(BytesIO(_canonical(output)), local_receipt)
    receipt_key = target_prefix + "receipt.json"
    outcome = put_create_only(storage, local_receipt, receipt_key)
    # Only remove the private directory this invocation created below work_dir.
    if folder.resolve().parent != work_dir.resolve():
        raise ValueError("unsafe_cleanup_directory")
    shutil.rmtree(folder)
    return ConvertedDay(provider_id, utc_day, receipt_key, outcome, tuple(results))
