"""Fetch explicitly inventoried, verified archive objects into the batch layout."""

import hashlib
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

from transit_ops.batch.build import BuildRequest, FamilyBuilder, InputNeed
from transit_ops.batch.engine import InputRefused
from transit_ops.batch.inputs import resolve_inputs
from transit_ops.ingestion.storage import BronzeStorage


class InputDigestMismatch(ValueError):
    """An input's bytes differ from its verified archive receipt."""


@dataclass(frozen=True)
class FetchReceipt:
    need: InputNeed
    key: str
    path: Path
    sha256: str
    byte_size: int
    reused: bool


def _receipt_size(receipt: Mapping[str, object], key: str, digest: str) -> int:
    proof = receipt.get("proof")
    if not isinstance(proof, Mapping) or proof.get("verified") is not True:
        raise ValueError(f"receipt proof.verified must be true: {key}")
    size = receipt.get("object_bytes")
    if (
        not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or receipt.get("key") != key
        or receipt.get("object_sha256") != digest
        or proof.get("object_sha256") != digest
        or type(size) is not int
        or size < 0
        or type(proof.get("object_bytes")) is not int
        or proof.get("object_bytes") != size
    ):
        raise ValueError(f"receipt key, object digest or byte size differs: {key}")
    return size


def _check(path: Path, need: InputNeed, digest: str, size: int) -> None:
    resolve_inputs((need,), path.parent.parent)
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
        actual_size = stream.tell()
    if (actual, actual_size) != (digest, size):
        raise InputDigestMismatch(f"{need.relation} window {need.window}: {path}")


def _sync_directory(path: Path) -> None:
    if os.name == "nt":
        return  # Windows has no directory fsync; NTFS journals metadata.
    descriptor = os.open(path, os.O_RDONLY | cast(Any, os).O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _download(
    storage: BronzeStorage, key: str, path: Path, need: InputNeed, digest: str, size: int
) -> bool:
    with TemporaryDirectory(prefix=".fetch-", dir=path.parent) as directory:
        temporary = Path(directory) / "input.parquet"
        hasher, count = hashlib.sha256(), 0
        with temporary.open("xb") as output, storage.open_stream(key) as source:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
                hasher.update(chunk)
                count += len(chunk)
            output.flush()
            os.fsync(output.fileno())
        if (hasher.hexdigest(), count) != (digest, size):
            raise InputDigestMismatch(f"{need.relation} window {need.window}: {key}")
        try:
            os.link(temporary, path)
        except FileExistsError:
            _check(path, need, digest, size)
            return True
        _sync_directory(path.parent)
    return False


def fetch_inputs(
    needs: Sequence[InputNeed],
    storage: BronzeStorage,
    inputs_root: Path,
    *,
    key_for: Callable[[InputNeed], str],
    expected_sha256: Callable[[InputNeed], str],
    receipt_for: Callable[[InputNeed], Mapping[str, object]],
) -> list[FetchReceipt]:
    """Keep matching files; refuse conflicts; publish only fully verified downloads.

    Keys and receipts come from the runner's archive inventory, including rescue
    copies. No storage listing or receipt-key inference occurs here. Each file is
    published independently; earlier successes remain resumable after a failure.
    """
    root = inputs_root.resolve()
    receipts = []
    for need in needs:
        key, digest = key_for(need), expected_sha256(need)
        size = _receipt_size(receipt_for(need), key, digest)
        path = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
        if any(c in str(inputs_root) + str(path) for c in "*?[]{}"):
            raise InputRefused(f"glob path refused: {path}")
        if any(p.is_symlink() or p.is_junction() for p in (path.parent, path)):
            raise InputRefused(f"redirected input: {path}")
        if path.exists():
            _check(path, need, digest, size)
            reused = True
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            reused = _download(storage, key, path, need, digest, size)
        receipts.append(FetchReceipt(need, key, path, digest, size, reused))
    return receipts


def needs_for_replay(
    families: Sequence[FamilyBuilder],
    request: BuildRequest,
    *,
    postgres_needs: Sequence[InputNeed],
) -> tuple[InputNeed, ...]:
    """Union family declarations with PostgreSQL's explicit archive inventory.

    The runner owns complete PostgreSQL coverage, including edition identities
    and historical outputs; a BuildRequest cannot infer those windows.
    """
    needs = set(postgres_needs)
    for family in families:
        needs.update(family.inputs(request))
    return tuple(sorted(needs, key=lambda need: (need.relation, need.window)))
