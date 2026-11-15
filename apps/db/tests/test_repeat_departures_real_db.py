from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from test_windowable_repeat_offenders_realdb import _seeded

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
            source_ingestion_run_id,dataset_kind,content_hash,is_current,observed_from_utc)
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
        UPDATE core.dataset_versions SET is_current = false,
            observed_until_utc = :change_date WHERE dataset_version_id = :v
    """),
        dict(v=version, change_date=change_date),
    )
    future = conn.execute(
        text("""
        INSERT INTO core.dataset_versions(provider_id,feed_endpoint_id,
            source_ingestion_run_id,dataset_kind,content_hash,is_current,observed_from_utc)
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
