"""Row-group sizing for CSV windows whose rows are too wide for the writer budget.

DuckDB's Parquet writer closes a row group only at a source-chunk boundary, and the
CSV reader emits up to 2,048 rows per chunk whatever ``ROW_GROUP_SIZE`` says. Rows near
a megabyte therefore cannot be bounded by a smaller group size: one chunk alone is
over the codec's memory budget. Wide windows are fed through small part files instead,
so each chunk, and the row group written from it, stays near a fixed byte target.

Everything here is a pure function of the CSV bytes and the default group size, so a
re-run chooses the same layout. Windows below the threshold are left untouched.
"""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Final

# A default-size row group above this many CSV bytes cannot be buffered by the 256 MiB
# codec connection (measured: about 57 MB passes, about 75 MB fails). Smaller windows
# keep the legacy layout so existing object bytes and digests stay valid.
WIDE_WINDOW_BYTES: Final = 64 * 1024**2
# Target CSV bytes per row group (and part file) for wide windows.
TARGET_GROUP_BYTES: Final = 16 * 1024**2

_MARKS = re.compile(rb'["\n]')


@dataclass(frozen=True)
class WindowShape:
    max_record_bytes: int
    max_window_bytes: int


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


def measure(path: Path, window_rows: int) -> WindowShape:
    """Widest data record, and widest run of ``window_rows`` records from the first."""
    widest = window_widest = window = size = records = 0
    header = True
    for piece, ends in _pieces(path):
        size += len(piece)
        if not ends:
            continue
        if header:
            header = False
        else:
            widest = max(widest, size)
            window += size
            records += 1
            if records == window_rows:
                window_widest = max(window_widest, window)
                window = records = 0
        size = 0
    if size:  # last record without a final newline
        widest = max(widest, size)
        window += size
    return WindowShape(widest, max(window_widest, window))


def rows_per_group(shape: WindowShape, default_rows: int) -> int:
    """The default size for ordinary windows; a byte-targeted size for wide ones."""
    if shape.max_window_bytes <= WIDE_WINDOW_BYTES:
        return default_rows
    return max(1, min(default_rows, TARGET_GROUP_BYTES // shape.max_record_bytes))


def split(path: Path, directory: Path, rows: int) -> list[Path]:
    """Copy the CSV into part files of ``rows`` records, each repeating the header."""
    parts: list[Path] = []
    header = b""
    target = None
    count = 0
    pending = b""
    first = True
    try:
        for piece, ends in _pieces(path):
            if first:
                pending += piece
                if ends:
                    header, first = pending, False
                    pending = b""
                continue
            if target is None:
                parts.append(directory / f"part-{len(parts):06d}.csv")
                target = parts[-1].open("wb")
                target.write(header)
                count = 0
            target.write(piece)
            if ends:
                count += 1
                if count == rows:
                    target.close()
                    target = None
    finally:
        if target is not None:
            target.close()
    return parts
