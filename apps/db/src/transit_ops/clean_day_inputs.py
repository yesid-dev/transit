"""Read local Bronze captures and caller-pinned GTFS editions for a service day."""

import hashlib
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from heapq import merge
from pathlib import Path
from zoneinfo import ZoneInfo

from transit_ops.core.models import ProviderManifest
from transit_ops.history.manifest import Manifest, decode_manifest
from transit_ops.history.pack import PackedCapture, read_pack
from transit_ops.providers.normalize import RawCapture
from transit_ops.providers.schedule_archive import ArchiveScheduleContext


@dataclass(frozen=True)
class Edition:
    path: Path
    sha256: str


def schedule_contexts(
    manifest: ProviderManifest, day: date, index_path: Path
) -> dict[date, ArchiveScheduleContext]:
    """Use the latest declared effective date on or before each candidate day."""
    provider = manifest.provider
    value = json.loads(index_path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("provider") != provider.provider_id:
        raise ValueError("Schedule index must name the selected provider")
    records = value.get("editions")
    if not isinstance(records, list) or not records:
        raise ValueError("Schedule index must supply a nonempty editions list")
    editions: dict[date, Edition] = {}
    for record in records:
        if not isinstance(record, dict) or not all(
            isinstance(record.get(key), str) for key in ("effective_date", "path", "sha256")
        ):
            raise ValueError("Each edition needs effective_date, path and sha256 strings")
        effective = date.fromisoformat(record["effective_date"])
        if effective in editions:
            raise ValueError(f"Competing schedule editions effective {effective}")
        editions[effective] = Edition(index_path.parent / record["path"], record["sha256"])

    grouped: dict[Edition, list[date]] = {}
    for offset in (-1, 0, 1):
        candidate = day + timedelta(days=offset)
        eligible = [effective for effective in editions if effective <= candidate]
        if eligible:
            grouped.setdefault(editions[max(eligible)], []).append(candidate)
    if not any(day in dates for dates in grouped.values()):
        raise ValueError(f"No schedule edition in force on {day}")
    return {
        candidate: context
        for ident, (edition, dates) in enumerate(grouped.items(), 1)
        for context in (
            ArchiveScheduleContext(
                provider_id=provider.provider_id,
                dataset_version_id=ident,
                edition_sha256=edition.sha256,
                archive_bytes=edition.path.read_bytes(),
                service_dates=dates,
                timezone=ZoneInfo(provider.timezone),
            ),
        )
        for candidate in dates
    }


def loose_captures(
    manifest: ProviderManifest, root: Path, start: datetime, end: datetime
) -> Iterator[RawCapture]:
    provider_root = root / manifest.provider.provider_id
    if not provider_root.is_dir():
        raise ValueError(f"Missing Bronze provider directory: {provider_root}")
    files: list[tuple[datetime, str, Path, str]] = []
    for endpoint, family in _realtime_feeds(manifest).items():
        day = start.date()
        while day <= end.date():
            partition = provider_root / endpoint / f"captured_at_utc={day}"
            for path in partition.glob("*.pb"):
                stamp, checksum, _ = path.name.split("__", 2)
                captured = datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
                if captured.date() != day:
                    raise ValueError(f"Capture timestamp disagrees with partition: {path}")
                if start <= captured <= end:
                    files.append((captured, family, path, checksum))
            day += timedelta(days=1)
    if not files:
        raise ValueError("No GTFS-Realtime captures found in the service-day input window")
    for captured, family, path, checksum in sorted(files):
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest()[:12] != checksum:
            raise ValueError(f"Capture checksum differs from Bronze key: {path}")
        yield RawCapture(family, "gtfs-rt", payload, captured, str(path))


def archived_captures(
    provider: ProviderManifest, root: Path, manifests: list[Path], start: datetime, end: datetime
) -> Iterator[RawCapture]:
    """Read explicitly selected local pack manifests, one version per feed/UTC day."""
    families = _realtime_feeds(provider)
    selections = {}
    for path in manifests:
        manifest = decode_manifest(path.read_bytes())
        key = (manifest.endpoint_key, manifest.utc_date)
        if (
            manifest.provider_id != provider.provider.provider_id
            or manifest.endpoint_key not in families
            or key in selections
        ):
            raise ValueError(f"Unexpected or duplicate capture feed/day manifest: {path}")
        selections[key] = manifest
    captures = merge(
        *(
            _packed_day(root, manifest, families[manifest.endpoint_key], start, end)
            for _, manifest in sorted(selections.items())
        ),
        key=lambda capture: capture.captured_at_utc,
    )
    first = next(captures, None)
    if first is None:
        raise ValueError("No archived GTFS-Realtime captures in the service-day input window")
    yield first
    yield from captures


def _realtime_feeds(manifest: ProviderManifest) -> dict[str, str]:
    return {
        endpoint: feed.feed_kind.value
        for endpoint, feed in manifest.feeds.items()
        if feed.feed_kind.value in {"trip_updates", "vehicle_positions"}
    }


def _packed_day(
    root: Path, manifest: Manifest, family: str, start: datetime, end: datetime
) -> Iterator[RawCapture]:
    if not start.date() <= manifest.utc_date <= end.date():
        return
    selected = [c for c in manifest.captures if start <= c.captured_at_utc <= end]
    if any(not c.packed for c in selected):
        raise ValueError(f"Capture manifest includes unavailable objects: {manifest.utc_date}")
    if not selected or manifest.pack is None:
        return
    packed = []
    entries = [c for c in manifest.captures if c.packed]
    for entry in entries:
        assert entry.stream is not None and entry.offset is not None
        packed.append(PackedCapture(entry.stream, entry.offset, entry.byte_size, entry.sha256))
    path = (root / manifest.pack.path).resolve()
    if not path.is_relative_to(root.resolve()) or path.stat().st_size != manifest.pack.byte_size:
        raise ValueError(f"Capture pack path or size differs from manifest: {manifest.pack.path}")
    with path.open("rb") as stream:
        for entry, payload in zip(
            entries, read_pack(stream, manifest.streams, packed), strict=True
        ):
            if start <= entry.captured_at_utc <= end:
                yield RawCapture(family, "gtfs-rt", payload, entry.captured_at_utc, str(path))
