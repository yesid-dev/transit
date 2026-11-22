"""Load checksum-pinned schedules and Bronze or archived captures for a service day."""

import hashlib
import json
import re
from collections.abc import Callable, Iterable, Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from heapq import merge
from itertools import batched
from pathlib import Path
from zoneinfo import ZoneInfo

from transit_ops.clean_day import REALTIME_FEEDS, CleanDay, build_clean_day
from transit_ops.clean_day_alerts import (
    AlertVersion,
    alert_sources,
    collect_alerts,
    read_alert_capture,
)
from transit_ops.clean_day_realtime import DayCapture, FeedPoll
from transit_ops.core.models import ProviderManifest, SourceFormat
from transit_ops.history.manifest import Manifest, decode_manifest
from transit_ops.history.pack import PackedCapture, read_pack
from transit_ops.ingestion.storage import (
    BronzeStorage,
    ByteStream,
    LocalBronzeStorage,
    S3BronzeStorage,
)
from transit_ops.lake.archive_keys import validate_provider_id
from transit_ops.providers.registry import load_provider_manifest
from transit_ops.providers.schedule_archive import ArchiveScheduleContext


@dataclass(frozen=True)
class Edition:
    key: str
    sha256: str


def declaration_for(provider: str) -> ProviderManifest:
    validate_provider_id(provider)
    config = Path(__file__).resolve().parents[2] / "config" / "providers" / f"{provider}.yaml"
    declaration = load_provider_manifest(config)
    if declaration.provider.provider_id != provider:
        raise ValueError(f"Provider manifest does not match {provider}")
    return declaration


def clean_from_inputs(
    declaration: ProviderManifest,
    day: date,
    schedules: Mapping[date, ArchiveScheduleContext],
    captures: Iterable[DayCapture | FeedPoll],
) -> CleanDay:
    feeds = realtime_feeds(declaration).values()
    gaps = declaration.realtime.lines_without_live_data
    route_types = {kind for gap in gaps for kind in gap.route_types}
    routes = {route for gap in gaps for route in gap.route_ids}
    routes.update(
        route for route, kind in schedules[day].route_types.items() if kind in route_types
    )
    sources = alert_sources(declaration)
    versions: dict[tuple[str, str, SourceFormat], AlertVersion] = {}
    seen: dict[tuple[str, bytes], FeedPoll] = {}
    zone = schedules[day].timezone

    def trip_and_vehicle_captures() -> Iterator[DayCapture | FeedPoll]:
        for capture in captures:
            if isinstance(capture, DayCapture) and (source := sources.get(capture.feed)):
                if capture.captured_at_utc.astimezone(zone).date() == day:
                    poll, records = read_alert_capture(capture, source[0], seen)
                    collect_alerts(versions, source[0], capture.captured_at_utc, records)
                    yield poll
            else:
                yield capture

    result = build_clean_day(
        declaration.provider.provider_id,
        day,
        schedules,
        trip_and_vehicle_captures(),
        required_feeds=tuple(family for family in REALTIME_FEEDS if family in feeds),
        source_lag_seconds=declaration.provider.live_source_lag_seconds,
        routes_without_live_data=routes,
    )
    result.alerts = versions if sources else None
    result.scorecard_declaration = {
        "timezone": declaration.provider.timezone,
        "feeds": [*sorted(set(feeds)), *(["alerts"] if sources else [])],
        "unpublished_vehicle_fields": sorted(set(declaration.realtime.unpublished_vehicle_fields)),
    }
    return result


def schedule_contexts(
    manifest: ProviderManifest, day: date, index_path: Path
) -> dict[date, ArchiveScheduleContext]:
    """Use the latest declared effective date on or before each candidate day."""
    value = json.loads(index_path.read_text(encoding="utf-8"))
    editions = edition_index(value, manifest.provider.provider_id)
    return load_contexts(
        manifest, day, editions, lambda key: (index_path.parent / key).read_bytes()
    )


def edition_index(value: object, provider: str) -> dict[date, Edition]:
    if not isinstance(value, dict) or value.get("provider") != provider:
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
        if not re.fullmatch(r"[0-9a-f]{64}", record["sha256"]):
            raise ValueError(f"Invalid schedule checksum for {effective}")
        editions[effective] = Edition(record["path"], record["sha256"])
    return editions


def load_contexts(
    manifest: ProviderManifest,
    day: date,
    editions: Mapping[date, Edition],
    read: Callable[[str], bytes],
) -> dict[date, ArchiveScheduleContext]:
    provider = manifest.provider
    grouped: dict[Edition, list[date]] = {}
    for offset in (-1, 0, 1):
        candidate = day + timedelta(days=offset)
        eligible = [effective for effective in editions if effective <= candidate]
        if eligible:
            grouped.setdefault(editions[max(eligible)], []).append(candidate)
    if not any(day in dates for dates in grouped.values()):
        raise ValueError(f"No schedule edition in force on {day}")
    result = {}
    for ident, (edition, dates) in enumerate(grouped.items(), 1):
        payload = read(edition.key)
        checksum = edition.sha256
        # Dated Bronze originals carry the first 12 hex digits in their key.
        if len(checksum) == 12:
            actual = hashlib.sha256(payload).hexdigest()
            if not actual.startswith(checksum):
                raise ValueError(f"Schedule checksum differs from Bronze key: {edition.key}")
            checksum = actual
        context = ArchiveScheduleContext(
            provider_id=provider.provider_id,
            dataset_version_id=ident,
            edition_sha256=checksum,
            archive_bytes=payload,
            service_dates=dates,
            timezone=ZoneInfo(provider.timezone),
        )
        result.update(dict.fromkeys(dates, context))
    return result


def loose_captures(
    manifest: ProviderManifest, root: Path, start: datetime, end: datetime
) -> Iterator[DayCapture]:
    provider_root = root / manifest.provider.provider_id
    if not provider_root.is_dir():
        raise ValueError(f"Missing Bronze provider directory: {provider_root}")
    storage = LocalBronzeStorage(storage_backend="local", root=root)
    files = find_loose_captures(storage, "", manifest, start, end, set())
    if not files:
        raise ValueError("No captures found in the service-day input window")
    yield from read_loose_captures(storage, files)


@dataclass(frozen=True, order=True)
class LooseCapture:
    captured: datetime
    endpoint: str
    family: str
    key: str
    checksum: str


def find_loose_captures(
    storage: BronzeStorage,
    prefix: str,
    manifest: ProviderManifest,
    start: datetime,
    end: datetime,
    archived: set[tuple[str, date]],
) -> list[LooseCapture]:
    files: list[LooseCapture] = []
    provider = manifest.provider.provider_id
    sources = alert_sources(manifest)
    for endpoint, family in capture_feeds(manifest).items():
        extension = sources[endpoint][1] if endpoint in sources else ".pb"
        day = start.date()
        while day <= end.date():
            if (endpoint, day) not in archived:
                partition = f"{prefix}{provider}/{endpoint}/captured_at_utc={day}/"
                for key in storage.list_keys(partition):
                    name = key.removeprefix(partition)
                    if "/" in name or not name.endswith(extension):
                        continue
                    stamp, checksum, _ = name.split("__", 2)
                    captured = datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
                    if captured.date() != day:
                        raise ValueError(f"Capture timestamp disagrees with partition: {key}")
                    if start <= captured <= end:
                        files.append(LooseCapture(captured, endpoint, family, key, checksum))
            day += timedelta(days=1)
    return sorted(files)


def read_loose_captures(
    storage: BronzeStorage, files: Iterable[LooseCapture]
) -> Iterator[DayCapture]:
    def read(file: LooseCapture) -> DayCapture:
        payload = storage.read_bytes(file.key)
        if hashlib.sha256(payload).hexdigest()[:12] != file.checksum:
            raise ValueError(f"Capture checksum differs from Bronze key: {file.key}")
        return DayCapture(
            file.family, file.endpoint, file.captured, file.key.rsplit("/", 1)[-1], payload
        )

    if isinstance(storage, S3BronzeStorage):
        # Keep GETs in flight without retaining a full day of payloads in memory.
        with ThreadPoolExecutor(max_workers=10) as pool:
            for batch in batched(files, 20):
                yield from pool.map(read, batch)
    else:
        yield from map(read, files)


def archived_captures(
    provider: ProviderManifest, root: Path, manifests: list[Path], start: datetime, end: datetime
) -> Iterator[DayCapture | FeedPoll]:
    """Read explicitly selected local pack manifests, one version per feed/UTC day."""
    families = capture_feeds(provider)
    selections = {}
    for path in manifests:
        manifest = decode_manifest(path.read_bytes())
        key = (manifest.endpoint_key, manifest.utc_date)
        if (
            manifest.provider_id != provider.provider.provider_id
            or manifest.endpoint_key not in families
            or manifest.feed_kind != families[manifest.endpoint_key]
            or key in selections
        ):
            raise ValueError(f"Unexpected or duplicate capture feed/day manifest: {path}")
        selections[key] = manifest
        if manifest.pack and not (root / manifest.pack.path).resolve().is_relative_to(
            root.resolve()
        ):
            raise ValueError(f"Capture pack escapes Bronze root: {manifest.pack.path}")
    yield from merged_captures(
        LocalBronzeStorage(storage_backend="local", root=root),
        "",
        ((manifest, families[manifest.endpoint_key]) for _, manifest in sorted(selections.items())),
        start,
        end,
    )


def merged_captures(
    storage: BronzeStorage,
    prefix: str,
    selections: Iterable[tuple[Manifest, str]],
    start: datetime,
    end: datetime,
    loose: Iterable[DayCapture] = (),
) -> Iterator[DayCapture | FeedPoll]:
    streams: list[Iterator[DayCapture | FeedPoll]] = [iter(loose)]
    for manifest, family in selections:
        if start.date() <= manifest.utc_date <= end.date():
            streams.append(_packed_day(storage, prefix, manifest, family, start, end))
            if family in REALTIME_FEEDS:
                streams.append(_manifest_only_polls(manifest, start, end))
    captures = merge(*streams, key=lambda capture: capture.captured_at_utc)
    first = next(captures, None)
    if first is None:
        raise ValueError("No archived captures in the service-day input window")
    yield first
    yield from captures


def realtime_feeds(manifest: ProviderManifest) -> dict[str, str]:
    return {
        endpoint: feed.feed_kind.value
        for endpoint, feed in manifest.feeds.items()
        if feed.is_enabled and feed.feed_kind.value in REALTIME_FEEDS
    }


def realtime_capture_present(
    selections: Iterable[tuple[Manifest, str]], start: datetime, end: datetime
) -> bool:
    """Whether a declared realtime feed has a packed capture inside the window."""
    return any(
        family in REALTIME_FEEDS
        and any(
            capture.packed and start <= capture.captured_at_utc <= end
            for capture in manifest.captures
        )
        for manifest, family in selections
    )


def capture_feeds(manifest: ProviderManifest) -> dict[str, str]:
    return {
        **realtime_feeds(manifest),
        **{
            endpoint: manifest.feeds[endpoint].feed_kind.value
            for endpoint in alert_sources(manifest)
        },
    }


class _PackReader:
    def __init__(self, stream: ByteStream) -> None:
        self.stream = stream
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size: int = -1) -> bytes:
        data = self.stream.read(size)
        self.digest.update(data)
        self.size += len(data)
        return data


def _manifest_only_polls(manifest: Manifest, start: datetime, end: datetime) -> Iterator[FeedPoll]:
    entries = {entry.capture_row_id: entry for entry in manifest.captures}
    for poll in manifest.polls:
        if not start <= poll.time_utc <= end:
            continue
        capture = entries.get(poll.capture_row_id) if poll.capture_row_id is not None else None
        if (
            capture is not None
            and capture.packed
            and capture.ingestion_run_id == poll.ingestion_run_id
            and start <= capture.captured_at_utc <= end
        ):
            # The payload supplies the outcome and header for this attempt.
            continue
        duplicate = poll.status == "skipped_identical"
        if duplicate and poll.duplicate_of_row_id is not None:
            capture = entries.get(poll.duplicate_of_row_id)
        yield FeedPoll(
            manifest.endpoint_key,
            poll.time_utc,
            str(poll.ingestion_run_id),
            "duplicate" if duplicate else "error",
            poll.feed_timestamp_utc if poll.feed_timestamp_source == "header" else None,
            capture.byte_size if capture is not None else None,
            poll.entity_count,
        )


def _packed_day(
    storage: BronzeStorage,
    prefix: str,
    manifest: Manifest,
    family: str,
    start: datetime,
    end: datetime,
) -> Iterator[DayCapture]:
    packed = []
    entries = [c for c in manifest.captures if c.packed]
    if manifest.pack is None or not any(start <= c.captured_at_utc <= end for c in entries):
        return
    for entry in entries:
        assert entry.stream is not None and entry.offset is not None
        packed.append(PackedCapture(entry.stream, entry.offset, entry.byte_size, entry.sha256))
    key = prefix + manifest.pack.path
    with storage.open_stream(key) as source:
        stream = _PackReader(source)
        for entry, payload in zip(
            entries, read_pack(stream, manifest.streams, packed), strict=True
        ):
            if start <= entry.captured_at_utc <= end:
                yield DayCapture(
                    family,
                    manifest.endpoint_key,
                    entry.captured_at_utc,
                    str(entry.ingestion_run_id),
                    payload,
                )
        if (
            stream.read(1)
            or stream.size != manifest.pack.byte_size
            or stream.digest.hexdigest() != manifest.pack.sha256
        ):
            raise ValueError(f"Capture pack checksum or size differs from manifest: {key}")
