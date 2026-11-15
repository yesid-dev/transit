"""Create-only edition ownership, independent of registration retention."""

import hashlib
import json
import shutil
from collections.abc import Iterable, Mapping
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from transit_ops.history import datasets
from transit_ops.history.datasets import TableSource
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import parse_proof_key, validate_provider_id
from transit_ops.lake.edition_identity import (
    EditionIdentityRefused,
    merge_assignments,
    parse_assignments,
)
from transit_ops.lake.objects import put_create_only


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


def _legacy_owner(storage: BronzeStorage, key: str, column: str) -> dict[int, str]:
    parts = parse_proof_key(key)
    assert parts is not None
    receipt = json.loads(storage.read_bytes(key))
    proof = receipt.get("proof", {})
    object_key = key.removesuffix(".proof.json") + ".parquet"
    if (
        proof.get("verified") is not True
        or receipt.get("key") != object_key
        or proof.get("object_sha256") != receipt.get("object_sha256")
        or proof.get("object_bytes") != receipt.get("object_bytes")
        or any(
            receipt.get(name) != expected
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
    with TemporaryDirectory(prefix="edition-owner-") as directory:
        path = Path(directory) / "copy.parquet"
        with storage.open_stream(object_key) as source, path.open("xb") as output:
            shutil.copyfileobj(source, output)
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != receipt["object_sha256"] or path.stat().st_size != receipt["object_bytes"]:
            raise EditionIdentityRefused(f"edition_identity: legacy object digest differs: {key}")
        assigned = parquet_assignments(path)
        owners = [i for i, w in assigned.items() if w == parts.window_key]
        if len(owners) == 1:
            return assigned
        with duckdb.connect() as conn:
            quoted = '"' + column.replace('"', '""') + '"'
            rows = conn.execute(
                f"SELECT DISTINCT {quoted} FROM read_parquet(?,hive_partitioning=false) LIMIT 2",
                [str(path)],
            ).fetchall()
        if len(rows) != 1 or type(rows[0][0]) is not int or rows[0][0] <= 0:
            raise EditionIdentityRefused(f"edition_identity: legacy owner unprovable: {key}")
        return {rows[0][0]: parts.window_key}


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
