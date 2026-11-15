from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from transit_ops.snapshots.builders.historic.repeat_offenders_history import (
    build_repeat_offenders_history_plan,
)
from transit_ops.snapshots.builders.historic.stop_reliability import build_stop_reliability
from transit_ops.snapshots.builders.historic.weekly_ranking import (
    rank_weekly_periods,
    weekly_payload_rows,
)


def test_weekly_stop_ranking_matches_sql_published_periods(real_db_engine, seed_provider):
    provider = "honest_weekly_test"
    with real_db_engine.connect() as conn, conn.begin() as tx:
        seed_provider(conn, provider, display_name="Weekly ranking test")
        day = datetime.now(UTC).date() - timedelta(days=2)
        for stop, observations, severe in [("bad", 30, 15), ("good", 30, 6), ("thin", 29, 29)]:
            conn.execute(
                text(
                    "INSERT INTO gold.stop_delay_spine "
                    "(provider_id, stop_id, route_id, provider_local_date, observation_count, "
                    "severe_delay_count, sum_delay_seconds) VALUES (:p,:s,'R',:d,:n,:k,6000)"
                ),
                dict(p=provider, s=stop, d=day, n=observations, k=severe),
            )
        files = build_stop_reliability(conn, provider_id=provider, generated_utc="t")
        ranked = rank_weekly_periods(weekly_payload_rows(files, kind="stop", excluded=set()))
        assert [row.id for row in ranked if row.state == "ranked"] == ["bad", "good"]
        assert (
            ranked[0].severe_pct
            == next(period.severe_pct for period in files["bad"].periods if period.grain == "week")
            == 50
        )
        assert ranked[-1].state == "too_few_units"
        tx.rollback()


def test_repeat_history_sql_requires_three_observed_days(real_db_engine, seed_provider):
    provider = "honest_repeat_test"
    with real_db_engine.connect() as conn, conn.begin() as tx:
        seed_provider(conn, provider, display_name="Repeat ranking test")
        anchor = datetime.now(UTC).date() - timedelta(days=2)
        for days in (1, 2, 3):
            for offset in range(days):
                conn.execute(
                    text(
                        "INSERT INTO gold.repeat_offender_daily_spine "
                        "(provider_id, entity_kind, entity_id, route_id, provider_local_date, "
                        "observation_count, severe_delay_count, sum_delay_seconds) "
                        "VALUES (:p,'trip',:id,'R',:d,30,30,18000)"
                    ),
                    dict(p=provider, id=str(days), d=anchor - timedelta(days=offset)),
                )
        payload = build_repeat_offenders_history_plan(conn, provider_id=provider).materialize()[-1]
        week = next(grain for grain in payload.by_grain if grain.grain == "week")
        assert [entry.id for entry in week.entries] == ["3"]
        assert {entry.id for entry in week.tray} == {"1", "2"}
        tx.rollback()
