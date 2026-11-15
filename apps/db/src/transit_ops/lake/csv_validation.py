"""Refuse malformed records and values that cannot survive a typed CSV read."""

import csv
import re
from collections.abc import Iterable, Iterator
from pathlib import Path

import duckdb

from transit_ops.lake.table_schema import TableSchema

# PostgreSQL Appendix K: maximum field size is 1 GB (1 GiB).
# https://www.postgresql.org/docs/current/limits.html
POSTGRES_MAX_FIELD_SIZE = 1024**3

CSV_OPTIONS = (
    "auto_detect=false, header=true, delim=',', quote='\"', escape='\"', nullstr='', "
    "allow_quoted_nulls=false, strict_mode=true, ignore_errors=false, hive_partitioning=false, "
    # Up to 1,664 result columns, with every byte doubled by CSV quote escaping,
    # plus enclosing quotes and separators. This is a ceiling, not an allocation.
    f"max_line_size={1664 * (2 * POSTGRES_MAX_FIELD_SIZE + 3)}"
)


def csv_options(path: Path) -> str:
    """Size the reader buffer for the largest record, not the whole file.

    Count CSV record bytes in bounded chunks; doubled quotes toggle twice.
    PostgreSQL's field ceiling remains a validation rule, not an allocation.
    """
    largest, size, quoted = 2 * 1024**2, 0, False
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            start = 0
            for match in re.finditer(b'["\\n]', block):
                size += match.end() - start
                start = match.end()
                if match[0] == b'"':
                    quoted = not quoted
                elif not quoted:
                    largest = max(largest, size)
                    size = 0
            size += len(block) - start
    largest = max(largest, size)
    return re.sub(r"max_line_size=[0-9]+", f"max_line_size={largest}", CSV_OPTIONS)


class InvalidCsvValue(ValueError):
    """A CSV record or column value is malformed or unsupported."""

    def __init__(self, column: str, row: int, value: object) -> None:
        self.column, self.row, self.value = column, row, value
        super().__init__(f"Column {column!r}, row {row}, value {value!r}: invalid CSV value")


def _oversize_column(record: list[str], columns: tuple[str, ...]) -> str:
    # Only completed fields precede the oversized field, including quoted newlines.
    return columns[len(record)] if len(record) < len(columns) else "<record>"


def _records(source: Iterable[str], columns: tuple[str, ...]) -> Iterator[list[str]]:
    # Local CSV state never reads or changes csv.field_size_limit(), so concurrent
    # readers retain their own process policy. Retain at most one logical record.
    record: list[str] = []
    parts: list[str] = []
    state, size, row = "start", 0, 1
    for line in source:
        for match in re.finditer(r'[^",\r\n]+|\r\n|.', line, re.DOTALL):
            token = match[0]
            if state != "quoted" and token in {",", "\n", "\r", "\r\n"}:
                if token == "," or record or parts or state != "start":
                    record.append("".join(parts))
                parts, size, state = [], 0, "start"
                if token != ",":
                    yield record
                    record = []
                    row += 1
                continue
            if token == '"' and state != "bare":
                if state == "quoted":
                    state = "end"
                    continue
                if state == "start":
                    state = "quoted"
                    continue
                state = "quoted"  # doubled quote inside a quoted field
            elif state == "end":
                raise csv.Error("',' expected after '\"'")
            elif state == "start":
                state = "bare"
            size += len(token.encode("utf-8"))
            if size > POSTGRES_MAX_FIELD_SIZE:
                raise InvalidCsvValue(
                    _oversize_column(record, columns),
                    row,
                    f"field larger than field limit ({POSTGRES_MAX_FIELD_SIZE})",
                )
            parts.append(token)
    if state == "quoted":
        raise csv.Error("unexpected end of data")
    if record or parts or state != "start":
        yield [*record, "".join(parts)]


def _record_shapes(path: Path, columns: tuple[str, ...]) -> None:
    with path.open(encoding="utf-8", newline="") as source:
        reader = _records(source, columns)
        row = 1
        try:
            for record in reader:
                if row > 1 and len(record) != len(columns):
                    raise InvalidCsvValue("<record>", row, tuple(record))
                # A leading value must not be mistaken for a byte-order mark.
                if row == 2 and record[0].startswith("\ufeff"):
                    raise InvalidCsvValue(columns[0], row, record[0])
                row += 1
        except csv.Error as error:
            raise InvalidCsvValue("<record>", row, str(error)) from error
        except UnicodeError as error:
            raise InvalidCsvValue("<record>", row, str(error)) from error


def _tokens(values: list[str | None], kind: str, column: str, start: int) -> None:
    for offset, value in enumerate(values):
        if value is None:
            continue
        invalid = (
            (kind in {"SMALLINT", "INTEGER", "BIGINT"} and not re.fullmatch(r"-?[0-9]+", value))
            or (kind.startswith(("DATE", "TIMESTAMP")) and value.upper().endswith(" BC"))
            or (
                kind.startswith("DECIMAL")
                and value.casefold().lstrip("+-") in {"nan", "infinity", "inf"}
            )
        )
        if invalid:
            raise InvalidCsvValue(column, start + offset, value)


def _batch(
    connection: duckdb.DuckDBPyConnection,
    rows: list[tuple[object, ...]],
    types: dict[str, str],
    start: int,
) -> None:
    for index, (column, kind) in enumerate(types.items()):
        if kind == "VARCHAR":
            continue
        values = [None if row[index] is None else str(row[index]) for row in rows]
        _tokens(values, kind, column, start)
        invalid = connection.execute(
            f"SELECT ordinal, value FROM unnest(?) WITH ORDINALITY AS t(value, ordinal) "
            f"WHERE value IS NOT NULL AND TRY_CAST(value AS {kind}) IS NULL "
            "ORDER BY ordinal LIMIT 1",
            [values],
        ).fetchone()
        if invalid:
            raise InvalidCsvValue(column, start + int(invalid[0]) - 1, invalid[1])


def validate_csv(connection: duckdb.DuckDBPyConnection, path: Path, schema: TableSchema) -> None:
    if any(character in str(path) for character in "*?[]{}"):
        raise ValueError(f"Glob characters in path: {path}")
    types = schema.duckdb_types()
    _record_shapes(path, tuple(types))
    try:
        with connection.cursor() as source, connection.cursor() as checker:
            source.execute(
                f"SELECT * FROM read_csv(?, columns=?, {csv_options(path)})",
                [str(path), dict.fromkeys(types, "VARCHAR")],
            )
            checker.execute("SET TimeZone='UTC'")
            row = 2
            while batch := source.fetchmany(4096):
                _batch(checker, batch, types, row)
                row += len(batch)
    except duckdb.Error as error:
        message = str(error)
        line = re.search(r"(?:Line|line):? (\d+)", message)
        column = re.search(r'column "([^"]+)"', message)
        raise InvalidCsvValue(
            column[1] if column else "<record>", int(line[1]) if line else 2, message
        ) from error
