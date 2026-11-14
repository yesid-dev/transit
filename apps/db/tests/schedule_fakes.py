"""One synthetic provider per fake; identities are never archive evidence."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from hashlib import sha256
from types import MappingProxyType
from zoneinfo import ZoneInfo

from transit_ops.providers import schedule as sc


@dataclass(frozen=True)
class FakeTrip:
    trip: sc.ScheduledTrip
    stop_times: tuple[sc.ScheduledStopTime, ...]


def fake_trip(
    trip_id: str,
    route_id: str,
    stops: Sequence[tuple[str, int | None, int | None]],
    *,
    first_stop_sequence: int = 1,
    direction_id: int | None = None,
) -> FakeTrip:
    """Build a non-frequency fixture; sequence 1 is only a test convenience."""
    rows = tuple(
        sc.ScheduledStopTime(first_stop_sequence + i, stop, arrival, departure, None, None)
        for i, (stop, arrival, departure) in enumerate(stops)
    )
    if not rows or rows[0].departure_s is None or rows[-1].arrival_s is None:
        raise ValueError("missing_required_endpoints")
    trip = sc.ScheduledTrip(
        trip_id,
        route_id,
        direction_id,
        "fake-service",
        first_stop_sequence,
        rows[0].departure_s,
        rows[-1].arrival_s,
        len(rows),
        False,
        None,
        None,
        None,
    )
    return FakeTrip(trip, rows)


@dataclass
class FakeScheduleContext:
    context_id: str
    timezone: ZoneInfo
    days: Mapping[date, sc.ScheduleDay]
    unavailable: Mapping[date, str]
    _dates: Mapping[date, int]
    _editions: Mapping[int, Mapping[str, FakeTrip]]
    _stops: Mapping[str, sc.ScheduledStop]

    def _edition(self, dataset_version_id: int) -> Mapping[str, FakeTrip]:
        if dataset_version_id not in self._editions:
            raise sc.EditionNotAvailable(dataset_version_id)
        return self._editions[dataset_version_id]

    def trip_in_edition(self, dataset_version_id: int, trip_id: str) -> sc.ScheduledTrip | None:
        value = self._edition(dataset_version_id).get(trip_id)
        return value.trip if value else None

    def stop_times_in_edition(
        self, dataset_version_id: int, trip_id: str
    ) -> tuple[sc.ScheduledStopTime, ...]:
        value = self._edition(dataset_version_id).get(trip_id)
        return value.stop_times if value else ()

    def stop_in_edition(self, dataset_version_id: int, stop_id: str) -> sc.ScheduledStop | None:
        self._edition(dataset_version_id)
        return self._stops.get(stop_id)

    def trip(self, service_date: date, trip_id: str) -> sc.ScheduledTrip | None:
        return self.trip_in_edition(self._dates[service_date], trip_id)

    def stop_times(self, service_date: date, trip_id: str) -> tuple[sc.ScheduledStopTime, ...]:
        return self.stop_times_in_edition(self._dates[service_date], trip_id)

    def stop(self, service_date: date, stop_id: str) -> sc.ScheduledStop | None:
        return self.stop_in_edition(self._dates[service_date], stop_id)

    def service_day_start(self, service_date: date) -> datetime:
        if service_date not in self._dates and service_date not in self.unavailable:
            raise KeyError(service_date)
        return sc.service_day_start(service_date, self.timezone)


def fake_schedule(
    editions: Mapping[int, Sequence[FakeTrip]],
    days: Mapping[date, int],
    *,
    timezone: str = "America/Toronto",
    unavailable: Mapping[date, str] | None = None,
    stops: Sequence[sc.ScheduledStop] = (),
) -> FakeScheduleContext:
    dates, reasons, zone = dict(days), dict(unavailable or {}), ZoneInfo(timezone)
    if dates.keys() & reasons.keys():
        raise ValueError("usable_and_unavailable_overlap")
    frozen, records, identities = {}, {}, []
    for edition, values in sorted(editions.items()):
        trips = {v.trip.trip_id: FakeTrip(v.trip, tuple(v.stop_times)) for v in values}
        if len(trips) != len(values):
            raise sc.InvalidScheduleEdition(edition, "duplicate_trip_ids")
        frozen[edition] = MappingProxyType(trips)
        checksum = sha256(repr(sorted(trips.items())).encode()).hexdigest()
        service_dates = [d for d, e in dates.items() if e == edition]
        trip_ids, route_ids = frozenset(trips), frozenset(v.trip.route_id for v in trips.values())
        for d in service_dates:
            records[d] = sc.ScheduleDay(d, checksum, None, trip_ids, route_ids)
        identities.append(
            sc.context_id(
                provider_id="synthetic-fake",
                dataset_version_id=edition,
                edition_sha256=checksum,
                timezone=zone,
                service_dates=service_dates,
            )
        )
    if missing := set(dates.values()) - frozen.keys():
        raise sc.EditionNotAvailable(min(missing))
    stop_map = {stop.stop_id: stop for stop in stops}
    payload = identities, sorted(reasons.items()), sorted(stop_map.items()), zone.key
    identity = sha256(repr(payload).encode()).hexdigest()
    return FakeScheduleContext(
        "fake:" + identity,
        zone,
        MappingProxyType(records),
        MappingProxyType(reasons),
        MappingProxyType(dates),
        MappingProxyType(frozen),
        MappingProxyType(stop_map),
    )
