from datetime import UTC, date, datetime
from hashlib import sha256
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from test_schedule_archive import archive

from transit_ops.providers.schedule_archive import ArchiveScheduleContext

# Deliberate collisions must neither activate nor remove this edition's service.
CALENDAR_SQL = text("""
WITH calendar_fixture(provider_id, dataset_version_id, service_id,
              monday, tuesday, wednesday, thursday, friday, saturday, sunday,
              start_date, end_date) AS (VALUES
    ('p', 1, 's', false,false,false,false,false,false,true, DATE '2026-03-08',DATE '2026-03-15'),
    ('q', 1, 's', true,true,true,true,true,true,true, DATE '2026-03-01',DATE '2026-03-31'),
    ('p', 2, 's', true,true,true,true,true,true,true, DATE '2026-03-01',DATE '2026-03-31')
), calendar AS (
    SELECT * FROM calendar_fixture
    WHERE :weekly OR provider_id <> :provider OR dataset_version_id <> :edition
), calendar_dates(provider_id, dataset_version_id, service_id, service_date,
                  exception_type) AS (VALUES
    ('p',1,'s',DATE '2026-03-09',1), ('p',1,'s',DATE '2026-03-15',2),
    ('p',1,'s',DATE '2026-03-22',1),
    ('q',1,'s',DATE '2026-03-08',2), ('p',2,'s',DATE '2026-03-08',2),
    ('q',1,'s',DATE '2026-03-10',1), ('p',2,'s',DATE '2026-03-10',1)
), trips(provider_id, dataset_version_id, service_id, trip_id) AS (VALUES
    ('p',1,'s','t'), ('q',1,'s','t'), ('p',2,'s','t'),
    ('q',1,'s','foreign_provider'), ('p',2,'s','foreign_edition')
), active_service AS (
    SELECT c.service_id FROM calendar c
    WHERE c.provider_id = :provider AND c.dataset_version_id = :edition
      AND CAST(:date AS date) BETWEEN c.start_date AND c.end_date
      AND CASE EXTRACT(ISODOW FROM CAST(:date AS date))
        WHEN 1 THEN c.monday WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
        WHEN 4 THEN c.thursday WHEN 5 THEN c.friday WHEN 6 THEN c.saturday
        ELSE c.sunday END
      AND NOT EXISTS (
        SELECT 1 FROM calendar_dates cd
        WHERE cd.provider_id = :provider AND cd.dataset_version_id = :edition
          AND cd.service_id = c.service_id AND cd.service_date = CAST(:date AS date)
          AND cd.exception_type = 2
      )
    UNION
    SELECT cd.service_id FROM calendar_dates cd
    WHERE cd.provider_id = :provider AND cd.dataset_version_id = :edition
      AND cd.service_date = CAST(:date AS date) AND cd.exception_type = 1
)
SELECT t.trip_id FROM trips t JOIN active_service a USING (service_id)
WHERE t.provider_id = :provider AND t.dataset_version_id = :edition
""")


@pytest.fixture(params=[True, False], ids=["weekly-and-holidays", "calendar-dates-only"])
def calendar_case(request):
    weekly = request.param
    # March 22 is an addition outside the weekly calendar's inclusive range.
    data = archive(
        calendar="s,0,0,0,0,0,0,1,20260308,20260315\n" if weekly else None,
        calendar_dates="s,20260309,1\ns,20260315,2\ns,20260322,1\n",
    )
    expected = {
        date(2026, 3, 7): set(),
        date(2026, 3, 8): {"t"} if weekly else set(),
        date(2026, 3, 9): {"t"},
        date(2026, 3, 10): set(),
        date(2026, 3, 15): set(),
        date(2026, 3, 16): set(),
        date(2026, 3, 22): {"t"},
    }
    ctx = ArchiveScheduleContext(
        provider_id="p",
        dataset_version_id=1,
        edition_sha256=sha256(data).hexdigest(),
        archive_bytes=data,
        service_dates=expected,
        timezone=ZoneInfo("America/Toronto"),
    )
    return weekly, ctx, expected


def test_archive_calendar_has_independently_specified_days(calendar_case):
    _, ctx, expected = calendar_case
    assert {day: record.trip_ids for day, record in ctx.days.items()} == expected


def test_archive_calendar_matches_postgresql(real_db_engine, calendar_case):
    weekly, ctx, expected = calendar_case
    with real_db_engine.connect() as connection:
        for day, trip_ids in expected.items():
            actual = set(
                connection.execute(
                    CALENDAR_SQL,
                    {
                        "weekly": weekly,
                        "provider": "p",
                        "edition": 1,
                        "date": day,
                    },
                ).scalars()
            )
            assert actual == trip_ids, day
            assert actual == ctx.days[day].trip_ids, day


@pytest.mark.parametrize(
    "day,expected",
    [
        (date(2026, 3, 8), datetime(2026, 3, 8, 4, tzinfo=UTC)),
        (date(2026, 11, 1), datetime(2026, 11, 1, 5, tzinfo=UTC)),
    ],
)
def test_archive_service_day_start_matches_postgresql(real_db_engine, day, expected):
    data = archive()
    ctx = ArchiveScheduleContext(
        provider_id="p",
        dataset_version_id=1,
        edition_sha256=sha256(data).hexdigest(),
        archive_bytes=data,
        service_dates=(day,),
        timezone=ZoneInfo("America/Toronto"),
    )
    with real_db_engine.connect() as connection:
        actual = connection.execute(
            text("""
            SELECT ((CAST(:date AS date) + TIME '12:00') AT TIME ZONE :timezone)
                   - INTERVAL '12 hours'
        """),
            {"date": day, "timezone": ctx.timezone.key},
        ).scalar_one()
    assert actual == expected
    assert ctx.service_day_start(day) == expected
    assert ctx.service_day_start(day) == actual
