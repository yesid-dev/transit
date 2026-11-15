"""One activation proof for the declared Silver alert whole-state copy group."""

import hashlib
import json
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from psycopg import Connection

from transit_ops.history.datasets import HISTORY_DATASETS
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import put_create_only
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_copy import TableCopy, _archive, _json_file, _prove
from transit_ops.lake.table_export import WindowSpec, export_group

GROUP = "silver_alert_state"
PREFIX = "archive/v1/bundles/silver_alert_state/"
MEMBERS = tuple(d.dataset_id for d in HISTORY_DATASETS.values() if d.copy_group == GROUP)


def validate_members(specs: Sequence[WindowSpec]) -> None:
    identities = {(s.dataset_id, s.provider_id) for s in specs}
    providers = {s.provider_id for s in specs if s.dataset_id != "silver.i3_alert_active_periods"}
    expected = {
        (r, p)
        for r in MEMBERS
        for p in (("_shared",) if r == "silver.i3_alert_active_periods" else sorted(providers))
    }
    missing = expected - identities
    missing_relations = set(MEMBERS) - {s.dataset_id for s in specs}
    if (
        not providers
        or missing
        or missing_relations
        or identities != expected
        or len(identities) != len(specs)
        or len({s.window_key for s in specs}) != 1
    ):
        raise ValueError(f"incomplete {GROUP}: {sorted(missing_relations)} {sorted(missing)}")


@dataclass(frozen=True)
class BundleCopy:
    version: str
    snapshot_at_utc: str
    members: tuple[TableCopy, ...]


def copy_group(
    connection: Connection[Any],
    storage: BronzeStorage,
    specs: Sequence[WindowSpec],
    *,
    work_dir: Path,
    copied_by: str,
    statement_timeout_s: int,
) -> BundleCopy:
    """Only the last create-only write activates members; partial copies are inert."""
    validate_members(specs)
    if not re.fullmatch("[0-9a-f]{40}", copied_by):
        raise ValueError("copied_by must be a 40-hex commit")
    if (
        not work_dir.is_dir()
        or any(work_dir.iterdir())
        or any(c in str(work_dir) for c in "*?[]{}")
    ):
        raise ValueError("work_dir must be empty and contain no glob characters")
    directories = tuple(work_dir / str(i) for i in range(len(specs)))
    for directory in directories:
        directory.mkdir()
    with export_group(
        connection,
        tuple(specs),
        tuple(d / "window.csv" for d in directories),
        statement_timeout_s=statement_timeout_s,
    ) as exported:
        pass  # Release the source snapshot before CPU, upload and readback work.
    results, records = [], []
    for item, directory in zip(exported, directories, strict=True):
        temporary = directory / "temporary"
        temporary.mkdir()
        written = write_window(
            item.csv_path,
            item.schema,
            directory / "window.parquet",
            metadata={k: str(v) for k, v in asdict(item.spec).items()},
            temp_dir=temporary,
        )
        proof = _prove(item, written.path, written, temporary)
        _json_file(directory / "proof.json", asdict(proof))
        result = _archive(storage, item, written, directory, temporary, copied_by)
        results.append(result)
        records.append(json.loads(storage.read_bytes(str(result.proof_key))))
    at = exported[0].snapshot_at_utc
    document = dict(
        format_version=1,
        kind=GROUP,
        snapshot_at_utc=at.isoformat(),
        coverage_from_utc=(at - timedelta(days=30)).isoformat(),
        members=records,
    )
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    version = hashlib.sha256(payload).hexdigest()
    path = work_dir / "bundle.json"
    path.write_bytes(payload)
    put_create_only(storage, path, PREFIX + version + ".json", expected=(version, len(payload)))
    return BundleCopy(version, at.isoformat(), tuple(results))
