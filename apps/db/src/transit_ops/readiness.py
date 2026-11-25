"""Check a city's declaration and one sample of each feed without writing product data."""

import argparse
import csv
import json
import os
import re
import sys
import zlib
from collections import Counter
from datetime import UTC, date, datetime
from functools import cache
from hashlib import sha256
from http.client import HTTPException
from importlib.resources import files
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from google.protobuf.message import DecodeError
from google.transit.gtfs_realtime_pb2 import FeedHeader, VehiclePosition
from pydantic import ValidationError

from transit_ops.clean_day import STOPPED_AT_RADIUS_METRES
from transit_ops.core.models import FeedConfigBase, FeedKind, ProviderManifest
from transit_ops.ingestion.common import build_request_details, download_to_tempfile, project_root
from transit_ops.providers.declaration import DeclarationError
from transit_ops.providers.formats import decode_gtfs_rt
from transit_ops.providers.formats.alerts_stm_json import stm_json_alerts
from transit_ops.providers.registry import load_provider_manifest
from transit_ops.providers.schedule import InvalidScheduleEdition
from transit_ops.providers.schedule_archive import ArchiveScheduleContext
from transit_ops.silver.static_rows import RowRejection, iter_member_rows

REALTIME = {
    FeedKind.VEHICLE_POSITIONS: "vehicle",
    FeedKind.TRIP_UPDATES: "trip_update",
    FeedKind.SERVICE_ALERTS: "alert",
    FeedKind.I3_ALERTS: "alert",
}


class CheckError(ValueError):
    """A diagnostic safe to repeat without exposing request or feed data."""


class ProcessEnvironment:
    @staticmethod
    def env_value(name: str | None) -> str | None:
        return os.environ.get(name) if name else None


def _sample(feed: FeedConfigBase, local: Path | None, directory: Path) -> bytes:
    if local is not None:
        try:
            return local.read_bytes()
        except OSError:
            raise CheckError("sample file could not be read") from None
    env = ProcessEnvironment()
    if any(
        not env.env_value(name)
        for name in (feed.auth.credential_env_var, feed.auth.signing_secret_env_var)
        if name
    ):
        raise CheckError("key required")
    url = env.env_value(feed.source_url_env_var) or str(feed.source_url or "")
    if not url:
        raise CheckError("feed URL required")
    try:
        if urlsplit(url).scheme not in {"http", "https"}:
            raise ValueError
        request = build_request_details(source_url=url, auth=feed.auth, settings=env)
        artifact = download_to_tempfile(
            source_url=request.request_url,
            headers=request.request_headers,
            temp_dir=directory,
            default_filename="readiness.bin",
        )
        return artifact.temp_path.read_bytes()
    except (OSError, HTTPException, ValueError):
        raise CheckError("feed download failed") from None


def _declaration(path: Path) -> tuple[ProviderManifest, ZoneInfo, list[str]]:
    try:
        manifest = load_provider_manifest(path)
    except ValidationError as exc:
        # Report schema locations only. Validation inputs may contain credentials.
        fields = sorted(
            {".".join(map(str, issue["loc"])) for issue in exc.errors(include_input=False)}
        )
        raise CheckError("invalid declaration fields: " + ", ".join(fields)) from None
    except DeclarationError as exc:
        raise CheckError(str(exc).replace("\n", "; ")) from None
    except ValueError:
        raise CheckError("could not validate provider declaration") from None
    provider, public = manifest.provider, manifest.public
    if provider.provider_id != path.stem:
        raise CheckError("provider id must match the declaration filename")
    try:
        zone = ZoneInfo(provider.timezone)
    except (ValueError, ZoneInfoNotFoundError):
        raise CheckError("timezone must be a valid IANA zone") from None
    blockers = []
    bounds = provider.bounds
    if not bounds or not (
        bounds.min_latitude < bounds.max_latitude and bounds.min_longitude < bounds.max_longitude
    ):
        blockers.append("provider bounds must have positive width and height")
    for locale in ("en", "fr"):
        label = public.labels.get(locale)
        if label is None or not (label.city.strip() and label.operator.strip()):
            blockers.append(f"public city and operator labels required in {locale}")
        if public.alert_links and locale not in public.alert_links:
            blockers.append(f"alert link required in {locale} when links are declared")
    if not provider.attribution_text or not provider.attribution_text.strip():
        blockers.append("provider attribution required")
    if public.download_licence is None:
        blockers.append("reviewed bilingual download licence and attribution required")
    return manifest, zone, blockers


@cache
def _timezone_links() -> dict[str, str]:
    """Read the portable IANA link table shipped with tzdata."""
    links = {}
    with files("tzdata.zoneinfo").joinpath("tzdata.zi").open(encoding="utf-8") as source:
        for line in source:
            if line.startswith("L "):
                _, target, alias = line.split()
                links[alias] = target
    return links


def _canonical_timezone(name: str | None) -> str | None:
    links = _timezone_links()
    while name is not None and name in links:
        name = links[name]
    return name


def _static(
    payload: bytes, provider: str, zone: ZoneInfo, today: date
) -> tuple[dict[str, Any], set[str], set[str]]:
    try:
        schedule = ArchiveScheduleContext(
            provider_id=provider,
            dataset_version_id=1,
            edition_sha256=sha256(payload).hexdigest(),
            archive_bytes=payload,
            service_dates=[today],
            timezone=zone,
        )
        with ZipFile(BytesIO(payload)) as archive:

            def rows(member: str):
                for row in iter_member_rows(archive, member, provider_id=provider):
                    if isinstance(row, RowRejection):
                        raise CheckError(f"{member} contains an invalid row")
                    yield row

            agency_zones = {
                _canonical_timezone(row["agency_timezone"]) for row in rows("agency.txt")
            }
            if agency_zones != {_canonical_timezone(zone.key)}:
                raise CheckError("agency_timezone must match the declaration")
            trips = list(rows("trips.txt"))
            trip_ids = {row["trip_id"] for row in trips}
            stop_ids = {row["stop_id"] for row in rows("stops.txt")}
            shapes = {row["shape_id"] for row in rows("shapes.txt")}
            referenced = {row["shape_id"] for row in trips if row["shape_id"]}
            if referenced - shapes:
                raise CheckError("shapes.txt must contain the shape ids referenced by trips")
            if not trip_ids or not stop_ids:
                raise CheckError("static schedule must contain trips and stops")
            service_ids = {row["service_id"] for row in trips}
            calendar = [row for row in rows("calendar.txt") if row["service_id"] in service_ids]
            additions = [
                row["service_date"]
                for row in rows("calendar_dates.txt")
                if row["service_id"] in service_ids and row["exception_type"] == 1
            ]
            start = min([row["start_date"] for row in calendar] + additions, default=None)
            end = max([row["end_date"] for row in calendar] + additions, default=None)
            if start is None or end is None or start > end:
                raise CheckError("calendar or calendar_dates must declare a service date range")
    except CheckError:
        raise
    except (ValueError, OSError, RuntimeError, BadZipFile, csv.Error, zlib.error, EOFError) as exc:
        reason = exc.reason if isinstance(exc, InvalidScheduleEdition) else "invalid archive"
        raise CheckError(f"static GTFS failed cleaner validation ({reason})") from None
    return (
        {
            "service_start": start.isoformat(),
            "service_end": end.isoformat(),
            "covers_today": start <= today <= end,
            "trips_today": len(schedule.days[today].trip_ids),
            "trip_ids": len(trip_ids),
            "stop_ids": len(stop_ids),
            "shape_ids": len(shapes),
        },
        trip_ids,
        stop_ids,
    )


def _realtime(
    payload: bytes,
    feed: FeedConfigBase,
    ids: tuple[set[str], set[str]] | None,
    now: datetime,
) -> tuple[dict[str, Any], list[str]]:
    if feed.feed_kind == FeedKind.I3_ALERTS:
        try:
            alerts = stm_json_alerts(json.loads(payload), preserve_flat_targets=True)
        except (ValueError, TypeError):
            raise CheckError("invalid alert sample") from None
        return {"entities": len(alerts)}, []
    try:
        message = decode_gtfs_rt(payload)
        if not message.IsInitialized() or not message.header.gtfs_realtime_version:
            raise DecodeError("incomplete message")
    except DecodeError:
        raise CheckError("invalid GTFS-Realtime sample") from None

    age = int(now.timestamp()) - message.header.timestamp if message.header.timestamp else None
    full = message.header.incrementality == FeedHeader.FULL_DATASET
    blockers = []
    if not full:
        blockers.append("differential feed requires full dataset")
    if age is not None and not 0 <= age <= 3 * feed.refresh_interval_seconds:
        blockers.append("feed timestamp outside three declared polling intervals")
    counts: Counter[str] = Counter()
    trips: list[str] = []
    stops: list[str] = []
    unknown_stop_without_trip = 0
    field = REALTIME[feed.feed_kind]
    for entity in message.entity:
        if entity.is_deleted or not entity.HasField(field):
            continue
        counts["entities"] += 1
        record = getattr(entity, field)
        if field == "vehicle":
            trips.append(record.trip.trip_id)
            stops.append(record.stop_id)
            if ids and record.stop_id and not record.trip.trip_id and record.stop_id not in ids[1]:
                unknown_stop_without_trip += 1
            counts["stopped_at"] += (
                record.HasField("current_status")
                and record.current_status == VehiclePosition.STOPPED_AT
            )
            for name in ("position", "occupancy_status", "occupancy_percentage"):
                counts[name] += record.HasField(name)
        elif field == "trip_update":
            trips.append(record.trip.trip_id)
            for stop in record.stop_time_update:
                counts["stop_time_update"] += 1
                stops.append(stop.stop_id)
                for name in ("arrival", "departure"):
                    counts[name] += stop.HasField(name)
        else:
            for selector in record.informed_entity:
                trips.append(selector.trip.trip_id)
                stops.append(selector.stop_id)
    if not counts["entities"] and (message.entity or field in {"vehicle", "trip_update"}):
        blockers.append(f"sample has no {field} entities")
    evidence: dict[str, Any] = {
        "entities": counts["entities"],
        "full_dataset": full,
        "timestamp_age_seconds": age,
    }
    for index, (name, values) in enumerate((("trip_id", trips), ("stop_id", stops))):
        reported = sum(bool(value) for value in values)
        matched = sum(value in ids[index] for value in values if value) if ids else None
        evidence[name] = {"reported": reported, "matched": matched}
        if matched is not None and reported > matched:
            unknown = reported - matched
            if name == "stop_id" and field == "vehicle" and unknown == unknown_stop_without_trip:
                continue
            if name == "stop_id" and field == "trip_update":
                # Permit at most 0.5% isolated rows. An unknown stop cannot supply a reading.
                if unknown * 200 <= counts["stop_time_update"]:
                    continue
                blockers.append(
                    f"stop_id mismatch with static GTFS "
                    f"({unknown}/{counts['stop_time_update']} stop updates, limit 0.5%)"
                )
                continue
            blockers.append(f"{name} mismatch with static GTFS ({unknown}/{reported})")
    if field == "vehicle":
        evidence["unknown_stop_without_trip"] = unknown_stop_without_trip if ids else None
        evidence.update(
            {
                name: counts[name]
                for name in ("position", "stopped_at", "occupancy_status", "occupancy_percentage")
            }
        )
        evidence["stop_detection"] = (
            "stopped_at"
            if counts["stopped_at"]
            else f"gps_{STOPPED_AT_RADIUS_METRES}m"
            if counts["entities"]
            else "unobserved"
        )
        evidence["occupancy"] = (
            "supported"
            if counts["occupancy_status"] or counts["occupancy_percentage"]
            else "unobserved"
        )
    if field == "trip_update":
        stop_match = evidence["stop_id"]
        evidence["unknown_stop_time_updates"] = (
            stop_match["reported"] - stop_match["matched"] if ids else None
        )
        evidence["unknown_stop_time_update_limit_percent"] = 0.5
        evidence.update(
            {name: counts[name] for name in ("stop_time_update", "arrival", "departure")}
        )
    return evidence, blockers


def check_provider(
    declaration: Path,
    *,
    static: Path | None = None,
    samples: dict[str, Path] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Report one sample per enabled realtime endpoint. Optional feeds stay distinct."""
    samples = samples or {}
    report: dict[str, Any] = {
        "schema_version": 1,
        "provider": declaration.stem,
        "ready": False,
        "declaration": {"status": "invalid", "timezone": None},
        "capabilities": {
            key.value: {"status": "unverified", "evidence": None}
            for key in (FeedKind.STATIC_SCHEDULE, *REALTIME)
        },
        "blockers": [],
    }
    blockers = report["blockers"]
    try:
        manifest, zone, checks = _declaration(declaration)
    except CheckError as exc:
        blockers.append(f"declaration: {exc}")
        return report
    report["declaration"] = {"status": "incomplete" if checks else "valid", "timezone": zone.key}
    blockers.extend(f"declaration: {check}" for check in checks)
    feeds = {feed.feed_kind: feed for feed in manifest.feeds.values() if feed.is_enabled}
    blockers.extend(
        f"{key}: sample has no enabled endpoint" for key in sorted(samples.keys() - feeds)
    )
    ids = None
    today = (now or datetime.now(UTC)).astimezone(zone).date()
    with TemporaryDirectory(prefix="transit-readiness-") as tmp:
        for key, verdict in report["capabilities"].items():
            feed = feeds.get(key)
            if feed is None:
                verdict["status"] = "not_applicable"
                if key == FeedKind.STATIC_SCHEDULE:
                    verdict["status"] = "blocked"
                    blockers.append(f"{key}: schedule is disabled")
                continue
            try:
                local = static if key == FeedKind.STATIC_SCHEDULE else samples.get(key)
                payload = _sample(feed, local, Path(tmp))
                if key == FeedKind.STATIC_SCHEDULE:
                    evidence, trips, stops = _static(payload, declaration.stem, zone, today)
                    ids = trips, stops
                    issues = [] if evidence["covers_today"] else ["service date outside feed range"]
                else:
                    evidence, issues = _realtime(payload, feed, ids, now or datetime.now(UTC))
                verdict.update(
                    status="blocked"
                    if issues
                    else "supported"
                    if key == FeedKind.STATIC_SCHEDULE or evidence["entities"]
                    else "unobserved",
                    evidence={
                        "source": "file" if local else "network",
                        "format": feed.source_format.value,
                        **evidence,
                    },
                )
                blockers.extend(f"{key}: {issue}" for issue in issues)
            except CheckError as exc:
                verdict["status"] = "key_required" if str(exc) == "key required" else "blocked"
                blockers.append(f"{key}: {exc}")
    report["ready"] = not blockers
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider", help="Provider declaration id")
    parser.add_argument("--static", type=Path, help="Read a local static GTFS ZIP")
    parser.add_argument(
        "--sample",
        action="append",
        default=[],
        metavar="ENDPOINT=PATH",
        help="Read one local realtime sample by endpoint key. May be repeated.",
    )
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.provider):
        parser.error("provider must be a declaration id")
    samples = {}
    for item in args.sample:
        key, separator, filename = item.partition("=")
        if not separator or not filename or key not in REALTIME or key in samples:
            parser.error("each --sample requires a distinct realtime ENDPOINT=PATH")
        samples[key] = Path(filename)
    declaration = project_root() / "config" / "providers" / f"{args.provider}.yaml"
    report = check_provider(declaration, static=args.static, samples=samples)
    print(json.dumps(report, indent=2))
    outcome = "ready for sampled checks" if report["ready"] else "blocked"
    print(f"{args.provider}: {outcome} ({len(report['blockers'])} blockers)", file=sys.stderr)
    for blocker in report["blockers"]:
        print(f"- {blocker}", file=sys.stderr)
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
