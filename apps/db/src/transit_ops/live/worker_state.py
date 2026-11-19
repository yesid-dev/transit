"""One worker-owned LocalFile; PostgreSQL remains the public authority."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from functools import partial
from hashlib import sha256
from typing import TYPE_CHECKING, Any, get_type_hints
from urllib.parse import quote

from sqlalchemy import Engine, text

from transit_ops.core.models import ProviderManifest
from transit_ops.history.poll_record import CaptureEntry, PollRecord
from transit_ops.ingestion.common import redact_error_message
from transit_ops.ingestion.i3 import extract_i3_metadata, extract_service_alerts_metadata
from transit_ops.ingestion.storage import BronzeStorageResolver
from transit_ops.live.admission import restart_evidence_path
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.edition import (
    EditionId,
    EditionMissing,
    current_dim_versions,
    current_edition_id,
    load_edition_from_postgres,
    loaded_edition,
)
from transit_ops.live.facts import apply_capture
from transit_ops.live.local_file import LocalFile, LocalFileMismatch
from transit_ops.live.poll_records import _entry
from transit_ops.live.recording import Recorder
from transit_ops.live.recovery import open_worker_file
from transit_ops.live.segments import SHADOW_SEGMENTS_PREFIX, export_segment
from transit_ops.live.settings import LaneSettings
from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import AlertSeed
from transit_ops.static.alert_state import seed_alert_state

if TYPE_CHECKING:
    from transit_ops.live.ingest import LocalCaptureOutcome, LocalIngestor
    from transit_ops.settings import Settings

logger = logging.getLogger(__name__)


class WorkerState:
    def __init__(
        self,
        local: LocalFile,
        *,
        engine: Engine | None,
        manifest: ProviderManifest,
        settings: LaneSettings,
        resolver: BronzeStorageResolver,
        ingestor: LocalIngestor | None = None,
        edition_loader: Callable[[LocalFile, str], EditionId | None] | None = None,
    ):
        self.local, self.engine, self.manifest = local, engine, manifest
        self.settings, self.resolver = settings, resolver
        self.ingestor = ingestor
        self.edition_loader = edition_loader
        self.recorder = (
            ingestor.recorder
            if ingestor is not None
            else Recorder(local, provider_id=manifest.provider.provider_id)
        )
        self.unavailable: str | None = None if ingestor is not None else "local_not_observed"
        self._recovery_ready = False
        self._required_current: set[int] = set()
        self._current_batch: set[int] = set()
        self._recovered_through: int | None = None

    def sync(self, *, current_run_ids: tuple[int, ...] = (), project: bool = True) -> None:
        """Observe all terminal outcomes; a local error never falsifies PG success."""
        if self.settings.ingress == "local":
            raise ValueError("local_ingress_forbids_postgres_sync")
        try:
            self._sync(current_run_ids=current_run_ids, project=project)
        except Exception as exc:
            self.unavailable = redact_error_message(str(exc))
            logger.error("Local recording unavailable: %s", self.unavailable)

    def capture_local(
        self,
        endpoint_key: str,
        *,
        attempt_key: str | None = None,
    ) -> LocalCaptureOutcome:
        """Capture one endpoint through the borrowed single-owner local ingestor."""
        if self.ingestor is None:
            raise ValueError("local_ingress_not_configured")
        return self.ingestor.capture_endpoint(endpoint_key, attempt_key=attempt_key)

    def _loaded_local_edition(self, provider: str) -> EditionId | None:
        exists = self.local.connection.execute(
            "SELECT 1 FROM duckdb_tables() WHERE table_name='edition_meta' "
            "AND schema_name='main' AND database_name=current_database()"
        ).fetchone()
        loaded = loaded_edition(self.local.connection) if exists else None
        if loaded is None or loaded.provider_id != provider:
            return None
        return loaded

    def _ensure_local_edition(self, provider: str) -> EditionId | None:
        """Load the static schedule edition through live/edition.py (#883) when available."""
        self.local.require_committed()
        if self.edition_loader is not None:
            try:
                self.edition_loader(self.local, provider)
            except EditionMissing:
                return None
        elif self.engine is not None:
            try:
                self._ensure_edition(provider)
            except EditionMissing:
                return None
        return self._loaded_local_edition(provider)

    def _local_pending_captures(self) -> list[tuple[str, CaptureEntry]]:
        columns = ", ".join('c."' + n + '"' for n in get_type_hints(CaptureEntry))
        rows = self.local.connection.execute(
            f"SELECT c.endpoint_key, {columns} FROM captures c LEFT JOIN local_applications a "
            "ON c.endpoint_key=a.endpoint_key AND c.capture_row_id=a.capture_row_id "
            "WHERE coalesce(a.status, '') <> 'succeeded' AND c.ingestion_run_id > "
            "(SELECT coalesce(max(initial_run_id), 0) FROM recording_cursor) "
            "ORDER BY CASE c.endpoint_key WHEN 'vehicle_positions' THEN 0 "
            "WHEN 'trip_updates' THEN 2 ELSE 1 END, c.captured_at_utc, c.capture_row_id"
        ).fetchall()
        return [(str(r[0]), _entry(CaptureEntry, r[1:])) for r in rows]

    def apply_local(self, *, live_trip_updates: Any = None) -> dict[tuple[str, int], str]:
        """Apply pending locally recorded captures and export pre-cutover shadow segments."""
        if self.ingestor is None:
            raise ValueError("local_ingress_not_configured")
        from transit_ops.live.ingest import application_input_signature

        provider = self.manifest.provider.provider_id
        timezone = self.manifest.provider.timezone
        failures: dict[tuple[str, int], str] = {}
        deferred_failures: dict[tuple[str, int], str] = {}
        remaining_actionable = False
        try:
            edition = self._ensure_local_edition(provider)
            recorded_failures = self.ingestor.recorded_application_failures()
            pending = self._local_pending_captures()
            blocked_endpoints: set[str] = set()
            attempted = 0
            for endpoint, capture in pending:
                if endpoint == "trip_updates" and "vehicle_positions" in blocked_endpoints:
                    continue
                if endpoint in blocked_endpoints:
                    continue
                sig = application_input_signature(
                    endpoint, capture, provider_timezone=timezone, edition=edition
                )
                prior = recorded_failures.get((endpoint, capture.capture_row_id))
                if prior is not None and prior[0] == sig:
                    # Failed application already recorded for identical inputs (ruling 27.5).
                    deferred_failures[(endpoint, capture.capture_row_id)] = prior[1]
                    if endpoint != "trip_updates":
                        blocked_endpoints.add(endpoint)
                    continue
                if attempted >= self.settings.catchup_page_size:
                    remaining_actionable = True
                    continue
                attempted += 1
                started = self.ingestor.clock()
                try:
                    applied = self.recorder.apply(
                        endpoint,
                        capture.capture_row_id,
                        partial(self._apply, endpoint, capture),
                        capture=capture,
                    )
                except Exception as exc:
                    message = redact_error_message(str(exc))
                    failures[(endpoint, capture.capture_row_id)] = message
                    self.ingestor.record_application_failure(
                        endpoint,
                        capture,
                        error=exc,
                        started_at_utc=started,
                        input_signature=sig,
                    )
                    if endpoint != "trip_updates":
                        blocked_endpoints.add(endpoint)
                    continue
                self.ingestor.clear_application_failure(endpoint, capture.capture_row_id)
                if applied and endpoint == "trip_updates" and live_trip_updates is not None:
                    try:
                        payload = self.resolver(capture.storage_backend).read_bytes(
                            capture.storage_path
                        )
                        live_trip_updates.accept(
                            payload,
                            CaptureRef.from_entry(
                                capture, provider_id=provider, endpoint_key=endpoint
                            ),
                        )
                    except Exception as exc:
                        logger.error(
                            "Trip updates holder update failed: %s", redact_error_message(str(exc))
                        )
        finally:
            backend = self.settings.segment_storage_backend
            assert backend is not None
            # Pre-cutover local segments stay under the shadow prefix (live ruling 27.2).
            export_segment(
                self.local, self.resolver(backend), root_prefix=SHADOW_SEGMENTS_PREFIX
            )
        self.unavailable = (
            next(iter(failures.values()))
            if failures
            else next(iter(deferred_failures.values()))
            if deferred_failures
            else "local_application_pending"
            if remaining_actionable
            else None
        )
        return failures

    def _sync(self, *, current_run_ids: tuple[int, ...], project: bool) -> None:
        if self.engine is None:
            raise ValueError("live_recording_requires_engine")
        provider = self.manifest.provider.provider_id
        self._required_current.update(current_run_ids)
        self._current_batch.update(current_run_ids)
        records = self.recorder.catch_up(
            self.engine,
            page_size=self.settings.catchup_page_size,
            current_run_ids=tuple(self._required_current),
        )
        self._required_current.difference_update(
            p.ingestion_run_id for r in records for p in r.polls
        )
        self._required_current.difference_update(
            p.ingestion_run_id for r in records for p in r.processing
        )
        self._recovery_ready |= self.recorder.completed_upper is not None
        if self.recorder.completed_upper is not None:
            self._recovered_through = max(
                self._recovered_through or 0, self.recorder.completed_upper
            )
        if project and not self._required_current:
            self.recorder.ready_current(self._current_batch)
            self._current_batch.clear()
        try:
            failures = (
                self._apply_records(provider, (), through_run_id=self._recovered_through)
                if project and self._recovery_ready and not self._required_current
                else []
            )
        finally:
            # Pending cuts are retried even when edition loading/application fails.
            backend = self.settings.segment_storage_backend
            assert backend is not None
            export_segment(self.local, self.resolver(backend))
        if self._required_current:
            self.unavailable = "local_current_receipt_missing"
        elif not self._recovery_ready or self.recorder._due_runs(1):
            self.unavailable = "local_recovery_pending"
        else:
            self.unavailable = (
                failures[0]
                if failures
                else "local_application_pending"
                if self.recorder.pending_captures(1)
                else None
            )

    def _apply_records(
        self, provider: str, records: tuple[PollRecord, ...], *, through_run_id: int | None = None
    ) -> list[str]:
        # Direct batch callers share the same durable queue as paged recovery.
        for record in records:
            self.recorder.record(record)
        pending = self.recorder.pending_captures(
            self.settings.catchup_page_size,
            through_run_id=through_run_id,
            for_application=True,
        )
        self._ensure_edition(provider)
        if not pending:
            return []
        failures = []
        for endpoint, capture in pending:
            try:
                self.recorder.apply(
                    endpoint,
                    capture.capture_row_id,
                    partial(self._apply, endpoint, capture),
                    capture=capture,
                )
            except Exception as exc:
                failures.append(redact_error_message(str(exc)))
                # Stateful alerts must retain first-seen continuity; trip facts
                # must never finalize before an earlier required vehicle application.
                break
        return failures

    def _ensure_edition(self, provider: str) -> None:
        self.local.require_committed()
        if self.engine is None:
            raise ValueError("live_recording_requires_engine")
        with self.engine.connect() as pg:
            with pg.begin():
                pg.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
                edition = current_edition_id(pg, provider_id=provider)
                dimensions = current_dim_versions(pg, provider_id=provider)
            exists = self.local.connection.execute(
                "SELECT 1 FROM duckdb_tables() WHERE table_name='edition_meta' "
                "AND schema_name='main' AND database_name=current_database()"
            ).fetchone()
            loaded = loaded_edition(self.local.connection) if exists else None
            if loaded == edition and loaded is not None and loaded.dimension_versions == dimensions:
                return
            # The loader owns its idle transaction; never enter it from apply().
            load_edition_from_postgres(self.local.connection, pg, edition)

    def _apply(self, endpoint: str, capture: CaptureEntry) -> None:
        payload = self.resolver(capture.storage_backend).read_bytes(capture.storage_path)
        if len(payload) != capture.byte_size or sha256(payload).hexdigest() != capture.sha256:
            raise ValueError("capture_bytes_mismatch")
        provider = self.manifest.provider.provider_id
        timezone = self.manifest.provider.timezone
        if endpoint in ("vehicle_positions", "trip_updates"):
            if (
                endpoint == "trip_updates"
                and self.settings.ingress == "local"
                and self._loaded_local_edition(provider) is None
            ):
                raise EditionMissing("local_trip_updates_edition_missing")
            parsed = parse_capture(
                payload,
                CaptureRef.from_entry(capture, provider_id=provider, endpoint_key=endpoint),
                ParsePolicy.from_manifest(self.manifest),
            )
            apply_capture(self.local, parsed, provider_timezone=timezone)
        else:
            metadata = (
                extract_service_alerts_metadata
                if endpoint == "service_alerts"
                else extract_i3_metadata
            )(payload, provider_id=provider)
            result = apply_alert_snapshot(
                self.local,
                RawI3AlertSnapshot(
                    capture.capture_row_id,
                    provider,
                    timezone,
                    capture.captured_at_utc,
                    metadata.raw_payload_json,
                ),
                loaded_at_utc=capture.captured_at_utc,
            )
            if result.skipped_older_capture:
                raise ValueError(f"local_alert_repair_required:{capture.capture_row_id}")


def _verified_alert_seed(settings: LaneSettings, provider: str) -> AlertSeed:
    assert settings.alert_seed_path is not None
    payload = settings.alert_seed_path.read_bytes()
    if sha256(payload).hexdigest() != settings.alert_seed_sha256:
        raise ValueError("live_recording_alert_seed_digest_mismatch")
    seed = AlertSeed.from_json(payload)
    if seed.provider_id != provider:
        raise ValueError("live_recording_alert_seed_provider_mismatch")
    return seed


def _verified_seed(settings: LaneSettings, provider: str) -> tuple[AlertSeed, int]:
    for field in (
        "local_dir",
        "duckdb_memory_limit_mb",
        "duckdb_threads",
        "temp_dir_max_mb",
        "initial_cut_path",
        "initial_cut_sha256",
        "alert_seed_path",
        "alert_seed_sha256",
        "segment_storage_backend",
    ):
        if getattr(settings, field) is None:
            raise ValueError(f"live_recording_requires_{field}")
    seed = _verified_alert_seed(settings, provider)
    return seed, _verified_cut(settings, seed)


def _verified_cut(settings: LaneSettings, seed: AlertSeed) -> int:
    """Consume an operator-supplied cut bound to the exact seed, never infer a floor.

    This verifies the supplied artifact, not production coverage or approval.
    Its initial_run_id is an exclusive ingestion-run boundary; the supplying owner
    must certify that source retention and in-flight coverage include this cut.
    """
    assert settings.initial_cut_path is not None
    payload = settings.initial_cut_path.read_bytes()
    if sha256(payload).hexdigest() != settings.initial_cut_sha256:
        raise ValueError("live_recording_initial_cut_digest_mismatch")
    cut = json.loads(payload)
    expected = {
        "version": 1,
        "provider_id": seed.provider_id,
        "alert_seed_sha256": settings.alert_seed_sha256,
        "seed_snapshot_at_utc": seed.snapshot_at.isoformat(),
    }
    if not isinstance(cut, dict) or set(cut) != {*expected, "initial_run_id"}:
        raise ValueError("live_recording_initial_cut_shape_mismatch")
    initial = cut.pop("initial_run_id")
    if (
        cut != expected
        or type(cut["version"]) is not int
        or type(initial) is not int
        or not 0 <= initial < 2**63
    ):
        raise ValueError("live_recording_initial_cut_identity_mismatch")
    return initial


def _assert_ingress_mode(local: LocalFile, *, local_mode: bool) -> None:
    """Enforce sticky per-file ingress mode in both directions (live ruling 27.3)."""
    existing = {
        str(row[0])
        for row in local.connection.execute(
            "SELECT table_name FROM duckdb_tables() "
            "WHERE database_name=current_database() AND schema_name='main' AND NOT temporary"
        ).fetchall()
    }
    has_local_identity = bool(
        existing.intersection(
            ("local_identity_meta", "local_identity_namespaces", "local_identity_reservations")
        )
    )
    if not local_mode:
        if has_local_identity:
            raise LocalFileMismatch("ingress_mode_changed")
        return
    if not has_local_identity:
        has_pg_state = any(
            local.connection.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None
            for table in ("recording_cursor", "polls", "captures", "processing")
        )
        if has_pg_state:
            raise LocalFileMismatch("ingress_mode_changed")


def _ensure_local_cursor(
    recorder: Recorder, *, provider: str, initial_run_id: int, seed_sha256: str
) -> None:
    with recorder.local.transaction() as conn:
        rows = conn.execute("SELECT * FROM recording_cursor").fetchall()
        if not rows:
            recorder.initialize(initial_run_id=initial_run_id, seed_sha256=seed_sha256)
            return
        if (
            len(rows) != 1
            or rows[0][0] != provider
            or rows[0][4] != seed_sha256
            or int(rows[0][1]) != initial_run_id
        ):
            raise LocalFileMismatch("recording_initial_cut_or_seed_changed")


@contextmanager
def worker_state_scope(
    *,
    settings: LaneSettings,
    engine: Engine | None = None,
    manifest: ProviderManifest,
    resolver: BronzeStorageResolver,
    record_restart: bool = False,
    app_settings: Settings | None = None,
    edition_loader: Callable[[LocalFile, str], EditionId | None] | None = None,
) -> Iterator[WorkerState | None]:
    """Own the provider's worker file for this scope.

    ``record_restart`` is for the worker loop only: each of its reopens appends a restart
    record beside the file. One-shot cycles are not worker restarts and record nothing.
    """
    local_mode = settings.ingress == "local"
    if not settings.recording and not local_mode:
        yield None
        return
    provider = manifest.provider.provider_id
    if not provider or provider in (".", "..") or re.search(r"[\x00-\x1f]", provider):
        raise ValueError("live_recording_invalid_provider")
    if local_mode:
        from transit_ops.live.identity import IdentityAllocator, verify_identity_floors
        from transit_ops.live.ingest import LocalIngestor, validate_local_ingress_settings

        validate_local_ingress_settings(settings)
        if app_settings is None:
            raise ValueError("local_ingress_requires_app_settings")
        seed = _verified_alert_seed(settings, provider)
        initial_run_id = _verified_cut(settings, seed)
        assert settings.identity_floors_path is not None
        assert settings.identity_floors_sha256 is not None
        assert settings.alert_seed_sha256 is not None
        floors = verify_identity_floors(
            settings.identity_floors_path,
            expected_sha256=settings.identity_floors_sha256,
            seed=seed,
            alert_seed_sha256=settings.alert_seed_sha256,
            initial_cut_run_id=initial_run_id,
        )
    else:
        seed, initial_run_id = _verified_seed(settings, provider)
        floors = None
    assert settings.local_dir is not None
    settings.local_dir.mkdir(parents=True, exist_ok=True)
    path = settings.local_dir / ("provider-" + quote(provider, safe="") + ".duckdb")
    local = open_worker_file(
        path,
        provider_id=provider,
        settings=settings,
        restart_evidence=restart_evidence_path(path) if record_restart else None,
    )
    try:
        _assert_ingress_mode(local, local_mode=local_mode)
        seed_alert_state(local, seed)
        assert settings.alert_seed_sha256 is not None
        if local_mode:
            assert floors is not None and app_settings is not None
            assert settings.identity_floors_sha256 is not None
            assert settings.segment_storage_backend is not None
            segment_storage = resolver(settings.segment_storage_backend)
            allocator = IdentityAllocator(local, provider_id=provider, watermark_database=path)
            allocator.initialize(
                floors,
                floors_sha256=settings.identity_floors_sha256,
                seed=seed,
                alert_seed_sha256=settings.alert_seed_sha256,
                segment_storage=segment_storage,
                watermark_database=path,
            )
            recorder = Recorder(local, provider_id=provider)
            _ensure_local_cursor(
                recorder,
                provider=provider,
                initial_run_id=initial_run_id,
                seed_sha256=settings.alert_seed_sha256,
            )
            spool_dir = settings.local_dir / ("spool-" + quote(provider, safe=""))
            ingestor = LocalIngestor(
                local,
                manifest=manifest,
                settings=app_settings,
                resolver=resolver,
                spool_dir=spool_dir,
                recorder=recorder,
                allocator=allocator,
            )
            # Startup crash recovery: finish committed spools and sweep uncommitted orphans.
            ingestor.resume_pending()
            state = WorkerState(
                local,
                engine=engine,
                manifest=manifest,
                settings=settings,
                resolver=resolver,
                ingestor=ingestor,
                edition_loader=edition_loader,
            )
            yield state
        else:
            state = WorkerState(
                local, engine=engine, manifest=manifest, settings=settings, resolver=resolver
            )
            state.recorder.initialize(
                initial_run_id=initial_run_id, seed_sha256=settings.alert_seed_sha256
            )
            yield state
    finally:
        local.close()
