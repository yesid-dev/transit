"""Create-only edition ownership, independent of registration retention."""

import hashlib
import json
import re
import shutil
from collections.abc import Iterable, Mapping
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from transit_ops.history import datasets
from transit_ops.history.datasets import TableSource
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import parse_proof_key, schema_key, validate_provider_id
from transit_ops.lake.edition_identity import (
    EditionIdentityRefused,
    merge_assignments,
    parse_assignments,
)
from transit_ops.lake.objects import put_create_only
from transit_ops.lake.parquet_verify import WindowProof, _check_types
from transit_ops.lake.table_schema import TableSchema


def _prefix(provider: str) -> str:
    return f"archive/v1/edition-identities/{validate_provider_id(provider)}/"


def parquet_assignments(path: Path) -> dict[int, str]:
    with duckdb.connect() as conn:
        rows = conn.execute(
            "SELECT value FROM parquet_kv_metadata(?) WHERE key='edition_assignments'::BLOB",
            [str(path)],
        ).fetchall()
    if not rows:
        return {}
    if len(rows) != 1:
        raise EditionIdentityRefused("edition_identity: ambiguous bootstrap assignments")
    return parse_assignments(bytes(rows[0][0]).decode())


def stored_assignments(storage: BronzeStorage, provider: str) -> dict[int, str]:
    result: dict[int, str] = {}
    prefix = _prefix(provider)
    for key in storage.list_keys(prefix):
        value = json.loads(storage.read_bytes(key))
        if not isinstance(value, dict):
            raise EditionIdentityRefused(f"edition_identity: invalid ownership record: {key}")
        ident = value.get("dataset_version_id")
        if (
            type(ident) is not int
            or value.get("provider_id") != provider
            or value.get("format_version") != 1
            or key != f"{prefix}{ident}.json"
        ):
            raise EditionIdentityRefused(f"edition_identity: invalid ownership record: {key}")
        window = value.get("window_key")
        if not isinstance(window, str):
            raise EditionIdentityRefused(f"edition_identity: invalid ownership record: {key}")
        result = merge_assignments(result, {ident: window})
    return result


def persist_assignments(
    storage: BronzeStorage, provider: str, assignments: Mapping[int, str]
) -> None:
    if not assignments:
        return
    existing = stored_assignments(storage, provider)
    assignments = merge_assignments(existing, assignments)
    with TemporaryDirectory(prefix="edition-identity-") as directory:
        for ident, window in assignments.items():
            if ident in existing:
                continue
            payload = json.dumps(
                dict(
                    format_version=1,
                    provider_id=provider,
                    dataset_version_id=ident,
                    window_key=window,
                ),
                sort_keys=True,
            ).encode()
            path = Path(directory) / f"{ident}.json"
            path.write_bytes(payload)
            put_create_only(storage, path, f"{_prefix(provider)}{ident}.json")


def _legacy_proof(receipt: object, schema: TableSchema) -> WindowProof:
    if not isinstance(receipt, dict) or not isinstance(receipt.get("proof"), dict):
        raise EditionIdentityRefused("edition_identity: invalid legacy proof")
    value = receipt["proof"]
    proof = WindowProof(
        **{k: v for k, v in value.items() if k not in {"cut_utc", "partial", "date_bound"}}
    )
    if (
        proof.verified is not True
        or proof.in_key_order is not True
        or proof.missing_from_copy != 0
        or type(proof.missing_from_copy) is not int
        or proof.extra_in_copy != 0
        or type(proof.extra_in_copy) is not int
        or not isinstance(proof.checked_with, str)
        or not proof.checked_with
        or proof.schema_sha256 != schema.columns_sha256()
        or any(
            type(getattr(proof, n)) is not int or getattr(proof, n) < 0
            for n in ("rows", "object_bytes")
        )
        or any(
            not isinstance(getattr(proof, n), str)
            or not re.fullmatch(r"[0-9a-f]{64}", getattr(proof, n))
            for n in ("content_sha256", "object_sha256", "schema_sha256")
        )
        or any(
            type(receipt.get(n)) is not type(getattr(proof, n))
            or receipt.get(n) != getattr(proof, n)
            for n in ("rows", "object_bytes", "object_sha256", "content_sha256")
        )
        or any(
            d.get("cut_utc") is not None
            or d.get("date_bound") is not None
            or d.get("partial", False) is not False
            for d in (receipt, value)
        )
    ):
        raise EditionIdentityRefused("edition_identity: inconsistent legacy proof")
    return proof


def _legacy_owner(storage: BronzeStorage, key: str, column: str) -> dict[int, str]:
    parts = parse_proof_key(key)
    assert parts is not None
    receipt = json.loads(storage.read_bytes(key))
    object_key = key.removesuffix(".proof.json") + ".parquet"
    if (
        not isinstance(receipt, dict)
        or type(receipt.get("format_version")) is not int
        or receipt.get("format_version") != 1
        or receipt.get("kind") != "table_copy"
        or receipt.get("key") != object_key
        or receipt.get("schema_key") != schema_key(parts.dataset_id, parts.schema_version)
        or any(
            type(receipt.get(name)) is not type(expected) or receipt.get(name) != expected
            for name, expected in (
                ("dataset_id", parts.dataset_id),
                ("provider_id", parts.provider_id),
                ("window_key", parts.window_key),
                ("revision", parts.revision),
                ("content_version", parts.version),
                ("schema_version", parts.schema_version),
            )
        )
    ):
        raise EditionIdentityRefused(f"edition_identity: unproven legacy copy: {key}")
    schema = TableSchema.from_json(storage.read_bytes(receipt["schema_key"]))
    proof = _legacy_proof(receipt, schema)
    with TemporaryDirectory(prefix="edition-owner-") as directory:
        path = Path(directory) / "copy.parquet"
        with storage.open_stream(object_key) as source, path.open("xb") as output:
            shutil.copyfileobj(source, output)
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != receipt["object_sha256"] or path.stat().st_size != receipt["object_bytes"]:
            raise EditionIdentityRefused(f"edition_identity: legacy object digest differs: {key}")
        with duckdb.connect() as conn:
            conn.execute("SET memory_limit='256MiB'")
            conn.execute("SET temp_directory=?", [directory])
            conn.execute("SET max_temp_directory_size='20GiB'")
            _check_types(conn, path, schema)
            metadata = dict(
                conn.execute("SELECT key,value FROM parquet_kv_metadata(?)", [str(path)]).fetchall()
            )
            if any(
                metadata.get(k) != v
                for k, v in {
                    b"transit.schema": schema.to_json(),
                    b"transit.rows": str(proof.rows).encode(),
                    b"transit.content_sha256": proof.content_sha256.encode(),
                }.items()
            ):
                raise EditionIdentityRefused("edition_identity: legacy metadata differs")
            quoted = '"' + column.replace('"', '""') + '"'
            has_provider = "provider_id" in {c.name for c in schema.columns}
            selected = f'{quoted}, "provider_id"' if has_provider else quoted
            rows = conn.execute(
                f"SELECT {selected}, count(*) FROM read_parquet(?,hive_partitioning=false) "
                f"GROUP BY {selected} LIMIT 2",
                [str(path)],
            ).fetchall()
        if (
            len(rows) != 1
            or type(rows[0][0]) is not int
            or rows[0][0] <= 0
            or rows[0][-1] != proof.rows
            or (has_provider and rows[0][1] != parts.provider_id)
        ):
            raise EditionIdentityRefused(f"edition_identity: legacy owner unprovable: {key}")
        owner = rows[0][0]
        assigned = parquet_assignments(path)
        owners = [i for i, w in assigned.items() if w == parts.window_key]
        if (owners and owners != [owner]) or assigned.get(
            owner, parts.window_key
        ) != parts.window_key:
            raise EditionIdentityRefused("edition_identity: legacy assignment contradicts rows")
        # An edition object establishes its own owner, never unrelated map entries.
        return {owner: parts.window_key}


def archive_assignments(
    storage: BronzeStorage | None,
    provider: str,
    digests: Iterable[str] = (),
) -> dict[int, str]:
    if storage is None:
        return {}
    assigned = stored_assignments(storage, provider)
    missing = set(digests) - {w.split(".")[0] for w in assigned.values() if "." not in w}
    if not missing:
        return assigned
    # Adopt old names from digest-verified bytes, never from surviving registry
    # order. Prefer small edition tables; each digest needs only one owner proof.
    for name, dataset in sorted(datasets.HISTORY_DATASETS.items()):
        source = dataset.source
        if dataset.archive_grain != "edition" or not isinstance(source, TableSource):
            continue
        for key in storage.list_keys(f"archive/v1/tables/{name}/{provider}/"):
            parts = parse_proof_key(key)
            if parts is None or parts.window_key not in missing:
                continue
            try:
                assigned = merge_assignments(
                    assigned, _legacy_owner(storage, key, str(source.window_column))
                )
            except (ValueError, KeyError, TypeError, duckdb.Error, OSError) as exc:
                raise EditionIdentityRefused(
                    f"edition_identity: legacy owner unprovable: {key}"
                ) from exc
            missing.remove(parts.window_key)
    return assigned
