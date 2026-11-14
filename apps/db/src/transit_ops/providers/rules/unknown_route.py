"""N9: diagnose supplied routes without proposing any writes."""

from datetime import date

from google.transit.gtfs_realtime_pb2 import TripDescriptor

from transit_ops.providers.rules import RuleProposal
from transit_ops.providers.schedule import ScheduleContext


def propose(
    trip: TripDescriptor, supplied_route: str, schedule: ScheduleContext | None, day: date
) -> RuleProposal:
    if not supplied_route:
        return RuleProposal()
    if schedule is None or day not in schedule.days or day in schedule.unavailable:
        return RuleProposal(seen=1, unresolved=1, reasons=(("schedule_not_kept", 1),))
    reasons = []
    if supplied_route not in schedule.days[day].route_ids:
        reasons.append(("unknown_route", 1))
    match = schedule.trip(day, trip.trip_id) if trip.trip_id else None
    if match is not None and match.route_id != supplied_route:
        reasons.append(("trip_route_mismatch", 1))
    return RuleProposal(seen=1, unresolved=int(bool(reasons)), reasons=tuple(reasons))
