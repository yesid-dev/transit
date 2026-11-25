import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from zipfile import ZipFile
from zoneinfo import ZoneInfo

import pytest

from transit_ops.core.models import ProviderManifest
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.playback import LivePublisher
from transit_ops.live.silent_trips import TripReporting, TripSpan, count_silent_trips
from transit_ops.live.trip_schedule import LiveTripSchedule

ZONE = ZoneInfo("America/Toronto")
DAY = date(2026, 11, 24)


def span(trip, first=12 * 3600, last=13 * 3600, *, line="1"):
    return TripSpan(trip, line, first, last)


def test_silent_trips_uses_trip_identity_and_start_and_end_grace():
    now = datetime(2026, 11, 24, 17, 15, tzinfo=UTC)
    trips = (
        span("reporting"),
        span("silent", 12 * 3600 + 600),  # Exactly five minutes since departure.
        span("starting", 12 * 3600 + 601),
        span("ended", last=12 * 3600 + 900),  # Arrival already reached.
        span("nearly-ended", last=12 * 3600 + 901),
        span("cancelled"),
        span("other-day"),
    )
    counts = count_silent_trips(
        now,
        ZONE,
        {DAY: trips},
        reports=[
            ("reporting", None),
            ("reporting", None),
            ("unmatched", None),
            ("other-day", "20261123"),
        ],
        cancellations=[("cancelled", "20261124"), ("silent", "20261123")],
    )
    assert counts == {
        "scheduled_now": 5,
        "non_responding": 3,
        "cancelled_now": 1,
        "non_responding_by_route": [{"route_id": "1", "count": 3}],
    }


@pytest.mark.parametrize(
    ("instant", "day", "trip"),
    [
        ("2026-11-25T06:15:00+00:00", DAY, span("t", 25 * 3600, 26 * 3600)),
        # Spring 01:15 EST is 02:15 in GTFS elapsed seconds.
        ("2026-03-08T06:15:00+00:00", date(2026, 3, 8), span("t", 7200, 9000)),
        # Fall's first 01:15 is 00:15 in GTFS elapsed seconds.
        ("2026-11-01T05:15:00+00:00", date(2026, 11, 1), span("t", 0, 1800)),
        # The second 01:15 is 01:15 in GTFS elapsed seconds.
        ("2026-11-01T06:15:00+00:00", date(2026, 11, 1), span("t", 3600, 5400)),
    ],
)
def test_uses_elapsed_service_clock(instant, day, trip):
    now = datetime.fromisoformat(instant)
    counts = count_silent_trips(
        now, ZONE, {day: (trip,)}, reports=[("other", None)], cancellations=[]
    )
    assert counts["scheduled_now"] == counts["non_responding"] == 1


def test_dated_reports_do_not_hide_another_service_days_trip():
    now = datetime(2026, 11, 25, 5, 45, tzinfo=UTC)
    counts = count_silent_trips(
        now,
        ZONE,
        {DAY: (span("t", 86400, 90000),), date(2026, 11, 25): (span("t", 0, 3600),)},
        reports=[("t", "20261124"), ("t", None)],
        cancellations=[],
    )
    assert counts["scheduled_now"] == 2
    assert counts["non_responding"] == 1


NOON = datetime(2026, 11, 24, 17, 15, tzinfo=UTC)


def position_feed(now):
    return {
        "family": "vehicle_positions",
        "captured_at": now.isoformat(),
        "source_at": now.isoformat(),
        "fresh_for_seconds": 60,
        "source_lag_seconds": 0,
        "read_failed": False,
    }


def position(trip_id, observed=NOON):
    return {"trip_id": trip_id, "start_date": None, "observed_at": observed.isoformat()}


def snapshot(now, *vehicles):
    return {
        "feeds": {"positions": position_feed(now)},
        "vehicle_positions": list(vehicles),
        "trip_updates": [],
    }


def test_report_window_retains_omitted_trips_and_expires_them():
    reporting = TripReporting(source_lag_seconds=0)
    assert reporting.observe(snapshot(NOON, position("a")), NOON) == ({("a", None)}, set())
    later = NOON + timedelta(seconds=89)
    newer = snapshot(later, position("b", later))
    assert reporting.observe(newer, later) == ({("a", None), ("b", None)}, set())
    assert reporting.observe(newer, later + timedelta(seconds=1)) == ({("b", None)}, set())
    assert reporting.observe(snapshot(later, position(None, later)), later) is None


def test_source_lag_allows_fresh_position_at_declared_delay():
    reporting = TripReporting(source_lag_seconds=60)
    old = position("a", NOON - timedelta(seconds=149))
    expired = position("b", NOON - timedelta(seconds=150))
    assert reporting.observe(snapshot(NOON, old, expired), NOON) == ({("a", None)}, set())


def install_edition(raw_root, city):
    path = raw_root / "archive" / "v1" / "schedules" / city
    path.mkdir(parents=True)
    data = BytesIO()
    trip_rows = [
        ("reporting", "A", "weekday"),
        ("silent", "B", "added"),
        ("cancelled", "A", "weekday"),
        ("no-positions", "C", "weekday"),
        ("excluded-line", "D", "weekday"),
        ("inactive", "A", "removed"),
    ]
    with ZipFile(data, "w") as archive:
        archive.writestr("routes.txt", "route_id,route_type\nA,3\nB,3\nC,1\nD,3\n")
        archive.writestr(
            "trips.txt",
            "trip_id,route_id,service_id\n" + "".join(",".join(row) + "\n" for row in trip_rows),
        )
        archive.writestr(
            "stop_times.txt",
            "trip_id,stop_sequence,stop_id,arrival_time,departure_time\n"
            + "".join(
                f"{trip},10,end,13:00:00,13:05:00\n{trip},1,start,11:55:00,12:00:00\n"
                for trip, _, _ in trip_rows
            ),
        )
        archive.writestr(
            "calendar.txt",
            "service_id,start_date,end_date,monday,tuesday,wednesday,thursday,friday,saturday,sunday\n"
            "weekday,20261123,20261128,1,1,1,1,1,0,0\n"
            "removed,20261123,20261128,1,1,1,1,1,0,0\n",
        )
        archive.writestr(
            "calendar_dates.txt",
            "service_id,date,exception_type\nadded,20261124,1\nremoved,20261124,2\n",
        )
    body = data.getvalue()
    digest = sha256(body).hexdigest()
    (path / f"{digest}.zip").write_bytes(body)
    (path / "editions.json").write_text(
        json.dumps(
            {
                "provider": city,
                "editions": [
                    {"effective_date": "2026-11-23", "path": f"{digest}.zip", "sha256": digest}
                ],
            }
        ),
        encoding="utf-8",
    )


@pytest.mark.parametrize(("edition", "identified"), [(True, True), (False, True), (True, False)])
def test_published_city_answer_requires_a_schedule_and_trip_ids(
    tmp_path, monkeypatch, edition, identified
):
    manifest = ProviderManifest.model_validate(
        {
            "provider": {"provider_id": "demo", "display_name": "Demo", "timezone": ZONE.key},
            "public": {"enabled": True},
            "realtime": {
                "lines_without_live_data": [
                    {"gap_id": "untracked", "route_types": [1], "route_ids": ["D"]}
                ]
            },
            "feeds": {
                "static_schedule": {
                    "endpoint_key": "static_schedule",
                    "feed_kind": "static_schedule",
                    "source_format": "gtfs_schedule_zip",
                    "source_url": "https://example.test/schedule.zip",
                    "auth": {"auth_type": "none"},
                    "refresh_interval_seconds": 86400,
                }
            },
        }
    )
    city = manifest.provider.provider_id
    raw = LocalBronzeStorage("local", tmp_path)
    if edition:
        install_edition(tmp_path, city)
    reporting_vehicle = {
        **position("reporting" if identified else None),
        "route_id": "A",
        "stop_id": "end",
        "stop_sequence": 10,
    }
    observed = snapshot(NOON, reporting_vehicle)
    observed["feeds"]["trips"] = {**position_feed(NOON), "family": "trip_updates"}
    observed["trip_updates"] = [
        {"trip_id": "cancelled", "start_date": "20261124", "relationship": 3},
        {
            "trip_id": "reporting",
            "start_date": "20261124",
            "route_id": "A",
            "direction_id": None,
            "start_time": None,
            "relationship": 0,
            "delay": None,
            "stops": [
                {
                    "sequence": 10,
                    "stop_id": "end",
                    "arrival": int(datetime(2026, 11, 24, 18, 5, 1, tzinfo=UTC).timestamp()),
                    "departure": None,
                    "arrival_delay": None,
                    "departure_delay": None,
                    "relationship": 0,
                }
            ],
        },
    ]
    observed["city"] = city
    publisher = LivePublisher(manifest, raw)
    monkeypatch.setattr(publisher, "poll", lambda _: observed)

    class FrozenClock(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOON.astimezone(tz)

    monkeypatch.setattr("transit_ops.live.playback.datetime", FrozenClock)
    dest = LocalBronzeStorage("local", tmp_path / "dest")
    publisher.run(dest, "", once=True)
    published = json.loads(dest.read_bytes(f"live/v2/{city}.json"))
    assert "trip_updates" not in published
    scoped_index = json.loads(dest.read_bytes(f"live/v2/{city}/trips.json"))
    packed = dest.read_bytes(f"live/v2/{city}/trips.bin")
    start, length = scoped_index["ranges"]["trip:reporting"]
    update = json.loads(packed[start : start + length])
    assert update["stops"][0]["arrival_delay"] == (301 if edition else None)
    assert published["vehicle_positions"][0]["delay"] == (301 if edition and identified else None)
    coverage = publisher.inspect_delays(NOON)
    assert coverage["vehicles_with_trip"] == int(identified)
    assert coverage["vehicles_with_delay"] == int(edition and identified)
    assert coverage["without_delay"] == ({"no_schedule": 1} if identified and not edition else {})
    counts = {
        key: published[key]
        for key in ("scheduled_now", "non_responding", "cancelled_now", "non_responding_by_route")
    }
    if edition and identified:
        assert counts == {
            "scheduled_now": 2,
            "non_responding": 1,
            "cancelled_now": 1,
            "non_responding_by_route": [{"route_id": "B", "count": 1}],
        }
        with ThreadPoolExecutor(max_workers=1) as executor:
            workspace = tmp_path / "schedule"
            workspace.mkdir()
            schedule = LiveTripSchedule(manifest, raw, "", executor, workspace)
            assert all(
                value is None for value in schedule.at(NOON + timedelta(days=7), wait=True).values()
            )
    else:
        assert all(value is None for value in counts.values())
