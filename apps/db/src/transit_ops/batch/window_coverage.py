"""One coverage interval rule for archive FK preflight and final resolution."""

from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from transit_ops.batch.build import BuildRequest, InputNeed, utc_days


def required_end(
    need: InputNeed, needs: Sequence[InputNeed], as_of: datetime, request: BuildRequest | None
) -> datetime:
    if need.window == "all":
        return as_of
    if need.window.startswith("local:"):
        if request is None:
            raise ValueError("window_coverage: local input requires timezone")
        day = date.fromisoformat(need.window.removeprefix("local:"))
        return datetime.combine(
            day + timedelta(days=1), time(), ZoneInfo(request.timezone)
        ).astimezone(UTC)
    start = datetime.combine(date.fromisoformat(need.window), time(), UTC)
    end = min(start + timedelta(days=1), as_of)
    if request is None:
        return end
    # A relation declaring capture/observation days outside the local-day windows
    # requires those full intervals too. Never clip its lookahead to the report day.
    windows = {n.window for n in needs if n.relation == need.relation and len(n.window) == 10}
    if not windows:
        windows = {n.window for n in needs if len(n.window) == 10}
    if windows - set(utc_days(request)):
        return end
    overlaps = [
        min(
            end,
            datetime.combine(d + timedelta(days=1), time(), ZoneInfo(request.timezone)).astimezone(
                UTC
            ),
        )
        for d in request.local_dates
        if datetime.combine(d, time(), ZoneInfo(request.timezone)).astimezone(UTC) < end
        and datetime.combine(d + timedelta(days=1), time(), ZoneInfo(request.timezone)).astimezone(
            UTC
        )
        > start
    ]
    return max(overlaps) if overlaps else end
