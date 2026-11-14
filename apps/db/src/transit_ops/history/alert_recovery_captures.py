"""Read checked retained alert bytes into bounded archive recovery evidence."""

import hashlib
from collections.abc import Callable
from contextlib import ExitStack, closing
from datetime import UTC, datetime, time, timedelta

from sqlalchemy import Connection, text

from transit_ops.core.models import ProviderManifest
from transit_ops.history.alert_recovery_capture_records import prepare_capture_candidates
from transit_ops.history.alert_recovery_capture_state import AlertCaptureState
from transit_ops.history.alert_recovery_models import Candidate, SourceReport
from transit_ops.history.datasets import CaptureSource, get_dataset
from transit_ops.history.reader import Capture, CaptureWindow, open_window
from transit_ops.history.storage import history_storage
from transit_ops.ingestion.i3 import extract_i3_metadata, extract_service_alerts_metadata
from transit_ops.ingestion.storage import BronzeStorageScope
from transit_ops.settings import Settings
from transit_ops.silver.i3 import RawI3AlertSnapshot

_FORMATS = {"i3_alerts": "api_i3_json", "service_alerts": "gtfs_rt_service_alerts"}
_ENDPOINTS = text("""
    SELECT endpoint_key, feed_kind, source_format FROM core.feed_endpoints
    WHERE provider_id=:provider_id AND feed_kind IN ('i3_alerts', 'service_alerts')
""")


class _CaptureRefusal(ValueError):
    """Safe source diagnostics without decoder, SQL or storage error contents."""


def _endpoints(connection: Connection, manifest: ProviderManifest) -> tuple[str, ...]:
    declarations = [
        (f.endpoint_key, str(f.feed_kind), str(f.source_format))
        for f in manifest.feeds.values()
        if f.feed_kind in _FORMATS
    ]
    declarations.extend(
        tuple(r)
        for r in connection.execute(_ENDPOINTS, {"provider_id": manifest.provider.provider_id})
    )
    if not declarations:
        raise _CaptureRefusal("no alert endpoints")
    for endpoint, kind, format_ in declarations:
        if endpoint != kind or _FORMATS.get(kind) != format_:
            raise _CaptureRefusal("unsupported or contradictory alert endpoint: " + endpoint)
        source = get_dataset("capture." + endpoint).source
        if not isinstance(source, CaptureSource) or source.index_family != "alert_snapshot":
            raise _CaptureRefusal("unsupported alert dataset: " + endpoint)
    return tuple(sorted({r[0] for r in declarations}))


def _snapshot(capture: Capture, provider: str, timezone: str) -> RawI3AlertSnapshot:
    decoders = {
        "api_i3_json": extract_i3_metadata,
        "gtfs_rt_service_alerts": extract_service_alerts_metadata,
    }
    if capture.object_kind not in decoders:
        raise _CaptureRefusal("unsupported capture format")
    payload = capture.payload
    if (
        payload is None
        or len(payload) != capture.byte_size
        or hashlib.sha256(payload).hexdigest() != capture.checksum_sha256
    ):
        raise _CaptureRefusal("capture bytes differ")
    decoded = decoders[capture.object_kind](payload, provider_id=provider)
    return RawI3AlertSnapshot(
        capture.capture_row_id,
        provider,
        timezone,
        capture.captured_at_utc,
        decoded.raw_payload_json,
    )


class CaptureRecoveryReader:
    def __init__(
        self,
        settings: Settings,
        manifest: ProviderManifest,
        *,
        capture_from: datetime,
        capture_to: datetime,
        window_reader: Callable[..., CaptureWindow] = open_window,
        storage_factory: Callable[[Settings], BronzeStorageScope] = history_storage,
    ) -> None:
        if capture_from.utcoffset() is None or capture_to.utcoffset() is None:
            raise ValueError("aware increasing capture bounds required")
        capture_from, capture_to = capture_from.astimezone(UTC), capture_to.astimezone(UTC)
        if capture_from >= capture_to:
            raise ValueError("aware increasing capture bounds required")
        self.settings, self.manifest = settings, manifest
        self.start, self.end = capture_from, capture_to
        self.window_reader, self.storage_factory = window_reader, storage_factory

    def __call__(
        self,
        connection: Connection,
        *,
        provider_id: str,
        recovered_at_utc: datetime,
    ) -> tuple[tuple[Candidate, ...], SourceReport]:
        coverage = [
            f"interval [{self.start.isoformat()},{self.end.isoformat()})",
            *AlertCaptureState((), (), ()).limitations,
        ]
        missing: list[str] = []
        scanned: set[tuple[str, int]] = set()
        try:
            with connection.begin_nested():
                if provider_id != self.manifest.provider.provider_id:
                    raise _CaptureRefusal("provider scope mismatch")
                endpoints = _endpoints(connection, self.manifest)
                coverage.append("endpoints: " + ",".join(endpoints))
                with closing(self.storage_factory(self.settings)) as scope:
                    window = self.window_reader(
                        provider_id,
                        endpoints,
                        self.start,
                        self.end,
                        connection=connection,
                        storage=scope.resolve,
                    )
                    snapshots = self._consume(
                        window, provider_id, endpoints, coverage, missing, scanned
                    )
                    items: tuple[Candidate, ...] = ()
                    if not missing:
                        items = prepare_capture_candidates(
                            connection,
                            snapshots=snapshots,
                            provider_id=provider_id,
                            provider_timezone=self.manifest.provider.timezone,
                            recovered_at_utc=recovered_at_utc,
                            source_locator="; ".join(sorted(coverage)),
                        )
        except Exception as exc:
            items = ()
            errors: tuple[str, ...] = (
                str(exc)
                if isinstance(exc, _CaptureRefusal)
                else type(exc).__name__ + ": capture evidence failed",
            )
        else:
            errors = ()
        return items, SourceReport(
            "capture",
            len(scanned),
            len(items),
            tuple(sorted(missing)),
            errors=errors,
            coverage=tuple(sorted(coverage)),
            complete=not missing and not errors,
        )

    def _consume(
        self,
        window: CaptureWindow,
        provider: str,
        endpoints: tuple[str, ...],
        coverage: list[str],
        missing: list[str],
        scanned: set[tuple[str, int]],
    ) -> list[RawI3AlertSnapshot]:
        for day in window.days:
            coverage.append(
                f"day {day.endpoint_key}/{day.utc_date}: {day.state}/{day.reason}"
                f"/{day.form}/v{day.content_version}/polls={day.poll_count}"
                f"/captures={day.capture_count}"
            )
            if day.provider_id != provider or day.endpoint_key not in endpoints:
                raise ValueError("day scope mismatch")
            day_start = datetime.combine(day.utc_date, time(), UTC)
            if (
                day.state != "available"
                and day_start < self.end
                and (day_start + timedelta(days=1) > self.start)
            ):
                missing.append(f"{day.endpoint_key}/{day.utc_date}: {day.reason}")
        expected = set()
        for poll in window.polls():
            if poll.provider_id != provider or poll.endpoint_key not in endpoints:
                raise ValueError("poll scope mismatch")
            coverage.append(f"poll {poll.endpoint_key}/{poll.ingestion_run_id}: {poll.status}")
            if poll.capture_row_id is not None:
                expected.add((poll.endpoint_key, poll.capture_row_id))
            if poll.status in ("failed", "unfinished", "capture_missing"):
                missing.append(f"{poll.endpoint_key}/{poll.ingestion_run_id}: {poll.status}")
        snapshots = []
        with ExitStack() as resources:
            captures = window.captures(with_bytes=True)
            resources.callback(getattr(captures, "close", lambda: None))
            for capture in captures:
                key = capture.endpoint_key, capture.capture_row_id
                scanned.add(key)
                if (
                    capture.provider_id != provider
                    or capture.endpoint_key not in endpoints
                    or capture.index_family != "alert_snapshot"
                    or not self.start <= capture.captured_at_utc < self.end
                ):
                    raise ValueError("capture scope mismatch")
                coverage.append(
                    f"capture {key}: {capture.captured_at_utc.isoformat()}"
                    f"/{capture.byte_size}/{capture.checksum_sha256}"
                )
                snapshots.append(_snapshot(capture, provider, self.manifest.provider.timezone))
        for poll in window.unreadable:
            if poll.capture_row_id is not None:
                scanned.add((poll.endpoint_key, poll.capture_row_id))
            missing.append(f"{poll.endpoint_key}/{poll.capture_row_id}: unreadable")
        for key in sorted(expected - scanned):
            scanned.add(key)
            missing.append(f"{key}: indexed capture omitted")
        if not snapshots:
            missing.append("no readable alert observations")
        return snapshots
