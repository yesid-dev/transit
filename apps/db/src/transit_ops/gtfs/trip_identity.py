"""Resolve scheduled trip identities from GTFS-Realtime descriptor evidence."""

from datetime import date, datetime, timedelta
from functools import lru_cache

from transit_ops.gold.vehicle_instance_rule import (
    EARLY_START_MAX_LEAD_SECONDS,
    TripInstance,
    VehicleDescriptor,
    accepted_instance,
    resolve_vehicle_capture,
)
from transit_ops.gtfs.types import parse_gtfs_date, parse_gtfs_service_time


@lru_cache(maxsize=32)
def reported_service_date(value: str) -> date | None:
    try:
        return parse_gtfs_date(value, field_name="trip start_date")
    except ValueError:
        return None


def resolve_trip_instance(
    published: datetime,
    candidates: tuple[TripInstance, ...],
    evidence: VehicleDescriptor,
    *,
    advance_notice: bool,
    removed: bool = False,
    next_prediction: datetime | None = None,
) -> tuple[TripInstance | None, bool]:
    """Select an instance and report whether an in-window tie prevented acceptance."""
    if evidence.start_time:
        try:
            seconds = parse_gtfs_service_time(
                evidence.start_time, field_name="trip start_time"
            ).total_seconds
        except ValueError:
            return None, False
        candidates = tuple(c for c in candidates if c.first_departure_seconds == seconds)
    resolved = resolve_vehicle_capture(published, candidates, evidence)
    if resolved or not advance_notice:
        accepted = accepted_instance(resolved)
        return accepted, bool(resolved) and accepted is None

    lead = timedelta(seconds=EARLY_START_MAX_LEAD_SECONDS)
    # Live predictions have an independent absolute instant. For an advance
    # notice, it can resolve a trip whose date hint is the calendar date after
    # midnight. A conflicting in-window instance still takes precedence.
    if next_prediction is not None:
        upcoming = tuple(c for c in candidates if published < c.start_utc - lead)
        predicted = resolve_vehicle_capture(next_prediction, upcoming, evidence)
        if predicted:
            accepted = accepted_instance(predicted)
            return accepted, accepted is None

    return next(
        (
            c
            for c in candidates
            if c.service_date == evidence.start_date and (removed or published < c.start_utc - lead)
        ),
        None,
    ), False
