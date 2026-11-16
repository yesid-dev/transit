"""One worker-owned LocalFile; PostgreSQL remains the public authority."""

import json
import logging
import re
from collections.abc import Iterator
from contextlib import contextmanager
from functools import partial
from hashlib import sha256
from urllib.parse import quote

from sqlalchemy import Engine

from transit_ops.core.models import ProviderManifest
from transit_ops.history.poll_record import CaptureEntry, PollRecord
from transit_ops.ingestion.common import redact_error_message
from transit_ops.ingestion.i3 import extract_i3_metadata, extract_service_alerts_metadata
from transit_ops.ingestion.storage import BronzeStorageResolver
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.edition import current_edition_id, load_edition_from_postgres
from transit_ops.live.facts import apply_capture
from transit_ops.live.local_file import LocalFile
from transit_ops.live.recording import Recorder
from transit_ops.live.segments import export_segment
from transit_ops.live.settings import LaneSettings
from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import AlertSeed
from transit_ops.static.alert_state import seed_alert_state

logger = logging.getLogger(__name__)


class WorkerState:
    def __init__(
        self,
        local: LocalFile,
        *,
        engine: Engine,
        manifest: ProviderManifest,
        settings: LaneSettings,
        resolver: BronzeStorageResolver,
    ):
        self.local, self.engine, self.manifest = local, engine, manifest
        self.settings, self.resolver = settings, resolver
        self.recorder = Recorder(local, provider_id=manifest.provider.provider_id)
        self.unavailable: str | None = "local_not_observed"

    def sync(self) -> None:
        """Observe all terminal outcomes; a local error never falsifies PG success."""
        try:
            self._sync()
        except Exception as exc:
            self.unavailable = redact_error_message(str(exc))
            logger.error("Local recording unavailable: %s", self.unavailable)

    def _sync(self) -> None:
        provider = self.manifest.provider.provider_id
        records = self.recorder.catch_up(self.engine, page_size=self.settings.catchup_page_size)
        try:
            failures = self._apply_records(provider, records)
        finally:
            # Pending cuts are retried even when edition loading/application fails.
            backend = self.settings.segment_storage_backend
            assert backend is not None
            export_segment(self.local, self.resolver(backend))
        pending = self.local.connection.execute(
            "SELECT 1 FROM local_applications WHERE status='failed' LIMIT 1"
        ).fetchone()
        self.unavailable = (
            failures[0] if failures else "local_application_failed" if pending else None
        )

    def _apply_records(self, provider: str, records: tuple[PollRecord, ...]) -> list[str]:
        # Edition loader owns its own idle transactions on both connections.
        with self.engine.connect() as pg:
            edition = current_edition_id(pg, provider_id=provider)
            pg.rollback()
            load_edition_from_postgres(self.local.connection, pg, edition)
        failures = []
        for record in records:
            for capture in record.captures:
                endpoint = record.feed_day.endpoint_key
                try:
                    self.recorder.apply(
                        endpoint,
                        capture.capture_row_id,
                        partial(self._apply, endpoint, capture),
                        capture=capture,
                    )
                except Exception as exc:
                    failures.append(redact_error_message(str(exc)))
        return failures

    def _apply(self, endpoint: str, capture: CaptureEntry) -> None:
        payload = self.resolver(capture.storage_backend).read_bytes(capture.storage_path)
        if len(payload) != capture.byte_size or sha256(payload).hexdigest() != capture.sha256:
            raise ValueError("capture_bytes_mismatch")
        provider = self.manifest.provider.provider_id
        timezone = self.manifest.provider.timezone
        if endpoint in ("vehicle_positions", "trip_updates"):
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
            apply_alert_snapshot(
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
    assert settings.alert_seed_path is not None
    payload = settings.alert_seed_path.read_bytes()
    if sha256(payload).hexdigest() != settings.alert_seed_sha256:
        raise ValueError("live_recording_alert_seed_digest_mismatch")
    seed = AlertSeed.from_json(payload)
    if seed.provider_id != provider:
        raise ValueError("live_recording_alert_seed_provider_mismatch")
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


@contextmanager
def worker_state_scope(
    *,
    settings: LaneSettings,
    engine: Engine,
    manifest: ProviderManifest,
    resolver: BronzeStorageResolver,
) -> Iterator[WorkerState | None]:
    if not settings.recording:
        yield None
        return
    provider = manifest.provider.provider_id
    if not provider or provider in (".", "..") or re.search(r"[\x00-\x1f]", provider):
        raise ValueError("live_recording_invalid_provider")
    seed, initial_run_id = _verified_seed(settings, provider)
    assert settings.local_dir is not None
    settings.local_dir.mkdir(parents=True, exist_ok=True)
    local = LocalFile.open(
        settings.local_dir / ("provider-" + quote(provider, safe="") + ".duckdb"),
        provider_id=provider,
        settings=settings,
    )
    try:
        seed_alert_state(local, seed)
        state = WorkerState(
            local, engine=engine, manifest=manifest, settings=settings, resolver=resolver
        )
        assert settings.alert_seed_sha256 is not None
        state.recorder.initialize(
            initial_run_id=initial_run_id, seed_sha256=settings.alert_seed_sha256
        )
        yield state
    finally:
        local.close()
