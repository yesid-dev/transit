"""Deterministic replay evidence over the exact values supplied by the reader."""

import json
import math
import re
from dataclasses import asdict, dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

import duckdb

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
    code_commit: str | None = None
    engine_version: str | None = None
    difference_count: int = 0


def compare_family(
    family_id: str,
    builder: FamilyBuilder | None,
    postgres: FamilyOutput,
    duckdb: BuildResult | None,
    *,
    bodies_loaded: bool,
) -> FamilyReplay:
    if builder is None and duckdb is not None:
        raise ValueError(f"{family_id}: builder missing for build")
    if builder is not None and builder.family_id != family_id:
        raise ValueError(f"{family_id}: builder.family_id mismatch")
    manifest = duckdb.manifest if duckdb is not None else None
    if manifest is not None and manifest.family_id != family_id:
        raise ValueError(f"{family_id}: manifest.family_id mismatch")
    skipped = builder is not None and builder.published_keys and not bodies_loaded
    if builder is not None and duckdb is None and not skipped:
        raise ValueError(f"{family_id}: duckdb build missing")
    replay = FamilyReplay(
        family_id,
        "not_implemented" if builder is None else "not_compared",
        manifest.build_id if manifest else None,
        {n: len(t.rows) for n, t in postgres.tables.items()},
        {n: len(t.rows) for n, t in duckdb.output.tables.items()} if duckdb else None,
        code_commit=manifest.code_commit if manifest else None,
        engine_version=manifest.engine_version if manifest else None,
    )
    if builder is None:
        return replay
    if skipped:
        return replace(replay, reason="rollup history not loaded")
    assert duckdb is not None
    differences = _differences(postgres, duckdb.output)
    return replace(
        replay,
        status="different" if differences else "identical",
        differences=tuple(differences[:50]),
        difference_count=len(differences),
    )


def _differences(left: FamilyOutput, right: FamilyOutput) -> list[RowDifference | BodyDifference]:
    differences: list[RowDifference | BodyDifference] = []
    for name in sorted(left.tables.keys() | right.tables.keys()):
        a, b = left.tables.get(name), right.tables.get(name)
        if a is None or b is None:
            differences.append(
                RowDifference(
                    name,
                    (),
                    "columns",
                    None,
                    (a.relation, a.columns, a.key) if a else None,
                    (b.relation, b.columns, b.key) if b else None,
                )
            )
        else:
            differences.extend(compare_tables(a, b))
    return differences + compare_bodies(left.bodies, right.bodies)


def _value(value: object) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        return {"float": "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"}
    if isinstance(value, Decimal):
        sign, digits, exponent = value.as_tuple()
        names = {"n": "NaN", "N": "sNaN", "F": "Infinity"}
        return {
            "decimal": {
                "sign": sign,
                "digits": digits,
                "exponent": names[exponent] if isinstance(exponent, str) else exponent,
            }
        }
    if isinstance(value, datetime):
        return {"datetime": value.isoformat(), "fold": value.fold}
    if isinstance(value, date):
        return {"date": value.isoformat()}
    if isinstance(value, time):
        return {
            "time": value.isoformat(),
            "tz": value.tzinfo is not None,
            "utcoffset": _value(value.utcoffset()),
        }
    if isinstance(value, timedelta):
        return {"timedelta": (value.days * 86400 + value.seconds) * 1000000 + value.microseconds}
    if isinstance(value, bytes):
        return {"bytes_hex": value.hex()}
    if isinstance(value, type):
        return {"type": f"{value.__module__}.{value.__qualname__}"}
    if isinstance(value, (tuple, list)):
        items = [_value(v) for v in value]
        return {"tuple": items} if isinstance(value, tuple) else items
    if isinstance(value, dict):
        pairs = [[_value(k), _value(v)] for k, v in value.items()]
        return {"dict": sorted(pairs, key=lambda pair: json.dumps(pair[0], sort_keys=True))}
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"unsupported replay value: {type(value).__name__}")


@dataclass(frozen=True)
class ReplayReport:
    provider_id: str
    local_date: date
    as_of_utc: datetime
    code_commit: str
    duckdb_version: str = duckdb.__version__
    input_files: tuple[tuple[str, str], ...] = ()
    families: tuple[FamilyReplay, ...] = ()
    postgres_seconds: float | None = None
    duckdb_seconds: float | None = None

    def __post_init__(self) -> None:
        if self.as_of_utc.utcoffset() is None:
            raise ValueError("as_of_utc must be aware")
        object.__setattr__(self, "as_of_utc", self.as_of_utc.astimezone(UTC))
        if not re.fullmatch(r"[0-9a-f]{40}", self.code_commit):
            raise ValueError("code_commit must be 40 lowercase hex characters")
        ids = [f.family_id for f in self.families]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate family_id")
        for family in self.families:
            if family.build_id is not None:
                if family.code_commit != self.code_commit:
                    raise ValueError(f"{family.family_id}: code_commit differs from manifest")
                if family.engine_version != self.duckdb_version:
                    raise ValueError(f"{family.family_id}: engine_version differs from manifest")
        paths = [p for p, _ in self.input_files]
        if len(set(paths)) != len(paths):
            raise ValueError("input_files: duplicate path")
        for path, digest in self.input_files:
            posix = PurePosixPath(path)
            if (
                not path
                or PureWindowsPath(path).drive
                or "\\" in path
                or posix.is_absolute()
                or path != posix.as_posix()
                or any(p in {".", ".."} for p in path.split("/"))
            ):
                raise ValueError(f"input_files: noncanonical relative path {path!r}")
            if not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError(f"input_files: {path}: sha256 must be 64 lowercase hex characters")

    def to_json(self, *, timings: bool = False) -> bytes:
        payload = asdict(self)
        payload["as_of_utc"] = self.as_of_utc.isoformat(timespec="microseconds").replace(
            "+00:00", "Z"
        )
        payload["local_date"] = self.local_date.isoformat()
        payload["input_files"] = sorted(self.input_files)
        payload["families"] = [asdict(f) for f in sorted(self.families, key=lambda f: f.family_id)]
        for family in payload["families"]:
            for difference in family["differences"]:
                for field in ("key", "expected", "actual"):
                    difference[field] = _value(difference[field])
        if not timings:
            del payload["postgres_seconds"], payload["duckdb_seconds"]
        return json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")

    def exit_code(self) -> int:
        """0 means no differences; completeness also requires all expected families identical."""
        return 2 if any(f.status == "different" for f in self.families) else 0
