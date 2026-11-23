"""Rebuild an inclusive range from the raw capture and schedule archive."""

import json
import os
import re
from collections import Counter
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import boto3
import typer
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from transit_ops.clean_day import REALTIME_FEEDS, capture_window
from transit_ops.clean_day_inputs import (
    Edition,
    capture_feeds,
    clean_from_inputs,
    declaration_for,
    edition_index,
    find_loose_captures,
    load_contexts,
    merged_captures,
    read_loose_captures,
    realtime_capture_present,
    realtime_feeds,
)
from transit_ops.clean_day_output import (
    UnmeasuredReason,
    publish_clean_day,
    publish_unmeasured_day,
    version_key,
    write_clean_day,
    write_unmeasured_day,
)
from transit_ops.core.models import ProviderManifest
from transit_ops.history.manifest import Manifest, decode_manifest
from transit_ops.ingestion.storage import BronzeStorage, LocalBronzeStorage, S3BronzeStorage
from transit_ops.lake.objects import put_create_only
from transit_ops.providers.schedule_archive import ArchiveScheduleContext
from transit_ops.s3 import ObjectStorageError

_S3_URL = re.compile(r"s3://([a-z0-9][a-z0-9.-]*)(?:/([a-zA-Z0-9._/-]*))?")
_ORIGINAL = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2})/([0-9]{8}T[0-9]{12}Z)__([0-9a-f]{12})__[^/]+")
_ZIP = re.compile(r"([0-9a-f]{64})\.zip")
_MANIFEST = re.compile(r"([1-9][0-9]*)\.manifest\.json\.gz")


def _storage(location: str, role: str) -> tuple[BronzeStorage, str]:
    if not location.startswith("s3://"):
        return LocalBronzeStorage(storage_backend="local", root=Path(location)), ""
    parsed = _S3_URL.fullmatch(location)
    if not parsed or any(part in {".", ".."} for part in (parsed[2] or "").split("/")):
        raise ValueError(f"Expected {role.lower()} S3 URL in s3://bucket[/prefix] form")
    bucket, prefix = parsed[1], (parsed[2] or "").strip("/")
    env = f"CLEAN_{role}_S3_"
    names = [env + key for key in ("ENDPOINT", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY")]
    if missing := [name for name in names if not os.environ.get(name)]:
        raise ValueError(f"Required environment variables: {', '.join(missing)}")
    endpoint, access_key, secret_key = (os.environ[name] for name in names)
    url = urlsplit(endpoint)
    if (
        url.scheme not in {"http", "https"}
        or not url.hostname
        or url.username is not None
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
    ):
        raise ValueError(f"{names[0]} must be an HTTP(S) endpoint without a path or credentials")
    client = boto3.session.Session().client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        aws_session_token=os.environ.get(env + "SESSION_TOKEN"),
        region_name=os.environ.get(env + "REGION", "auto"),
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 6, "mode": "standard"},
            connect_timeout=10,
            read_timeout=60,
        ),
    )
    return S3BronzeStorage("s3", bucket, endpoint, client), f"{prefix}/" if prefix else ""


def discover_editions(
    storage: BronzeStorage, prefix: str, declaration: ProviderManifest
) -> dict[date, tuple[Edition, ...]]:
    provider = declaration.provider
    archive = f"{prefix}archive/v1/schedules/{provider.provider_id}/"
    index = archive + "editions.json"
    if storage.exists(index):
        pinned = edition_index(json.loads(storage.read_bytes(index)), provider.provider_id)
        for edition in pinned.values():
            if edition.key != f"{edition.sha256}.zip":
                raise ValueError("Archive edition index paths must be sibling checksum ZIPs")
        return {
            day: (Edition(archive + edition.key, edition.sha256),)
            for day, edition in pinned.items()
        }

    archived: dict[str, list[Edition]] = {}
    for key in storage.list_keys(archive):
        if match := _ZIP.fullmatch(key.removeprefix(archive)):
            archived.setdefault(match[1][:12], []).append(Edition(key, match[1]))
    zone = ZoneInfo(provider.timezone)
    originals: dict[date, dict[datetime, Edition]] = {}
    for endpoint, feed in declaration.feeds.items():
        if not feed.is_enabled or feed.feed_kind.value != "static_schedule":
            continue
        original = f"{prefix}{provider.provider_id}/{endpoint}/ingested_at_utc="
        for key in storage.list_keys(original):
            if not (match := _ORIGINAL.fullmatch(key.removeprefix(original))):
                continue
            observed = datetime.strptime(match[2], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
            if observed.date().isoformat() != match[1]:
                raise ValueError(f"Schedule timestamp disagrees with Bronze partition: {key}")
            day = observed.astimezone(zone).date()
            candidates = archived.get(match[3], [])
            edition = (
                Edition(candidates[0].key, candidates[0].sha256, key)
                if len(candidates) == 1
                else Edition(key, match[3], key)
            )
            observations = originals.setdefault(day, {})
            previous = observations.setdefault(observed, edition)
            if (previous.key, previous.sha256) != (edition.key, edition.sha256):
                raise ValueError(f"Competing schedule editions observed at {observed.isoformat()}")
    if not originals:
        raise ValueError("No dated Bronze schedule originals or archive editions.json found")
    return {
        day: tuple(observations[stamp] for stamp in sorted(observations, reverse=True))
        for day, observations in originals.items()
    }


def _capture_manifests(
    storage: BronzeStorage,
    prefix: str,
    declaration: ProviderManifest,
    start: datetime,
    end: datetime,
) -> Iterator[tuple[Manifest, str]]:
    provider = declaration.provider.provider_id
    for endpoint, family in capture_feeds(declaration).items():
        day = start.date()
        while day <= end.date():
            base = f"archive/v1/captures/{provider}/{endpoint}/{day:%Y/%m}/{day.isoformat()}.c"
            search = prefix + base
            latest = max(
                (
                    (int(match[1]), key)
                    for key in storage.list_keys(search)
                    if (match := _MANIFEST.fullmatch(key.removeprefix(search)))
                ),
                default=None,
            )
            if latest is not None:
                version, key = latest
                manifest = decode_manifest(storage.read_bytes(key))
                if (
                    (manifest.provider_id, manifest.endpoint_key, manifest.utc_date)
                    != (provider, endpoint, day)
                    or manifest.feed_kind != family
                    or manifest.content_version != version
                    or (manifest.pack and manifest.pack.path != f"{base}{version}.pack.xz")
                ):
                    raise ValueError(f"Capture manifest disagrees with archive key: {key}")
                yield manifest, family
            day += timedelta(days=1)


def parse_date(value: str) -> date:
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("Expected a service date in YYYY-MM-DD form")
    return parsed


def _failure_reason(error: Exception) -> str:
    # Object-store error bodies can echo parts of the request. Print only SDK identifiers.
    cause = error.__cause__ if isinstance(error, ObjectStorageError) else error
    if isinstance(cause, ClientError):
        code = cause.response.get("Error", {}).get("Code", "")
        safe_code = code if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", code) else "unknown"
        return f"S3 {cause.operation_name} failed ({safe_code})"
    if isinstance(cause, BotoCoreError):
        return f"S3 request failed ({type(cause).__name__})"
    return f"{type(error).__name__}: {error}"


def _publish_search_schedule(
    clean: BronzeStorage, prefix: str, schedule: ArchiveScheduleContext, day: date, city: str
) -> None:
    if isinstance(clean, LocalBronzeStorage):
        clean.root.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="search-schedule-") as temporary:
        edition_key = version_key(city, day)
        index = Path(temporary) / "index.json"
        index.write_text(
            json.dumps(schedule.search_index(day), ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        put_create_only(clean, index, f"{prefix}search/v1/{edition_key}.json")
        shapes = Path(temporary) / "shapes.json"
        shapes.write_text(
            json.dumps(
                {"date": day.isoformat(), "route_shapes": dict(schedule.route_shapes)},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        put_create_only(clean, shapes, f"{prefix}maps/v1/{edition_key}.json")


def _build_day(
    declaration: ProviderManifest,
    day: date,
    editions: dict[date, tuple[Edition, ...]],
    raw: BronzeStorage,
    raw_prefix: str,
    clean: BronzeStorage,
    clean_prefix: str,
) -> tuple[UnmeasuredReason | None, list[dict[str, str]]]:
    """Build one day or return the reason and evidence for an unmeasured day."""
    if day < min(editions):
        return "no_schedule_edition", []
    schedules, ignored = load_contexts(declaration, day, editions, raw.read_bytes)
    if day not in schedules:
        return "schedule_archive_unreadable", ignored
    _publish_search_schedule(
        clean,
        clean_prefix,
        schedules[day],
        day,
        declaration.provider.provider_id,
    )
    start, end = capture_window(schedules[day], day)
    selections = list(_capture_manifests(raw, raw_prefix, declaration, start, end))
    archived = {(manifest.endpoint_key, manifest.utc_date) for manifest, _ in selections}
    loose = find_loose_captures(raw, raw_prefix, declaration, start, end, archived)
    realtime_present = any(capture.family in REALTIME_FEEDS for capture in loose) or (
        realtime_capture_present(selections, start, end)
    )
    if realtime_feeds(declaration) and not realtime_present:
        return "no_raw_captures", ignored
    captures = merged_captures(
        raw, raw_prefix, selections, start, end, read_loose_captures(raw, loose)
    )
    cleaned = clean_from_inputs(declaration, day, schedules, captures)
    if isinstance(clean, LocalBronzeStorage):
        write_clean_day(cleaned, clean.root, ignored_invalid_original=ignored)
    else:
        publish_clean_day(cleaned, clean, clean_prefix, ignored_invalid_original=ignored)
    return None, ignored


def run_clean_days(provider: str, first: str, last: str, source: str, dest: str) -> None:
    try:
        start_day, end_day = parse_date(first), parse_date(last)
        if start_day > end_day:
            raise ValueError("--from must be on or before --to")
        declaration = declaration_for(provider)
        raw, raw_prefix = _storage(source, "SOURCE")
        clean, clean_prefix = _storage(dest, "DEST")
    except (ValueError, OSError, BotoCoreError, ClientError) as error:
        typer.echo(_failure_reason(error), err=True)
        raise typer.Exit(1) from None

    def settle(day: date, reason: UnmeasuredReason, ignored: list[dict[str, str]]) -> None:
        if isinstance(clean, LocalBronzeStorage):
            write_unmeasured_day(
                provider, day, clean.root, reason, ignored_invalid_original=ignored
            )
        else:
            publish_unmeasured_day(
                provider, day, clean, clean_prefix, reason, ignored_invalid_original=ignored
            )

    editions = None
    built = skipped = 0
    unmeasured: Counter[UnmeasuredReason] = Counter()
    failed: dict[date, str] = {}
    for ordinal in range(start_day.toordinal(), end_day.toordinal() + 1):
        day = date.fromordinal(ordinal)
        marker = f"{clean_prefix}{version_key(provider, day)}/manifest.json"
        try:
            if clean.exists(marker):
                skipped += 1
                continue
            if editions is None:
                editions = discover_editions(raw, raw_prefix, declaration)
            outcome, ignored = _build_day(
                declaration, day, editions, raw, raw_prefix, clean, clean_prefix
            )
            if outcome is None:
                built += 1
            else:
                settle(day, outcome, ignored)
                unmeasured[outcome] += 1
        except Exception as error:
            # A failed day must leave the next service day eligible for rebuilding.
            failed[day] = _failure_reason(error)
    typer.echo(
        f"Built {built}, skipped {skipped}, no raw captures {unmeasured['no_raw_captures']}, "
        f"no schedule edition {unmeasured['no_schedule_edition']}, "
        f"failed {len(failed)}"
    )
    if unreadable := unmeasured["schedule_archive_unreadable"]:
        typer.echo(f"Unreadable schedule archive {unreadable}")
    for day, reason in failed.items():
        typer.echo(f"{day}: {reason}", err=True)
    if failed:
        raise typer.Exit(1)
