"""Local capture mode: single HTTP fetch, durable verified spool, and canonical recording.

Borrows the worker's single LocalFile owner and records every outcome (stored, failed,
duplicate, empty, corrected, and failed local applications) through Recorder.
Uses no PostgreSQL connection, clock, or write, and never prunes Bronze bytes.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import ssl
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final, Literal, cast
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlsplit
from uuid import uuid4

from transit_ops.core.models import ProviderManifest
from transit_ops.history.poll_record import (
    CaptureEntry,
    FeedDayKey,
    PollEntry,
    PollRecord,
    ProcessingEntry,
    validate_record,
)
from transit_ops.ingestion.common import (
    REDACTED_PLACEHOLDER,
    DownloadedArtifact,
    capture_deadline,
    check_capture_deadline,
    download_to_tempfile,
    redact_error_message,
    utc_now,
)
from transit_ops.ingestion.i3 import (
    I3IngestionConfig,
    build_i3_ingestion_config,
    build_i3_object_storage_path,
    build_service_alerts_ingestion_config,
    build_service_alerts_object_storage_path,
    extract_i3_metadata,
    extract_service_alerts_metadata,
)
from transit_ops.ingestion.realtime_gtfs import (
    RealtimeIngestionConfig,
    _build_realtime_ssl_context,
    build_realtime_ingestion_config,
    build_realtime_object_storage_path,
    extract_realtime_metadata,
)
from transit_ops.ingestion.storage import BronzeStorageResolver
from transit_ops.lake.objects import ObjectKeyTaken, object_digest, put_create_only
from transit_ops.live.edition import EditionId
from transit_ops.live.identity import IdentityAllocator, IdentityReservation
from transit_ops.live.local_file import LocalFile, LocalFileMismatch, _table_shape
from transit_ops.live.recording import Recorder
from transit_ops.live.settings import LaneSettings
from transit_ops.s3 import ObjectStorageError
from transit_ops.settings import Settings

SPOOL_FORMAT_VERSION: Final = 1
_SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")
_ATTEMPT_KEY_RE: Final = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_REALTIME_ENDPOINTS: Final = frozenset({"trip_updates", "vehicle_positions"})
_ALERT_ENDPOINTS: Final = frozenset({"i3_alerts", "service_alerts"})
_ALL_ENDPOINTS: Final = _REALTIME_ENDPOINTS | _ALERT_ENDPOINTS
_BENIGN_HEADERS: Final = frozenset({"accept", "user-agent"})
_APP_FAILURE_TABLE: Final = "local_application_failures"
_APP_FAILURE_DEF: Final = (
    "endpoint_key VARCHAR NOT NULL, "
    "capture_row_id BIGINT NOT NULL, "
    "input_signature VARCHAR NOT NULL, "
    "ingestion_run_id BIGINT NOT NULL CHECK(ingestion_run_id > 0), "
    "error_message VARCHAR NOT NULL, "
    "PRIMARY KEY(endpoint_key, capture_row_id)"
)

LOCAL_INGRESS_REQUIRED_FIELDS: Final[tuple[str, ...]] = (
    "initial_cut_path",
    "initial_cut_sha256",
    "alert_seed_path",
    "alert_seed_sha256",
    "identity_floors_path",
    "identity_floors_sha256",
    "local_dir",
    "duckdb_memory_limit_mb",
    "duckdb_threads",
    "temp_dir_max_mb",
    "segment_storage_backend",
)

type CommitStage = Literal["spool", "bronze", "identity", "record"]
type CaptureOutcomeKind = Literal["stored", "failed"]
type EndpointConfig = RealtimeIngestionConfig | I3IngestionConfig
type Fetcher = Callable[..., DownloadedArtifact]


class LocalIngestRefused(ValueError):
    """Named refusal for incomplete or invalid local ingress configuration."""


class LocalIngestIntegrityError(RuntimeError):
    """Corrupt spool, torn bytes, immutable-byte conflict, or missing spool evidence."""


def validate_local_ingress_settings(settings: LaneSettings) -> None:
    """Refuse by name unless a role owns local ingress and all cut/seed/floor inputs exist."""
    if settings.shadow == "off":
        raise LocalIngestRefused("local_ingress_requires_shadow_role")
    if settings.shadow == "postgres_authoritative":
        raise LocalIngestRefused("postgres_authoritative_forbids_local_ingress")
    for field_name in LOCAL_INGRESS_REQUIRED_FIELDS:
        value = getattr(settings, field_name, None)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise LocalIngestRefused(f"local_ingress_requires_{field_name}")
    for digest_field in ("initial_cut_sha256", "alert_seed_sha256", "identity_floors_sha256"):
        digest = getattr(settings, digest_field)
        if not isinstance(digest, str) or _SHA256_RE.fullmatch(digest) is None:
            raise LocalIngestRefused(f"local_ingress_invalid_{digest_field}")


def application_input_signature(
    endpoint_key: str,
    capture: CaptureEntry,
    *,
    provider_timezone: str,
    edition: EditionId | None,
) -> str:
    """Deterministic fingerprint of the inputs needed to apply one capture."""
    edition_key: object = (
        None
        if endpoint_key != "trip_updates" or edition is None
        else [
            edition.provider_id,
            edition.dataset_version_id,
            edition.source_version,
            list(edition.dimension_versions),
        ]
    )
    return hashlib.sha256(
        _canonical_json(
            {
                "endpoint_key": endpoint_key,
                "capture_row_id": capture.capture_row_id,
                "sha256": capture.sha256,
                "byte_size": capture.byte_size,
                "provider_timezone": provider_timezone,
                "edition": edition_key,
            }
        )
    ).hexdigest()


@dataclass(frozen=True)
class LocalCaptureOutcome:
    provider_id: str
    endpoint_key: str
    index_family: str
    attempt_key: str
    outcome: CaptureOutcomeKind
    ingestion_run_id: int
    ingestion_object_id: int | None
    capture_row_id: int | None
    duplicate_of_row_id: int | None
    storage_backend: str | None
    storage_path: str | None
    byte_size: int | None
    sha256: str | None
    http_status_code: int | None
    error_message: str | None
    started_at_utc: datetime
    completed_at_utc: datetime
    feed_timestamp_utc: datetime | None
    feed_timestamp_source: str | None
    entity_count: int | None
    api_version: str | None
    alert_count: int | None
    capture_entry: CaptureEntry | None
    resumed_from_spool: bool = False

    def display_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "provider_id": self.provider_id,
            "endpoint_key": self.endpoint_key,
            "index_family": self.index_family,
            "attempt_key": self.attempt_key,
            "outcome": self.outcome,
            "status": "failed" if self.outcome == "failed" else "succeeded",
            "ingestion_run_id": self.ingestion_run_id,
            "ingestion_object_id": self.ingestion_object_id,
            "capture_row_id": self.capture_row_id,
            "duplicate_of_row_id": self.duplicate_of_row_id,
            "storage_backend": self.storage_backend,
            "storage_path": self.storage_path,
            "byte_size": self.byte_size,
            "checksum_sha256": self.sha256,
            "http_status_code": self.http_status_code,
            "error_message": self.error_message,
            "started_at_utc": self.started_at_utc.isoformat(),
            "completed_at_utc": self.completed_at_utc.isoformat(),
            "feed_timestamp_utc": (
                self.feed_timestamp_utc.isoformat()
                if self.feed_timestamp_utc is not None
                else None
            ),
            "feed_timestamp_source": self.feed_timestamp_source,
            "entity_count": self.entity_count,
            "api_version": self.api_version,
            "alert_count": self.alert_count,
            "resumed_from_spool": self.resumed_from_spool,
        }
        if self.index_family == "realtime_snapshot":
            payload["realtime_snapshot_id"] = self.capture_row_id
        else:
            payload["i3_alert_snapshot_id"] = self.capture_row_id
        return payload


@dataclass(frozen=True)
class _SpoolReceipt:
    version: int
    provider_id: str
    endpoint_key: str
    index_family: str
    attempt_key: str
    outcome: CaptureOutcomeKind
    run_kind: str
    declared_interval_seconds: int | None
    started_at_utc: datetime
    completed_at_utc: datetime
    http_status_code: int | None
    error_message: str | None
    storage_backend: str | None
    storage_path: str | None
    object_kind: str | None
    source_url: str | None
    byte_size: int | None
    sha256: str | None
    feed_timestamp_utc: datetime | None
    feed_timestamp_source: str | None
    entity_count: int | None
    api_version: str | None
    alert_count: int | None
    duplicate_of_row_id: int | None
    receipt_sha256: str

    def to_json(self) -> bytes:
        body = _receipt_body(self) | {"receipt_sha256": self.receipt_sha256}
        return _canonical_json(body)

    @classmethod
    def create(cls, **fields: Any) -> _SpoolReceipt:
        temp = cls(**fields, receipt_sha256="0" * 64)
        digest = hashlib.sha256(_canonical_json(_receipt_body(temp))).hexdigest()
        return cls(**fields, receipt_sha256=digest)

    @classmethod
    def from_json(cls, payload: bytes, *, expected_provider: str) -> _SpoolReceipt:
        try:
            raw = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:json") from exc
        if not isinstance(raw, dict):
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:shape")
        version = raw.get("version")
        if type(version) is not int or version != SPOOL_FORMAT_VERSION:
            raise LocalIngestIntegrityError(f"local_ingest_spool_version_unsupported:{version!r}")
        supplied_digest = raw.get("receipt_sha256")
        if not isinstance(supplied_digest, str) or _SHA256_RE.fullmatch(supplied_digest) is None:
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:digest")
        body = {k: v for k, v in raw.items() if k != "receipt_sha256"}
        expected_fields = set(cls.__dataclass_fields__) - {"receipt_sha256"}
        if set(body) != expected_fields:
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:fields")
        if hashlib.sha256(_canonical_json(body)).hexdigest() != supplied_digest:
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:digest_mismatch")
        if body["provider_id"] != expected_provider:
            raise LocalIngestIntegrityError("local_ingest_spool_provider_mismatch")
        if body["outcome"] not in ("stored", "failed"):
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:outcome")
        if body["endpoint_key"] not in _ALL_ENDPOINTS:
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:endpoint")
        try:
            started = _parse_utc(body["started_at_utc"])
            completed = _parse_utc(body["completed_at_utc"])
            raw_feed_ts = body["feed_timestamp_utc"]
            feed_ts = None if raw_feed_ts is None else _parse_utc(raw_feed_ts)
        except ValueError as exc:
            raise LocalIngestIntegrityError("local_ingest_spool_corrupt:timestamp") from exc
        return cls(
            version=version,
            provider_id=str(body["provider_id"]),
            endpoint_key=str(body["endpoint_key"]),
            index_family=str(body["index_family"]),
            attempt_key=str(body["attempt_key"]),
            outcome=cast(CaptureOutcomeKind, body["outcome"]),
            run_kind=str(body["run_kind"]),
            declared_interval_seconds=body["declared_interval_seconds"],
            started_at_utc=started,
            completed_at_utc=completed,
            http_status_code=body["http_status_code"],
            error_message=body["error_message"],
            storage_backend=body["storage_backend"],
            storage_path=body["storage_path"],
            object_kind=body["object_kind"],
            source_url=body["source_url"],
            byte_size=body["byte_size"],
            sha256=body["sha256"],
            feed_timestamp_utc=feed_ts,
            feed_timestamp_source=body["feed_timestamp_source"],
            entity_count=body["entity_count"],
            api_version=body["api_version"],
            alert_count=body["alert_count"],
            duplicate_of_row_id=body["duplicate_of_row_id"],
            receipt_sha256=supplied_digest,
        )


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _iso_utc(stamp: datetime) -> str:
    if stamp.utcoffset() is None:
        raise ValueError("naive timestamp")
    return stamp.astimezone(UTC).isoformat(timespec="microseconds")


def _parse_utc(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp must be ISO string")
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() is None:
        raise ValueError("naive timestamp")
    return parsed.astimezone(UTC)


def _receipt_body(receipt: _SpoolReceipt) -> dict[str, object]:
    data = asdict(receipt)
    data.pop("receipt_sha256", None)
    data["started_at_utc"] = _iso_utc(receipt.started_at_utc)
    data["completed_at_utc"] = _iso_utc(receipt.completed_at_utc)
    data["feed_timestamp_utc"] = (
        None if receipt.feed_timestamp_utc is None else _iso_utc(receipt.feed_timestamp_utc)
    )
    return data


def _file_digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _write_file_durable(target: Path, payload: bytes) -> None:
    """Write via exclusive temp file, fsync, and atomic replace (POSIX also fsyncs dir)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        if os.name != "nt":
            descriptor = os.open(target.parent, os.O_RDONLY | cast(Any, os).O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _endpoint_family(endpoint_key: str) -> str:
    if endpoint_key in _REALTIME_ENDPOINTS:
        return "realtime_snapshot"
    if endpoint_key in _ALERT_ENDPOINTS:
        return "alert_snapshot"
    raise LocalIngestRefused(f"local_ingest_unknown_endpoint:{endpoint_key}")


def _build_endpoint_config(
    manifest: ProviderManifest, settings: Settings, endpoint_key: str
) -> tuple[EndpointConfig, str, ssl.SSLContext | None]:
    if endpoint_key in _REALTIME_ENDPOINTS:
        config: EndpointConfig = build_realtime_ingestion_config(manifest, settings, endpoint_key)
        return config, f"{endpoint_key}.pb", _build_realtime_ssl_context()
    if endpoint_key == "i3_alerts":
        return build_i3_ingestion_config(manifest, settings), "i3_alerts.json", None
    if endpoint_key == "service_alerts":
        return build_service_alerts_ingestion_config(manifest, settings), "service_alerts.pb", None
    raise LocalIngestRefused(f"local_ingest_unknown_endpoint:{endpoint_key}")


def _config_secrets(config: EndpointConfig) -> tuple[str, ...]:
    secrets: set[str] = set()
    for name, value in config.request_headers.items():
        if name.lower() not in _BENIGN_HEADERS and value:
            secrets.add(value)
    base_params = set(parse_qsl(urlsplit(config.source_url).query, keep_blank_values=True))
    for key, value in parse_qsl(urlsplit(config.request_url).query, keep_blank_values=True):
        if value and (key, value) not in base_params:
            secrets.add(value)
    return tuple(sorted(secrets, key=len, reverse=True))


def _redact(message: str, secrets: tuple[str, ...] = ()) -> str:
    redacted = message
    for secret in secrets:
        redacted = redacted.replace(secret, REDACTED_PLACEHOLDER)
    return redact_error_message(redacted)[:2000]


def _storage_path_for(
    endpoint_key: str, *, provider_id: str, started_at_utc: datetime, checksum: str
) -> str:
    if endpoint_key in _REALTIME_ENDPOINTS:
        return build_realtime_object_storage_path(
            provider_id=provider_id,
            endpoint_key=endpoint_key,
            captured_at_utc=started_at_utc,
            checksum_sha256=checksum,
        )
    if endpoint_key == "i3_alerts":
        return build_i3_object_storage_path(
            provider_id=provider_id,
            captured_at_utc=started_at_utc,
            checksum_sha256=checksum,
        )
    if endpoint_key == "service_alerts":
        return build_service_alerts_object_storage_path(
            provider_id=provider_id,
            captured_at_utc=started_at_utc,
            checksum_sha256=checksum,
        )
    raise LocalIngestRefused(f"local_ingest_unknown_endpoint:{endpoint_key}")


def _build_poll_record(
    receipt: _SpoolReceipt, reservation: IdentityReservation
) -> tuple[PollRecord, CaptureEntry | None]:
    day = FeedDayKey(
        provider_id=receipt.provider_id,
        endpoint_key=receipt.endpoint_key,
        index_family=receipt.index_family,
        utc_date=receipt.started_at_utc.astimezone(UTC).date(),
    )
    capture: CaptureEntry | None = None
    if receipt.outcome == "stored":
        assert reservation.ingestion_object_id is not None
        assert reservation.capture_row_id is not None
        assert receipt.byte_size is not None and receipt.sha256 is not None
        assert receipt.storage_backend is not None and receipt.storage_path is not None
        assert receipt.object_kind is not None
        assert receipt.feed_timestamp_utc is not None and receipt.feed_timestamp_source is not None
        capture = CaptureEntry(
            index_family=receipt.index_family,
            capture_row_id=reservation.capture_row_id,
            ingestion_run_id=reservation.ingestion_run_id,
            ingestion_object_id=reservation.ingestion_object_id,
            packed=False,
            stream=None,
            offset=None,
            byte_size=receipt.byte_size,
            sha256=receipt.sha256,
            storage_backend=receipt.storage_backend,
            storage_path=receipt.storage_path,
            object_kind=receipt.object_kind,
            source_url=receipt.source_url,
            object_created_at_utc=receipt.completed_at_utc,
            started_at_utc=receipt.started_at_utc,
            captured_at_utc=receipt.completed_at_utc,
            feed_timestamp_utc=receipt.feed_timestamp_utc,
            feed_timestamp_source=receipt.feed_timestamp_source,
            entity_count=receipt.entity_count,
            http_status_code=receipt.http_status_code,
            api_version=receipt.api_version,
            alert_count=receipt.alert_count,
        )
        poll = PollEntry(
            ingestion_run_id=reservation.ingestion_run_id,
            run_kind=receipt.run_kind,
            status="stored",
            run_status="succeeded",
            requested_at_utc=receipt.started_at_utc,
            started_at_utc=receipt.started_at_utc,
            completed_at_utc=receipt.completed_at_utc,
            time_utc=receipt.completed_at_utc,
            http_status_code=receipt.http_status_code,
            error_message=None,
            feed_timestamp_utc=receipt.feed_timestamp_utc,
            feed_timestamp_source=receipt.feed_timestamp_source,
            entity_count=receipt.entity_count,
            index_family=receipt.index_family,
            capture_row_id=reservation.capture_row_id,
            duplicate_of_row_id=None,
            missing_reason=None,
        )
    else:
        poll = PollEntry(
            ingestion_run_id=reservation.ingestion_run_id,
            run_kind=receipt.run_kind,
            status="failed",
            run_status="failed",
            requested_at_utc=receipt.started_at_utc,
            started_at_utc=receipt.started_at_utc,
            completed_at_utc=receipt.completed_at_utc,
            time_utc=receipt.completed_at_utc,
            http_status_code=receipt.http_status_code,
            error_message=receipt.error_message,
            feed_timestamp_utc=None,
            feed_timestamp_source=None,
            entity_count=None,
            index_family=receipt.index_family,
            capture_row_id=None,
            duplicate_of_row_id=None,
            missing_reason=None,
        )
    record = PollRecord(
        feed_day=day,
        polls=(poll,),
        captures=(capture,) if capture is not None else (),
        processing=(),
        declared_interval_seconds=receipt.declared_interval_seconds,
        observed_interval_ms=None,
    )
    validate_record(record)
    return record, capture


class LocalIngestor:
    """Single-owner local ingress with crash-safe spool, identity, and record commits."""

    def __init__(
        self,
        local: LocalFile,
        *,
        manifest: ProviderManifest,
        settings: Settings,
        resolver: BronzeStorageResolver,
        spool_dir: Path,
        recorder: Recorder | None = None,
        allocator: IdentityAllocator | None = None,
        clock: Callable[[], datetime] = utc_now,
        fetcher: Fetcher | None = None,
        after_commit: Callable[[CommitStage], None] | None = None,
    ) -> None:
        self.local = local
        self.manifest = manifest
        self.provider_id = manifest.provider.provider_id
        self.settings = settings
        self.resolver = resolver
        self.spool_dir = spool_dir
        self.recorder = recorder or Recorder(local, provider_id=self.provider_id)
        self.allocator = allocator or IdentityAllocator(local, provider_id=self.provider_id)
        self.clock = clock
        self.fetcher = download_to_tempfile if fetcher is None else fetcher
        self.after_commit = after_commit

    def _receipt_path(self, attempt_key: str) -> Path:
        return self.spool_dir / f"{attempt_key}.spool.json"

    def _payload_path(self, attempt_key: str) -> Path:
        return self.spool_dir / f"{attempt_key}.payload"

    def _pending_spools(self, *, endpoint_key: str | None = None) -> list[_SpoolReceipt]:
        if not self.spool_dir.is_dir():
            return []
        receipts: list[_SpoolReceipt] = []
        for path in sorted(self.spool_dir.glob("*.spool.json")):
            try:
                raw = path.read_bytes()
            except OSError as exc:
                raise LocalIngestIntegrityError(
                    f"local_ingest_spool_unreadable:{path.name}"
                ) from exc
            receipt = _SpoolReceipt.from_json(raw, expected_provider=self.provider_id)
            if path.name != f"{receipt.attempt_key}.spool.json":
                raise LocalIngestIntegrityError("local_ingest_spool_corrupt:filename_mismatch")
            if endpoint_key is None or receipt.endpoint_key == endpoint_key:
                receipts.append(receipt)
        receipts.sort(key=lambda r: (r.started_at_utc, r.attempt_key))
        return receipts

    def _check_unrecorded_reservations(
        self, *, endpoint_key: str | None, pending: list[_SpoolReceipt]
    ) -> None:
        present = {r.attempt_key for r in pending}
        for reservation in self.allocator.unrecorded_reservations(endpoint_key=endpoint_key):
            if reservation.outcome == "silver_load_failed":
                continue
            if reservation.attempt_key not in present:
                raise LocalIngestIntegrityError(
                    f"local_ingest_spool_missing:{reservation.attempt_key}"
                )

    def _verify_recorded_bronze(self, reservation: IdentityReservation) -> None:
        if reservation.outcome != "stored":
            return
        assert reservation.capture_row_id is not None
        row = self.local.connection.execute(
            "SELECT storage_backend, storage_path, sha256, byte_size FROM captures "
            "WHERE index_family=? AND capture_row_id=?",
            [reservation.index_family, reservation.capture_row_id],
        ).fetchone()
        if row is None:
            raise LocalIngestIntegrityError("local_ingest_recorded_row_missing:capture")
        backend, path, expected_sha, expected_size = (
            str(row[0]),
            str(row[1]),
            str(row[2]),
            int(row[3]),
        )
        try:
            actual = object_digest(self.resolver(backend), path)
        except Exception as exc:
            raise LocalIngestIntegrityError("local_ingest_torn_bytes:bronze_readback") from exc
        if actual != (expected_sha, expected_size):
            raise LocalIngestIntegrityError("local_ingest_torn_bytes:bronze_readback")

    def cleanup_orphans(self) -> None:
        """Sweep uncommitted orphan staging files under the owner lock (never touch Bronze)."""
        self.local.require_committed()
        if not self.spool_dir.is_dir():
            return
        tmp_dir = self.spool_dir / ".tmp"
        if tmp_dir.is_dir():
            for entry in list(tmp_dir.iterdir()):
                if entry.is_file():
                    entry.unlink(missing_ok=True)
        for leftover in self.spool_dir.glob("*.tmp"):
            if leftover.is_file():
                leftover.unlink(missing_ok=True)
        for payload_path in sorted(self.spool_dir.glob("*.payload")):
            attempt_key = payload_path.name.removesuffix(".payload")
            if self._receipt_path(attempt_key).exists():
                continue
            if _ATTEMPT_KEY_RE.fullmatch(attempt_key) is not None:
                existing = self.allocator.get_reservation(attempt_key)
                if existing is not None:
                    if not existing.recorded:
                        continue
                    self._verify_recorded_bronze(existing)
            payload_path.unlink(missing_ok=True)

    def resume_pending(self, *, endpoint_key: str | None = None) -> tuple[LocalCaptureOutcome, ...]:
        """Complete every committed local spool without issuing any HTTP request."""
        self.local.require_committed()
        self.allocator.require_initialized()
        self.cleanup_orphans()
        pending = self._pending_spools(endpoint_key=endpoint_key)
        self._check_unrecorded_reservations(endpoint_key=endpoint_key, pending=pending)
        return tuple(self._finish_spooled(receipt, resumed=True) for receipt in pending)

    def capture_endpoint(
        self,
        endpoint_key: str,
        *,
        attempt_key: str | None = None,
    ) -> LocalCaptureOutcome:
        """Fetch one endpoint once, durably spool verified bytes, allocate IDs, and record."""
        self.local.require_committed()
        self.allocator.require_initialized()
        _endpoint_family(endpoint_key)
        if attempt_key is not None and _ATTEMPT_KEY_RE.fullmatch(attempt_key) is None:
            raise LocalIngestRefused("local_ingest_invalid_attempt_key")

        # 1. Explicit attempt retry: verify Bronze before cleaning staging, return with zero HTTP.
        if attempt_key is not None:
            existing = self.allocator.get_reservation(attempt_key)
            if existing is not None:
                if existing.endpoint_key != endpoint_key:
                    raise LocalIngestIntegrityError("local_ingest_attempt_endpoint_mismatch")
                if existing.outcome == "silver_load_failed":
                    raise LocalIngestIntegrityError("local_ingest_attempt_outcome_mismatch")
                if existing.recorded:
                    self._verify_recorded_bronze(existing)
                    self._cleanup_staging(attempt_key)
                    return self._recorded_outcome(existing)

        # 2. Drain any pending committed spool for this endpoint before issuing fresh HTTP work.
        pending = self._pending_spools(endpoint_key=endpoint_key)
        self._check_unrecorded_reservations(endpoint_key=endpoint_key, pending=pending)
        if pending:
            if attempt_key is not None:
                matching = [r for r in pending if r.attempt_key == attempt_key]
                if matching:
                    return self._finish_spooled(matching[0], resumed=True)
            for earlier in pending:
                self._finish_spooled(earlier, resumed=True)

        # 3. Fresh single HTTP fetch + Commit 1 (durable spool).
        key = attempt_key or uuid4().hex
        receipt = self._fetch_and_spool(endpoint_key, attempt_key=key)
        if self.after_commit is not None:
            self.after_commit("spool")
        return self._finish_spooled(receipt, resumed=False)

    def _fetch_and_spool(self, endpoint_key: str, *, attempt_key: str) -> _SpoolReceipt:
        family = _endpoint_family(endpoint_key)
        config, default_filename, ssl_context = _build_endpoint_config(
            self.manifest, self.settings, endpoint_key
        )
        secrets = _config_secrets(config)
        safe_source_url = _redact(config.source_url, secrets)
        started_at_utc = self.clock()
        if started_at_utc.utcoffset() is None:
            raise LocalIngestRefused("local_ingest_naive_clock")
        deadline = capture_deadline()
        artifact: DownloadedArtifact | None = None
        payload: bytes | None = None
        actual_sha: str | None = None
        http_status_code: int | None = None
        completed_at_utc = started_at_utc.astimezone(UTC)
        feed_ts: datetime | None = None
        feed_ts_source: str | None = None
        entity_count: int | None = None
        api_version: str | None = None
        alert_count: int | None = None
        fetch_error: Exception | None = None
        try:
            artifact = self.fetcher(
                source_url=config.request_url,
                temp_dir=self.spool_dir / ".tmp",
                headers=config.request_headers,
                default_filename=default_filename,
                ssl_context=ssl_context,
                deadline=deadline,
            )
            http_status_code = artifact.http_status_code
            payload = artifact.temp_path.read_bytes()
            actual_sha = hashlib.sha256(payload).hexdigest()
            if len(payload) != artifact.byte_size or actual_sha != artifact.checksum_sha256:
                raise ValueError("local_ingest_torn_bytes:download")
            check_capture_deadline(deadline)
            completed_at_utc = max(self.clock().astimezone(UTC), started_at_utc.astimezone(UTC))
            if family == "realtime_snapshot":
                rt_meta = extract_realtime_metadata(
                    payload, provider_id=self.provider_id, endpoint_key=endpoint_key
                )
                feed_ts = rt_meta.feed_timestamp_utc or completed_at_utc
                feed_ts_source = (
                    "header" if rt_meta.feed_timestamp_utc is not None else "capture_time"
                )
                entity_count = rt_meta.entity_count
            else:
                al_meta = (
                    extract_service_alerts_metadata
                    if endpoint_key == "service_alerts"
                    else extract_i3_metadata
                )(payload, provider_id=self.provider_id)
                feed_ts = completed_at_utc
                feed_ts_source = "capture_time"
                entity_count = al_meta.alert_count
                api_version = al_meta.api_version
                alert_count = al_meta.alert_count
        except (LocalIngestIntegrityError, LocalIngestRefused):
            raise
        except Exception as exc:
            fetch_error = exc
        finally:
            if artifact is not None:
                artifact.temp_path.unlink(missing_ok=True)

        if fetch_error is not None:
            completed_at_utc = max(self.clock().astimezone(UTC), started_at_utc.astimezone(UTC))
            http_status = (
                fetch_error.code if isinstance(fetch_error, HTTPError) else http_status_code
            )
            raw_message = (
                f"HTTP {fetch_error.code}: {fetch_error.reason}"
                if isinstance(fetch_error, HTTPError)
                else str(fetch_error)
            )
            receipt = _SpoolReceipt.create(
                version=SPOOL_FORMAT_VERSION,
                provider_id=self.provider_id,
                endpoint_key=endpoint_key,
                index_family=family,
                attempt_key=attempt_key,
                outcome="failed",
                run_kind=config.feed_kind,
                declared_interval_seconds=config.refresh_interval_seconds,
                started_at_utc=started_at_utc.astimezone(UTC),
                completed_at_utc=completed_at_utc,
                http_status_code=http_status,
                error_message=_redact(raw_message, secrets),
                storage_backend=None,
                storage_path=None,
                object_kind=None,
                source_url=safe_source_url,
                byte_size=None,
                sha256=None,
                feed_timestamp_utc=None,
                feed_timestamp_source=None,
                entity_count=None,
                api_version=None,
                alert_count=None,
                duplicate_of_row_id=None,
            )
            _write_file_durable(self._receipt_path(attempt_key), receipt.to_json())
            return receipt

        assert payload is not None and actual_sha is not None and feed_ts is not None
        storage_path = _storage_path_for(
            endpoint_key,
            provider_id=self.provider_id,
            started_at_utc=started_at_utc,
            checksum=actual_sha,
        )
        payload_target = self._payload_path(attempt_key)
        _write_file_durable(payload_target, payload)
        if _file_digest(payload_target) != (actual_sha, len(payload)):
            payload_target.unlink(missing_ok=True)
            raise LocalIngestIntegrityError("local_ingest_torn_bytes:spool_write")
        receipt = _SpoolReceipt.create(
            version=SPOOL_FORMAT_VERSION,
            provider_id=self.provider_id,
            endpoint_key=endpoint_key,
            index_family=family,
            attempt_key=attempt_key,
            outcome="stored",
            run_kind=config.feed_kind,
            declared_interval_seconds=config.refresh_interval_seconds,
            started_at_utc=started_at_utc.astimezone(UTC),
            completed_at_utc=completed_at_utc,
            http_status_code=http_status_code,
            error_message=None,
            storage_backend=config.storage_backend,
            storage_path=storage_path,
            object_kind=config.source_format,
            source_url=safe_source_url,
            byte_size=len(payload),
            sha256=actual_sha,
            feed_timestamp_utc=feed_ts,
            feed_timestamp_source=feed_ts_source,
            entity_count=entity_count,
            api_version=api_version,
            alert_count=alert_count,
            duplicate_of_row_id=None,
        )
        try:
            _write_file_durable(self._receipt_path(attempt_key), receipt.to_json())
        except BaseException:
            payload_target.unlink(missing_ok=True)
            raise
        return receipt

    def _ensure_bronze_durable(self, receipt: _SpoolReceipt) -> None:
        if receipt.outcome != "stored":
            return
        assert receipt.storage_backend is not None and receipt.storage_path is not None
        assert receipt.sha256 is not None and receipt.byte_size is not None
        expected = (receipt.sha256, receipt.byte_size)
        storage = self.resolver(receipt.storage_backend)
        payload_path = self._payload_path(receipt.attempt_key)
        if payload_path.exists():
            if _file_digest(payload_path) != expected:
                raise LocalIngestIntegrityError("local_ingest_torn_bytes:spool_payload")
            tmp_dir = self.spool_dir / ".tmp"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            upload_copy = tmp_dir / f"upload_{receipt.attempt_key}_{uuid4().hex}.bin"
            try:
                shutil.copyfile(payload_path, upload_copy)
                put_create_only(storage, upload_copy, receipt.storage_path, expected=expected)
            except ObjectKeyTaken as exc:
                raise LocalIngestIntegrityError(
                    f"local_ingest_immutable_byte_conflict:{receipt.storage_path}"
                ) from exc
            except ObjectStorageError:
                raise
            except ValueError as exc:
                raise LocalIngestIntegrityError("local_ingest_torn_bytes:spool_payload") from exc
            finally:
                upload_copy.unlink(missing_ok=True)
        elif not storage.exists(receipt.storage_path):
            raise LocalIngestIntegrityError("local_ingest_torn_bytes:payload_missing")
        try:
            actual = object_digest(storage, receipt.storage_path)
        except Exception as exc:
            raise LocalIngestIntegrityError("local_ingest_torn_bytes:bronze_readback") from exc
        if actual != expected:
            raise LocalIngestIntegrityError("local_ingest_torn_bytes:bronze_readback")

    def _finish_spooled(self, receipt: _SpoolReceipt, *, resumed: bool) -> LocalCaptureOutcome:
        # Stage 4: Bronze durability & immutable-byte readback BEFORE identity/record commits.
        self._ensure_bronze_durable(receipt)
        if self.after_commit is not None:
            self.after_commit("bronze")

        # Stage 5 (Commit 2): Atomic identity reservation bound to receipt digest.
        reservation = self.allocator.reserve(
            attempt_key=receipt.attempt_key,
            endpoint_key=receipt.endpoint_key,
            index_family=receipt.index_family,
            outcome=receipt.outcome,
            request_digest=receipt.receipt_sha256,
        )
        if self.after_commit is not None:
            self.after_commit("identity")

        # Stage 6 (Commit 3): Canonical recording through Recorder + terminal coverage.
        record, capture = _build_poll_record(receipt, reservation)
        with self.local.transaction() as conn:
            self.recorder.record(record)
            conn.execute(
                "INSERT INTO recording_coverage VALUES (?, true) "
                "ON CONFLICT (ingestion_run_id) DO UPDATE SET terminal_recorded=true",
                [reservation.ingestion_run_id],
            )
            self.allocator.mark_recorded(
                receipt.attempt_key, request_digest=receipt.receipt_sha256
            )
        self.allocator.write_watermark()
        if self.after_commit is not None:
            self.after_commit("record")

        # Stage 7: Remove staging spool files ONLY after Bronze was verified & record committed.
        self._cleanup_staging(receipt.attempt_key)
        return LocalCaptureOutcome(
            provider_id=receipt.provider_id,
            endpoint_key=receipt.endpoint_key,
            index_family=receipt.index_family,
            attempt_key=receipt.attempt_key,
            outcome=receipt.outcome,
            ingestion_run_id=reservation.ingestion_run_id,
            ingestion_object_id=reservation.ingestion_object_id,
            capture_row_id=reservation.capture_row_id,
            duplicate_of_row_id=receipt.duplicate_of_row_id,
            storage_backend=receipt.storage_backend,
            storage_path=receipt.storage_path,
            byte_size=receipt.byte_size,
            sha256=receipt.sha256,
            http_status_code=receipt.http_status_code,
            error_message=receipt.error_message,
            started_at_utc=receipt.started_at_utc,
            completed_at_utc=receipt.completed_at_utc,
            feed_timestamp_utc=receipt.feed_timestamp_utc,
            feed_timestamp_source=receipt.feed_timestamp_source,
            entity_count=receipt.entity_count,
            api_version=receipt.api_version,
            alert_count=receipt.alert_count,
            capture_entry=capture,
            resumed_from_spool=resumed,
        )

    def _cleanup_staging(self, attempt_key: str) -> None:
        self._payload_path(attempt_key).unlink(missing_ok=True)
        self._receipt_path(attempt_key).unlink(missing_ok=True)

    def _recorded_outcome(self, reservation: IdentityReservation) -> LocalCaptureOutcome:
        poll_row = self.local.connection.execute(
            "SELECT status, started_at_utc, completed_at_utc, http_status_code, error_message, "
            "feed_timestamp_utc, feed_timestamp_source, entity_count, duplicate_of_row_id "
            "FROM polls WHERE index_family=? AND ingestion_run_id=?",
            [reservation.index_family, reservation.ingestion_run_id],
        ).fetchone()
        if poll_row is None:
            raise LocalIngestIntegrityError("local_ingest_recorded_row_missing:poll")
        capture_entry: CaptureEntry | None = None
        if reservation.outcome == "stored":
            assert reservation.capture_row_id is not None
            from transit_ops.live.poll_records import LocalPollRecords

            day = FeedDayKey(
                self.provider_id,
                reservation.endpoint_key,
                reservation.index_family,
                poll_row[1].replace(tzinfo=UTC).date(),
            )
            capture_entry = LocalPollRecords(self.local)._capture(day, reservation.capture_row_id)
        started = poll_row[1].replace(tzinfo=UTC)
        completed = (poll_row[2] or poll_row[1]).replace(tzinfo=UTC)
        feed_ts = None if poll_row[5] is None else poll_row[5].replace(tzinfo=UTC)
        return LocalCaptureOutcome(
            provider_id=self.provider_id,
            endpoint_key=reservation.endpoint_key,
            index_family=reservation.index_family,
            attempt_key=reservation.attempt_key,
            outcome=cast(CaptureOutcomeKind, reservation.outcome),
            ingestion_run_id=reservation.ingestion_run_id,
            ingestion_object_id=reservation.ingestion_object_id,
            capture_row_id=reservation.capture_row_id,
            duplicate_of_row_id=poll_row[8],
            storage_backend=capture_entry.storage_backend if capture_entry else None,
            storage_path=capture_entry.storage_path if capture_entry else None,
            byte_size=capture_entry.byte_size if capture_entry else None,
            sha256=capture_entry.sha256 if capture_entry else None,
            http_status_code=poll_row[3],
            error_message=poll_row[4],
            started_at_utc=started,
            completed_at_utc=completed,
            feed_timestamp_utc=feed_ts,
            feed_timestamp_source=poll_row[6],
            entity_count=poll_row[7],
            api_version=capture_entry.api_version if capture_entry else None,
            alert_count=capture_entry.alert_count if capture_entry else None,
            capture_entry=capture_entry,
            resumed_from_spool=True,
        )

    def _ensure_app_failure_table(self, conn: Any, *, create: bool) -> bool:
        exists = (
            conn.execute(
                "SELECT 1 FROM duckdb_tables() WHERE database_name=current_database() "
                "AND schema_name='main' AND NOT temporary AND table_name=?",
                [_APP_FAILURE_TABLE],
            ).fetchone()
            is not None
        )
        if not exists and not create:
            return False
        conn.execute(f"CREATE TEMP TABLE _app_failure_expected ({_APP_FAILURE_DEF})")
        try:
            if not exists:
                conn.execute(f"CREATE TABLE {_APP_FAILURE_TABLE} ({_APP_FAILURE_DEF})")
            if _table_shape(conn, _APP_FAILURE_TABLE) != _table_shape(
                conn, "_app_failure_expected"
            ):
                raise LocalIngestIntegrityError("local_ingest_app_failure_table_shape_differs")
        except LocalFileMismatch as exc:
            raise LocalIngestIntegrityError("local_ingest_app_failure_table_shape_differs") from exc
        finally:
            conn.execute("DROP TABLE _app_failure_expected")
        return True

    def recorded_application_failures(self) -> dict[tuple[str, int], tuple[str, str]]:
        """Return (endpoint_key, capture_row_id) -> (input_signature, error_message)."""
        self.local.require_committed()
        with self.local.transaction() as conn:
            if not self._ensure_app_failure_table(conn, create=False):
                return {}
            rows = conn.execute(
                f"SELECT endpoint_key, capture_row_id, input_signature, error_message "
                f"FROM {_APP_FAILURE_TABLE}"
            ).fetchall()
        return {(str(r[0]), int(r[1])): (str(r[2]), str(r[3])) for r in rows}

    def clear_application_failure(self, endpoint_key: str, capture_row_id: int) -> None:
        """Clear a recorded failure once the capture succeeds on a new input."""
        self.local.require_committed()
        with self.local.transaction() as conn:
            if not self._ensure_app_failure_table(conn, create=False):
                return
            conn.execute(
                f"DELETE FROM {_APP_FAILURE_TABLE} WHERE endpoint_key=? AND capture_row_id=?",
                [endpoint_key, capture_row_id],
            )

    def record_application_failure(
        self,
        endpoint_key: str,
        capture: CaptureEntry,
        *,
        error: Exception | str,
        started_at_utc: datetime,
        completed_at_utc: datetime | None = None,
        attempt_key: str | None = None,
        input_signature: str | None = None,
    ) -> int:
        """Record a failed local Silver/fact application once per input signature."""
        self.local.require_committed()
        self.allocator.require_initialized()
        family = _endpoint_family(endpoint_key)
        if capture.index_family != family:
            raise LocalIngestIntegrityError("local_ingest_failure_family_mismatch")
        started = started_at_utc.astimezone(UTC)
        completed = (
            max(self.clock().astimezone(UTC), started)
            if completed_at_utc is None
            else completed_at_utc.astimezone(UTC)
        )
        if attempt_key is not None and _ATTEMPT_KEY_RE.fullmatch(attempt_key) is None:
            raise LocalIngestRefused("local_ingest_invalid_attempt_key")
        redacted = _redact(str(error))[:1950]
        signature = (
            input_signature
            if input_signature is not None
            else hashlib.sha256(
                _canonical_json(
                    {
                        "endpoint_key": endpoint_key,
                        "capture_row_id": capture.capture_row_id,
                        "sha256": capture.sha256,
                        "error": redacted,
                    }
                )
            ).hexdigest()
        )
        key = attempt_key or f"appfail-{endpoint_key}-{capture.capture_row_id}-{signature[:16]}"
        # Timestamp-free digest so retrying the same failure attempt is idempotent.
        digest = hashlib.sha256(
            _canonical_json(
                {
                    "endpoint_key": endpoint_key,
                    "index_family": family,
                    "capture_row_id": capture.capture_row_id,
                    "input_signature": signature,
                    "error": redacted,
                }
            )
        ).hexdigest()
        feed = self.manifest.feeds.get(endpoint_key)
        interval = int(feed.refresh_interval_seconds) if feed is not None else None
        day = FeedDayKey(self.provider_id, endpoint_key, family, started.date())
        with self.local.transaction() as conn:
            self._ensure_app_failure_table(conn, create=True)
            reservation = self.allocator.reserve(
                attempt_key=key,
                endpoint_key=endpoint_key,
                index_family=family,
                outcome="silver_load_failed",
                request_digest=digest,
            )
            if not reservation.recorded:
                entry = ProcessingEntry(
                    stage="silver_load",
                    index_family=family,
                    capture_row_id=capture.capture_row_id,
                    attribution="recorded",
                    status="failed",
                    started_at_utc=started,
                    completed_at_utc=completed,
                    error_message=redacted,
                    rows=None,
                    ingestion_run_id=reservation.ingestion_run_id,
                )
                record = PollRecord(day, (), (), (entry,), interval, None)
                validate_record(record)
                self.recorder.record(record)
                conn.execute(
                    "INSERT INTO recording_coverage VALUES (?, true) "
                    "ON CONFLICT (ingestion_run_id) DO UPDATE SET terminal_recorded=true",
                    [reservation.ingestion_run_id],
                )
                self.allocator.mark_recorded(key, request_digest=digest)
            conn.execute(
                f"INSERT INTO {_APP_FAILURE_TABLE} VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT (endpoint_key, capture_row_id) DO UPDATE SET "
                "input_signature=excluded.input_signature, "
                "ingestion_run_id=excluded.ingestion_run_id, "
                "error_message=excluded.error_message",
                [
                    endpoint_key,
                    capture.capture_row_id,
                    signature,
                    reservation.ingestion_run_id,
                    redacted,
                ],
            )
        self.allocator.write_watermark()
        return reservation.ingestion_run_id
