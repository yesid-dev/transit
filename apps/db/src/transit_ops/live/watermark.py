"""The worker's committed watermark: what it had durably committed, kept outside its file.

A worker reopen verifies committed rows against this sidecar, never against the reopened
file alone (live ruling 12). Only the worker loop writes it, once per cycle after the
cycle's local commits, even when the cycle raised: one aggregate read, one write of a few
hundred bytes, one fsync and one atomic rename.

The watermark can only lag the file, never lead it: a kill between a commit and the next
watermark leaves the file ahead, which is recovered. A file behind it lost committed rows.
A one-shot cycle on the same file writes no watermark, so its commits stay unwitnessed
until the worker loop's next one.

``<db>.committed.invalid`` means no watermark may witness the file: it is written when a
watermark write fails (before the old one is removed, which Windows can refuse while
another process holds it) and before an adoption replaces the file, and only a later
successful write clears it. Either way the next reopen is unmeasured, never a pass.

A reopen that finds the file gone under a sound watermark lost every row it witnessed
(live ruling 26a). The marker then keeps that watermark's bytes, so a first local install
can still tell a file that never allocated a local identity (live ruling 27a).
"""

import json
import logging
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

from transit_ops.live.local_file import LocalFile

logger = logging.getLogger(__name__)

# 2: segment exports, terminal coverage, cursor, cadence and decided applications measured.
# 3: local ingress identity namespaces and reservations measured (live ruling 27.1).
FORMAT = 3
# Measures that never decrease on a live file. Every recorded row and every completion or
# decision flag a cycle commits moves at least one of them (live rulings 26 and 27.1).
_RECORDER_MEASURES = (
    "next_seq",
    "covered_through",
    "polls",
    "captures",
    "processing",
    "recording_cursor",
    "recording_cadence",
    "recording_coverage",
    "coverage_terminal",
    "local_applications",
    "decided",
    "applied",
    "segment_fact_members",
    "segment_exports",
    "exports_completed",
)
_STATE = (
    "SELECT (SELECT next_seq FROM segment_clock), "
    "(SELECT coalesce(max(covered_through), 0) FROM recording_cursor), "
    "(SELECT count(*) FROM polls), (SELECT count(*) FROM captures), "
    "(SELECT count(*) FROM processing), (SELECT count(*) FROM recording_cursor), "
    "(SELECT count(*) FROM recording_cadence), (SELECT count(*) FROM recording_coverage), "
    "(SELECT count(*) FROM recording_coverage WHERE terminal_recorded), "
    "(SELECT count(*) FROM local_applications), "
    "(SELECT count(*) FROM local_applications WHERE status<>'ready'), "
    "(SELECT count(*) FROM local_applications WHERE status='succeeded'), "
    "(SELECT count(*) FROM segment_fact_members), (SELECT count(*) FROM segment_exports), "
    "(SELECT count(*) FROM segment_exports WHERE completed)"
)
# Local ingress identity (live/identity.py, #1165): each namespace's next_id, then all and
# recorded reservations. A PostgreSQL-ingress file has no identity tables: all zero.
IDENTITY_NAMESPACES = ("ingestion_run", "ingestion_object", "realtime_snapshot", "alert_snapshot")
_IDENTITY_MEASURES = (
    *(f"identity_next_{n}" for n in IDENTITY_NAMESPACES),
    "identity_reservations",
    "identity_recorded",
)
_IDENTITY_TABLES = ["local_identity_namespaces", "local_identity_reservations"]
_IDENTITY = (
    "SELECT "
    + "".join(
        f"(SELECT coalesce(max(next_id), 0) FROM local_identity_namespaces WHERE namespace='{n}'), "
        for n in IDENTITY_NAMESPACES
    )
    + "(SELECT count(*) FROM local_identity_reservations), "
    "(SELECT count(*) FROM local_identity_reservations WHERE recorded)"
)
MEASURES = (*_RECORDER_MEASURES, *_IDENTITY_MEASURES)
# Allocation positions: a deficit is that many lost allocations.
ALLOCATIONS = ("next_seq", *_IDENTITY_MEASURES[: len(IDENTITY_NAMESPACES)])
# Positions, not row counts; covered_through behind only says the file is behind.
POSITIONS = (*ALLOCATIONS, "covered_through")


def committed_watermark_path(database: Path) -> Path:
    return Path(str(database) + ".committed.json")


def invalid_marker_path(database: Path) -> Path:
    return Path(str(database) + ".committed.invalid")


def committed_state(local: LocalFile) -> dict[str, int]:
    local.require_committed()
    conn = local.connection
    row = conn.execute(_STATE).fetchone()
    present = conn.execute(
        "SELECT count(*) FROM duckdb_tables() WHERE schema_name='main' "
        "AND database_name=current_database() AND list_contains(?, table_name)",
        [_IDENTITY_TABLES],
    ).fetchone()
    assert row is not None and present is not None
    if present[0] not in (0, len(_IDENTITY_TABLES)):
        raise ValueError("local_identity_tables_partial")
    identity = conn.execute(_IDENTITY).fetchone() if present[0] else (0,) * 6
    assert identity is not None
    return dict(zip(MEASURES, (int(v) for v in (*row, *identity)), strict=True))


def _write_synced(path: Path, payload: bytes) -> None:
    with path.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def invalidate_watermark(database: Path, *, keep: bytes = b"") -> bool:
    """Make the next reopen unmeasured: mark first, then remove the old watermark.

    ``keep`` is the removed watermark's bytes, kept in the marker only as identity evidence
    (live ruling 27a); any marker means no watermark witnesses the file. False (logged by
    name) only when neither held, so a stale watermark may remain.
    """
    marked = True
    try:
        _write_synced(invalid_marker_path(database), keep)
    except OSError as exc:
        marked = False
        logger.error("live_committed_watermark_unmarkable:%s", type(exc).__name__)
    try:
        committed_watermark_path(database).unlink(missing_ok=True)
    except OSError as exc:
        if not marked:
            logger.error("live_committed_watermark_stale:%s", type(exc).__name__)
            return False
    return True


def write_committed_watermark(
    database: Path, local: LocalFile, *, provider_id: str, cycle_at: datetime
) -> bool:
    """Durably record the file's committed state; False (logged by name) when it could not."""
    target = committed_watermark_path(database)
    try:
        if cycle_at.utcoffset() is None:
            raise ValueError("cycle_at must be timezone-aware")
        document = {
            "format": FORMAT,
            "provider_id": provider_id,
            "cycle_at": cycle_at.astimezone(UTC).isoformat(),
            "state": committed_state(local),
        }
        temporary = target.with_name(target.name + ".tmp")
        _write_synced(temporary, json.dumps(document, sort_keys=True).encode("utf-8"))
        os.replace(temporary, target)
    except Exception as exc:  # noqa: BLE001 - the cycle never depends on its watermark
        logger.error("live_committed_watermark_unwritable:%s", type(exc).__name__)
        invalidate_watermark(database)
        return False
    try:
        invalid_marker_path(database).unlink(missing_ok=True)
    except OSError as exc:  # The marker stays: later reopens stay unmeasured until cleared.
        logger.error("live_committed_watermark_marker_kept:%s", type(exc).__name__)
    return True


def _read_bytes(path: Path) -> bytes | str:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unreadable"


def _read(database: Path, provider_id: str) -> tuple[Mapping[str, int] | str, bytes]:
    """The watermark's state, or the name of why it cannot witness the dead worker."""
    if invalid_marker_path(database).exists():
        return "invalidated", b""
    payload = _read_bytes(committed_watermark_path(database))
    if isinstance(payload, str):
        return payload, b""
    return _parse(payload, provider_id), payload


def _parse(payload: bytes, provider_id: str) -> Mapping[str, int] | str:
    try:
        document = json.loads(payload)
    except ValueError:
        return "torn"
    if not isinstance(document, dict) or set(document) != {
        "format",
        "provider_id",
        "cycle_at",
        "state",
    }:
        return "torn"
    if document["format"] != FORMAT:
        return "format"
    if document["provider_id"] != provider_id:
        return "provider"
    state = document["state"]
    if (
        not isinstance(state, dict)
        or set(state) != set(MEASURES)
        or any(type(v) is not int or v < 0 for v in state.values())
    ):
        return "torn"
    return state


def verify_committed(database: Path, local: LocalFile, *, provider_id: str) -> int | None:
    """At least how many committed rows or row updates the reopened file lacks.

    0 when the file is at or ahead of the last watermark. None, logged by name, when no
    sound watermark witnesses what the dead worker committed; the gate then reads the
    restart as ``measurement_unavailable``.
    """
    watermark, _ = _read(database, provider_id)
    if isinstance(watermark, str):
        logger.warning("live_committed_watermark_unavailable:%s", watermark)
        return None
    try:
        state = committed_state(local)
    except Exception as exc:  # noqa: BLE001 - an unread state is unmeasured, never a pass
        logger.warning("live_committed_watermark_unavailable:%s", type(exc).__name__)
        return None
    return _deficit(watermark, state)


def _deficit(watermark: Mapping[str, int], state: Mapping[str, int]) -> int:
    rows = sum(max(0, watermark[m] - state[m]) for m in MEASURES if m not in POSITIONS)
    allocations = (watermark[m] - state[m] for m in ALLOCATIONS)
    behind = any(watermark[m] > state[m] for m in POSITIONS)
    return max(rows, *allocations, int(behind))


def verify_vanished(database: Path, *, provider_id: str) -> tuple[int | None, bytes]:
    """Live ruling 26a: the reopen found no file. What its watermark witnessed is lost.

    Returns at least how many committed rows a sound watermark witnessed (at least one: it
    witnessed a committed file), with its bytes for the marker that will replace it; None,
    logged by name, when no sound watermark exists, so the restart stays unmeasured.
    """
    watermark, payload = _read(database, provider_id)
    if isinstance(watermark, str):
        logger.warning("live_committed_watermark_unavailable:%s", watermark)
        return None, b""
    return max(1, _deficit(watermark, dict.fromkeys(MEASURES, 0))), payload


def identity_history_witnessed(database: Path, *, provider_id: str) -> bool:
    """Live ruling 27a: whether a committed watermark beside ``database`` may hold identity.

    Only a sound watermark (current, or kept in the marker when its file vanished) whose
    identity measures are all zero witnesses none: a PostgreSQL-ingress file. Any other
    watermark or marker present (torn, empty, another format or provider) fails closed.
    """
    for path in (committed_watermark_path(database), invalid_marker_path(database)):
        payload = _read_bytes(path)
        if payload == "missing":
            continue
        state = payload if isinstance(payload, str) else _parse(payload, provider_id)
        if isinstance(state, str) or any(state[m] for m in _IDENTITY_MEASURES):
            return True
    return False
