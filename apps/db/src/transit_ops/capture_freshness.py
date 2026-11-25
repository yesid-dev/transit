"""Check declared raw capture feeds using Bronze object keys."""

import argparse
import re
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal

from transit_ops.core.models import FeedKind
from transit_ops.ingestion.common import project_root
from transit_ops.ingestion.storage import BronzeStorage, BronzeStorageScope
from transit_ops.providers.registry import ProviderRegistry
from transit_ops.raw_capture import STATIC, capture_fresh_for_seconds
from transit_ops.settings import Settings

_DAY = re.compile(r"\d{4}-\d{2}-\d{2}/")
_OBJECT = re.compile(r"(\d{8}T\d{12}Z)__[0-9a-f]{12}__[^/]+")


@dataclass(frozen=True)
class CaptureReading:
    city: str
    feed: str
    status: Literal["fresh", "late", "missing", "unavailable"]
    age_seconds: int | None
    limit_seconds: int


def _latest_capture(storage: BronzeStorage, prefix: str, now: datetime) -> datetime | None:
    # List day partitions first to avoid paging through all retained objects.
    days = []
    for child in storage.list_prefixes(prefix):
        suffix = child.removeprefix(prefix)
        if _DAY.fullmatch(suffix):
            try:
                day = date.fromisoformat(suffix[:-1])
            except ValueError:
                continue
            if day <= now.date():
                days.append((day, child))
    for day, child in sorted(days, reverse=True):
        latest = None
        for key in storage.list_keys(child):
            if match := _OBJECT.fullmatch(key.removeprefix(child)):
                try:
                    captured = datetime.strptime(match[1], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
                except ValueError:
                    continue
                if captured.date() == day and captured <= now:
                    latest = max(latest, captured) if latest else captured
        if latest is not None:
            return latest
    return None


def check_capture_freshness(
    registry: ProviderRegistry, storage: BronzeStorage, *, now: datetime
) -> list[CaptureReading]:
    readings = []
    for city in registry.list_provider_ids():
        manifest = registry.get_provider(city)
        if not manifest.capture_enabled:
            continue
        for endpoint, feed in manifest.feeds.items():
            if not feed.is_enabled:
                continue
            limit = capture_fresh_for_seconds(feed)
            if feed.feed_kind not in STATIC:
                limit = max(900, limit)
            partition = "ingested_at_utc" if feed.feed_kind in STATIC else "captured_at_utc"
            archive_feed = (
                feed.feed_kind.value
                if feed.feed_kind in (FeedKind.I3_ALERTS, FeedKind.SERVICE_ALERTS)
                else endpoint
            )
            try:
                captured = _latest_capture(storage, f"{city}/{archive_feed}/{partition}=", now)
            except Exception:
                # Storage exceptions can include request URLs or authentication details.
                readings.append(CaptureReading(city, endpoint, "unavailable", None, limit))
                continue
            if captured is None:
                readings.append(CaptureReading(city, endpoint, "missing", None, limit))
            else:
                age = (now - captured).total_seconds()
                status: Literal["late", "fresh"] = "late" if age > limit else "fresh"
                readings.append(CaptureReading(city, endpoint, status, int(age), limit))
    return readings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--provider-dir", type=Path, default=project_root() / "config" / "providers"
    )
    args = parser.parse_args()
    try:
        settings = Settings(_env_file=None)  # type: ignore[call-arg]
        registry = ProviderRegistry(args.provider_dir, settings=settings)
        with closing(BronzeStorageScope(settings, project_root=project_root())) as scope:
            readings = check_capture_freshness(
                registry, scope.resolve(settings.BRONZE_STORAGE_BACKEND), now=datetime.now(UTC)
            )
    except Exception:
        print("Raw capture probe unavailable. Check provider and storage configuration.")
        return 1

    for reading in readings:
        details = (
            f" (age {reading.age_seconds}s, limit {reading.limit_seconds}s)"
            if reading.age_seconds is not None
            else ""
        )
        print(f"{reading.city}/{reading.feed}: {reading.status}{details}")
    return int(any(reading.status != "fresh" for reading in readings))


if __name__ == "__main__":
    raise SystemExit(main())
