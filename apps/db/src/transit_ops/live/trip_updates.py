"""Read one raw trip capture through borrowed local and byte-resolution resources."""

from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, get_type_hints

from transit_ops.history.poll_record import CaptureEntry
from transit_ops.live.captures import CaptureRef, ParsedCapture, ParsePolicy, parse_capture

if TYPE_CHECKING:
    from transit_ops.live.local_file import LocalFile


class LocalTripUpdatesError(ValueError):
    """Local cold-start evidence cannot safely supply a trip capture."""


def latest_local_trip_updates(
    provider_id: str,
    *,
    local: "LocalFile",
    policy: ParsePolicy,
    resolve_bytes: Callable[[CaptureEntry], bytes],
) -> ParsedCapture | None:
    """None means no candidate; an invalid latest candidate never selects an older one."""
    from transit_ops.live.local_file import SCHEMA_VERSION
    from transit_ops.live.poll_records import _entry

    try:
        if not provider_id or local.connection.execute(
            "SELECT schema_version, provider_id FROM meta"
        ).fetchall() != [(SCHEMA_VERSION, provider_id)]:
            raise LocalTripUpdatesError("local_trip_updates_provider_mismatch")
        columns = ", ".join('c."' + n + '"' for n in get_type_hints(CaptureEntry))
        # Preserve both sides of stored success, including a dangling poll. Rank
        # by either copy of the capture clock so moving one backward cannot hide
        # contradictory latest evidence. Validation still requires the clocks to agree.
        row = local.connection.execute(
            f"SELECT c.capture_row_id, {columns}, c.endpoint_key FROM captures c "
            "FULL OUTER JOIN polls p ON p.ingestion_run_id=c.ingestion_run_id "
            "WHERE c.endpoint_key='trip_updates' OR (p.endpoint_key='trip_updates' AND "
            "(c.capture_row_id IS NOT NULL OR (p.status='stored' AND p.run_status='succeeded'))) "
            "ORDER BY greatest(c.captured_at_utc, p.time_utc) DESC NULLS FIRST, "
            "greatest(c.capture_row_id, p.capture_row_id) DESC NULLS FIRST LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        if row[0] is None:
            raise LocalTripUpdatesError("local_trip_updates_capture_missing")
        entry = _entry(CaptureEntry, row[1:-1])
        _validate_binding(local, entry, row[-1], provider_id)
        return parse_capture(
            resolve_bytes(entry),
            CaptureRef.from_entry(entry, provider_id=provider_id, endpoint_key="trip_updates"),
            policy,
        )
    except LocalTripUpdatesError:
        raise
    except Exception as exc:
        raise LocalTripUpdatesError(f"local_trip_updates_read_failed:{type(exc).__name__}") from exc


def _validate_binding(
    local: "LocalFile", entry: CaptureEntry, endpoint: object, provider_id: str
) -> None:
    from transit_ops.snapshots.live_trip_updates import _validate

    rows = local.connection.execute(
        "SELECT index_family, endpoint_key, run_kind, status, run_status, capture_row_id, "
        "feed_timestamp_utc, feed_timestamp_source, time_utc, started_at_utc, completed_at_utc "
        "FROM polls WHERE ingestion_run_id=?",
        [entry.ingestion_run_id],
    ).fetchall()
    expected = (
        "realtime_snapshot",
        "trip_updates",
        "trip_updates",
        "stored",
        "succeeded",
        entry.capture_row_id,
        entry.feed_timestamp_utc.replace(tzinfo=None),
        entry.feed_timestamp_source,
        entry.captured_at_utc.replace(tzinfo=None),
        entry.started_at_utc.replace(tzinfo=None),
    )
    if (
        endpoint != "trip_updates"
        or entry.index_family != "realtime_snapshot"
        or len(rows) != 1
        or rows[0][:-1] != expected
        or not isinstance(rows[0][-1], datetime)
    ):
        raise LocalTripUpdatesError("local_trip_updates_poll_identity_mismatch")
    if (
        entry.ingestion_run_id <= 0
        or entry.ingestion_object_id <= 0
        or not entry.storage_backend
        or not entry.storage_path
        or not entry.object_kind
        or entry.feed_timestamp_source not in ("header", "capture_time")
        or (
            entry.packed
            and (
                entry.stream is None or entry.offset is None or entry.stream < 0 or entry.offset < 0
            )
        )
        or (not entry.packed and (entry.stream is not None or entry.offset is not None))
    ):
        raise LocalTripUpdatesError("local_trip_updates_capture_identity_mismatch")
    _validate(
        CaptureRef.from_entry(entry, provider_id=provider_id, endpoint_key="trip_updates"),
        provider_id,
    )
