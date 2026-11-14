"""Strict engine parity checks; diagnostics never relax equality."""

import json
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import MappingProxyType
from typing import Literal

from transit_ops.batch.build import TableRows

RUNTIME_ONLY_COLUMNS: Mapping[str, frozenset[str]] = MappingProxyType(
    {
        "gold.route_delay_hourly": frozenset({"built_at_utc"}),
        "gold.warm_rollup_periods": frozenset({"built_at_utc", "invalidated_at_utc"}),
    }
)
# Readiness predicate: gold/delay_periods.py:120,160 (batch ruling R19).
_WARM_FLAG = "built_after_period"


@dataclass(frozen=True)
class BodyDifference:
    key: str
    kind: Literal["missing", "extra", "bytes"]
    path: str | None
    expected: str | None
    actual: str | None


@dataclass(frozen=True)
class RowDifference:
    relation: str
    key: tuple[object, ...]
    kind: Literal["missing", "extra", "value", "type", "columns"]
    column: str | None
    expected: object
    actual: object


@dataclass(frozen=True)
class _JsonNumber:
    spelling: str


def _invalid_constant(value: str) -> object:
    raise ValueError(f"not a JSON number: {value}")


def _parse_body(body: bytes) -> object:
    return json.loads(
        body, parse_float=_JsonNumber, parse_int=_JsonNumber, parse_constant=_invalid_constant
    )


def _identity(value: object) -> object:
    """Retain representations Python equality would otherwise collapse."""
    if isinstance(value, float):
        return type(value), struct.pack("<d", value)
    if isinstance(value, Decimal):
        return type(value), value.as_tuple()
    if isinstance(value, datetime):
        offset = value.utcoffset()
        instant = value if offset is None else value.astimezone(UTC)
        return type(value), instant.isoformat(), offset, instant.fold
    if isinstance(value, (list, tuple)):
        return type(value), tuple(_identity(item) for item in value)
    if isinstance(value, dict):
        return type(value), frozenset((_identity(k), _identity(v)) for k, v in value.items())
    return type(value), value


def _json_path(left: object, right: object, path: str = "$") -> str | None:
    if type(left) is not type(right):
        return path
    if isinstance(left, dict) and isinstance(right, dict):
        for key in dict.fromkeys((*left, *right)):
            child = f"{path}.{key}" if key.isidentifier() else f"{path}[{json.dumps(key)}]"
            if key not in left or key not in right:
                return child
            difference = _json_path(left[key], right[key], child)
            if difference is not None:
                return difference
        return None
    if isinstance(left, list) and isinstance(right, list):
        for index in range(max(len(left), len(right))):
            child = f"{path}[{index}]"
            if index >= len(left) or index >= len(right):
                return child
            difference = _json_path(left[index], right[index], child)
            if difference is not None:
                return difference
        return None
    return None if _identity(left) == _identity(right) else path


def compare_bodies(
    expected: Mapping[str, bytes], actual: Mapping[str, bytes]
) -> list[BodyDifference]:
    differences = []
    for key in sorted(expected.keys() | actual.keys()):
        left, right = expected.get(key), actual.get(key)
        if left == right:
            continue
        path = None
        if left is not None and right is not None:
            try:
                # Preserve number spelling for diagnostics, including exponents.
                path = _json_path(_parse_body(left), _parse_body(right)) or "$"
            except (ValueError, UnicodeError, RecursionError):
                pass
        differences.append(
            BodyDifference(
                key,
                "extra" if left is None else "missing" if right is None else "bytes",
                path,
                None if left is None else left.decode("utf-8", errors="backslashreplace"),
                None if right is None else right.decode("utf-8", errors="backslashreplace"),
            )
        )
    return differences


def _project(table: TableRows) -> tuple[tuple[str, ...], list[tuple[object, ...]]]:
    ignored = RUNTIME_ONLY_COLUMNS.get(table.relation, frozenset())
    columns = table.columns
    rows = [
        tuple(
            "<runtime>" if name in ignored and value is not None else value
            for name, value in zip(columns, row, strict=True)
        )
        for row in table.rows
    ]
    if table.relation == "gold.warm_rollup_periods":
        rows = [
            (
                *masked,
                _warm_flag(
                    row[columns.index("built_at_utc")], row[columns.index("period_start_utc")]
                ),
            )
            for row, masked in zip(table.rows, rows, strict=True)
        ]
        columns += (_WARM_FLAG,)
    return columns, rows


def _warm_flag(built: object, period: object) -> bool | None:
    if built is None or period is None:
        return None
    if not isinstance(built, datetime) or not isinstance(period, datetime):
        raise ValueError("gold.warm_rollup_periods: built_at_utc/period_start_utc need datetime")
    return built.astimezone(UTC) >= period.astimezone(UTC) + timedelta(minutes=5)


def compare_tables(expected: TableRows, actual: TableRows) -> list[RowDifference]:
    shape = expected.relation, expected.columns, expected.key
    other_shape = actual.relation, actual.columns, actual.key
    required = RUNTIME_ONLY_COLUMNS.get(expected.relation, frozenset())
    if expected.relation == "gold.warm_rollup_periods":
        required = required | {"period_start_utc"}
    if (
        shape != other_shape
        or not required <= set(expected.columns)
        or set(expected.key) & RUNTIME_ONLY_COLUMNS.get(expected.relation, frozenset())
    ):
        return [RowDifference(expected.relation, (), "columns", None, shape, other_shape)]
    columns, left_rows = _project(expected)
    _, right_rows = _project(actual)
    indexes = [columns.index(name) for name in expected.key]
    left = {_identity(tuple(row[i] for i in indexes)): row for row in left_rows}
    right = {_identity(tuple(row[i] for i in indexes)): row for row in right_rows}
    differences = []
    for identity in dict.fromkeys((*left, *right)):
        a, b = left.get(identity), right.get(identity)
        row = a if a is not None else b
        assert row is not None
        key = tuple(row[i] for i in indexes)
        if a is None or b is None:
            differences.append(
                RowDifference(
                    expected.relation, key, "extra" if a is None else "missing", None, a, b
                )
            )
            continue
        for column, x, y in zip(columns, a, b, strict=True):
            if _identity(x) != _identity(y):
                differences.append(
                    RowDifference(
                        expected.relation,
                        key,
                        "type" if type(x) is not type(y) else "value",
                        column,
                        x,
                        y,
                    )
                )
    return differences
