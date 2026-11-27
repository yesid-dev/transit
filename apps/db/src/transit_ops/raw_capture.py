"""Capture one declared city's raw feeds without a database."""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import signal
import time
from collections import deque
from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZipFile

from google.transit.gtfs_realtime_pb2 import FeedMessage

from transit_ops.clean_day_inputs import declaration_for
from transit_ops.core.models import (
    AuthType,
    CaptureDownloadLimit,
    FeedConfig,
    FeedKind,
    ProviderManifest,
)
from transit_ops.ingestion.common import build_request_details, project_root
from transit_ops.ingestion.gis import build_gis_object_storage_path
from transit_ops.ingestion.i3 import (
    build_i3_object_storage_path,
    build_service_alerts_object_storage_path,
    extract_i3_metadata,
)
from transit_ops.ingestion.realtime_gtfs import build_realtime_object_storage_path
from transit_ops.ingestion.static_gtfs import build_static_object_storage_path
from transit_ops.ingestion.storage import BronzeStorage, BronzeStorageScope, ObjectAlreadyExists
from transit_ops.settings import Settings

LOGGER = logging.getLogger(__name__)
STATIC = {FeedKind.STATIC_SCHEDULE, FeedKind.GIS_STATIC}
# OC Transpo's schedule export reached 69 MB; the live schedule reader accepts 128 MB.
MAX_STATIC_BYTES = 128 * 1024 * 1024
MAX_REALTIME_BYTES = 8 * 1024 * 1024
# A daemon keeps every download short so realtime polls are not held up; a
# one-time schedule check may wait for a large archive.
DOWNLOAD_SECONDS = 20
PATIENT_DOWNLOAD_SECONDS = 180


class Environment:
    @staticmethod
    def env_value(name: str | None) -> str | None:
        return os.environ.get(name) if name else None


class CaptureError(Exception):
    """A failure described without any request data."""


class CaptureHTTPError(CaptureError):
    def __init__(self, status: int, retry_after: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.retry_after = retry_after


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


def _write_json(path: Path, document: object, *, durable: bool = False) -> None:
    pending = path.with_suffix(".tmp")
    with pending.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, allow_nan=False)
        if durable:
            handle.flush()
            os.fsync(handle.fileno())
    pending.replace(path)


def _source(feed: FeedConfig) -> str:
    source = Environment.env_value(feed.source_url_env_var) or (
        str(feed.source_url) if feed.source_url else ""
    )
    url = urlsplit(source)
    loopback = url.scheme == "http" and url.hostname in {"127.0.0.1", "::1", "localhost"}
    if not url.hostname or url.username is not None or not (url.scheme == "https" or loopback):
        raise CaptureError("Feed URL must use HTTPS or local loopback HTTP")
    return source


class DownloadBudget:
    """Reserve a rolling-window slot before every HTTP attempt, across worker restarts."""

    def __init__(self, limit: CaptureDownloadLimit | None, path: Path | None, now: float) -> None:
        self.limit = limit
        self.path = path
        self.attempts: deque[float] = deque()
        if path is not None and limit is not None:
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return
            if (
                not isinstance(saved, list)
                or any(
                    not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
                    for value in saved
                )
                or saved != sorted(saved)
            ):
                raise CaptureError("Invalid capture rate state")
            # A reboot can reset the monotonic clock. Retain every prior
            # reservation for a full window when the clock moved backwards.
            self.attempts.extend([now] * len(saved) if saved and saved[-1] > now else saved)

    def wait(self, now: float) -> float:
        if self.limit is None:
            return 0
        while self.attempts and now - self.attempts[0] >= self.limit.window_seconds:
            self.attempts.popleft()
        if len(self.attempts) < self.limit.requests:
            return 0
        return self.attempts[-self.limit.requests] + self.limit.window_seconds - now

    def reserve(self, now: float) -> None:
        if self.limit is None:
            return
        self.attempts.append(now)
        if self.path is not None:
            _write_json(self.path, list(self.attempts), durable=True)


@dataclass
class FeedPoll:
    feed: FeedConfig
    due: float
    failures: int = 0
    attempted_at: str | None = None
    captured_at: str | None = None
    error: str | None = None


def _request(
    feed: FeedConfig,
    source: str,
    now: datetime,
    stop: Event,
    clock: Callable[[], float],
    *,
    limited: bool,
    patient: bool = False,
) -> bytes:
    details = build_request_details(
        source_url=source, auth=feed.auth, settings=Environment(), now=now
    )
    headers = {"User-Agent": "transit-ops", **details.request_headers}
    if feed.feed_kind not in STATIC:
        headers["Accept"] = (
            "application/json" if feed.feed_kind == FeedKind.I3_ALERTS else "application/x-protobuf"
        )
    request = Request(details.request_url, headers=headers)
    # Keyed requests never forward credentials to a redirect destination.
    allow_redirect = feed.auth.auth_type == AuthType.NONE and not limited
    opener = build_opener() if allow_redirect else build_opener(NoRedirect())
    max_size = MAX_STATIC_BYTES if feed.feed_kind in STATIC else MAX_REALTIME_BYTES
    end = clock() + (PATIENT_DOWNLOAD_SECONDS if patient else DOWNLOAD_SECONDS)
    data = BytesIO()
    try:
        with opener.open(request, timeout=30 if patient else 5) as response:
            while block := response.read1(128 * 1024):
                if stop.is_set() or clock() >= end:
                    raise CaptureError("Download interrupted or timed out")
                if data.tell() + len(block) > max_size:
                    raise CaptureError("Download exceeds size limit")
                data.write(block)
    except HTTPError as error:
        with error:
            retry_after = error.headers.get("Retry-After", "")
            delay = (
                int(retry_after)
                if len(retry_after) <= 10 and retry_after.isascii() and retry_after.isdecimal()
                else 0
            )
            raise CaptureHTTPError(error.code, delay) from None
    if not data.tell():
        raise CaptureError("Empty download")
    return data.getvalue()


def capture_fresh_for_seconds(feed: FeedConfig) -> int:
    interval = feed.refresh_interval_seconds
    return interval * 3 // 2 if feed.feed_kind in STATIC else max(60, interval * 3)


def _artifact(
    city: str, feed: FeedConfig, source: str, now: datetime, data: bytes
) -> tuple[str, int]:
    digest = sha256(data).hexdigest()
    endpoint = feed.endpoint_key
    if feed.feed_kind in STATIC:
        with ZipFile(BytesIO(data)) as archive:
            members = len(archive.infolist())
        build_key = (
            build_static_object_storage_path
            if feed.feed_kind == FeedKind.STATIC_SCHEDULE
            else build_gis_object_storage_path
        )
        # Remove query credentials before deriving the legacy filename.
        return build_key(
            city, endpoint, now, urlsplit(source).path or "download.zip", digest
        ), members
    if feed.feed_kind == FeedKind.I3_ALERTS:
        count = extract_i3_metadata(data, provider_id=city).alert_count
        return build_i3_object_storage_path(
            provider_id=city, captured_at_utc=now, checksum_sha256=digest
        ), count
    message = FeedMessage.FromString(data)
    if not message.IsInitialized():
        raise CaptureError("Incomplete GTFS-Realtime message")
    if feed.feed_kind == FeedKind.SERVICE_ALERTS:
        key = build_service_alerts_object_storage_path(
            provider_id=city, captured_at_utc=now, checksum_sha256=digest
        )
    else:
        key = build_realtime_object_storage_path(city, endpoint, now, digest)
    return key, len(message.entity)


def _already_stored(storage: BronzeStorage, key: str, data: bytes) -> bool:
    """Whether the newest stored capture of this static feed has the same content."""
    prefix, separator, _ = key.partition("ingested_at_utc=")
    if not separator:
        return False
    newest = max(storage.list_keys(prefix + separator), default=None)
    digest = sha256(data).hexdigest()[:12]
    return newest is not None and f"__{digest}__" in newest.rsplit("/", 1)[-1]


class CaptureRunner:
    def __init__(
        self,
        manifest: ProviderManifest,
        storage: BronzeStorage | None,
        *,
        rate_state: Path | None = None,
        heartbeat: Path | None = None,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], datetime] = lambda: datetime.now(UTC),
        endpoints: frozenset[str] | None = None,
        once: bool = False,
    ) -> None:
        """Poll the enabled feeds, or only ``endpoints``.

        ``once`` checks each feed one time and returns, for a timer. A static
        feed whose content matches its newest stored capture is then not stored
        again, so frequent checks keep one object per published edition.
        """
        self.city = manifest.provider.provider_id
        self.storage = storage
        self.once = once
        self.clock = clock
        self.wall = wall
        self.heartbeat = heartbeat
        self.stop = Event()
        self.paused_until = 0.0
        now = clock()
        wall_seconds = wall().timestamp()
        enabled = {key for key, feed in manifest.feeds.items() if feed.is_enabled}
        if endpoints is not None and not endpoints <= enabled:
            raise CaptureError("Unknown or disabled capture feed")
        self.polls = [
            FeedPoll(
                feed,
                now
                + (
                    (feed.refresh_phase_seconds - wall_seconds) % feed.refresh_interval_seconds
                    if storage is not None and feed.refresh_phase_seconds is not None and not once
                    else 0
                ),
            )
            for key, feed in manifest.feeds.items()
            if key in enabled and (endpoints is None or key in endpoints)
        ]
        if not self.polls:
            raise CaptureError("No enabled capture feeds")
        self.budget = DownloadBudget(manifest.capture_download_limit, rate_state, now)

    def step(self) -> float:
        """Process the next due feed, or return the time until it may be fetched."""
        pending = [
            poll
            for poll in self.polls
            if (self.storage is not None and not self.once) or not poll.attempted_at
        ]
        if not pending:
            return math.inf
        poll = min(pending, key=lambda item: item.due)
        current = self.clock()
        wait = max(poll.due - current, self.paused_until - current, self.budget.wait(current))
        if wait > 0 or self.stop.is_set():
            return wait
        feed = poll.feed
        now = self.wall()
        poll.attempted_at = now.isoformat()
        try:
            source = _source(feed)
            self.budget.reserve(current)
            data = _request(
                feed,
                source,
                now,
                self.stop,
                self.clock,
                limited=self.budget.limit is not None,
                patient=self.once,
            )
            key, count = _artifact(self.city, feed, source, now, data)
            if self.storage is None:
                print(
                    json.dumps(
                        {"feed": feed.endpoint_key, "bytes": len(data), "count": count, "key": key}
                    )
                )
            elif (
                self.once and feed.feed_kind in STATIC and _already_stored(self.storage, key, data)
            ):
                LOGGER.info("Unchanged %s/%s; nothing stored", self.city, feed.endpoint_key)
            elif not self.stop.is_set():
                with TemporaryDirectory(prefix="transit-raw-") as directory:
                    artifact = Path(directory) / "capture"
                    artifact.write_bytes(data)
                    try:
                        self.storage.put_if_absent(artifact, key)
                    except ObjectAlreadyExists as error:
                        if error.http_status == 409:
                            raise CaptureError("Concurrent object write") from None
            if not self.stop.is_set():
                poll.captured_at = poll.attempted_at
                poll.error = None
                poll.failures = 0
        except Exception as error:
            poll.failures = min(poll.failures + 1, 8)
            # Third-party exceptions can embed a signed URL or credentials.
            poll.error = str(error) if isinstance(error, CaptureError) else type(error).__name__
            LOGGER.warning(
                "Capture failed for %s/%s (%s)", self.city, feed.endpoint_key, poll.error
            )
            if isinstance(error, CaptureHTTPError) and error.status == 429:
                limit = self.budget.limit
                fallback = limit.window_seconds if limit else 60
                self.paused_until = self.clock() + max(fallback, error.retry_after)
        finished = self.clock()
        interval = feed.refresh_interval_seconds
        # Never replay missed polls in a burst.
        poll.due += (1 + max(0, int((finished - poll.due) // interval))) * interval
        if feed.refresh_phase_seconds is None:
            poll.due = max(poll.due, current + interval)
        if poll.failures:
            base = 300 if feed.feed_kind in STATIC else interval
            poll.due = finished + min(3600, base * 2 ** (poll.failures - 1))
        if self.heartbeat is not None:
            _write_json(
                self.heartbeat,
                {
                    "provider": self.city,
                    "updated_at": self.wall().isoformat(),
                    "feeds": {
                        item.feed.endpoint_key: {
                            "attempted_at": item.attempted_at,
                            "captured_at": item.captured_at,
                            "error": item.error,
                            "fresh_for_seconds": capture_fresh_for_seconds(item.feed),
                        }
                        for item in self.polls
                    },
                },
            )
        return 0

    def run(self) -> int:
        while not self.stop.is_set():
            wait = self.step()
            if math.isinf(wait):
                return int(any(poll.failures for poll in self.polls))
            self.stop.wait(wait)
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("city")
    parser.add_argument("--provider-dir", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--check-config", action="store_true")
    parser.add_argument("--rate-state", type=Path)
    parser.add_argument("--heartbeat", type=Path)
    parser.add_argument(
        "--feed", action="append", help="Capture only this endpoint key; may be repeated"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Check each feed one time and exit; unchanged static files are not stored again",
    )
    args = parser.parse_args()
    endpoints = frozenset(args.feed) if args.feed else None
    if args.dry_run and (args.rate_state or args.heartbeat):
        parser.error("--dry-run does not write rate state or a heartbeat")
    logging.basicConfig(level=logging.INFO)
    try:
        manifest = declaration_for(args.city, directory=args.provider_dir)
        if (
            manifest.capture_download_limit
            and not (args.dry_run or args.check_config)
            and args.rate_state is None
        ):
            parser.error("--rate-state is required for a provider with a download limit")
        if args.dry_run:
            return _run(CaptureRunner(manifest, None, endpoints=endpoints))
        settings = Settings(_env_file=None)  # type: ignore[call-arg]
        with closing(BronzeStorageScope(settings, project_root=project_root())) as scope:
            storage = scope.resolve(settings.BRONZE_STORAGE_BACKEND)
            if args.check_config:
                for key, feed in manifest.feeds.items():
                    if feed.is_enabled and (endpoints is None or key in endpoints):
                        build_request_details(
                            source_url=_source(feed), auth=feed.auth, settings=Environment()
                        )
                LOGGER.info("Capture configuration validated for %s", args.city)
                return 0
            return _run(
                CaptureRunner(
                    manifest,
                    storage,
                    rate_state=args.rate_state,
                    heartbeat=args.heartbeat,
                    endpoints=endpoints,
                    once=args.once,
                )
            )
    except Exception as error:
        LOGGER.error("Capture runner stopped (%s)", type(error).__name__)
        return 1


def _run(runner: CaptureRunner) -> int:
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: runner.stop.set())
    return runner.run()


if __name__ == "__main__":
    raise SystemExit(main())
