"""Validate the completion receipt before a clean day can be measured."""

import json
import re
from datetime import datetime, timedelta

STOP_EVENTS = "stop_events.parquet"
TRIP_DAYS = "trip_days.parquet"
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
        checksum = manifest.get("schedule_sha256")
        if not isinstance(checksum, str) or not _SHA256.fullmatch(checksum):
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
        files = manifest.get("files")
        if not isinstance(files, dict) or set(files) != {STOP_EVENTS, TRIP_DAYS}:
            return None
        identities: dict[str, tuple[str, int]] = {}
        for name, field in (
            (STOP_EVENTS, "row_counts_by_basis"),
            (TRIP_DAYS, "row_counts_by_state"),
        ):
            entry, counts = files[name], manifest.get(field)
            if not isinstance(entry, dict) or not isinstance(counts, dict):
                return None
            digest, size, rows = entry.get("sha256"), entry.get("byte_size"), entry.get("rows")
            if (
                not isinstance(digest, str)
                or not _SHA256.fullmatch(digest)
                or type(size) is not int
                or size <= 0
                or type(rows) is not int
                or rows < 0
                or any(type(count) is not int or count < 0 for count in counts.values())
                or sum(counts.values()) != rows
            ):
                return None
            identities[name] = (digest, size)
        return identities
    except (ValueError, RecursionError):
        return None
