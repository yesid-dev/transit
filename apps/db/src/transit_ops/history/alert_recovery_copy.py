"""A deliberately narrow native COPY language; dump SQL is never executable input."""

import re
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError

_TEXT = (
    "provider_id alert_id header_text header_text_en description_text description_text_en "
    "severity cause effect url url_en content_hash"
).split()
_TYPES = dict.fromkeys(_TEXT, "text") | {
    "archive_month": "date",
    "route_ids": "text[]",
    "stop_ids": "text[]",
    "active_periods": "jsonb",
    "message": "jsonb",
    **dict.fromkeys(
        ("start_utc", "end_utc", "first_seen_utc", "last_seen_utc", "updated_at_utc"), "timestamptz"
    ),
}
_OPTIONAL = ("url_en", "message")
_CAST = text("SELECT " + ", ".join(f"CAST(:{k} AS {v}) AS {k}" for k, v in _TYPES.items()))
_HEADER = re.compile(r"COPY gold\.alert_archive_entry \(([a-z_, ]+)\) FROM stdin;")
_SET = re.compile(
    r"SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|"
    r"transaction_timeout) = 0;|SET client_encoding = 'UTF8';|"
    r"SET (?:standard_conforming_strings|row_security) = (?:on|off);|"
    r"SET check_function_bodies = false;|SET xmloption = content;|"
    r"SET client_min_messages = warning;|SELECT pg_catalog.set_config\('search_path', '', false\);"
)


def canonical_archive_message(message: Any) -> dict[str, Any] | None:
    if message is None:
        return None
    keys = (
        "snapshot_id alert_index captured_utc header_language description_language url_language"
    ).split()
    if not isinstance(message, dict) or set(message) != set(keys):
        raise ValueError("copy_message_keys")
    return {key: message[key] for key in keys}


def _field(raw: bytes) -> str | None:
    if raw == b"\\N":
        return None
    out = bytearray()
    i = 0
    escapes = dict(zip(b"btnvfr\\", (8, 9, 10, 11, 12, 13, 92), strict=True))
    while i < len(raw):
        value = raw[i]
        i += 1
        if value == 92:
            if i == len(raw):
                raise ValueError("copy_escape")
            match = re.match(rb"[0-7]{1,3}|x[0-9a-fA-F]{1,2}", raw[i:])
            if match:
                token = match[0]
                value = int(token[1:], 16) if token.startswith(b"x") else int(token, 8)
                i += len(token)
            else:
                value = escapes.get(raw[i], raw[i])
                i += 1
        if value == 0 or value > 255:
            raise ValueError("copy_escape")
        out.append(value)
    return out.decode("utf-8")


def parse_alert_archive_copy(
    data: bytes,
) -> tuple[tuple[dict[str, str | None], ...], tuple[str, ...]]:
    """Validate the entire script before returning raw decoded records and absent fields."""
    rows: list[dict[str, str | None]] = []
    columns: list[str] = []
    state, restriction = "before", None
    try:
        data.decode("utf-8")
        if not data.endswith(b"\n"):
            raise ValueError("copy_truncated")
        for raw in data.split(b"\n")[:-1]:
            if state == "rows":
                if raw == b"\\.":
                    state = "after"
                    continue
                fields = raw.split(b"\t")
                if len(fields) != len(columns):
                    raise ValueError("copy_width")
                rows.append(dict(zip(columns, map(_field, fields), strict=True)))
                continue
            line = raw.decode("utf-8")
            header = _HEADER.fullmatch(line)
            if header:
                if state != "before":
                    raise ValueError("copy_multiple")
                columns = [c.strip() for c in header[1].split(",")]
                if (
                    len(set(columns)) != len(columns)
                    or set(columns) - _TYPES.keys()
                    or _TYPES.keys() - set(columns) - set(_OPTIONAL)
                ):
                    raise ValueError("copy_columns")
                state = "rows"
            elif line.startswith("\\restrict ") and restriction is None and state == "before":
                restriction = line.removeprefix("\\restrict ")
            elif restriction and line == "\\unrestrict " + restriction and state == "after":
                restriction = None
            elif not line or line.startswith("--") or _SET.fullmatch(line):
                continue
            else:
                raise ValueError("copy_framing")
    except UnicodeError:
        raise ValueError("copy_encoding") from None
    if state != "after" or restriction is not None:
        raise ValueError("copy_truncated" if columns else "copy_missing")
    return tuple(rows), tuple(c for c in _OPTIONAL if c not in columns)


def read_alert_archive_copy(
    connection: Connection,
    path: Path,
    *,
    provider_id: str,
) -> tuple[tuple[dict[str, Any], ...], tuple[str, ...]]:
    try:
        rows, missing = parse_alert_archive_copy(path.read_bytes())
    except OSError:
        raise ValueError("copy_unreadable") from None
    result = []
    for row in rows:
        if row["provider_id"] != provider_id:
            continue
        instants = {}
        for key in ("first_seen_utc", "last_seen_utc", "start_utc", "end_utc", "updated_at_utc"):
            value = row[key]
            try:
                instant = datetime.fromisoformat(value) if value is not None else None
                if instant is not None and instant.utcoffset() is None:
                    raise ValueError
                if instant is None and key not in ("start_utc", "end_utc"):
                    raise ValueError
            except ValueError:
                raise ValueError("copy_instant") from None
            instants[key] = instant
        for a, b in (("first_seen_utc", "last_seen_utc"), ("start_utc", "end_utc")):
            left, right = instants[a], instants[b]
            if left is not None and right is not None and left > right:
                raise ValueError("copy_inverted")
        try:
            typed = dict(connection.execute(_CAST, row | dict.fromkeys(missing)).mappings().one())
        except DBAPIError as exc:
            if exc.connection_invalidated:
                raise
            raise ValueError("copy_cast") from None
        typed["message"] = canonical_archive_message(typed["message"])
        result.append(typed)
    return tuple(result), missing
