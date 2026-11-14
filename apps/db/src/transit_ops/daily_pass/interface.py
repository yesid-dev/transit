"""Pure daily-pass values; capture identity is independent of physical storage."""

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
from types import MappingProxyType
from typing import Literal, Protocol

from sqlalchemy import Connection

from transit_ops.capture_coverage.rules import CaptureKey
from transit_ops.history.reader import Capture, FeedDay, Poll
from transit_ops.providers.declaration import Provider
from transit_ops.providers.modes import RuleMode
from transit_ops.providers.normalize import NormalizedCapture, RawCapture, ScheduleIdentity
from transit_ops.providers.schedule import ScheduleContext
from transit_ops.snapshots.serialization import snapshot_json_bytes

FeedFamily = Literal["trip_updates", "vehicle_positions", "alerts"]
DeliveryOutcome = Literal[
    "decoded",
    "rejected",
    "unreadable",
    "capture_missing",
    "failed_poll",
    "unfinished",
    "skipped_identical",
]
PASS_VERSION = 1
PASS_LEAD_SECONDS = 3_600
PASS_TAIL_SECONDS = 129_600


@dataclass(frozen=True)
class Delivery:
    sequence: int
    family: FeedFamily
    endpoint_key: str
    time_utc: datetime
    in_service_day: bool
    poll: Poll
    capture: Capture | None
    ref: CaptureKey | None
    outcome: DeliveryOutcome
    normalized: NormalizedCapture | None
    payload: bytes | None

    @property
    def has_entities(self) -> bool:
        return self.outcome == "decoded"


@dataclass(frozen=True)
class ServiceDayBuild:
    provider: Provider
    service_date: date
    day_start_utc: datetime
    day_end_utc: datetime
    window_start_utc: datetime
    window_end_utc: datetime
    feeds: Mapping[str, FeedFamily]
    feed_days: tuple[FeedDay, ...]
    schedule: ScheduleContext
    normalizer: str
    pass_fingerprint: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "feeds", MappingProxyType(dict(self.feeds)))
        object.__setattr__(self, "feed_days", tuple(self.feed_days))


@dataclass(frozen=True)
class LineMatch:
    realtime_trip_ids: int
    matched_trip_ids: int
    passes: bool


@dataclass(frozen=True)
class StreamSummary:
    completeness: Literal["complete", "incomplete"]
    incomplete_reasons: tuple[str, ...]
    deliveries: Mapping[str, Mapping[str, int]]
    accounted_share: Mapping[str, float | None]
    consumed: frozenset[CaptureKey]
    consumed_set_sha256: str
    missing_blocks: Mapping[str, tuple[tuple[datetime, datetime], ...]]
    line_match: Mapping[tuple[date, str], LineMatch]

    def __post_init__(self) -> None:
        deliveries = {
            key: MappingProxyType(dict(counts)) for key, counts in self.deliveries.items()
        }
        blocks = {
            key: tuple(tuple(block) for block in spans)
            for key, spans in self.missing_blocks.items()
        }
        object.__setattr__(self, "deliveries", MappingProxyType(deliveries))
        object.__setattr__(self, "accounted_share", MappingProxyType(dict(self.accounted_share)))
        object.__setattr__(self, "missing_blocks", MappingProxyType(blocks))
        object.__setattr__(self, "line_match", MappingProxyType(dict(self.line_match)))
        object.__setattr__(self, "incomplete_reasons", tuple(self.incomplete_reasons))
        object.__setattr__(self, "consumed", frozenset(self.consumed))


@dataclass(frozen=True)
class WindowLock:
    dataset_id: str
    window_key: str
    revision: int = 0


@dataclass(frozen=True)
class Decision:
    action: Literal["build", "skip", "refuse"]
    reason: str | None = None


class PassConsumer(Protocol):
    name: str
    version: int
    families: frozenset[FeedFamily]
    uses_schedule: bool
    uses_coverage: bool
    wants_bytes: bool

    def fingerprint_extra(self, build: ServiceDayBuild) -> Mapping[str, str | int]: ...
    def decide(self, build: ServiceDayBuild, connection: Connection) -> Decision: ...
    def locks(self, build: ServiceDayBuild) -> Sequence[WindowLock]: ...
    def accept(self, delivery: Delivery) -> None: ...
    def write(
        self,
        build: ServiceDayBuild,
        summary: StreamSummary,
        connection: Connection,
    ) -> Mapping[str, object]: ...


class CaptureNormalizer(Protocol):
    def __call__(
        self,
        provider: Provider,
        capture: RawCapture,
        schedule: ScheduleIdentity | None = None,
        *,
        modes: Mapping[str, RuleMode],
        collect: bool = False,
    ) -> NormalizedCapture: ...


def consumed_set_sha256(consumed: Collection[CaptureKey]) -> str:
    identities = [[key.index_family, key.capture_row_id] for key in sorted(set(consumed))]
    # The canonical serializer accepts JSON lists; its annotation is narrower.
    return sha256(snapshot_json_bytes(identities)).hexdigest()  # type: ignore[arg-type]
