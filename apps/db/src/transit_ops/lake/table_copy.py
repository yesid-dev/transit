"""Copy one table window; callers serialize archive writers, without a ledger."""

import json
import os
import re
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal, cast

from psycopg import Connection

from transit_ops.history.datasets import TableSource, get_dataset, utc_day_closes_at, window_start
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import (
    parse_proof_key,
    proof_key,
    resolve_copy_version,
    resolve_schema_version,
    schema_key,
    table_copy_key,
    validate_provider_id,
)
from transit_ops.lake.objects import put_create_only
from transit_ops.lake.parquet_codec import WrittenWindow, write_window
from transit_ops.lake.parquet_verify import Expected, WindowProof, prove_window, read_back
from transit_ops.lake.table_export import (
    ExportedWindow,
    WindowSpec,
    export_window,
    recheck_window,
    validate_timeout,
)


class ServerChanged(ValueError):
    """The source no longer matches the exported snapshot."""


class UnverifiedCopy(ValueError):
    """Canonical text equality is required before publishing a receipt."""


@dataclass(frozen=True)
class TableCopy:
    spec: WindowSpec
    outcome: Literal["copied", "already_copied", "local_only"]
    key: str | None
    proof_key: str | None
    content_sha256: str
    rows: int
    proof: WindowProof


def _sync_directory(path: Path) -> None:
    if os.name == "nt":
        # Windows does not support directory fsync; NTFS journals metadata.
        return
    descriptor = os.open(path, os.O_RDONLY | cast(Any, os).O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _publish(source: Path, destination: Path) -> None:
    with source.open("r+b") as stream:
        os.fsync(stream.fileno())
    os.link(source, destination)
    try:
        _sync_directory(destination.parent)
    except BaseException:
        destination.unlink()
        raise


def _publish_local(temporary: Path, work_dir: Path) -> None:
    published: list[Path] = []
    try:
        for name in ("window.csv", "window.parquet", "proof.json"):
            destination = work_dir / name
            _publish(temporary / name, destination)
            published.append(destination)
    except BaseException:
        for path in published:
            path.unlink()
        _sync_directory(work_dir)
        raise


def _json_file(path: Path, value: dict[str, Any]) -> None:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    with TemporaryDirectory(prefix=".receipt-", dir=path.parent) as directory:
        temporary = Path(directory) / "receipt.json"
        with temporary.open("xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        _publish(temporary, path)


def _prove(exported: ExportedWindow, path: Path, written: WrittenWindow, temp: Path) -> WindowProof:
    proof = prove_window(
        exported.csv_path,
        path,
        exported.schema,
        expect=Expected(exported.content_sha256, exported.rows, written.sha256),
        temp_dir=temp,
    )
    if proof.verified is not True:
        raise UnverifiedCopy("proof.verified must be true")
    return proof


def _receipt(
    exported: ExportedWindow,
    written: WrittenWindow,
    proof: WindowProof,
    key: str,
    version: int,
    schema_version: int,
    copied_by: str,
) -> dict[str, Any]:
    return dict(
        format_version=1,
        kind="table_copy",
        **asdict(exported.spec),
        partial=exported.spec.cut_utc is not None,
        content_version=version,
        schema_version=schema_version,
        key=key,
        schema_key=schema_key(exported.spec.dataset_id, schema_version),
        content_sha256=exported.content_sha256,
        rows=proof.rows,
        object_sha256=proof.object_sha256,
        object_bytes=proof.object_bytes,
        details=written.details(),
        proof={
            **asdict(proof),
            "cut_utc": exported.spec.cut_utc,
            "partial": exported.spec.cut_utc is not None,
        },
        source=dict(
            snapshot_at_utc=exported.snapshot_at_utc.isoformat(),
            server_version=exported.server_version,
            copied_by=copied_by,
        ),
    )


def _archive(
    storage: BronzeStorage,
    exported: ExportedWindow,
    written: WrittenWindow,
    work_dir: Path,
    temporary: Path,
    copied_by: str,
) -> TableCopy:
    spec = exported.spec
    grain = get_dataset(spec.dataset_id).archive_grain
    schema_version = resolve_schema_version(storage, spec.dataset_id, exported.schema)
    version = resolve_copy_version(
        storage,
        spec.dataset_id,
        spec.provider_id,
        spec.revision,
        grain,
        spec.window_key,
        exported.content_sha256,
        schema_version=schema_version,
        cut_utc=spec.cut_utc,
        complete_window=_closed(spec, exported.snapshot_at_utc),
    )
    key = version.key or table_copy_key(
        spec.dataset_id,
        spec.provider_id,
        spec.revision,
        grain,
        spec.window_key,
        version.version,
        schema_version,
    )
    if version.key is None:
        _upload(
            storage,
            exported,
            written,
            work_dir,
            temporary,
            key,
            version.version,
            schema_version,
            copied_by,
        )
    return _finish(storage, exported, key, work_dir, "already_copied" if version.key else "copied")


def _upload(
    storage: BronzeStorage,
    exported: ExportedWindow,
    written: WrittenWindow,
    work_dir: Path,
    temporary: Path,
    key: str,
    version: int,
    schema_version: int,
    copied_by: str,
) -> WindowProof:
    # Storage consumes uploads. Keep local evidence until the receipt exists.
    upload = temporary / "upload.parquet"
    _publish(work_dir / "window.parquet", upload)
    put_create_only(storage, upload, key, expected=(written.sha256, written.byte_size))
    downloaded = temporary / "readback.parquet"
    read_back(storage, key, downloaded)
    _sync_directory(temporary)
    proof = _prove(exported, downloaded, written, temporary)
    receipt = temporary / "receipt.json"
    _json_file(receipt, _receipt(exported, written, proof, key, version, schema_version, copied_by))
    put_create_only(storage, receipt, proof_key(key))
    return proof


def _finish(
    storage: BronzeStorage,
    exported: ExportedWindow,
    key: str,
    work_dir: Path,
    outcome: Literal["copied", "already_copied"],
) -> TableCopy:
    receipt_value = json.loads(storage.read_bytes(proof_key(key)))
    proof = _receipt_proof(receipt_value, exported)
    for name in ("window.csv", "window.parquet", "proof.json"):
        (work_dir / name).unlink()
    _sync_directory(work_dir)
    return TableCopy(
        exported.spec, outcome, key, proof_key(key), exported.content_sha256, exported.rows, proof
    )


def _receipt_proof(receipt: dict[str, Any], exported: ExportedWindow) -> WindowProof:
    if not isinstance(receipt, dict):
        raise UnverifiedCopy("invalid archive receipt")
    value = receipt.get("proof")
    if not isinstance(value, dict) or value.get("verified") is not True:
        raise UnverifiedCopy("archive receipt proof.verified must be true")
    try:
        coverage = {"cut_utc": exported.spec.cut_utc, "partial": exported.spec.cut_utc is not None}
        if (
            value.get("cut_utc") != coverage["cut_utc"]
            or value.get("partial", False) is not coverage["partial"]
        ):
            raise UnverifiedCopy("archive receipt coverage differs")
        proof = WindowProof(**{k: v for k, v in value.items() if k not in coverage})
    except TypeError as error:
        raise UnverifiedCopy("invalid archive receipt WindowProof") from error
    for name in ("content_sha256", "object_sha256", "schema_sha256"):
        digest = getattr(proof, name)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise UnverifiedCopy(f"invalid archive receipt proof.{name}")
    for name in ("rows", "object_bytes", "missing_from_copy", "extra_in_copy"):
        count = getattr(proof, name)
        if type(count) is not int or count < 0:
            raise UnverifiedCopy(f"invalid archive receipt proof.{name}")
    if (
        proof.content_sha256 != exported.content_sha256
        or proof.rows != exported.rows
        or proof.schema_sha256 != exported.schema.columns_sha256()
        or proof.missing_from_copy != 0
        or proof.extra_in_copy != 0
        or proof.in_key_order is not True
        or not isinstance(proof.checked_with, str)
        or not proof.checked_with
        or receipt.get("object_sha256") != proof.object_sha256
        or type(receipt.get("object_bytes")) is not int
        or receipt["object_bytes"] != proof.object_bytes
    ):
        raise UnverifiedCopy("archive receipt WindowProof differs from copy")
    return proof


def copy_table_window(
    connection: Connection[Any],
    storage: BronzeStorage | None,
    spec: WindowSpec,
    *,
    work_dir: Path,
    copied_by: str,
    statement_timeout_s: int,
) -> TableCopy:
    """Export, prove canonical text, recheck source, and create-only publish exact files.

    The existing work directory must be empty. Unknown files are never resumed.
    Failed archive uploads retain local evidence; successful receipts permit cleanup.
    """
    validate_timeout(statement_timeout_s)
    if not isinstance(copied_by, str) or not re.fullmatch(r"[0-9a-f]{40}", copied_by):
        raise ValueError("copied_by must be a 40-hex commit")
    if not isinstance(spec.provider_id, str):
        raise ValueError("Invalid provider_id")
    validate_provider_id(spec.provider_id)
    if any(character in str(work_dir) for character in "*?[]{}"):
        raise ValueError("Glob characters in work_dir")
    if not work_dir.is_dir() or any(work_dir.iterdir()):
        raise ValueError("work_dir must exist and be empty")
    now = _copy_start()
    if storage is not None and _closed(spec, now):
        existing = _proven_closed(storage, spec)
        if existing is not None:
            return existing
    dataset = get_dataset(spec.dataset_id)
    source = dataset.source
    if (
        isinstance(source, TableSource)
        and source.window_column
        and dataset.archive_grain != "edition"
        and not _closed(spec, now)
    ):
        spec = replace(
            spec,
            cut_utc=(now - timedelta(hours=6))
            .replace(minute=0, second=0, microsecond=0)
            .isoformat(),
        )
    with TemporaryDirectory(prefix=".copy-", dir=work_dir) as directory:
        temporary = Path(directory)
        exported, written, proof = _prepare(connection, spec, temporary, statement_timeout_s)
        _json_file(
            temporary / "proof.json",
            {**asdict(proof), "cut_utc": spec.cut_utc, "partial": spec.cut_utc is not None},
        )
        _publish_local(temporary, work_dir)
        if storage is None:
            return TableCopy(
                spec, "local_only", None, None, exported.content_sha256, exported.rows, proof
            )
        return _archive(storage, exported, written, work_dir, temporary, copied_by)


def _prepare(
    connection: Connection[Any],
    spec: WindowSpec,
    temporary: Path,
    statement_timeout_s: int,
) -> tuple[ExportedWindow, WrittenWindow, WindowProof]:
    exported = export_window(
        connection, spec, temporary / "window.csv", statement_timeout_s=statement_timeout_s
    )
    _sync_directory(temporary)
    written = write_window(
        exported.csv_path,
        exported.schema,
        temporary / "window.parquet",
        metadata={
            **{k: str(v) for k, v in asdict(spec).items()},
            "partial": str(spec.cut_utc is not None).lower(),
        },
        temp_dir=temporary,
    )
    proof = _prove(exported, written.path, written, temporary)
    current = recheck_window(
        connection,
        spec,
        statement_timeout_s=statement_timeout_s,
        expected_schema=exported.schema,
    )
    if current != (exported.content_sha256, exported.content_bytes, exported.rows):
        raise ServerChanged("source differs from exported window")
    return exported, written, proof


def _copy_start() -> datetime:
    return datetime.now(UTC)


def _closed(spec: WindowSpec, now: datetime) -> bool:
    from transit_ops.settings import get_settings

    dataset = get_dataset(spec.dataset_id)
    source = dataset.source
    if (
        not isinstance(source, TableSource)
        or not source.window_column
        or dataset.archive_grain == "edition"
    ):
        return False
    start = window_start(dataset, spec.window_key)
    assert start is not None
    if dataset.archive_grain == "utc_day":
        return utc_day_closes_at(start) <= now
    end = start.replace(year=start.year + (start.month == 12), month=start.month % 12 + 1, day=1)
    return end + timedelta(days=get_settings().GOLD_REPORTING_OPEN_WINDOW_DAYS) <= now.date()


def _proven_closed(storage: BronzeStorage, spec: WindowSpec) -> TableCopy | None:
    candidates = []
    for key in storage.list_keys(
        f"archive/v1/tables/{spec.dataset_id}/{spec.provider_id}/r{spec.revision}/"
    ):
        parts = parse_proof_key(key)
        if parts is None or parts.window_key != spec.window_key:
            continue
        receipt = json.loads(storage.read_bytes(key))
        if not isinstance(receipt, dict) or receipt.get("proof", {}).get("verified") is not True:
            continue
        candidates.append((parts.version, parts.schema_version, key, receipt))
    if not candidates:
        return None
    _, _, key, receipt = max(candidates, key=lambda item: item[:2])
    # A cut copy never proves a complete closed window.
    if receipt.get("cut_utc") is not None or receipt.get("partial", False):
        return None
    stamp = receipt.get("source", {}).get("snapshot_at_utc")
    if not isinstance(stamp, str) or not _closed(spec, datetime.fromisoformat(stamp)):
        return None
    object_key = key.removesuffix(".proof.json") + ".parquet"
    if receipt.get("key") != object_key or not storage.exists(object_key):
        raise UnverifiedCopy("archive receipt object missing or differs")
    for name in ("dataset_id", "provider_id", "window_key", "revision"):
        if receipt.get(name) != getattr(spec, name):
            raise UnverifiedCopy("archive receipt identity differs")
    from transit_ops.lake.table_schema import TableSchema

    schema = TableSchema.from_json(storage.read_bytes(receipt["schema_key"]))
    exported = ExportedWindow(
        spec, Path(), receipt["content_sha256"], 0, receipt["rows"], schema, datetime.now(UTC), ""
    )
    proof = _receipt_proof(receipt, exported)
    return TableCopy(
        spec, "already_copied", object_key, key, exported.content_sha256, exported.rows, proof
    )
