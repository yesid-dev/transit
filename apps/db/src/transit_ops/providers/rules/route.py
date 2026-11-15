"""N1: fill only from unanimous evidence on the three candidate dates."""

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from google.transit.gtfs_realtime_pb2 import FeedMessage, TripDescriptor

from transit_ops.providers.rules import FieldWrite, RuleProposal
from transit_ops.providers.schedule import ScheduleContext


def candidate_dates(message: FeedMessage, captured_at: datetime, zone: str) -> tuple[date, ...]:
    observed = (
        datetime.fromtimestamp(message.header.timestamp, UTC)
        if message.header.HasField("timestamp")
        else captured_at
    )
    if observed.tzinfo is None or observed.utcoffset() is None:
        raise ValueError("capture time must be aware")
    day = observed.astimezone(ZoneInfo(zone)).date()
    return tuple(day + timedelta(days=offset) for offset in (-1, 0, 1))


def propose(
    trip: TripDescriptor, field: str, schedule: ScheduleContext | None, dates: tuple[date, ...]
) -> RuleProposal:
    if not trip.trip_id or trip.route_id:
        return RuleProposal()
    if schedule is None or any(d not in schedule.days or d in schedule.unavailable for d in dates):
        reason = "schedule_not_kept"
    else:
        routes = {
            match.route_id for d in dates if (match := schedule.trip(d, trip.trip_id)) is not None
        }
        if len(routes) == 1:
            return RuleProposal((FieldWrite(field, routes.pop()),), seen=1)
        reason = "route_differs_between_days" if routes else "trip_not_in_schedule"
    return RuleProposal(seen=1, unresolved=1, reasons=((reason, 1),))
