"""Ordered delivery over checked reader values; no storage is opened here."""

from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import replace
from datetime import datetime

from transit_ops.capture_coverage.rules import CaptureKey
from transit_ops.daily_pass.interface import (
    CaptureNormalizer,
    Delivery,
    DeliveryOutcome,
    PassConsumer,
    ServiceDayBuild,
)
from transit_ops.history.reader import Capture, Poll
from transit_ops.providers.modes import PASS_MODES
from transit_ops.providers.normalize import RawCapture, normalize_capture


def _ref(poll: Poll) -> CaptureKey | None:
    if poll.capture_row_id is None:
        return None
    return CaptureKey(poll.index_family, poll.capture_row_id)


def _delivery(build: ServiceDayBuild, poll: Poll, sequence: int) -> Delivery:
    outcomes: dict[str, DeliveryOutcome] = {
        "stored": "unreadable",
        "failed": "failed_poll",
        "unfinished": "unfinished",
        "skipped_identical": "skipped_identical",
        "capture_missing": "capture_missing",
    }
    endpoint, time = poll.endpoint_key, poll.time_utc
    family, ref, outcome = build.feeds[endpoint], _ref(poll), outcomes[poll.status]
    inside = build.day_start_utc <= time < build.day_end_utc
    return Delivery(sequence, family, endpoint, time, inside, poll, None, ref, outcome, None, None)


def _readable(
    build: ServiceDayBuild,
    poll: Poll,
    capture: Capture,
    sequence: int,
    normalizer: CaptureNormalizer,
) -> Delivery:
    if capture.payload is None:
        raise ValueError("Capture requires checked bytes")
    feed = next(f for f in build.provider.feeds if f.endpoint_key == capture.endpoint_key)
    raw = RawCapture(
        feed.family, feed.format, capture.payload, capture.captured_at_utc, capture.endpoint_key
    )
    normalized = normalizer(build.provider, raw, build.schedule, modes=PASS_MODES, collect=True)
    return replace(
        _delivery(build, poll, sequence),
        capture=replace(capture, payload=None),
        normalized=normalized,
        outcome="decoded" if normalized.status == "ok" else "rejected",
    )


def _dispatch(
    delivery: Delivery,
    payload: bytes | None,
    active: list[PassConsumer],
    report: Callable[[PassConsumer, Exception], None],
) -> None:
    for consumer in tuple(active):
        if delivery.family not in consumer.families:
            continue
        try:
            consumer.accept(
                replace(delivery, payload=payload) if consumer.wants_bytes else delivery
            )
        except Exception as exc:
            report(consumer, exc)
            active[:] = [c for c in active if c is not consumer]


def deliver_stream(
    build: ServiceDayBuild,
    *,
    polls: Iterable[Poll],
    captures: Iterable[Capture],
    consumers: Sequence[PassConsumer],
    on_consumer_error: Callable[[PassConsumer, Exception], None],
    normalizer: CaptureNormalizer = normalize_capture,
) -> Iterator[Delivery]:
    """Fan out byte-free observations; accepting consumers must not retain bytes.
    Captures arrive in reader order; readers may buffer overlapping feed days.
    """
    if not consumers:
        return
    source = iter(captures)
    try:
        yield from _merge(build, polls, source, list(consumers), on_consumer_error, normalizer)
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()


def _poll_index(build: ServiceDayBuild, pending: Sequence[Poll]) -> dict[CaptureKey, Poll]:
    stored: dict[CaptureKey, Poll] = {}
    for poll in pending:
        if poll.provider_id != build.provider.id or poll.endpoint_key not in build.feeds:
            raise ValueError("Poll does not match build")
        ref = _ref(poll)
        if poll.status == "stored":
            if ref is None or ref in stored:
                raise ValueError("Stored poll identity is missing or duplicated")
            stored[ref] = poll
    return stored


def _match(capture: Capture, stored: dict[CaptureKey, Poll], seen: set[CaptureKey]) -> Poll:
    ref = CaptureKey(capture.index_family, capture.capture_row_id)
    if ref in seen:
        raise ValueError("Duplicate capture identity")
    poll = stored.get(ref)
    if poll is None:
        raise ValueError("Capture has no stored poll")
    if (capture.provider_id, capture.endpoint_key, capture.ingestion_run_id) != (
        poll.provider_id,
        poll.endpoint_key,
        poll.ingestion_run_id,
    ):
        raise ValueError("Capture does not match its poll")
    seen.add(ref)
    return poll


def _merge(
    build: ServiceDayBuild,
    polls: Iterable[Poll],
    source: Iterator[Capture],
    active: list[PassConsumer],
    report: Callable[[PassConsumer, Exception], None],
    normalizer: CaptureNormalizer,
) -> Iterator[Delivery]:
    pending = sorted(polls, key=lambda p: (p.time_utc, p.endpoint_key, p.ingestion_run_id))
    stored = _poll_index(build, pending)
    seen: set[CaptureKey] = set()
    position = sequence = 0
    previous: tuple[datetime, str, int] | None = None
    for capture in source:
        poll = _match(capture, stored, seen)
        order = capture.captured_at_utc, capture.endpoint_key, capture.capture_row_id
        if previous is not None and order < previous:
            raise ValueError("Captures are not in reader order")
        previous = order
        while position < len(pending):
            candidate = pending[position]
            if (candidate.time_utc, candidate.endpoint_key) >= order[:2]:
                break
            position += 1
            if candidate.status == "stored" and _ref(candidate) in seen:
                continue
            delivery = _delivery(build, candidate, sequence)
            _dispatch(delivery, None, active, report)
            yield delivery
            del delivery
            sequence += 1
        delivery = _readable(build, poll, capture, sequence, normalizer)
        _dispatch(delivery, capture.payload, active, report)
        del capture
        yield delivery
        del delivery
        sequence += 1
    for poll in pending[position:]:
        if poll.status != "stored" or _ref(poll) not in seen:
            delivery = _delivery(build, poll, sequence)
            _dispatch(delivery, None, active, report)
            yield delivery
            del delivery
            sequence += 1
