"""Collect alert versions from the declared alert feeds for one local day."""

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime
from hashlib import sha256

from google.protobuf.message import DecodeError  # type: ignore[import-untyped]

from transit_ops.clean_day_realtime import DayCapture, FeedPoll, PollResult
from transit_ops.core.models import ProviderManifest, SourceFormat
from transit_ops.providers.alert_record import AlertRecord, Period
from transit_ops.providers.formats import decode_gtfs_rt
from transit_ops.providers.formats.alerts_gtfs_rt import gtfs_rt_alerts
from transit_ops.providers.formats.alerts_stm_json import stm_json_alerts

type AlertSource = tuple[SourceFormat, str]

ALERT_SOURCES: dict[SourceFormat, str] = {
    SourceFormat.API_I3_JSON: ".json",
    SourceFormat.GTFS_RT_SERVICE_ALERTS: ".pb",
}


def alert_sources(manifest: ProviderManifest) -> dict[str, AlertSource]:
    return {
        endpoint: (feed.source_format, ALERT_SOURCES[feed.source_format])
        for endpoint, feed in manifest.feeds.items()
        if feed.is_enabled and feed.source_format in ALERT_SOURCES
    }


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _version(record: AlertRecord) -> str:
    # The Silver identity uses display text and publication metadata. Use all
    # published text variants and selectors here, independent of capture order.
    periods = [
        (start.isoformat() if start else None, end.isoformat() if end else None)
        for start, end in _ordered_periods(record)
    ]
    selectors = record.selector_keys
    if selectors is None:
        selectors = tuple(_canonical(entity.raw) for entity in record.informed_entities)
    content = (
        record.header,
        record.description,
        periods,
        sorted(set(selectors)),
        record.cause,
        record.effect,
    )
    return sha256(_canonical(content).encode()).hexdigest()


def _ordered_periods(record: AlertRecord) -> list[Period]:
    return sorted(
        set(record.active_periods),
        key=lambda period: tuple(bound.isoformat() if bound else "" for bound in period),
    )


def _utc_timestamp(stamp: datetime | None) -> datetime | None:
    # The writer's connection is set to UTC. Bind naive UTC values so DuckDB's
    # Python conversion does not need a separate timezone package for lists.
    return stamp.astimezone(UTC).replace(tzinfo=None) if stamp is not None else None


@dataclass
class AlertVersion:
    record: AlertRecord
    source: SourceFormat
    first_seen_at_utc: datetime
    last_seen_at_utc: datetime

    def row(
        self, provider: str, day: date, cleaning_version: str, alert_id: str, version: str
    ) -> tuple[object, ...]:
        record = self.record
        return (
            provider,
            day,
            cleaning_version,
            alert_id,
            version,
            _utc_timestamp(self.first_seen_at_utc),
            _utc_timestamp(self.last_seen_at_utc),
            record.header.get("en"),
            record.header.get("fr"),
            record.description.get("en"),
            record.description.get("fr"),
            [
                {"start_utc": _utc_timestamp(start), "end_utc": _utc_timestamp(end)}
                for start, end in _ordered_periods(record)
            ],
            sorted({entity.route_id for entity in record.informed_entities if entity.route_id}),
            sorted({entity.stop_id for entity in record.informed_entities if entity.stop_id}),
            record.cause,
            record.effect,
            self.source.value,
        )


def read_alert_capture(
    capture: DayCapture,
    source: SourceFormat,
    seen: dict[tuple[str, bytes], FeedPoll],
) -> tuple[FeedPoll, tuple[AlertRecord, ...]]:
    """Decode one alert capture into its poll and records, mirroring read_capture.

    The payload is always parsed so that a repeated, identical publication still
    extends each alert version's last-seen time while the attempt is reported as
    a duplicate.
    """
    key = (capture.feed, sha256(capture.payload).digest())
    previous = seen.get(key)
    header: datetime | None = None
    entities: int | None = None
    records: tuple[AlertRecord, ...] = ()
    status: PollResult = "error"
    try:
        if source == SourceFormat.API_I3_JSON:
            records = stm_json_alerts(json.loads(capture.payload), preserve_flat_targets=True)
        else:
            message = decode_gtfs_rt(capture.payload)
            if not message.IsInitialized():
                raise DecodeError("Incomplete GTFS-Realtime capture")
            if message.header.timestamp:
                header = datetime.fromtimestamp(message.header.timestamp, UTC)
            records = gtfs_rt_alerts(capture.payload, message)
        entities = len(records)
        status = "ok" if entities else "empty"
    except (DecodeError, TypeError, OverflowError, OSError, ValueError):
        status = "error"
    if previous is not None and previous.result != "error":
        status = "duplicate"
    poll = FeedPoll(
        capture.feed,
        capture.captured_at_utc,
        capture.attempt_id,
        status,
        header,
        len(capture.payload),
        entities,
    )
    seen[key] = poll
    return poll, records


def collect_alerts(
    versions: dict[tuple[str, str, SourceFormat], AlertVersion],
    source: SourceFormat,
    captured: datetime,
    records: tuple[AlertRecord, ...],
) -> None:
    for record in records:
        version = _version(record)
        # Without an agency ID there is no evidence linking two different
        # contents to the same alert. Identical anonymous records still merge.
        alert_id = record.id or f"anonymous:{version}"
        key = alert_id, version, source
        if (prior := versions.get(key)) is None:
            versions[key] = AlertVersion(record, source, captured, captured)
        else:
            prior.first_seen_at_utc = min(prior.first_seen_at_utc, captured)
            prior.last_seen_at_utc = max(prior.last_seen_at_utc, captured)
