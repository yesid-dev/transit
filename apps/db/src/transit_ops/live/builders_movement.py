"""Clock-explicit local movement payloads; intentionally unwired.

Capture evidence supplies rows, while only matching committed local_serving certifies
freshness. A borrowed cold holder cannot promote its own capture timestamp.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import cast

from transit_ops.live.local_file import LocalFile
from transit_ops.live.running import (
    Evidence,
    FeedPolicy,
    Projection,
    ScheduleInputs,
    TripHolder,
    project_running,
)
from transit_ops.snapshots.builders._helpers import (
    _OCCUPANCY_MAP,
    _delay_min,
    _iso,
    _kmh,
    _opt_int,
    _opt_iso,
    _round5,
)
from transit_ops.snapshots.contract import (
    Occupancy,
    Status,
    StopDeparture,
    StopDeparturesFile,
    StopEta,
    Trip,
    TripsFile,
    Vehicle,
    VehiclesFile,
)
from transit_ops.snapshots.serialization import snapshot_json_bytes


def _status(delay: Decimal | None) -> Status:
    if delay is None:
        return Status.unknown
    if delay < -60:
        return Status.early
    if delay < 60:
        return Status.on_time
    return Status.late if delay < 300 else Status.severe


def _vehicles(
    projection: Projection, generated: str, bounds: tuple[float, float, float, float] | None
) -> VehiclesFile:
    vehicles = []
    for r in projection.vehicles:
        if bounds is not None:
            west, south, east, north = bounds
            if not (south <= r["latitude"] <= north and west <= r["longitude"] <= east):
                continue
        paired = r["next_stop_lat"] is not None and r["next_stop_lon"] is not None
        occupancy = r["occupancy_status"]
        vehicles.append(
            Vehicle(
                id=str(r["vehicle_id"]),
                route=r["route_id"],
                trip=r["trip_id"],
                lat=cast(float, _round5(r["latitude"])),
                lon=cast(float, _round5(r["longitude"])),
                bearing=_opt_int(r["bearing"]),
                speed_kmh=_kmh(r["speed"]),
                status=_status(r["trip_avg_delay_seconds"]),
                delay_min=_delay_min(r["trip_avg_delay_seconds"]),
                occupancy=cast(Occupancy | None, _OCCUPANCY_MAP.get(occupancy)),
                next_stop=r["next_stop"],
                next_stop_lat=_round5(r["next_stop_lat"]) if paired else None,
                next_stop_lon=_round5(r["next_stop_lon"]) if paired else None,
                updated_utc=_iso(r["captured_at_utc"]),
                reported_utc=_opt_iso(r["position_timestamp_utc"]),
            )
        )
    return VehiclesFile(generated_utc=generated, vehicles=vehicles)


def _trips(projection: Projection, cycle: datetime, stamp: str | None) -> TripsFile:
    trips: dict[str, Trip] = {}
    for r in projection.delays:
        trips[str(r["trip_id"])] = Trip(
            route=r["route_id"],
            status=_status(r["avg_delay_seconds"]),
            delay_min=_delay_min(r["avg_delay_seconds"]),
            stops=[],
        )
    departures = sorted(
        projection.departures,
        key=lambda r: (
            r["trip_id"] is None,
            r["trip_id"] or "",
            r["predicted_departure_utc"],
            r["stop_sequence"] is None,
            r["stop_sequence"] or 0,
        ),
    )
    for r in departures:
        if r["predicted_departure_utc"] >= cycle + timedelta(minutes=60):
            continue
        trip = trips.setdefault(str(r["trip_id"]), Trip(route=r["route_id"], status=Status.unknown))
        trip.stops.append(
            StopEta(
                stop=str(r["stop_id"]),
                eta_utc=_iso(r["predicted_departure_utc"]),
                delay_min=trip.delay_min,
            )
        )
    return TripsFile(generated_utc=_iso(cycle), trips=trips, feed_captured_utc=stamp)


def _departures(projection: Projection, generated: str, stamp: str | None) -> StopDeparturesFile:
    delays: dict[str | None, list[Decimal]] = {}
    for r in projection.delays:
        delays.setdefault(r["trip_id"], []).append(r["avg_delay_seconds"])
    ranks: dict[tuple[str, str | None], int] = {}
    stops: dict[str, list[StopDeparture]] = {}
    rows = sorted(
        projection.departures,
        key=lambda r: (
            r["stop_id"],
            r["route_id"] is None,
            r["route_id"] or "",
            r["predicted_departure_utc"],
            r["trip_id"] is None,
            r["trip_id"] or "",
            r["stop_sequence"] is None,
            r["stop_sequence"] or 0,
        ),
    )
    selected = []
    for r in rows:
        key = (r["stop_id"], r["route_id"])
        ranks[key] = ranks.get(key, 0) + 1
        if ranks[key] <= 2:
            selected.append(r)
    selected.sort(
        key=lambda r: (
            r["stop_id"],
            r["predicted_departure_utc"],
            r["route_id"] is None,
            r["route_id"] or "",
            r["trip_id"] is None,
            r["trip_id"] or "",
        )
    )
    for r in selected:
        values = delays.get(r["trip_id"], [])
        delay = sum(values) / len(values) if values else None
        stops.setdefault(r["stop_id"], []).append(
            StopDeparture(
                route=r["route_id"],
                trip=r["trip_id"],
                eta_utc=_iso(r["predicted_departure_utc"]),
                delay_min=_delay_min(delay),
            )
        )
    return StopDeparturesFile(generated_utc=generated, stops=stops, feed_captured_utc=stamp)


def _serving_stamp(
    local: LocalFile, evidence: Evidence, cycle: datetime, *, enabled: bool
) -> str | None:
    row = local.connection.execute(
        "SELECT capture_row_id, captured_at_utc FROM local_serving "
        "WHERE endpoint_key='trip_updates'"
    ).fetchone()
    if row is None:
        return None
    capture_id, captured = row[0], row[1].replace(tzinfo=UTC)
    if captured > cycle:
        raise ValueError("serving capture is after cycle")
    if not enabled:
        return None
    if evidence.capture_id is None or evidence.captured_at is None:
        raise ValueError("local_trip_updates_serving_mismatch")
    identity = (evidence.captured_at.astimezone(UTC), evidence.capture_id)
    committed = (captured, capture_id)
    if identity == committed:
        return _iso(captured)
    if evidence.capture_id == capture_id or identity < committed:
        raise ValueError("local_trip_updates_serving_mismatch")
    # A newer raw cold fallback is usable, but has no matching serving certificate.
    return None


def build_movement(
    local: LocalFile,
    holder: TripHolder,
    inputs: ScheduleInputs,
    *,
    provider_id: str,
    timezone: str,
    cycle: datetime,
    trip_policy: FeedPolicy,
    vehicle_policy: FeedPolicy,
    bounds: tuple[float, float, float, float] | None = None,
) -> dict[str, bytes]:
    """Build one packet from committed state without owning any input lifetime.

    Bounds are west/south/east/north, resolved by the provider policy owner.
    Cycle is the actual supplied instant: source lag never rewinds ETA eligibility
    or changes generated/serving stamps. Feed freshness budgets are also resolved
    by the policy owner (including any provider source lag allowance).
    """
    if cycle.utcoffset() is None:
        raise ValueError("cycle must be aware")
    cycle = cycle.astimezone(UTC)
    local.require_committed()
    if bounds is not None:
        west, south, east, north = bounds
        if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
            raise ValueError("invalid provider bounds")
    projection = project_running(
        local,
        holder,
        inputs,
        provider_id=provider_id,
        timezone=timezone,
        cycle=cycle,
        trip_policy=trip_policy,
        vehicle_policy=vehicle_policy,
    )
    stamp = _serving_stamp(local, projection.trip_evidence, cycle, enabled=trip_policy.enabled)
    generated = _iso(cycle)
    return {
        "vehicles.json": snapshot_json_bytes(_vehicles(projection, generated, bounds)),
        "trips.json": snapshot_json_bytes(_trips(projection, cycle, stamp)),
        "stop_departures.json": snapshot_json_bytes(_departures(projection, generated, stamp)),
    }
