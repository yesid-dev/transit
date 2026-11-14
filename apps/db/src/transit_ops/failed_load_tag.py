"""Capture provenance for persisted Silver failures, independent of database imports."""

import re

_PREFIX = re.compile(r"\A\[capture_row_id=([1-9][0-9]{0,18})\] ")
_MAX_ID = 9223372036854775807


def format_failed_load_error(error_message: str, capture_row_id: int) -> str:
    if type(capture_row_id) is not int or not 1 <= capture_row_id <= _MAX_ID:
        raise ValueError("capture_row_id must be a positive BIGINT")
    return f"[capture_row_id={capture_row_id}] {error_message}"


def parse_failed_load_capture_row_id(error_message: str | None) -> int | None:
    match = _PREFIX.match(error_message) if error_message else None
    if match is None:
        return None
    capture_row_id = int(match[1])
    return capture_row_id if capture_row_id <= _MAX_ID else None
