"""In-memory fixtures; schedule and reader values stay with their owners."""

from collections.abc import Iterable, Iterator, Sequence
from dataclasses import replace
from datetime import date, datetime, timedelta
from typing import Literal, cast, get_args

from google.transit.gtfs_realtime_pb2 import FeedMessage
from history_reader_fakes import fake_capture, fake_poll
from schedule_fakes import fake_schedule

from transit_ops.capture_coverage.rules import CaptureKey
from transit_ops.daily_pass import interface as p
from transit_ops.history.datasets import IndexFamily
from transit_ops.history.reader import FeedDay, Poll
from transit_ops.providers.alert_record import AlertRecord
from transit_ops.providers.declaration import Provider
from transit_ops.providers.modes import PASS_MODES, normalizer_fingerprint
from transit_ops.providers.normalize import NormalizedCapture
from transit_ops.providers.schedule import ScheduleContext

_PollStatus = Literal["stored", "failed", "skipped_identical", "unfinished", "capture_missing"]


def fake_build(
    provider: Provider,
    service_date: date,
    *,
    schedule: ScheduleContext | None = None,
    feed_days: Sequence[FeedDay] = (),
) -> p.ServiceDayBuild:
    next_date = service_date + timedelta(days=1)
    if schedule is None:
        unavailable = dict.fromkeys((service_date, next_date), "fake_unavailable")
        schedule = fake_schedule({}, {}, timezone=provider.timezone, unavailable=unavailable)
    start, end = schedule.service_day_start(service_date), schedule.service_day_start(next_date)
    feeds = {
        f.endpoint_key: cast(p.FeedFamily, f.family)
        for f in provider.feeds
        if f.family in get_args(p.FeedFamily)
    }
    lead, tail = timedelta(seconds=p.PASS_LEAD_SECONDS), timedelta(seconds=p.PASS_TAIL_SECONDS)
    fingerprint = normalizer_fingerprint(PASS_MODES)
    return p.ServiceDayBuild(
        provider,
        service_date,
        start,
        end,
        start - lead,
        start + tail,
        feeds,
        tuple(feed_days),
        schedule,
        fingerprint,
        "fake-pass",
    )


def _normalized(
    family: p.FeedFamily,
    outcome: p.DeliveryOutcome,
    message: FeedMessage | None,
    normalized: NormalizedCapture | None,
) -> NormalizedCapture | None:
    readable = outcome in ("decoded", "rejected")
    status: Literal["ok", "rejected"] = "ok" if outcome == "decoded" else "rejected"
    if normalized is not None:
        if message is not None or not readable or normalized.status != status:
            raise ValueError("Normalized input does not match delivery outcome")
        return normalized
    if not readable:
        return None
    reason = None if outcome == "decoded" else "undecodable"
    message = (message if message is not None else FeedMessage()) if status == "ok" else None
    if family == "alerts":
        message = None
    fingerprint = normalizer_fingerprint(PASS_MODES)
    return NormalizedCapture(status, reason, message, (), (), (), None, None, fingerprint)


def _poll(
    family: p.FeedFamily, time_utc: datetime, outcome: p.DeliveryOutcome, row_id: int
) -> Poll:
    endpoint = "service_alerts" if family == "alerts" else family
    index: IndexFamily = "alert_snapshot" if family == "alerts" else "realtime_snapshot"
    has_ref = outcome in ("decoded", "rejected", "unreadable", "capture_missing")
    status = {
        "decoded": "stored",
        "rejected": "stored",
        "unreadable": "stored",
        "failed_poll": "failed",
    }.get(outcome, outcome)
    return fake_poll(
        endpoint_key=endpoint,
        run_kind=family,
        index_family=index,
        ingestion_run_id=row_id,
        status=cast(_PollStatus, status),
        started_at_utc=time_utc,
        time_utc=time_utc,
        completed_at_utc=None if outcome == "unfinished" else time_utc,
        capture_row_id=row_id if has_ref else None,
        entity_count=None,
        feed_timestamp_utc=None,
        feed_timestamp_source=None,
        http_status_code=None,
    )


def fake_delivery(
    family: p.FeedFamily,
    time_utc: datetime,
    *,
    outcome: p.DeliveryOutcome = "decoded",
    message: FeedMessage | None = None,
    alerts: Sequence[AlertRecord] = (),
    in_service_day: bool = True,
    payload: bytes | None = None,
    row_id: int = 1,
    normalized: NormalizedCapture | None = None,
) -> p.Delivery:
    if outcome not in get_args(p.DeliveryOutcome):
        raise ValueError("Unknown delivery outcome")
    if alerts:
        raise ValueError("Alert records are not supported by the P201 shell")
    result = _normalized(family, outcome, message, normalized)
    poll = _poll(family, time_utc, outcome, row_id)
    ref = CaptureKey(poll.index_family, row_id) if poll.capture_row_id is not None else None
    capture = None
    if result is not None:
        capture = fake_capture(
            endpoint_key=poll.endpoint_key,
            index_family=poll.index_family,
            capture_row_id=row_id,
            ingestion_run_id=row_id,
            started_at_utc=time_utc,
            captured_at_utc=time_utc,
            payload=None,
            entity_count=None,
            feed_timestamp_utc=None,
            feed_timestamp_source=None,
        )
    return p.Delivery(
        0,
        family,
        poll.endpoint_key,
        time_utc,
        in_service_day,
        poll,
        capture,
        ref,
        outcome,
        result,
        payload if capture else None,
    )


def fake_stream(build: p.ServiceDayBuild, deliveries: Iterable[p.Delivery]) -> Iterator[p.Delivery]:
    def order(d: p.Delivery) -> tuple[datetime, str, bool, int]:
        identity = d.capture.capture_row_id if d.capture else d.poll.ingestion_run_id
        return d.time_utc, d.endpoint_key, d.capture is None, identity

    for sequence, delivery in enumerate(sorted(deliveries, key=order)):
        yield replace(
            delivery,
            sequence=sequence,
            payload=None,
            capture=replace(delivery.capture, payload=None) if delivery.capture else None,
            in_service_day=build.day_start_utc <= delivery.time_utc < build.day_end_utc,
        )
