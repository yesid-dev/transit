"""Inventory retained backups and validate evidence without restoring a database."""

import hashlib
import json
from collections.abc import Callable
from contextlib import closing
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from sqlalchemy import Connection

from transit_ops.backups import iter_database_backup_objects
from transit_ops.gold.alert_archive import prepare_recovered_archive_record
from transit_ops.history.alert_recovery_copy import read_alert_archive_copy
from transit_ops.history.alert_recovery_models import Candidate, SourceReport
from transit_ops.history.alert_recovery_pg_restore import extract_alert_archive_copy
from transit_ops.ingestion.storage import build_s3_client
from transit_ops.settings import Settings


def _download(client: Any, bucket: str, entry: dict[str, object], path: Path) -> str:
    size, modified, etag = entry["size"], entry["last_modified"], entry["etag"]
    if type(size) is not int or size < 0 or not isinstance(modified, str):
        raise ValueError("backup_inventory_invalid")
    if not isinstance(etag, str) or not etag:
        raise ValueError("backup_inventory_invalid")
    head = client.head_object(Bucket=bucket, Key=entry["key"], IfMatch=etag)
    if (
        head["ContentLength"] != size
        or head["LastModified"].isoformat() != modified
        or head.get("ETag") != etag
    ):
        raise ValueError("backup_changed")
    response = client.get_object(Bucket=bucket, Key=entry["key"], IfMatch=etag)
    digest, measured = hashlib.sha256(), 0
    with closing(response["Body"]) as body, path.open("wb") as output:
        if response.get("ETag") != etag:
            raise ValueError("backup_changed")
        while block := body.read(1024 * 1024):
            measured += len(block)
            output.write(block)
            digest.update(block)
    if measured != size:
        raise ValueError("backup_length")
    return digest.hexdigest()


def _prepare(
    rows: tuple[dict[str, Any], ...],
    provider: str,
    stamp: datetime,
    entry: dict[str, object],
    digest: str,
) -> list[Candidate]:
    prepared = [
        prepare_recovered_archive_record(row, provider_id=provider, recovered_at_utc=stamp)
        for row in rows
    ]
    return [
        Candidate(
            provider,
            row["alert_id"],
            row["archive_month"],
            row,
            "backup",
            f"{entry['key']} sha256={digest}",
        )
        for row in prepared
    ]


class BackupRecoveryReader:
    def __init__(
        self,
        settings: Settings,
        *,
        client_factory: Callable[..., Any] = build_s3_client,
        extract: Callable[[Path, Path], None] = extract_alert_archive_copy,
    ):
        self.settings, self.client_factory, self.extract = settings, client_factory, extract

    def __call__(
        self, connection: Connection, *, provider_id: str, recovered_at_utc: datetime
    ) -> tuple[tuple[Candidate, ...], SourceReport]:
        if not self.settings.BRONZE_S3_BUCKET:
            return (), SourceReport("backup", missing=("backup_bucket",), coverage=())
        try:
            with closing(self.client_factory(self.settings)) as client:
                inventory = list(iter_database_backup_objects(self.settings, client=client))
                if not inventory:
                    return (), SourceReport("backup", missing=("backup_objects",), coverage=())
                return self._scan(connection, client, inventory, provider_id, recovered_at_utc)
        except Exception:
            if connection is not None and (connection.closed or connection.invalidated):
                raise
            return (), SourceReport("backup", errors=("backup_inventory_failed",), coverage=())

    def _scan(
        self,
        connection: Connection,
        client: Any,
        inventory: list[dict[str, object]],
        provider: str,
        stamp: datetime,
    ) -> tuple[tuple[Candidate, ...], SourceReport]:
        candidates, coverage, errors = [], [], []
        for entry in sorted(inventory, key=lambda e: str(e["key"]), reverse=True):
            note = json.dumps(entry, sort_keys=True)
            try:
                with TemporaryDirectory(prefix="alert-recovery-") as directory:
                    dump, output = Path(directory) / "source.dump", Path(directory) / "copy.sql"
                    digest = _download(client, self.settings.BRONZE_S3_BUCKET or "", entry, dump)
                    note += f" sha256={digest}"
                    self.extract(dump, output)
                    # A bad cast rolls back before the next retained object is attempted.
                    with connection.begin_nested():
                        rows, absent = read_alert_archive_copy(
                            connection, output, provider_id=provider
                        )
                        items = _prepare(rows, provider, stamp, entry, digest)
                    candidates.extend(items)
                    note += " complete" + (
                        f" projected_missing={','.join(absent)}" if absent else ""
                    )
            except Exception:
                if connection.closed or connection.invalidated:
                    raise
                errors.append(f"{entry['key']}: backup_read_failed")
                note += " failed"
            coverage.append(note)
        return tuple(candidates), SourceReport(
            "backup",
            scanned=len(inventory),
            candidates=len(candidates),
            errors=tuple(errors),
            coverage=tuple(coverage),
            complete=not errors,
        )
