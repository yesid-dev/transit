from datetime import UTC, datetime

import pytest
import real_db_seed
from sqlalchemy import text
from test_family_receipts import ALERTS, DAY, REQUEST, ROUTES, STAMP, STOPS
from test_revision_2_both_engines_real_db import _export_inputs

from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families.receipts import builder
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import run_family
from transit_ops.gold import rollups
from transit_ops.silver.i3 import compute_alert_content_hash

PROVIDER = "receipts_seed"
RELATIONS = (
    *builder.tables,
    "gold.route_delay_spine",
    "gold.stop_delay_hourly",
    "silver.i3_alerts",
    "raw.i3_alert_snapshots",
    "raw.ingestion_runs",
    "core.feed_endpoints",
    "core.providers",
)


def seed(conn, seed_provider, routes, stops, alerts):
    seed_provider(conn, PROVIDER, display_name="Receipts seed", timezone=REQUEST.timezone)
    params = dict(p=PROVIDER, e=98130001, r=98130002, s=98130003, at=STAMP)
    real_db_seed.feed_endpoints(
        conn, params, feed_kind="'i3_alerts'", source_format="'api_i3_json'"
    )
    real_db_seed.ingestion_runs(conn, params, run_kind="'i3_alerts'")
    conn.execute(
        text(
            "INSERT INTO raw.i3_alert_snapshots "
            "(i3_alert_snapshot_id,provider_id,feed_endpoint_id,ingestion_run_id,"
            "captured_at_utc,raw_payload_json) VALUES (:s,:p,:e,:r,:at,'{}')"
        ),
        params,
    )
    for route, hour, direction, severe, delayed, total, hist in routes:
        conn.execute(
            text(
                "INSERT INTO gold.route_delay_spine "
                "(provider_id,route_id,provider_local_date,hour_of_day_local,direction_id,"
                "severe_delay_count,delayed_trip_count,sum_delay_seconds,delay_histogram) "
                "VALUES (:p,:route,:day,:hour,:direction,:severe,:delayed,:total,:hist)"
            ),
            params
            | dict(
                route=route,
                day=DAY,
                hour=hour,
                direction=direction,
                severe=severe,
                delayed=delayed,
                total=total,
                hist=hist,
            ),
        )
    for stop, hour, arrival, departure, severe in stops:
        if stop is None:  # SQL table forbids NULL keys; the pure seam also tests NULL input.
            continue
        conn.execute(
            text(
                "INSERT INTO gold.stop_delay_hourly "
                "(provider_id,stop_id,route_id,period_start_utc,avg_arrival_delay_seconds,"
                "avg_departure_delay_seconds,severe_delay_count) "
                "VALUES (:p,:stop,'R',:at,:arrival,:departure,:severe)"
            ),
            params
            | dict(
                stop=stop,
                at=datetime(2026, 11, 1, hour, tzinfo=UTC),
                arrival=arrival,
                departure=departure,
                severe=severe,
            ),
        )
    for index, (description, severity, cause, effect) in enumerate(alerts):
        # Active hashes are unique per provider (0093:2096-2097). Production
        # includes alert_id in stored identity, but accountability's hash does not.
        alert_id = f"alert-{index}"
        content_hash = compute_alert_content_hash(
            alert_id=alert_id,
            alert_header_text=None,
            description_text=description,
            severity=severity,
            cause=cause,
            effect=effect,
            active_period_start_utc=None,
            active_period_end_utc=None,
            published_at_utc=None,
            updated_at_utc=None,
        )
        conn.execute(
            text(
                "INSERT INTO silver.i3_alerts "
                "(i3_alert_snapshot_id,alert_index,provider_id,captured_at_utc,"
                "raw_alert_json,alert_id,content_hash,description_text,severity,cause,effect) "
                "VALUES (:s,:i,:p,:at,'{}',:alert_id,:hash,:d,:sev,:cause,:effect)"
            ),
            params
            | dict(
                i=index,
                alert_id=alert_id,
                hash=content_hash,
                at=datetime(2026, 11, 1, 6, 0, 0, 1, UTC),
                d=description,
                sev=severity,
                cause=cause,
                effect=effect,
            ),
        )


@pytest.mark.parametrize(
    "routes,stops,alerts",
    [
        (ROUTES, STOPS, ALERTS),
        ([], [], ALERTS),
        ([], STOPS, []),
        ([], [], []),
        ([("tie", 0, 0, 0, 0, 60001, [200])], [], []),
        ([("cap", 0, 0, 4000, 4000, 0, [1])], [], []),
    ],
)
def test_accountability_matches_postgres_on_exported_inputs(
    real_db_engine, seed_provider, tmp_path, routes, stops, alerts
):
    try:
        with real_db_engine.begin() as conn:
            seed(conn, seed_provider, routes, stops, alerts)
            params = dict(provider_id=PROVIDER, built_at_utc=STAMP, open_window_days=10)
            conn.execute(
                rollups.DELETE_REPORTING_AGGREGATES["citizen_accountability_daily"], params
            )
            conn.execute(rollups.UPSERT_CITIZEN_ACCOUNTABILITY_DAILY, params)
        _export_inputs(real_db_engine, builder, REQUEST, tmp_path)
        result = run_family(
            builder, REQUEST, inputs_root=tmp_path, workdir=tmp_path, code_commit="a" * 40
        )
        with real_db_engine.begin() as conn:
            expected = read_table_rows(
                conn,
                builder.tables[0],
                ("provider_id", "provider_local_date"),
                provider_id=PROVIDER,
                local_dates=(DAY,),
            )
        assert compare_tables(expected, result.output.tables[builder.tables[0]]) == []
    finally:
        with real_db_engine.begin() as conn:
            for relation in RELATIONS:
                conn.execute(text(f"DELETE FROM {relation} WHERE provider_id=:p"), {"p": PROVIDER})
            for relation in RELATIONS:
                assert (
                    conn.execute(
                        text(f"SELECT count(*) FROM {relation} WHERE provider_id=:p"),
                        {"p": PROVIDER},
                    ).scalar_one()
                    == 0
                ), relation
