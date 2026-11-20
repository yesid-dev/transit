"""Part-file layouts for CSV windows whose rows are too wide for the codec budget.

DuckDB's CSV reader emits chunks of up to 2,048 rows whatever the buffer size, and its
Parquet writer closes a row group only between chunks. Rows near a megabyte therefore
cannot be bounded by a smaller ``ROW_GROUP_SIZE``: one chunk alone is over the 256 MiB
codec budget, in the writer and in every verifier scan that reads the CSV. Wide windows
are read through small part files instead, so each chunk, each row group and each
verifier slice stays near a fixed byte target.

Everything here is a pure function of the CSV bytes and the requested group size, so a
re-run chooses the same layout. Windows that are not wide are left untouched and keep
their legacy bytes.

Byte-identity boundary: a window takes the part-file path only when one of its 2,048-row
chunks exceeds ``WIDE_CHUNK_BYTES`` or a default-size group exceeds ``WIDE_WINDOW_BYTES``.
Measured against the 256 MiB codec on DuckDB 2.0.0: groups up to about 57 MB of
~580 KB rows write, 75 MB fails; narrow-row groups of 71 MB and compressible JSONB groups
of 77 MiB write and verify, while ordinary rows from about 82 MiB per group fail in the
writer or the verifier. Every window below both thresholds keeps its legacy layout and
bytes.
"""

import re
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

CHUNK_ROWS: Final = 2048
# One reader chunk above this is far over what the codec buffers (about 57 MB of wide
# rows passed, 75 MB failed), and below it ordinary windows keep their legacy path.
WIDE_CHUNK_BYTES: Final = 32 * 1024**2
# Groups above this did not write and verify in the codec budget, whatever their row
# width; the largest known group that did was 77 MiB of compressible JSONB.
WIDE_WINDOW_BYTES: Final = 76 * 1024**2
# Target CSV bytes per part, and so per row group and per verifier slice.
TARGET_GROUP_BYTES: Final = 16 * 1024**2
# One record above this is refused by name; larger ones did not fit the budget.
MAX_RECORD_BYTES: Final = 32 * 1024**2

_MARKS = re.compile(rb'["\n]')


class RecordTooWide(ValueError):
    """A single CSV record is too wide to write or verify within the codec budget."""

    reason = "record_too_wide"

    def __init__(self, record_bytes: int) -> None:
        self.record_bytes = record_bytes
        super().__init__(
            f"{self.reason}: a record of {record_bytes} bytes exceeds {MAX_RECORD_BYTES}"
        )


@dataclass(frozen=True)
class WindowShape:
    max_record_bytes: int
    max_chunk_bytes: int
    max_window_bytes: int

    @property
    def wide(self) -> bool:
        return self.max_chunk_bytes > WIDE_CHUNK_BYTES or self.max_window_bytes > WIDE_WINDOW_BYTES


@dataclass(frozen=True)
class Layout:
    """Part files covering the data records in order, each repeating the header."""

    parts: tuple[Path, ...]
    rows: tuple[int, ...]

    @property
    def row_group_rows(self) -> int:
        return max(self.rows, default=1)

    def spans(self) -> Iterator[tuple[Path, int, int]]:
        start = 0
        for part, rows in zip(self.parts, self.rows, strict=True):
            yield part, start, start + rows
            start += rows


def _pieces(path: Path) -> Iterator[tuple[bytes, bool]]:
    """Yield CSV bytes in order, flagging the piece that ends a record."""
    quoted = False
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            start = 0
            for match in _MARKS.finditer(block):
                if match[0] == b'"':
                    quoted = not quoted
                elif not quoted:
                    yield block[start : match.end()], True
                    start = match.end()
            if start < len(block):
                yield block[start:], False


def _records(path: Path) -> Iterator[tuple[int, int]]:
    """Yield (index, byte length) of each data record, the header excluded."""
    size, index, header = 0, 0, True
    for piece, ends in _pieces(path):
        size += len(piece)
        if not ends:
            continue
        if header:
            header = False
        else:
            yield index, size
            index += 1
        size = 0
    if size and not header:  # last record without a final newline
        yield index, size


def measure(path: Path, window_rows: int) -> WindowShape:
    """Widest record, widest reader chunk and widest default-size group."""
    widest = chunk = window = chunk_widest = window_widest = 0
    for index, size in _records(path):
        widest = max(widest, size)
        chunk += size
        window += size
        if (index + 1) % CHUNK_ROWS == 0:
            chunk_widest, chunk = max(chunk_widest, chunk), 0
        if (index + 1) % window_rows == 0:
            window_widest, window = max(window_widest, window), 0
    return WindowShape(widest, max(chunk_widest, chunk), max(window_widest, window))


def _whole_records(path: Path) -> Iterator[bytes]:
    """Yield each record's bytes, the header first. Holds one record at a time."""
    pending: list[bytes] = []
    for piece, ends in _pieces(path):
        pending.append(piece)
        if ends:
            yield b"".join(pending)
            pending.clear()
    if pending:  # last record without a final newline
        yield b"".join(pending)


def split(path: Path, directory: Path, max_rows: int) -> Layout:
    """Copy the CSV into part files of at most ``max_rows`` records and the byte target.

    A part closes before the record that would pass ``TARGET_GROUP_BYTES``; a record
    wider than the target gets a part of its own.
    """
    max_rows = min(max_rows, CHUNK_ROWS)
    parts: list[Path] = []
    counts: list[int] = []
    records = _whole_records(path)
    header = next(records, b"")
    target = None
    size = 0
    try:
        for record in records:
            if target is not None and (
                counts[-1] >= max_rows or size + len(record) > TARGET_GROUP_BYTES
            ):
                target.close()
                target = None
            if target is None:
                parts.append(directory / f"part-{len(parts):06d}.csv")
                counts.append(0)
                target = parts[-1].open("wb")
                target.write(header)
                size = 0
            target.write(record)
            size += len(record)
            counts[-1] += 1
    finally:
        if target is not None:
            target.close()
    return Layout(tuple(parts), tuple(counts))


@contextmanager
def window_layout(path: Path, directory: Path, window_rows: int) -> Iterator[Layout | None]:
    """The part layout for a wide window, or None for one that keeps the legacy path.

    Raises ``RecordTooWide`` for a wide window holding a record over the ceiling.
    """
    # No chunk can exceed the threshold in a file smaller than it.
    if path.stat().st_size <= WIDE_CHUNK_BYTES:
        yield None
        return
    shape = measure(path, window_rows)
    if not shape.wide:
        yield None
        return
    if shape.max_record_bytes > MAX_RECORD_BYTES:
        raise RecordTooWide(shape.max_record_bytes)
    with TemporaryDirectory(prefix=".transit-parts-", dir=directory) as parts:
        yield split(path, Path(parts), window_rows)
