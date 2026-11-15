"""Current schedule selection shared by live PostgreSQL and verified replay inputs."""

from collections.abc import Iterable, Sequence
from dataclasses import replace
from datetime import date
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
