"""Manual, transaction-owned composition of retained alert evidence."""

import json
from collections.abc import Iterable, Mapping
from contextlib import ExitStack
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Annotated

import typer
from sqlalchemy import Connection, Engine, text

from transit_ops.db.connection import make_engine
from transit_ops.history.alert_recovery import RecoverySourceReader, recover_alert_archive_entries
from transit_ops.history.alert_recovery_models import (
    Candidate,
    RecoveryReport,
    SourceKind,
    SourceReport,
)
from transit_ops.history.alert_recovery_published import read_published_candidates
from transit_ops.providers.registry import ProviderRegistry
from transit_ops.settings import get_settings
from transit_ops.snapshots.storage import (
    LocalSnapshotStorage,
    SnapshotStorage,
    build_snapshot_storage,
)

KINDS: tuple[SourceKind, ...] = ("backup", "published", "capture")


def build_recovery_source_readers(
    storage: SnapshotStorage | LocalSnapshotStorage,
) -> Mapping[SourceKind, RecoverySourceReader]:
    def published(
        connection: Connection, *, provider_id: str, recovered_at_utc: datetime
    ) -> tuple[tuple[Candidate, ...], SourceReport]:
        return read_published_candidates(
            storage, provider_id=provider_id, recovered_at_utc=recovered_at_utc
        )

    return {"published": published}


def run_alert_archive_recovery(
    engine: Engine,
    *,
    provider_id: str,
    source_readers: Mapping[SourceKind, RecoverySourceReader],
    expected_ids: Iterable[str] | None = None,
    dry_run: bool = True,
    recovered_at_utc: datetime,
) -> RecoveryReport:
    """Commit one complete operation; source failures remain incomplete evidence."""
    if set(source_readers) - set(KINDS):
        raise ValueError("unknown source slot")
    candidates: list[Candidate] = []
    reports: list[SourceReport] = []
    with engine.connect().execution_options(isolation_level="READ COMMITTED") as connection:
        with connection.begin():
            connection.execute(
                text("SET TRANSACTION READ ONLY" if dry_run else "SET TRANSACTION READ WRITE")
            )
            for kind in KINDS:
                items: tuple[Candidate, ...] = ()
                report = SourceReport(kind)
                if kind in source_readers:
                    try:
                        result, report = source_readers[kind](
                            connection, provider_id=provider_id, recovered_at_utc=recovered_at_utc
                        )
                        items = tuple(result)
                        if report.kind != kind or any(c.source_kind != kind for c in items):
                            raise ValueError("source slot mismatch")
                    except Exception:
                        items = ()
                        report = SourceReport(kind, errors=("source read failed",))
                candidates.extend(items)
                reports.append(report)
            report_result = recover_alert_archive_entries(
                connection,
                provider_id=provider_id,
                candidates=candidates,
                source_reports=reports,
                expected_ids=expected_ids,
                dry_run=dry_run,
                recovered_at_utc=recovered_at_utc,
            )
    return report_result


def recover_alert_archive_entries_command(
    provider_id: str,
    capture_from: Annotated[str, typer.Option("--capture-from")],
    capture_to: Annotated[str, typer.Option("--capture-to")],
    expected_id: Annotated[list[str] | None, typer.Option("--expected-id")] = None,
    dry_run: Annotated[bool, typer.Option("--dry-run/--apply")] = True,
) -> None:
    """Preview retained evidence; production apply requires the owner's explicit yes."""
    try:
        start, end = (datetime.fromisoformat(v) for v in (capture_from, capture_to))
        if start.utcoffset() is None or end.utcoffset() is None:
            raise ValueError
        start, end = start.astimezone(UTC), end.astimezone(UTC)
        if start >= end or not provider_id or provider_id != provider_id.strip():
            raise ValueError
        if expected_id and any(not v or v != v.strip() for v in expected_id):
            raise ValueError
    except ValueError:
        typer.echo(json.dumps({"error": "invalid identity or aware half-open capture interval"}))
        raise typer.Exit(2) from None
    try:
        with ExitStack() as resources:
            settings = get_settings()
            ProviderRegistry.from_project_root(settings=settings).get_provider(provider_id)
            engine = make_engine(settings)
            resources.callback(engine.dispose)
            storage = build_snapshot_storage(settings, provider_id=provider_id)
            if isinstance(storage, SnapshotStorage):
                resources.callback(storage.close)
            report = run_alert_archive_recovery(
                engine,
                provider_id=provider_id,
                source_readers=build_recovery_source_readers(storage),
                expected_ids=expected_id,
                dry_run=dry_run,
                recovered_at_utc=datetime.now(UTC),
            )
    except Exception:
        typer.echo(json.dumps({"error": "alert archive recovery failed"}))
        raise typer.Exit(1) from None
    typer.echo(json.dumps(asdict(report), default=lambda v: v.isoformat(), sort_keys=True))
    if not report.complete or report.conflicts:
        raise typer.Exit(1)
