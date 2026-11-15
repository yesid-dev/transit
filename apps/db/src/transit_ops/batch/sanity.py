"""Exact math checks and the shared checked-build boundary."""

import math
from collections import defaultdict
from dataclasses import dataclass, replace
from decimal import Decimal
from fractions import Fraction
from typing import Literal

from transit_ops.batch.build import FamilyOutput


def canonical_float(value: float) -> str:
    """Comparison form only; a string avoids overflowing a finite maximum double."""
    return format(value, ".12g") if value else "0"


@dataclass(frozen=True)
class Invariant:
    table: str
    kind: Literal["count", "rate", "sum", "percentiles", "duration"]
    columns: tuple[str, ...]
    name: str = ""
    precision: int = 12  # Rate column's decimal places.
    total_table: str | None = None
    total_column: str | None = None
    group_by: tuple[str, ...] = ()


def count_columns(invariants: tuple[Invariant, ...]) -> dict[str, frozenset[str]]:
    """Count semantics follow declarations, independently of rule order or SQL type."""
    columns: dict[str, frozenset[str]] = {}
    for rule in invariants:
        if rule.kind == "count":
            columns[rule.table] = columns.get(rule.table, frozenset()) | frozenset(rule.columns)
    return columns


def _number(value) -> Fraction:
    return Fraction(value)


def _sum_matches(total, parts, *, exact: bool = False) -> bool:
    if not exact and isinstance(total, float) and all(isinstance(v, float) for v in parts):
        return canonical_float(total) == canonical_float(math.fsum(parts))
    return _number(total) == sum((_number(v) for v in parts), Fraction())


def _rate(rule: Invariant, values: list) -> bool:
    rate, numerator, denominator = values
    if numerator is None or denominator is None:
        return rate is None
    n, d = _number(numerator), _number(denominator)
    if not 0 <= n <= d:
        return False
    if d == 0:
        return rate is None
    if rate is None or not 0 <= _number(rate) <= 1:
        return False
    derived = Fraction(round(n / d * 10**rule.precision), 10**rule.precision)
    if isinstance(rate, float):
        return canonical_float(rate) == canonical_float(float(derived))
    return _number(rate) == derived


def _valid(rule: Invariant, values: list, *, exact: bool = False) -> bool:
    if rule.kind == "percentiles":
        present = [_number(v) for v in values if v is not None]
        return all(a <= b for a, b in zip(present, present[1:], strict=False))
    if rule.kind == "rate":
        return _rate(rule, values)
    if any(v is None for v in values):
        return False
    if rule.kind == "sum":
        return _sum_matches(values[0], values[1:], exact=exact)
    if rule.kind == "count":
        return all(
            _number(v) >= 0
            and _number(v).denominator == 1
            and (not isinstance(v, float) or v <= 2**53)
            for v in values
        )
    return all(_number(v) >= 0 for v in values)


def _grouped(output: FamilyOutput, rule: Invariant, *, exact: bool = False) -> None:
    parts, totals = defaultdict(list), {}
    for row in output.tables[rule.table].rows:
        data = dict(zip(output.tables[rule.table].columns, row, strict=True))
        parts[tuple(data[c] for c in rule.group_by)].extend(data[c] for c in rule.columns)
    total = output.tables[rule.total_table]
    for row in total.rows:
        data = dict(zip(total.columns, row, strict=True))
        key = tuple(data[c] for c in rule.group_by)
        if key in totals:
            raise ValueError(
                f"{rule.table} key={key!r} invariant={rule.name or rule.kind}: duplicate total"
            )
        totals[key] = data[rule.total_column]
    for key in parts.keys() | totals.keys():
        values = parts.get(key)
        if (
            values is None
            or key not in totals
            or totals[key] is None
            or any(v is None for v in values)
            or not _sum_matches(totals[key], values, exact=exact)
        ):
            raise ValueError(f"{rule.table} key={key!r} invariant={rule.name or rule.kind}")


def check_output(output: FamilyOutput, invariants: tuple[Invariant, ...] = ()) -> None:
    """Refuse by table, primary key and invariant; missing values stay missing."""
    for table in output.tables.values():
        for row in table.rows:
            data = dict(zip(table.columns, row, strict=True))
            key = tuple(data[c] for c in table.key)
            for column, value in data.items():
                failure = None
                if (isinstance(value, float) and not math.isfinite(value)) or (
                    isinstance(value, Decimal) and not value.is_finite()
                ):
                    failure = "finite"
                elif isinstance(value, float) and value == 0 and math.copysign(1, value) < 0:
                    failure = "negative_zero"
                elif isinstance(value, str) and "\x00" in value:
                    failure = "nul"
                if failure:
                    raise ValueError(
                        f"{table.relation} key={key!r} invariant={failure} column={column}"
                    )
    counts = count_columns(invariants)
    for rule in invariants:
        try:
            exact = bool(set(rule.columns) & counts.get(rule.table, frozenset()))
            if rule.total_table:
                exact = exact or rule.total_column in counts.get(rule.total_table, frozenset())
                _grouped(output, rule, exact=exact)
                continue
            table = output.tables[rule.table]
            for row in table.rows:
                data = dict(zip(table.columns, row, strict=True))
                key = tuple(data[c] for c in table.key)
                if not _valid(rule, [data[c] for c in rule.columns], exact=exact):
                    raise ValueError(f"{rule.table} key={key!r} invariant={rule.name or rule.kind}")
        except (KeyError, TypeError, ArithmeticError) as error:
            raise ValueError(f"{rule.table} invariant={rule.name or rule.kind}: {error}") from error


def build_checked(builder, session, request) -> FamilyOutput:
    """Every wrapper invokes this boundary for its wrapped builder as well."""
    output = builder.build(session, request)
    output = replace(
        output,
        tables={
            name: replace(
                table,
                rows=tuple(
                    tuple(0.0 if isinstance(v, float) and v == 0 else v for v in row)
                    for row in table.rows
                ),
            )
            for name, table in output.tables.items()
        },
    )
    check_output(output, getattr(builder, "invariants", ()))
    return output
