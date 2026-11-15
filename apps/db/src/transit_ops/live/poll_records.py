"""Failed Silver provenance over the disposable local file; no capture ID allocation."""

from dataclasses import replace
from datetime import UTC, datetime, time, timedelta
from typing import get_type_hints

from transit_ops.failed_load_tag import (
    format_failed_load_error,
    parse_failed_load_capture_row_id,
)
from transit_ops.history.poll_record import CaptureEntry, FeedDayKey, ProcessingEntry, typed_value
from transit_ops.live.local_file import LocalFile


class FailedLoadIntegrityError(ValueError):
    """Recorded provenance is dangling or disagrees with its capture namespace."""


class LocalPollRecords:
    """Accept a caller-verified receipt, then verify it against durable capture evidence.

    A receipt is supplied only after source identity verification succeeds. Without
    one, the existing by-time/unknown attribution is retained. No latest-capture
    query establishes recorded certainty. Failed attempts never update raw polls
    or captures. Methods compose with LocalFile.transaction for atomic cycles.
    """

    def __init__(self, local: LocalFile):
        self.local = local

    def _provider(self, day: FeedDayKey) -> None:
        row = self.local.connection.execute("SELECT provider_id FROM meta").fetchone()
        if row != (day.provider_id,):
            raise FailedLoadIntegrityError("failure provider differs from local file")
        if day.index_family not in ("realtime_snapshot", "alert_snapshot"):
            raise FailedLoadIntegrityError("unknown capture index family")

    def _capture(self, day: FeedDayKey, capture_id: int) -> CaptureEntry:
        columns = ", ".join(f'"{name}"' for name in get_type_hints(CaptureEntry))
        rows = self.local.connection.execute(
            f"SELECT {columns} FROM captures "
            "WHERE index_family=? AND capture_row_id=? AND endpoint_key=?",
            [day.index_family, capture_id, day.endpoint_key],
        ).fetchall()
        if len(rows) != 1:
            raise FailedLoadIntegrityError(
                "recorded capture is missing or its endpoint/family differs"
            )
        return _entry(CaptureEntry, rows[0])

    def record_failure(
        self,
        day: FeedDayKey,
        failure: ProcessingEntry,
        *,
        verified_capture: CaptureEntry | None = None,
    ) -> int:
        with self.local.transaction():
            self._provider(day)
            if (
                failure.stage != "silver_load"
                or failure.status != "failed"
                or failure.index_family != day.index_family
                or type(failure.ingestion_run_id) is not int
                or failure.started_at_utc is None
                or failure.started_at_utc.utcoffset() is None
                or failure.started_at_utc.astimezone(UTC).date() != day.utc_date
            ):
                raise FailedLoadIntegrityError("invalid failed Silver attempt identity")
            error = failure.error_message
            if verified_capture is not None:
                if (
                    verified_capture.index_family != day.index_family
                    or self._capture(day, verified_capture.capture_row_id) != verified_capture
                ):
                    raise FailedLoadIntegrityError("verified receipt differs from stored capture")
                error = format_failed_load_error(error or "", verified_capture.capture_row_id)
                failure = replace(
                    failure,
                    capture_row_id=verified_capture.capture_row_id,
                    attribution="recorded",
                    error_message=error,
                )
            else:
                if failure.attribution not in (None, "by_time"):
                    raise FailedLoadIntegrityError(
                        "recorded attribution requires a verified receipt"
                    )
                # An exception body cannot confer provenance before verification.
                if parse_failed_load_capture_row_id(error) is not None:
                    failure = replace(failure, error_message=f"Unverified failure: {error}")
            return self.local.record_processing([failure], endpoint_key=day.endpoint_key)

    def processing(self, day: FeedDayKey) -> tuple[ProcessingEntry, ...]:
        with self.local.transaction() as conn:
            self._provider(day)
            start = datetime.combine(day.utc_date, time())
            columns = ", ".join(f'"{name}"' for name in get_type_hints(ProcessingEntry))
            rows = conn.execute(
                f"SELECT {columns} FROM processing WHERE index_family=? AND endpoint_key=? "
                "AND started_at_utc>=? AND started_at_utc<? "
                "ORDER BY started_at_utc, ingestion_run_id",
                [day.index_family, day.endpoint_key, start, start + timedelta(days=1)],
            ).fetchall()
            return tuple(self._reconstruct(day, _entry(ProcessingEntry, row)) for row in rows)

    def _reconstruct(self, day: FeedDayKey, entry: ProcessingEntry) -> ProcessingEntry:
        capture_id = parse_failed_load_capture_row_id(entry.error_message)
        if capture_id is not None:
            self._capture(day, capture_id)
            if entry.attribution == "recorded" and entry.capture_row_id != capture_id:
                raise FailedLoadIntegrityError("failure tag differs from stored capture identity")
            return replace(entry, capture_row_id=capture_id, attribution="recorded")
        if entry.attribution == "recorded":
            raise FailedLoadIntegrityError("recorded failure has no valid leading capture tag")
        return entry


def _entry[T: (CaptureEntry, ProcessingEntry)](kind: type[T], row: tuple[object, ...]) -> T:
    values = dict(zip(get_type_hints(kind), row, strict=True))
    for name, value in values.items():
        if isinstance(value, datetime):
            values[name] = value.replace(tzinfo=UTC)
    result: T = typed_value(kind, values)
    return result
