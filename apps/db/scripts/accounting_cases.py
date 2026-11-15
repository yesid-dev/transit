"""Report the six synthetic daily-pass accounting cases."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import cast

from transit_ops.daily_pass.interface import ServiceDayBuild
from transit_ops.daily_pass.judge import account_feed
from transit_ops.history.reader import FeedDay, Poll
from transit_ops.providers.declaration import Feed, Licence, Provider
from transit_ops.providers.schedule import ScheduleContext

START = datetime(2026, 1, 2, tzinfo=UTC)
END = START + timedelta(seconds=133200)
ENDPOINT = "trip_updates"
FEED = Feed(ENDPOINT, "gtfs-rt", ENDPOINT, None, None, 20, None)
PROVIDER = Provider(
    id="synthetic",
    name="Synthetic",
    labels={},
    timezone="UTC",
    default_locale="en",
    feed_languages=("en",),
    stage="candidate",
    licence=Licence(name="Synthetic", terms_url="https://example.org/terms", review="pending"),
    attribution={},
    feeds=(FEED,),
    lines_without_live_data=(),
    reading_population=None,
    live_source_lag_seconds=0,
    map=None,
    overrides=None,
    website=None,
    currency=None,
    disclaimer=None,
    alert_links=None,
)
DAY = FeedDay(
    provider_id=PROVIDER.id,
    endpoint_key=ENDPOINT,
    utc_date=START.date(),
    state="available",
    reason=None,
    form="objects",
    content_version=None,
    poll_count=4320,
    capture_count=0,
    first_time_utc=START,
    last_time_utc=START + timedelta(seconds=86380),
    declared_interval_seconds=20,
    observed_interval_seconds=20,
    poll_record_sha256=None,
    pending_change=False,
    bytes_verified=False,
)
DAYS = tuple(replace(DAY, utc_date=(START + timedelta(days=i)).date()) for i in (-1, 0, 1))
# Schedule is intentionally unused by the pure accountant.
BUILD = ServiceDayBuild(
    PROVIDER,
    START.date(),
    START,
    START + timedelta(days=1),
    START,
    END,
    {ENDPOINT: ENDPOINT},
    DAYS,
    cast(ScheduleContext, None),
    "",
    "",
)
POLL = Poll(
    provider_id=PROVIDER.id,
    endpoint_key=ENDPOINT,
    run_kind=ENDPOINT,
    index_family="realtime_snapshot",
    ingestion_run_id=0,
    status="failed",
    started_at_utc=START,
    completed_at_utc=START,
    time_utc=START,
    http_status_code=None,
    error_message=None,
    feed_timestamp_utc=None,
    feed_timestamp_source=None,
    entity_count=None,
    capture_row_id=None,
    duplicate_of_row_id=None,
    missing_reason=None,
)
CASES = (
    ("Seven-hour hole", lambda s: not 36000 <= s < 61200),
    ("One record every six intervals", lambda s: s % 120 == 0),
    ("Every third slot missed", lambda s: s % 60 != 40),
    ("Nine-minute hole", lambda s: not 36000 <= s < 36540),
    ("Five-minute holes every half hour", lambda s: s % 1800 >= 300),
    ("Regular feed", lambda s: True),
)
if __name__ == "__main__":
    for name, keep in CASES:
        polls = (
            replace(POLL, ingestion_run_id=s, time_utc=START + timedelta(seconds=s))
            for s in range(0, 133200, 20)
            if keep(s)
        )
        result = account_feed(BUILD, ENDPOINT, polls)
        longest = max(((b - a).total_seconds() for a, b in result.missing_blocks), default=0)
        block = f"{longest:g} s" if longest else "none"
        print(
            f"{name}: {result.accounted_share:.1%}; "
            f"longest {block}; complete {str(result.complete).lower()}"
        )
