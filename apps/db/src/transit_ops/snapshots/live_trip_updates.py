"""Retain one verified trip capture; consumers borrow its frames read-only."""

from collections.abc import Callable
from contextlib import ExitStack
from datetime import datetime
from re import fullmatch

from sqlalchemy import Engine, text

from transit_ops.db.connection import make_engine
from transit_ops.ingestion.common import project_root
from transit_ops.ingestion.storage import BronzeStorageResolver, BronzeStorageScope
from transit_ops.live.captures import CaptureRef, ParsedCapture, ParsePolicy, parse_capture
from transit_ops.settings import Settings


class CaptureIdentityError(ValueError):
    """A capture has incomplete or contradictory identity."""


def _validate(capture: CaptureRef, provider_id: str) -> None:
    if (
        not provider_id
        or capture.provider_id != provider_id
        or capture.endpoint_key != "trip_updates"
        or type(capture.capture_row_id) is not int
        or capture.capture_row_id <= 0
        or type(capture.byte_size) is not int
        or capture.byte_size < 0
        or not isinstance(capture.sha256, str)
        or not fullmatch(r"[0-9a-fA-F]{64}", capture.sha256)
        or any(
            not isinstance(t, datetime) or t.utcoffset() is None
            for t in (capture.captured_at_utc, capture.feed_timestamp_utc)
        )
    ):
        raise CaptureIdentityError("Invalid trip capture identity")


class LiveTripUpdates:
    def __init__(
        self,
        provider_id: str,
        *,
        policy: ParsePolicy,
        fallback: Callable[[], ParsedCapture | None],
    ) -> None:
        self._provider_id = provider_id
        self._policy = policy
        self._fallback = fallback
        self._value: ParsedCapture | None = None
        self._resolved = False

    def accept(self, payload: bytes, capture: CaptureRef) -> None:
        _validate(capture, self._provider_id)
        parsed = parse_capture(payload, capture, self._policy)
        if self._value is not None:
            previous = self._value.capture
            if capture.capture_row_id == previous.capture_row_id:
                if capture != previous:
                    raise CaptureIdentityError("Contradictory trip capture identity")
                return
            if (capture.captured_at_utc, capture.capture_row_id) < (
                previous.captured_at_utc,
                previous.capture_row_id,
            ):
                return
        self._value = parsed
        self._resolved = True

    def latest(self) -> ParsedCapture | None:
        if not self._resolved:
            parsed = self._fallback()
            if parsed is not None:
                _validate(parsed.capture, self._provider_id)
            self._value = parsed
            self._resolved = True
        return self._value


_LATEST = text("""
    SELECT rsi.realtime_snapshot_id, rsi.provider_id, fe.endpoint_key,
           rsi.captured_at_utc, rsi.feed_timestamp_utc,
           io.byte_size, io.checksum_sha256, io.storage_backend, io.storage_path
    FROM raw.realtime_snapshot_index rsi
    JOIN raw.ingestion_runs ir ON ir.ingestion_run_id = rsi.ingestion_run_id
    JOIN core.feed_endpoints fe ON fe.feed_endpoint_id = rsi.feed_endpoint_id
    LEFT JOIN raw.ingestion_objects io ON io.ingestion_object_id = rsi.ingestion_object_id
    WHERE rsi.provider_id = :provider_id AND fe.endpoint_key = 'trip_updates'
      AND ir.status = 'succeeded' AND ir.provider_id = rsi.provider_id
      AND ir.feed_endpoint_id = rsi.feed_endpoint_id AND fe.provider_id = rsi.provider_id
      AND (io.ingestion_object_id IS NULL OR
           (io.provider_id = rsi.provider_id AND io.ingestion_run_id = rsi.ingestion_run_id))
    ORDER BY rsi.captured_at_utc DESC, rsi.realtime_snapshot_id DESC LIMIT 1
""")


def latest_stored_trip_updates(
    provider_id: str,
    *,
    settings: Settings,
    policy: ParsePolicy,
    engine: Engine | None = None,
    bronze_storage_resolver: BronzeStorageResolver | None = None,
) -> ParsedCapture | None:
    """Verify the latest succeeded raw capture without writes or a Silver-success claim."""
    with ExitStack() as stack:
        if engine is None:
            engine = make_engine(settings)
            stack.callback(engine.dispose)
        with engine.connect() as connection:
            row = connection.execute(_LATEST, {"provider_id": provider_id}).mappings().one_or_none()
        if row is None:
            return None
        if not row["storage_backend"] or not row["storage_path"]:
            raise CaptureIdentityError("Incomplete stored trip capture identity")
        if bronze_storage_resolver is None:
            scope = BronzeStorageScope(settings, project_root=project_root())
            stack.callback(scope.close)
            bronze_storage_resolver = scope.resolve
        payload = bronze_storage_resolver(row["storage_backend"]).read_bytes(row["storage_path"])
        capture = CaptureRef(
            row["provider_id"],
            row["endpoint_key"],
            row["realtime_snapshot_id"],
            row["captured_at_utc"],
            row["feed_timestamp_utc"],
            len(payload) if row["byte_size"] is None else row["byte_size"],
            row["checksum_sha256"],
        )
        _validate(capture, provider_id)
        return parse_capture(payload, capture, policy)
