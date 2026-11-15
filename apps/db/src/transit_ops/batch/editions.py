"""Current schedule selection shared by live PostgreSQL and verified replay inputs."""

import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import replace
from datetime import date, datetime
from pathlib import Path

import duckdb
from sqlalchemy import Connection, text

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import FAMILIES

EditionRow = tuple[int, str, bool]


def current_edition_for_days(rows: Iterable[EditionRow], days: Sequence[date]) -> dict[date, int]:
    """Rows are provider-scoped; capture timestamps never define edition validity."""
    current = [ident for ident, kind, active in rows if kind == "static_schedule" and active]
    if len(current) != 1 or type(current[0]) is not int or current[0] <= 0:
        raise ValueError("edition_unresolved: expected exactly one current static_schedule edition")
    return dict.fromkeys(days, current[0])


def reads_editions(families: Iterable[str]) -> bool:
    return any(FAMILIES[name].reads_editions for name in families if name in FAMILIES)


def with_editions(
    request: BuildRequest, families: Iterable[str], rows: Iterable[EditionRow]
) -> BuildRequest:
    if not reads_editions(families):
        return request
    return replace(
        request,
        edition_by_day=current_edition_for_days(rows, request.local_dates),
        edition_source="current_at_build",
    )


def snapshot_rows(path: Path, provider: str) -> tuple[EditionRow, ...]:
    """Read the same digest-verified bootstrap object replay subsequently loads."""
    with duckdb.connect() as conn:
        return tuple(
            conn.execute(
                "SELECT dataset_version_id, dataset_kind, is_current "
                "FROM read_parquet(?, hive_partitioning=false) WHERE provider_id=?",
                [str(path), provider],
            ).fetchall()
        )


def replay_edition_request(
    request: BuildRequest, families: Sequence[str], inputs: Path, report: Path, code_commit: str
) -> BuildRequest:
    """Read this row's editions, pinned to the completed replay rather than its DB."""
    from transit_ops.batch.build import InputNeed
    from transit_ops.batch.inputs import resolve_inputs

    data = json.loads(report.read_bytes())
    if (
        data["provider_id"] != request.provider_id
        or data["local_date"] != request.local_dates[0].isoformat()
        or datetime.fromisoformat(data["as_of_utc"]) != request.as_of_utc
        or data["code_commit"] != code_commit
    ):
        raise ValueError("edition_input_changed: replay provenance")
    path = resolve_inputs((InputNeed("core.dataset_versions", "all"),), inputs)[0].files[0]
    relative = path.relative_to(inputs.resolve()).as_posix()
    expected = [digest for name, digest in data["input_files"] if name == relative]

    def verify() -> None:
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if expected != [actual]:
            raise ValueError("edition_input_changed: metadata differs from replay")

    verify()
    rows = snapshot_rows(path, request.provider_id)
    verify()
    return with_editions(request, families, rows)


def postgres_rows(conn: Connection, provider: str) -> tuple[EditionRow, ...]:
    return tuple(
        (row[0], row[1], row[2])
        for row in conn.execute(
            text(
                "SELECT dataset_version_id, dataset_kind, is_current "
                "FROM core.dataset_versions WHERE provider_id=:provider"
            ),
            {"provider": provider},
        )
    )
