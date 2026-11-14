"""Replay diagnostics over reader-supplied values; no clocks or engine execution."""

import json
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

from transit_ops.batch.build import FamilyBuilder, FamilyOutput
from transit_ops.batch.compare import BodyDifference, RowDifference, compare_bodies, compare_tables
from transit_ops.batch.run import BuildResult


@dataclass(frozen=True)
class FamilyReplay:
    family_id: str
    status: Literal["identical", "different", "not_implemented", "not_compared"]
    build_id: str | None
    postgres_rows: dict[str, int]
    duckdb_rows: dict[str, int] | None
    differences: tuple[RowDifference | BodyDifference, ...] = ()
    reason: str | None = None


def compare_family(
    family_id: str,
    builder: FamilyBuilder | None,
    postgres: FamilyOutput,
    duckdb: BuildResult | None,
    *,
    bodies_loaded: bool,
) -> FamilyReplay:
    """Compare tables then bodies, retaining at most fifty ordered diagnostics."""
    replay = FamilyReplay(
        family_id,
        "not_implemented" if builder is None else "not_compared",
        duckdb.manifest.build_id if duckdb is not None else None,
        {name: len(table.rows) for name, table in postgres.tables.items()},
        None
        if duckdb is None
        else {name: len(table.rows) for name, table in duckdb.output.tables.items()},
    )
    if builder is None:
        return replay
    reason = (
        "rollup history not loaded"
        if builder.published_keys and not bodies_loaded
        else "DuckDB build not available"
        if duckdb is None
        else None
    )
    if reason is not None:
        return replace(replay, reason=reason)
    assert duckdb is not None
    differences = _differences(postgres, duckdb.output)
    return replace(
        replay,
        status="different" if differences else "identical",
        differences=tuple(differences[:50]),
    )


def _differences(
    postgres: FamilyOutput, duckdb: FamilyOutput
) -> list[RowDifference | BodyDifference]:
    differences: list[RowDifference | BodyDifference] = []
    for name in sorted(postgres.tables.keys() | duckdb.tables.keys()):
        left, right = postgres.tables.get(name), duckdb.tables.get(name)
        if left is None or right is None:
            differences.append(
                RowDifference(
                    name,
                    (),
                    "extra" if left is None else "missing",
                    None,
                    None if left is None else left.columns,
                    None if right is None else right.columns,
                )
            )
        else:
            differences.extend(compare_tables(left, right))
    differences.extend(compare_bodies(postgres.bodies, duckdb.bodies))
    return differences


def _json_value(value: object) -> object:
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, (Decimal, timedelta)):
        return str(value)
    if isinstance(value, bytes):
        return {"bytes_hex": value.hex()}
    if isinstance(value, type):
        return f"{value.__module__}.{value.__qualname__}"
    raise TypeError(f"unsupported replay value: {type(value).__name__}")


@dataclass(frozen=True)
class ReplayReport:
    provider_id: str
    local_date: date
    as_of_utc: datetime
    code_commit: str
    duckdb_version: str
    # Paths relative to the input root, paired with the hashes of those files.
    input_files: tuple[tuple[str, str], ...]
    families: tuple[FamilyReplay, ...]
    postgres_seconds: float | None = None
    duckdb_seconds: float | None = None

    def __post_init__(self) -> None:
        for path, _ in self.input_files:
            if (
                not path
                or PureWindowsPath(path).drive
                or "\\" in path
                or PurePosixPath(path).is_absolute()
                or ".." in PurePosixPath(path).parts
            ):
                raise ValueError("input_files require paths relative to the input root")

    def to_json(self, *, timings: bool = False) -> bytes:
        payload = asdict(self)
        payload["input_files"] = sorted(self.input_files)
        payload["families"] = [asdict(f) for f in sorted(self.families, key=lambda f: f.family_id)]
        if not timings:
            del payload["postgres_seconds"], payload["duckdb_seconds"]
        return json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=_json_value,
        ).encode("utf-8")

    def exit_code(self) -> int:
        return 2 if any(f.status == "different" for f in self.families) else 0
