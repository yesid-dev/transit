"""Read one raw trip capture through borrowed local and byte-resolution resources."""

from collections.abc import Callable
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
        # Retain contradictory latest namespaces for validation, rather than
        # filtering them into a successful older fallback. Failed raw polls
        # cannot promote a capture; Silver/application status is irrelevant.
        row = local.connection.execute(
            f"SELECT {columns}, c.endpoint_key FROM captures c WHERE "
            "(c.endpoint_key='trip_updates' OR EXISTS (SELECT 1 FROM polls p "
            "WHERE p.ingestion_run_id=c.ingestion_run_id AND p.endpoint_key='trip_updates')) "
            "ORDER BY c.captured_at_utc DESC NULLS FIRST, c.capture_row_id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        entry = _entry(CaptureEntry, row[:-1])
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
        "feed_timestamp_utc, feed_timestamp_source FROM polls WHERE ingestion_run_id=?",
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
    )
    if (
        endpoint != "trip_updates"
        or entry.index_family != "realtime_snapshot"
        or rows != [expected]
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
