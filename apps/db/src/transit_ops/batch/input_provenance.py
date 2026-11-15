"""Provenance checks only for local inputs covered by copy rejections."""

import hashlib
import json
import re
from pathlib import Path
from typing import TYPE_CHECKING

import duckdb

from transit_ops.batch.build import InputNeed
from transit_ops.batch.engine import InputRefused
from transit_ops.lake import copy_rejections
from transit_ops.lake.archive_keys import parse_copy_key

if TYPE_CHECKING:
    from collections.abc import Sequence

    from transit_ops.batch.input_sources import Source


def _matches(key: str, copy: copy_rejections.RejectedCopy) -> bool:
    parts = parse_copy_key(key)
    return (
        parts is not None
        and (parts.dataset_id, parts.provider_id, parts.window_key)
        == (copy.dataset_id, copy.provider_id, copy.window_key)
    ) or key == (
        f"rescue/v1/parquet/{copy.provider_id}/{copy.window_key}/{copy.dataset_id.split('.')[1]}.parquet"
    )


FETCH_RECEIPTS = "fetch-receipts.json"


def write_input_receipts(
    root: Path, needs: "Sequence[InputNeed]", sources: "Sequence[Source]"
) -> None:
    files = {}
    for need in needs:
        path = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
        records = [
            dict(s.receipt)
            for s in sources
            if any(
                n.relation == need.relation and (need.window == "all" or n == need) for n in s.needs
            )
        ]
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files[path.relative_to(root).as_posix()] = dict(input_sha256=digest, sources=records)
    with (root / FETCH_RECEIPTS).open("x", encoding="utf-8") as stream:
        json.dump(dict(format_version=1, files=files), stream, sort_keys=True)


def require_input_provenance(
    need: InputNeed, path: Path, root: Path, provider_id: str | None
) -> None:
    for copy in copy_rejections.REJECTED_COPIES:
        if need.relation != copy.dataset_id or need.window not in (copy.window_key, "all"):
            continue
        if provider_id is not None and provider_id != copy.provider_id:
            continue
        if provider_id is None or need.window == "all":
            with duckdb.connect() as conn:
                where = "provider_id=?"
                params: list[object] = [str(path), copy.provider_id]
                if need.window == "all":
                    where += (
                        " AND captured_at_utc>=?::TIMESTAMPTZ "
                        "AND captured_at_utc<?::TIMESTAMPTZ+INTERVAL 1 DAY"
                    )
                    params += [copy.window_key, copy.window_key]
                found = conn.execute(
                    f"SELECT EXISTS(SELECT 1 FROM read_parquet(?,hive_partitioning=false) "
                    f"WHERE {where})",
                    params,
                ).fetchone()
                assert found is not None
                if not found[0]:
                    continue
        _check_receipt(path, root, copy)


def _check_receipt(path: Path, root: Path, copy: copy_rejections.RejectedCopy) -> None:
    from transit_ops.batch.fetch_inputs import _receipt_size
    from transit_ops.batch.input_sources import _document
    from transit_ops.ingestion.storage import LocalBronzeStorage

    sidecar = root / FETCH_RECEIPTS
    missing = InputRefused(
        f"input_provenance_missing: {copy.dataset_id} {copy.provider_id} {copy.window_key}"
    )
    if not sidecar.is_file() or sidecar.is_symlink() or sidecar.stat().st_nlink != 1:
        raise missing
    try:
        document = _document(LocalBronzeStorage("local", root), sidecar.name)
    except (ValueError, TypeError) as error:
        raise missing from error
    files = document.get("files")
    if document.get("format_version") != 1 or not isinstance(files, dict):
        raise missing
    value = files.get(path.relative_to(root).as_posix())
    if not isinstance(value, dict) or not isinstance(value.get("sources"), list):
        raise missing
    with path.open("rb") as stream:
        if value.get("input_sha256") != hashlib.file_digest(stream, "sha256").hexdigest():
            raise missing
    matching = [
        r
        for r in value.get("sources", [])
        if isinstance(r, dict) and isinstance(r.get("key"), str) and _matches(r["key"], copy)
    ]
    if not matching:
        raise missing
    for receipt in matching:
        key = receipt["key"]
        try:
            if key.startswith("rescue/v1/parquet/"):
                # Rescue identity is its key; still validate the existing object proof.
                receipt = {k: receipt[k] for k in ("key", "object_sha256", "object_bytes", "proof")}
            elif not isinstance(receipt.get("content_sha256"), str) or not re.fullmatch(
                "[0-9a-f]{64}", receipt["content_sha256"]
            ):
                raise missing
            digest = receipt.get("object_sha256")
            if not isinstance(digest, str):
                raise missing
            _receipt_size(receipt, key, digest)
        except copy_rejections.KnownIncomplete:
            raise
        except (KeyError, TypeError, ValueError) as error:
            raise missing from error
