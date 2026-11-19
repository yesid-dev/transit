from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import text
from test_windowable_repeat_offenders_realdb import _seeded

from transit_ops.ingestion.dataset_versions import _touch_dataset_version
from transit_ops.silver.static_gtfs import BronzeStaticArchive, register_dataset_version
from transit_ops.snapshots.builders.historic.repeat_offenders_history import (
    build_repeat_offenders_history_plan,
)
from transit_ops.snapshots.builders.historic.small_surfaces import build_repeat_offenders


def _seed_departure_editions(conn, change_date="2026-07-02", matching_trip=True):
    version = conn.execute(
        text("""
        WITH endpoint AS (
            INSERT INTO core.feed_endpoints(provider_id,endpoint_key,feed_kind,source_format)
            VALUES ('stm_dense_ro','static_schedule','static_schedule','gtfs_schedule_zip')
            RETURNING feed_endpoint_id
        ), run AS (
            INSERT INTO raw.ingestion_runs(provider_id,feed_endpoint_id,run_kind,status)
            SELECT 'stm_dense_ro',feed_endpoint_id,'static_schedule','succeeded' FROM endpoint
            RETURNING ingestion_run_id,feed_endpoint_id
        )
        INSERT INTO core.dataset_versions(provider_id,feed_endpoint_id,
            source_ingestion_run_id,dataset_kind,content_hash,is_current,loaded_at_utc)
        SELECT 'stm_dense_ro',feed_endpoint_id,ingestion_run_id,'static_schedule',
               repeat('a',64),true,'2026-01-01' FROM run RETURNING dataset_version_id
    """)
    ).scalar_one()
    conn.execute(
        text("""
        INSERT INTO gold.dim_route_history(provider_id,route_id,route_short_name,
            valid_from_utc,last_seen_dataset_version_id)
        VALUES ('stm_dense_ro','RO1','36','2026-01-01',:v)
    """),
        dict(v=version, change_date=change_date),
    )
    conn.execute(
        text("""
        INSERT INTO silver.routes(dataset_version_id,provider_id,route_id,route_type)
        VALUES (:v,'stm_dense_ro','RO1',3)
    """),
        dict(v=version, change_date=change_date),
    )
    conn.execute(
        text("""
        INSERT INTO silver.stops(dataset_version_id,provider_id,stop_id)
        VALUES (:v,'stm_dense_ro','first')
    """),
        dict(v=version, change_date=change_date),
    )
    conn.execute(
        text("""
        INSERT INTO silver.trips(dataset_version_id,provider_id,trip_id,route_id,
                                 service_id,trip_headsign)
        VALUES (:v,'stm_dense_ro','sixty','RO1','weekday','Monk')
    """),
        dict(v=version, change_date=change_date),
    )
    conn.execute(
        text("""
        INSERT INTO silver.stop_times(dataset_version_id,provider_id,trip_id,
                                      stop_sequence,stop_id,departure_time)
        VALUES (:v,'stm_dense_ro','sixty',1,'first','07:42:00')
    """),
        dict(v=version, change_date=change_date),
    )
    # A newer current edition must not rename the retained June departure.
    conn.execute(
        text("""
        UPDATE core.dataset_versions SET is_current = false WHERE dataset_version_id = :v
    """),
        dict(v=version, change_date=change_date),
    )
    future = conn.execute(
        text("""
        INSERT INTO core.dataset_versions(provider_id,feed_endpoint_id,
            source_ingestion_run_id,dataset_kind,content_hash,is_current,loaded_at_utc)
        SELECT provider_id,feed_endpoint_id,source_ingestion_run_id,dataset_kind,
               repeat('b',64),true,:change_date FROM core.dataset_versions
        WHERE dataset_version_id = :v RETURNING dataset_version_id
    """),
        dict(v=version, change_date=change_date),
    ).scalar_one()
    if matching_trip:
        conn.execute(
            text("""
            INSERT INTO silver.routes(dataset_version_id,provider_id,route_id,route_type)
            VALUES (:v,'stm_dense_ro','RO1',3)
        """),
            dict(v=future),
        )
        conn.execute(
            text("""
            INSERT INTO silver.trips(dataset_version_id,provider_id,trip_id,route_id,
                                     service_id,trip_headsign)
            VALUES (:v,'stm_dense_ro','sixty','RO1','weekday','Future destination')
        """),
            dict(v=future),
        )
        conn.execute(
            text("""
            INSERT INTO silver.stops(dataset_version_id,provider_id,stop_id)
            VALUES (:v,'stm_dense_ro','first')
        """),
            dict(v=future),
        )
        conn.execute(
            text("""
            INSERT INTO silver.stop_times(dataset_version_id,provider_id,trip_id,
                                          stop_sequence,stop_id,departure_time)
            VALUES (:v,'stm_dense_ro','sixty',1,'first','08:00:00')
        """),
            dict(v=future),
        )


def test_repeat_departure_sql_labels_recurrence_and_sixty_minute_mean(
    real_db_engine, seed_provider
):
    anchor = datetime(2026, 6, 30, tzinfo=UTC).date()
    rows = [
        (
            "trip",
            identity,
            anchor - timedelta(days=offset),
            30,
            30 if offset < late_days else 0,
            30 * (seconds if offset < late_days else 120),
        )
        for identity, late_days, seconds in [
            ("often", 3, 600),
            ("later", 2, 900),
            ("once", 1, 600),
            ("sixty", 3, 3600),
        ]
        for offset in range(3)
    ]
    with _seeded(rows, real_db_engine, seed_provider) as conn:
        _seed_departure_editions(conn)
        payload = build_repeat_offenders_history_plan(
            conn, provider_id="stm_dense_ro"
        ).materialize()[-1]
        week = payload.by_grain[0]
        assert [entry.id for entry in week.entries] == ["sixty", "often", "later"]
        entry = week.entries[0]
        assert (entry.route_short_name, entry.departure_time, entry.headsign) == (
            "36",
            "07:42:00",
            "Monk",
        )
        assert (entry.avg_delay_min, entry.observation_count, entry.severe_count) == (60, 90, 90)
        assert (entry.recurrence_days, entry.observed_days, entry.window_days) == (3, 3, 7)
        assert "once" in {entry.id for entry in week.tray}

        current = build_repeat_offenders(
            conn, provider_id="stm_dense_ro", generated_utc="2026-07-01T00:00:00Z"
        )
        assert [entry.id for entry in current.by_grain[0].entries] == ["sixty", "often", "later"]
        assert current.by_grain[0].entries[0].departure_time == "07:42:00"


@pytest.mark.parametrize("matching_trip", [True, False])
def test_repeat_labels_use_closing_edition_after_last_observation(
    real_db_engine,
    seed_provider,
    matching_trip,
):
    rows = [
        ("trip", "sixty", datetime(2026, 6, day, tzinfo=UTC).date(), 30, 30, 18000)
        for day in (1, 2, 3)
    ]
    rows.append(("trip", "other", datetime(2026, 6, 4, tzinfo=UTC).date(), 1, 0, 0))
    with _seeded(rows, real_db_engine, seed_provider) as conn:
        _seed_departure_editions(
            conn, change_date="2026-06-04T04:00:00Z", matching_trip=matching_trip
        )
        days = build_repeat_offenders_history_plan(
            conn, provider_id="stm_dense_ro", as_of_utc=datetime(2026, 6, 5, 12, tzinfo=UTC)
        ).materialize()
        earlier = days[-2].by_grain[0].entries[0]
        assert (earlier.departure_time, earlier.headsign) == ("07:42:00", "Monk")
        retained = days[-1].by_grain[0].entries[0]
        current = (
            build_repeat_offenders(
                conn, provider_id="stm_dense_ro", generated_utc="2026-06-05T00:00:00Z"
            )
            .by_grain[0]
            .entries[0]
        )
        expected = ("08:00:00", "Future destination") if matching_trip else (None, None)
        for entry in (retained, current):
            assert (entry.departure_time, entry.headsign) == expected
            assert (
                entry.observation_count,
                entry.severe_count,
                entry.recurrence_days,
                entry.observed_days,
                entry.window_days,
                entry.avg_delay_min,
                entry.severe_pct,
            ) == (90, 90, 3, 3, 7, 10, 100)
            assert 0 <= entry.wilson_lo <= entry.wilson_hi <= 100


def _load_production_edition(conn, endpoint, *, tag, captured, loaded, last_seen, calendar, trips):
    """Leave an edition exactly as the static loader and the daily capture leave it.

    The loader registers it without observed_from_utc, and each later capture of the same
    bytes only moves observed_until_utc to that sighting.
    """
    path = f"schedule/{tag}.zip"
    run, source = conn.execute(
        text("""
        WITH run AS (
            INSERT INTO raw.ingestion_runs(provider_id,feed_endpoint_id,run_kind,status,
                                           started_at_utc,completed_at_utc)
            VALUES ('stm_dense_ro',:e,'static_schedule','succeeded',:at,:at)
            RETURNING ingestion_run_id
        )
        INSERT INTO raw.ingestion_objects(ingestion_run_id,provider_id,object_kind,
                                          storage_backend,storage_path,checksum_sha256)
        SELECT ingestion_run_id,'stm_dense_ro','gtfs_schedule_zip','local',:path,:h FROM run
        RETURNING ingestion_run_id, ingestion_object_id
    """),
        dict(e=endpoint, at=captured, path=path, h=tag * 64),
    ).one()
    version, _ = register_dataset_version(
        conn,
        archive=BronzeStaticArchive(
            provider_id="stm_dense_ro",
            storage_backend="local",
            feed_endpoint_id=endpoint,
            source_ingestion_run_id=run,
            source_ingestion_object_id=source,
            storage_path=path,
            archive_full_path=path,
            source_url=None,
            checksum_sha256=tag * 64,
            byte_size=None,
            source_completed_at_utc=captured,
        ),
        loaded_at_utc=loaded,
    )
    if last_seen is not None:
        _touch_dataset_version(conn, dataset_version_id=version, observed_at_utc=last_seen)
    conn.execute(
        text("""
        INSERT INTO silver.routes(dataset_version_id,provider_id,route_id,route_short_name,
                                  route_long_name,route_type)
        VALUES (:v,'stm_dense_ro','RO1','37','Jolicoeur',3)
    """),
        dict(v=version),
    )
    service_id, start_date, end_date = calendar
    conn.execute(
        text("""
        INSERT INTO silver.calendar(dataset_version_id,provider_id,service_id,monday,tuesday,
            wednesday,thursday,friday,saturday,sunday,start_date,end_date)
        VALUES (:v,'stm_dense_ro',:s,true,true,true,true,true,true,true,:start,:end)
    """),
        dict(v=version, s=service_id, start=start_date, end=end_date),
    )
    for stop in sorted({stop for _trip, _headsign, times in trips for _, stop, _, _ in times}):
        conn.execute(
            text("""
            INSERT INTO silver.stops(dataset_version_id,provider_id,stop_id)
            VALUES (:v,'stm_dense_ro',:stop)
        """),
            dict(v=version, stop=stop),
        )
    for trip_id, headsign, times in trips:
        conn.execute(
            text("""
            INSERT INTO silver.trips(dataset_version_id,provider_id,trip_id,route_id,
                                     service_id,trip_headsign)
            VALUES (:v,'stm_dense_ro',:t,'RO1',:s,:headsign)
        """),
            dict(v=version, t=trip_id, s=service_id, headsign=headsign),
        )
        for sequence, stop, arrival, departure in times:
            conn.execute(
                text("""
                INSERT INTO silver.stop_times(dataset_version_id,provider_id,trip_id,
                    stop_sequence,stop_id,arrival_time,departure_time)
                VALUES (:v,'stm_dense_ro',:t,:seq,:stop,:arrival,:departure)
            """),
                dict(
                    v=version,
                    t=trip_id,
                    seq=sequence,
                    stop=stop,
                    arrival=arrival,
                    departure=departure,
                ),
            )
    return version


def _seed_production_editions(conn):
    endpoint = conn.execute(
        text("""
        INSERT INTO core.feed_endpoints(provider_id,endpoint_key,feed_kind,source_format)
        VALUES ('stm_dense_ro','static_schedule','static_schedule','gtfs_schedule_zip')
        RETURNING feed_endpoint_id
    """)
    ).scalar_one()
    autumn = _load_production_edition(
        conn,
        endpoint,
        tag="a",
        captured=datetime(2026, 10, 6, 8, 5, tzinfo=UTC),
        loaded=datetime(2026, 10, 6, 8, 12, tzinfo=UTC),
        last_seen=datetime(2026, 11, 2, 8, 4, tzinfo=UTC),
        calendar=("25A-S", date(2026, 8, 24), date(2026, 11, 2)),
        trips=[
            (
                "305633061",
                "Station Lionel-Groulx",
                [(1, "52340", "07:30:00", "07:30:00"), (2, "52341", "07:33:00", "07:33:00")],
            )
        ],
    )
    conn.execute(
        text("""
        INSERT INTO gold.dim_route_history(provider_id,route_id,route_short_name,
            route_long_name,route_type,valid_from_utc,last_seen_dataset_version_id)
        VALUES ('stm_dense_ro','RO1','37','Jolicoeur',3,'2026-10-06T08:15:00Z',:v)
    """),
        dict(v=autumn),
    )
    # In force from 3 November; its last same-bytes capture precedes the 17 November close.
    _load_production_edition(
        conn,
        endpoint,
        tag="b",
        captured=datetime(2026, 11, 3, 8, 4, tzinfo=UTC),
        loaded=datetime(2026, 11, 3, 8, 20, tzinfo=UTC),
        last_seen=datetime(2026, 11, 17, 8, 3, tzinfo=UTC),
        calendar=("25N-S", date(2026, 11, 3), date(2027, 1, 4)),
        trips=[
            (
                "305633061",
                "Station Jolicoeur",
                [(1, "52340", "07:42:00", "07:42:00"), (2, "52341", "07:45:00", "07:45:00")],
            ),
            # The first stop is sequence 3 and departs past midnight on the service clock.
            (
                "305633140",
                "Station Angrignon",
                [(7, "52341", "24:21:00", "24:21:00"), (3, "52340", "24:16:30", "24:17:00")],
            ),
        ],
    )
    # Loaded after the 17 November close but before the publication: not yet in force.
    _load_production_edition(
        conn,
        endpoint,
        tag="c",
        captured=datetime(2026, 11, 18, 6, 2, tzinfo=UTC),
        loaded=datetime(2026, 11, 18, 6, 10, tzinfo=UTC),
        last_seen=None,
        calendar=("26J-S", date(2026, 11, 24), date(2027, 3, 29)),
        trips=[("305633061", "Next period", [(1, "52340", "08:00:00", "08:00:00")])],
    )


def _production_days():
    # 30 readings a day: every reading of the first trip is 7 min late; the second trip
    # has 24 readings 7 min late and 6 readings 2 min late each day.
    autumn = [date(2026, 10, 30), date(2026, 10, 31), date(2026, 11, 1)]
    week = [date(2026, 11, 11) + timedelta(days=offset) for offset in range(7)]
    rows = [("trip", "305633061", day, 30, 30, 30 * 420) for day in autumn + week]
    rows += [("trip", "305633140", day, 30, 24, 24 * 420 + 6 * 120) for day in week[-3:]]
    return rows


def _assert_counts_match_definition(entry, rows, first_day, last_day, window_days):
    window = [row for row in rows if row[1] == entry.id and first_day <= row[2] <= last_day]
    observations = sum(row[3] for row in window)
    severe = sum(row[4] for row in window)
    assert (
        entry.observation_count,
        entry.severe_count,
        entry.severe_pct,
        entry.recurrence_days,
        entry.observed_days,
        entry.avg_delay_min,
        entry.window_days,
    ) == (
        observations,
        severe,
        round(100 * severe / observations, 1),
        sum(1 for row in window if row[4] > 0),
        len(window),
        round(sum(row[5] for row in window) / observations / 60, 1),
        window_days,
    )
    not_severe_pct = 100 * (observations - severe) / observations
    assert 0 <= entry.wilson_lo <= not_severe_pct <= entry.wilson_hi <= 100


def test_repeat_labels_name_departures_from_production_shaped_editions(
    real_db_engine, seed_provider
):
    rows = _production_days()
    with _seeded(rows, real_db_engine, seed_provider) as conn:
        _seed_production_editions(conn)
        days = {
            payload.date: payload
            for payload in build_repeat_offenders_history_plan(
                conn,
                provider_id="stm_dense_ro",
                as_of_utc=datetime(2026, 11, 18, 7, tzinfo=UTC),
            ).materialize()
        }
        current = build_repeat_offenders(
            conn, provider_id="stm_dense_ro", generated_utc="2026-11-18T07:00:00Z"
        )

        closing_week = next(g for g in days["2026-11-17"].by_grain if g.grain == "week")
        current_week = next(g for g in current.by_grain if g.grain == "week")
        for week in (closing_week, current_week):
            assert [
                (entry.id, entry.route_short_name, entry.departure_time, entry.headsign)
                for entry in week.entries
            ] == [
                ("305633061", "37", "07:42:00", "Station Jolicoeur"),
                ("305633140", "37", "24:17:00", "Station Angrignon"),
            ]
            for entry in week.entries:
                _assert_counts_match_definition(
                    entry, rows, date(2026, 11, 11), date(2026, 11, 17), 7
                )

        # The month spans both editions; its labels still come from the edition at the close.
        month = next(g for g in days["2026-11-17"].by_grain if g.grain == "month").entries[0]
        assert (month.id, month.departure_time, month.headsign) == (
            "305633061",
            "07:42:00",
            "Station Jolicoeur",
        )
        _assert_counts_match_definition(month, rows, date(2026, 10, 19), date(2026, 11, 17), 30)

        # A window closing before 3 November names the edition in force then.
        autumn = next(g for g in days["2026-11-01"].by_grain if g.grain == "week").entries[0]
        assert (
            autumn.id,
            autumn.route_short_name,
            autumn.departure_time,
            autumn.headsign,
        ) == ("305633061", "37", "07:30:00", "Station Lionel-Groulx")
        _assert_counts_match_definition(autumn, rows, date(2026, 10, 26), date(2026, 11, 1), 7)
