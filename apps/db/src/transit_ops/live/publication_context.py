"""Immutable, detached inputs captured by the publication owner, never a PG reader.

Source inventory: provider/core.providers + provider registry; endpoints/core.feed_endpoints;
editions/core.dataset_versions (all current); tiers/core.snapshot_publish_state or verified
control.heartbeats; feeds/latest non-silver poll status and successful completion evidence.
All are read at the supplied cycle snapshot. Original event times remain in the rows.
Alerts/children/observations and movement/serving certificates stay in borrowed LocalFile.
Resolved FeedPolicy includes source lag; manifest source_lag_s is a separate display input.
None means missing context; an explicit empty source means a successfully read empty store.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from transit_ops.live.running import FeedPolicy


def aware(value: datetime, name: str) -> datetime:
    if value.utcoffset() is None:
        raise ValueError(f"{name} must be aware")
    return value.astimezone(UTC)


@dataclass(frozen=True)
class CapturedRows:
    source: str
    captured_at: datetime
    body: bytes  # Canonical JSON rows; no mutable caller-owned dictionaries retained.

    def __post_init__(self) -> None:
        if type(self.body) is not bytes:
            raise ValueError("captured body must be immutable bytes")

    def read(self, cycle: datetime, name: str) -> list[dict[str, Any]]:
        if not self.source or aware(self.captured_at, name) != cycle:
            raise ValueError(f"{name}: source/capture instant differs from cycle")
        rows = json.loads(self.body)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError(f"{name}: expected captured rows")
        return rows


@dataclass(frozen=True)
class PublicationContext:
    cycle: datetime
    provider_id: str
    provider: CapturedRows | None = None
    endpoints: CapturedRows | None = None
    editions: CapturedRows | None = None
    tiers: CapturedRows | None = None
    feeds: CapturedRows | None = None
    trip_policy: FeedPolicy | None = None
    vehicle_policy: FeedPolicy | None = None

    def rows(self, name: str) -> list[dict[str, Any]]:
        source = getattr(self, name)
        if not isinstance(source, CapturedRows):
            raise ValueError(f"publication_context_missing:{name}")
        rows = source.read(aware(self.cycle, "cycle"), name)
        if any(r.get("provider_id") != self.provider_id for r in rows):
            raise ValueError(f"{name}: provider differs")
        return rows


def event(value: Any, cycle: datetime, name: str) -> datetime | None:
    if value is None:
        return None
    stamp = aware(datetime.fromisoformat(value) if isinstance(value, str) else value, name)
    if stamp > cycle:
        raise ValueError(f"{name} is after cycle")
    return stamp
