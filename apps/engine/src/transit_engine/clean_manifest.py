"""Validate the completion receipt before a clean day can be measured."""

import json
import re
from datetime import datetime, timedelta

STOP_EVENTS = "stop_events.parquet"
TRIP_DAYS = "trip_days.parquet"
ALERTS = "alerts.parquet"
SCHEDULED_STOP_TIMES = "scheduled_stop_times.parquet"
VEHICLE_POSITIONS = "vehicle_positions.parquet"
FEED_POLLS = "feed_polls.parquet"
PREDICTION_SAMPLES = "prediction_samples.parquet"
ALERT_VERSIONS = frozenset({"5", "6", "7", "8", "9", "10", "11"})
STOP_ELIGIBILITY_VERSION = 9
_UNMEASURED_STATUSES = ("no_raw_captures", "no_schedule_edition", "schedule_archive_unreadable")
_V4_FILES = (SCHEDULED_STOP_TIMES, VEHICLE_POSITIONS, FEED_POLLS)
_SHA256 = re.compile(r"[0-9a-f]{64}")


def file_identities(
    payload: bytes, provider: str, day: str, version: str
) -> dict[str, tuple[str, int]] | None:
    try:
        manifest = json.loads(payload)
        if not isinstance(manifest, dict) or (
            manifest.get("provider"),
            manifest.get("service_date"),
            manifest.get("cleaning_version"),
        ) != (provider, day, version):
            return None
        built = manifest.get("built_at_utc")
        if not isinstance(built, str) or datetime.fromisoformat(built).utcoffset() != timedelta(0):
            return None
        commit = manifest.get("builder_git_commit")
        if commit is not None and (
            not isinstance(commit, str)
            or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", commit)
        ):
            return None
        status = manifest.get("status")
        if status is not None:
            if status in _UNMEASURED_STATUSES and "files" not in manifest:
                return {}
            return None
        checksum = manifest.get("schedule_sha256")
        if not isinstance(checksum, str) or not _SHA256.fullmatch(checksum):
            return None
        files = manifest.get("files")
        count_fields = {STOP_EVENTS: "row_counts_by_basis", TRIP_DAYS: "row_counts_by_state"}
        expected = set(count_fields)
        if version == "4" or version in ALERT_VERSIONS:
            expected.update(_V4_FILES)
        if version in {"7", "8", "9", "10", "11"}:
            expected.add(PREDICTION_SAMPLES)
        if version in ALERT_VERSIONS:
            if "alerts" not in manifest:
                expected.add(ALERTS)
            elif manifest["alerts"] != "not_tracked":
                return None
        if not isinstance(files, dict) or set(files) != expected:
            return None
        identities: dict[str, tuple[str, int]] = {}
        for name, entry in files.items():
            if not isinstance(entry, dict):
                return None
            digest, size, rows = entry.get("sha256"), entry.get("byte_size"), entry.get("rows")
            if (
                not isinstance(digest, str)
                or not _SHA256.fullmatch(digest)
                or type(size) is not int
                or size <= 0
                or type(rows) is not int
                or rows < 0
            ):
                return None
            if field := count_fields.get(name):
                counts = manifest.get(field)
                if (
                    not isinstance(counts, dict)
                    or any(type(count) is not int or count < 0 for count in counts.values())
                    or sum(counts.values()) != rows
                ):
                    return None
            identities[name] = (digest, size)
        return identities
    except (ValueError, RecursionError):
        return None
