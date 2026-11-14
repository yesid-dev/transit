from dataclasses import FrozenInstanceError
from datetime import date
from hashlib import sha256
from io import BytesIO
from zipfile import ZipFile, ZipInfo
from zoneinfo import ZoneInfo

import pytest

from transit_ops.providers.schedule import InvalidScheduleEdition, ScheduleMembersUnknown
from transit_ops.providers.schedule_archive import ArchiveScheduleContext

DAY = date(2026, 3, 8)
HEADERS = {
    "routes": "route_id,route_type",
    "trips": "route_id,service_id,trip_id,direction_id,block_id,shape_id,wheelchair_accessible",
    "stops": "stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding,parent_station",
    "stop_times": "trip_id,stop_sequence,stop_id,arrival_time,departure_time,timepoint,"
    "shape_dist_traveled",
    "calendar": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,"
    "start_date,end_date",
    "calendar_dates": "service_id,date,exception_type",
    "frequencies": "trip_id,start_time,end_time,headway_secs,exact_times",
}
ROWS = {
    "routes": "r,3\n",
    "trips": "r,s,t,,,,\n",
    "stops": "a,A,,,,\nb,B,,,,\n",
    "stop_times": "t,5,a,25:00:00,25:01:00,,\nt,9,b,26:00:00,26:00:00,,\n",
    "calendar": "s,0,0,0,0,0,0,1,20260308,20260315\n",
    "calendar_dates": "s,20260309,1\ns,20260315,2\n",
}


def archive(*, extra=(), **changes):
    output = BytesIO()
    with ZipFile(output, "w") as zipfile:
        for name, rows in (ROWS | changes).items():
            if rows is not None:
                zipfile.writestr(
                    ZipInfo("nested/" + name.upper() + ".TXT"), HEADERS[name] + "\n" + rows
                )
        for name, data in extra:
            info = ZipInfo()
            info.filename = name
            zipfile.writestr(info, data)
    return output.getvalue()


def context(data=None, dates=(DAY,), **identity):
    data = archive() if data is None else data
    options = dict(
        provider_id="p",
        dataset_version_id=1,
        edition_sha256=sha256(data).hexdigest(),
        timezone=ZoneInfo("America/Toronto"),
    )
    options.update(identity)
    return ArchiveScheduleContext(archive_bytes=data, service_dates=dates, **options)


def test_calendar_membership_and_inclusive_bounds():
    dates = (DAY, date(2026, 3, 9), date(2026, 3, 15), date(2026, 3, 22))
    assert [context(dates=dates).days[d].trip_ids for d in dates] == [
        frozenset({"t"}),
        frozenset({"t"}),
        frozenset(),
        frozenset(),
    ]
    assert context(archive(calendar_dates=""), dates=dates).days[dates[2]].trip_ids == {"t"}
    only = context(archive(calendar=None), dates=dates)
    assert [only.days[d].trip_ids for d in dates] == [frozenset(), {"t"}, frozenset(), frozenset()]


@pytest.mark.parametrize(
    "interior,arrival", [("t,7,a,,,,\n", None), ("t,7,a,27:00:00,24:00:00,,\n", 97200)]
)
def test_ordered_geometry_and_endpoint_rows(interior, arrival):
    from transit_ops.providers.schedule import ScheduledStop, ScheduledStopTime, ScheduledTrip

    ctx = context(
        archive(
            trips="r,s,t,1,block,shape,2\n",
            stops="a,A,45,-75,1,parent\nb,B,,,,\n",
            stop_times="t,9,b,26:00:00,26:00:00,1,12.5\n"
            + interior
            + "t,5,a,25:00:00,25:01:00,0,0\n",
        )
    )
    assert ctx.trip(DAY, "t") == ScheduledTrip(
        "t", "r", 1, "s", 5, 90060, 93600, 3, False, "block", "shape", 2
    )
    times = ctx.stop_times(DAY, "t")
    assert times[0] == ScheduledStopTime(5, "a", 90000, 90060, 0, 0.0)
    assert (times[1].stop_sequence, times[1].arrival_s) == (7, arrival)
    assert times[1].departure_s == (None if arrival is None else 86400)
    assert times[2] == ScheduledStopTime(9, "b", 93600, 93600, 1, 12.5)
    assert ctx.stop(DAY, "a") == ScheduledStop("a", 45, -75, 1, "parent")
    assert ctx.stop(DAY, "b") == ScheduledStop("b", None, None, None, None)
    zero = context(archive(stop_times="t,0,a,00:00:00,00:00:00,,\n"))
    assert zero.trip(DAY, "t").first_stop_sequence == 0


@pytest.mark.parametrize(
    "day,expected",
    [(DAY, "2026-03-08T04:00:00+00:00"), (date(2026, 11, 1), "2026-11-01T05:00:00+00:00")],
)
def test_clock_change_anchor(day, expected):
    assert context(dates=(day,)).service_day_start(day).isoformat() == expected
    with pytest.raises(KeyError):
        context(dates=(day,)).service_day_start(date.min)


@pytest.mark.parametrize(
    "frequency,flags",
    [
        (None, (False, False)),
        ("", (False, False)),
        ("t,25:00:00,26:00:00,600,1\n", (True, False)),
        ("t,25:00:00,26:00:00,600,0\n", (True, False)),
        ("t,25:00:00,26:00:00,600,\n", (True, False)),
    ],
)
def test_complete_frequency_evidence(frequency, flags):
    ctx = context(
        archive(
            frequencies=frequency,
            trips=ROWS["trips"] + "r,s,other,,,,\n",
            stop_times=ROWS["stop_times"] + "other,0,a,01:00:00,02:00:00,,\n",
        )
    )
    assert tuple(ctx.trip(DAY, t).frequency_based for t in ("t", "other")) == flags


@pytest.mark.parametrize("data", [None, b"not a zip"])
def test_inventory_and_checksum_refusals(data):
    with pytest.raises(ScheduleMembersUnknown) as error:
        ArchiveScheduleContext(
            provider_id="p",
            dataset_version_id=1,
            edition_sha256="0" * 64,
            archive_bytes=data,
            service_dates=(DAY,),
            timezone=ZoneInfo("UTC"),
        )
    assert error.value.reason == "schedule_members_unknown"
    with pytest.raises(InvalidScheduleEdition, match="checksum_mismatch"):
        context(edition_sha256="0" * 64)


@pytest.mark.parametrize(
    "changes,reason",
    [
        ({"trips": "r,inactive,t,,,,\nr,inactive,t,,,,\n"}, "duplicate_trip_ids"),
        ({"stops": "a,A,,,,\na,Duplicate,,,,\n"}, "duplicate_stop_ids"),
        ({"stop_times": ROWS["stop_times"] * 2}, "duplicate_stop_sequence"),
        ({"stop_times": ""}, "missing_trip_endpoints"),
        ({"stop_times": "t,0,a,00:00:00,,,\n"}, "missing_trip_endpoints"),
        ({"stop_times": "t,0,a,,01:00:00,,\n"}, "missing_trip_endpoints"),
        (
            {"frequencies": "t,25:00:00,26:00:00,0,\nt,25:00:00,26:00:00,600,\n"},
            "invalid_member_row",
        ),
        ({"frequencies": "unknown,25:00:00,26:00:00,10,\n"}, "unknown_frequency_trip"),
        ({"stop_times": "t,bad,a,00:00:00,00:00:00,,\n"}, "invalid_member_row"),
        ({"trips": None}, "invalid_member"),
        ({"calendar": None, "calendar_dates": None}, "invalid_member"),
        ({"extra": [("other/TRIPS.txt", "unused")]}, "duplicate_member_basename"),
        ({"frequencies": None, "extra": [("FREQUENCIES.TXT", b"\xff")]}, "invalid_member"),
        ({"stop_times": None, "extra": [("stop_times.txt", "wrong\nvalue\n")]}, "invalid_member"),
        ({"extra": [("nested\\FREQUENCIES.TXT", "unused")]}, "invalid_member_path"),
    ],
)
def test_invalid_editions_are_never_partial(changes, reason):
    with pytest.raises(InvalidScheduleEdition) as error:
        context(archive(**changes))
    assert (error.value.reason, error.value.dataset_version_id) == (reason, 1)


@pytest.mark.parametrize("name", ["FREQUENCIES.TXT", "notes.bin"])
def test_unreadable_listed_member_is_not_absent(name):
    data = archive(
        extra=[(name, "trip_id,start_time,end_time,headway_secs\nt,25:00:00,26:00:00,600\n")]
    )
    damaged = data.replace(b"25:00:00,26:00:00,600", b"25:00:00,26:00:00,601")
    with pytest.raises(InvalidScheduleEdition, match="invalid_member"):
        context(damaged)


def test_identity_isolation_and_immutable_outputs():
    dates = [DAY]
    ctx = context(dates=dates)
    assert ctx.context_id == context(dates=list(reversed(dates))).context_id
    dates.clear()
    assert (ctx.days[DAY].list_sha256, ctx.unavailable) == (None, {})
    assert ctx.days[DAY].edition_sha256 == sha256(archive()).hexdigest()
    for identity in ({"provider_id": "q"}, {"dataset_version_id": 2}, {"dates": ()}):
        assert ctx.context_id != context(**identity).context_id
    other = context(archive(trips="other,s,t,,,,\n"))
    assert (ctx.trip(DAY, "t").route_id, other.trip(DAY, "t").route_id) == ("r", "other")
    assert ctx.context_id != other.context_id
    for mapping in (ctx.days, ctx.unavailable):
        with pytest.raises(TypeError):
            mapping[DAY] = "changed"
    with pytest.raises(FrozenInstanceError):
        ctx.trip(DAY, "t").route_id = "changed"


@pytest.mark.parametrize("name,missing", [("trip", None), ("stop_times", ()), ("stop", None)])
def test_lookup_distinctions(name, missing):
    ctx = context(dates=(DAY, date(2026, 3, 22)))
    lookup = getattr(ctx, name)
    assert lookup(DAY, "absent") == missing
    with pytest.raises(KeyError):
        lookup(date.min, "t")
    assert ctx.trip(date(2026, 3, 22), "t") is None
    assert ctx.stop_times(date(2026, 3, 22), "t") == ()
    assert ctx.stop(date(2026, 3, 22), "a") == ctx.stop(DAY, "a")
