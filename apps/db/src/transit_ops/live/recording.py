"""Durable PG evidence and separately committed, idempotent local applications."""

from collections.abc import Callable
from datetime import UTC
from typing import get_type_hints

from sqlalchemy import Connection, Engine, text

from transit_ops.history.poll_record import CaptureEntry, PollRecord
from transit_ops.history.working_captures import read_working_runs
from transit_ops.ingestion.common import redact_error_message
from transit_ops.live.local_file import LocalFile, LocalFileMismatch
from transit_ops.live.poll_records import LocalPollRecords, _entry


class Recorder:
    def __init__(self, local: LocalFile, *, provider_id: str):
        self.local, self.provider_id = local, provider_id
        self.sweep_complete = False
        self.completed_upper: int | None = None

    def initialize(self, *, initial_run_id: int, seed_sha256: str) -> None:
        with self.local.transaction() as conn:
            row = conn.execute("SELECT * FROM recording_cursor").fetchall()
            if row:
                if len(row) != 1 or (row[0][0], row[0][1], row[0][4]) != (
                    self.provider_id,
                    initial_run_id,
                    seed_sha256,
                ):
                    raise LocalFileMismatch("recording_initial_cut_or_seed_changed")
                return
            conn.execute(
                "INSERT INTO recording_cursor VALUES (?, ?, ?, ?, ?, NULL, false)",
                [self.provider_id, initial_run_id, initial_run_id, initial_run_id, seed_sha256],
            )

    def record(self, record: PollRecord) -> None:
        day = record.feed_day
        if day.provider_id != self.provider_id:
            raise LocalFileMismatch("recording_provider_mismatch")
        with self.local.transaction() as conn:
            self.local.record_polls(record.polls, endpoint_key=day.endpoint_key)
            self.local.record_captures(record.captures, endpoint_key=day.endpoint_key)
            conn.execute(
                "INSERT INTO recording_cadence VALUES (?, ?) "
                "ON CONFLICT DO UPDATE SET declared_interval_seconds=excluded."
                "declared_interval_seconds",
                [day.endpoint_key, record.declared_interval_seconds],
            )
            for entry in record.processing:
                if entry.stage == "silver_load" and entry.status == "failed":
                    # Recorded tags are verified by the source reader against exact identities.
                    verified = next(
                        (c for c in record.captures if c.capture_row_id == entry.capture_row_id),
                        None,
                    )
                    if entry.attribution == "recorded" and verified is None:
                        assert entry.capture_row_id is not None
                        verified = LocalPollRecords(self.local)._capture(day, entry.capture_row_id)
                    LocalPollRecords(self.local).record_failure(
                        day,
                        entry,
                        verified_capture=verified if entry.attribution == "recorded" else None,
                    )

    def apply(
        self,
        endpoint: str,
        capture_id: int,
        operation: Callable[[], object],
        *,
        capture: CaptureEntry | None = None,
    ) -> bool:
        identity = [endpoint, capture_id]
        try:
            with self.local.transaction() as conn:
                previous = conn.execute(
                    "SELECT status FROM local_applications "
                    "WHERE endpoint_key=? AND capture_row_id=?",
                    identity,
                ).fetchone()
                if previous == ("succeeded",):
                    return False
                operation()
                if capture is not None:
                    self._advance_serving(endpoint, capture_id, capture)
                conn.execute(
                    "INSERT INTO local_applications VALUES (?, ?, 'succeeded', NULL) "
                    "ON CONFLICT DO UPDATE SET status='succeeded', error_message=NULL",
                    identity,
                )
            return True
        except Exception as exc:
            # This commit can never certify serving success, even after a partial operation.
            with self.local.transaction() as conn:
                conn.execute(
                    "INSERT INTO local_applications VALUES (?, ?, 'failed', ?) "
                    "ON CONFLICT DO UPDATE SET status='failed', "
                    "error_message=excluded.error_message",
                    [*identity, redact_error_message(str(exc))],
                )
            raise

    def _advance_serving(self, endpoint: str, capture_id: int, capture: CaptureEntry) -> None:
        conn = self.local.connection
        if capture.capture_row_id != capture_id:
            raise ValueError("local_serving_capture_mismatch")
        conn.execute(
            "INSERT INTO local_serving VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET "
            "capture_row_id=excluded.capture_row_id, "
            "captured_at_utc=excluded.captured_at_utc, "
            "feed_timestamp_utc=excluded.feed_timestamp_utc "
            "WHERE (excluded.captured_at_utc, excluded.capture_row_id) > "
            "(local_serving.captured_at_utc, local_serving.capture_row_id)",
            [
                endpoint,
                capture_id,
                capture.captured_at_utc.astimezone(UTC).replace(tzinfo=None),
                capture.feed_timestamp_utc.astimezone(UTC).replace(tzinfo=None),
            ],
        )

    def catch_up(
        self, engine: Engine, *, page_size: int, current_run_ids: tuple[int, ...] = ()
    ) -> tuple[PollRecord, ...]:
        """Bound each tick by run identities, then sweep again for late commits.

        No maximum id is a commit watermark. Repeated sweeps also discover terminal
        updates to runs which were still in flight on the previous pass. Raw source
        retention must cover the explicitly supplied initial cut.
        """
        cursor = self.local.connection.execute(
            "SELECT initial_run_id, after_run_id, sweep_last_run_id FROM recording_cursor"
        ).fetchone()
        if cursor is None:
            raise ValueError("recording_initial_cut_missing")
        initial, after, upper = cursor
        with engine.connect() as pg, pg.begin():
            pg.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
            records, ids, upper = self._source_page(
                pg,
                initial,
                after,
                upper,
                page_size,
                tuple(sorted(set(current_run_ids) | set(self._due_runs(page_size)))),
            )
        self._commit_page(records, ids, initial, upper)
        return records

    def _due_runs(self, limit: int) -> tuple[int, ...]:
        rows = self.local.connection.execute(
            "SELECT ingestion_run_id FROM recording_coverage WHERE NOT terminal_recorded "
            "ORDER BY ingestion_run_id LIMIT ?",
            [limit],
        ).fetchall()
        return tuple(r[0] for r in rows)

    def _commit_page(
        self, records: tuple[PollRecord, ...], ids: list[int], initial: int, upper: int
    ) -> None:
        """Raw evidence, per-identity obligations and eligibility share one commit.

        Enumeration alone never releases a horizon. Every enumerated identity
        must also have committed terminal evidence, including after reopen.
        """
        with self.local.transaction() as conn:
            for record in records:
                self.record(record)
            known = set(ids)
            known.update(p.ingestion_run_id for record in records for p in record.polls)
            known.update(c.ingestion_run_id for record in records for c in record.captures)
            known.update(
                p.ingestion_run_id
                for record in records
                for p in record.processing
                if p.ingestion_run_id is not None
            )
            known = {identity for identity in known if identity > initial}
            if known:
                conn.executemany(
                    "INSERT INTO recording_coverage VALUES (?, false) ON CONFLICT DO NOTHING",
                    [(i,) for i in sorted(known)],
                )
            observed = _observed_runs(records)
            conn.execute(
                "UPDATE recording_coverage SET terminal_recorded=true "
                "WHERE list_contains(?::BIGINT[], ingestion_run_id)",
                [sorted(observed)],
            )
            outstanding = conn.execute(
                "SELECT 1 FROM recording_coverage WHERE NOT terminal_recorded "
                "AND ingestion_run_id > ? AND ingestion_run_id <= ? LIMIT 1",
                [initial, upper],
            ).fetchone()
            previous = conn.execute(
                "SELECT covered_through, sweep_enumerated FROM recording_cursor"
            ).fetchone()
            if previous is None:
                raise ValueError("recording_initial_cut_missing")
            enumerated = previous[1] or not ids
            complete = enumerated and outstanding is None
            covered = max(previous[0] or initial, upper) if complete else previous[0]
            conn.execute(
                "UPDATE recording_cursor SET after_run_id=?, sweep_last_run_id=?, "
                "covered_through=?, sweep_enumerated=?",
                [
                    initial if complete or not ids else ids[-1],
                    initial if complete else upper,
                    covered,
                    False if complete else enumerated,
                ],
            )
        self.sweep_complete = complete
        self.completed_upper = covered

    def _source_page(
        self,
        pg: Connection,
        initial: int,
        after: int,
        upper: int,
        page_size: int,
        current_run_ids: tuple[int, ...],
    ) -> tuple[tuple[PollRecord, ...], list[int], int]:
        if upper == initial:
            upper = pg.execute(
                text(
                    "SELECT greatest(coalesce(max(ingestion_run_id), :initial), :initial) "
                    "FROM raw.ingestion_runs WHERE provider_id=:provider"
                ),
                dict(initial=initial, provider=self.provider_id),
            ).scalar_one()
        ids = _run_ids(pg, self.provider_id, initial, page_size, after=after, upper=upper)
        tail = _run_ids(pg, self.provider_id, initial, page_size)
        selected = sorted(set(ids) | set(tail) | set(current_run_ids))
        terminal = list(
            pg.execute(
                text(
                    "SELECT ingestion_run_id FROM raw.ingestion_runs WHERE provider_id=:provider "
                    "AND ingestion_run_id=ANY(:run_ids) AND completed_at_utc IS NOT NULL "
                    "AND status IN ('succeeded', 'failed')"
                ),
                dict(provider=self.provider_id, run_ids=selected),
            ).scalars()
        )
        records = read_working_runs(pg, provider_id=self.provider_id, run_ids=terminal)
        return records, ids, upper

    def ready_current(self, run_ids: set[int]) -> None:
        """Mark a completely observed current capture batch eligible for projection.

        Status alone never certifies application; facts and serving still require
        apply()'s atomic success. Eligibility uses existing metadata and allocates no identity.
        """
        if not run_ids:
            return
        with self.local.transaction() as conn:
            conn.execute(
                "INSERT INTO local_applications SELECT endpoint_key, capture_row_id, 'ready', NULL "
                "FROM captures WHERE list_contains(?::BIGINT[], ingestion_run_id) "
                "ON CONFLICT DO NOTHING",
                [sorted(run_ids)],
            )

    def pending_captures(
        self, limit: int, *, through_run_id: int | None = None, for_application: bool = False
    ) -> list[tuple[str, CaptureEntry]]:
        """Schedule bounded work over all durable pages, with vehicles before trips."""
        # Vehicle facts depend only on their own captured input. Admit known vehicles
        # before the historical horizon so a ready trip cannot overtake one, even
        # when its ingestion-run ID is higher. The bounded queue always sorts them first.
        # Batch readiness is not proof that historical dependencies were enumerated.
        columns = ", ".join('c."' + n + '"' for n in get_type_hints(CaptureEntry))
        rows = self.local.connection.execute(
            f"SELECT c.endpoint_key, {columns} FROM captures c LEFT JOIN local_applications a "
            "ON c.endpoint_key=a.endpoint_key AND c.capture_row_id=a.capture_row_id "
            "WHERE coalesce(a.status, '') <> 'succeeded' AND c.ingestion_run_id > "
            "(SELECT coalesce(max(initial_run_id), 0) FROM recording_cursor) "
            "AND ((?::BOOLEAN AND c.endpoint_key='vehicle_positions') OR ("
            "(?::BIGINT IS NULL OR c.ingestion_run_id <= ?::BIGINT) "
            "AND (NOT ?::BOOLEAN OR NOT EXISTS(SELECT 1 FROM recording_coverage o "
            "WHERE o.ingestion_run_id <= c.ingestion_run_id AND NOT o.terminal_recorded)))) "
            "ORDER BY CASE c.endpoint_key WHEN 'vehicle_positions' THEN 0 "
            "WHEN 'trip_updates' THEN 2 ELSE 1 END, c.captured_at_utc, c.capture_row_id LIMIT ?",
            [for_application, through_run_id, through_run_id, for_application, limit],
        ).fetchall()
        return [(r[0], _entry(CaptureEntry, r[1:])) for r in rows]


def _run_ids(
    pg: Connection,
    provider: str,
    initial: int,
    page_size: int,
    *,
    after: int | None = None,
    upper: int | None = None,
) -> list[int]:
    params: dict[str, object] = dict(provider=provider, initial=initial, limit=page_size)
    boundary, order = "ingestion_run_id > :initial", "DESC"
    terminal = "AND completed_at_utc IS NOT NULL AND status IN ('succeeded', 'failed') "
    if after is not None:
        params.update(after=after, upper=upper)
        boundary, order = "ingestion_run_id > :after AND ingestion_run_id <= :upper", "ASC"
        terminal = ""  # Enumerate in-flight identities; completion needs their durable receipts.
    return list(
        pg.execute(
            text(
                "SELECT ingestion_run_id FROM raw.ingestion_runs WHERE provider_id=:provider "
                f"AND {boundary} {terminal}"
                "AND feed_endpoint_id IN (SELECT feed_endpoint_id FROM core.feed_endpoints "
                "WHERE provider_id=:provider AND endpoint_key IN "
                "('trip_updates','vehicle_positions','i3_alerts','service_alerts')) "
                f"ORDER BY ingestion_run_id {order} LIMIT :limit"
            ),
            params,
        ).scalars()
    )


def _observed_runs(records: tuple[PollRecord, ...]) -> set[int]:
    observed = {
        p.ingestion_run_id
        for r in records
        for p in r.polls
        if p.run_status in ("succeeded", "failed") and p.status != "capture_missing"
    }
    observed.update(
        p.ingestion_run_id
        for r in records
        for p in r.processing
        if p.ingestion_run_id is not None and p.stage == "silver_load" and p.status == "failed"
    )
    return observed
