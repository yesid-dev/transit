from transit_ops.snapshots.builders.historic.ranking_kernel import build_offender_kind_ladder


def test_repeat_offenders_require_three_observed_days():
    rows = [
        dict(
            entity_id=str(days),
            route_id="R",
            obs=60,
            severe=60,
            sum_delay_sec=36000,
            recurrence_days=days,
            observed_days=days,
            window_days=7,
        )
        for days in (1, 2, 3)
    ]
    result = build_offender_kind_ladder(rows, "trip", {})
    assert [entry.id for entry in result.entries] == ["3"]
    assert {entry.id for entry in result.tray} == {"1", "2"}


def test_weekly_directory_uses_published_figures_and_readings_floor():
    from transit_ops.snapshots.builders.historic.weekly_ranking import rank_weekly_periods

    result = rank_weekly_periods(
        [
            dict(id="better", numerator=79, denominator=100),
            dict(id="worst", numerator=58, denominator=100),
            dict(id="thin", numerator=0, denominator=29),
            dict(id="boundary", numerator=18, denominator=30),
        ]
    )
    assert [row.id for row in result if row.state == "ranked"] == ["worst", "boundary", "better"]
    assert result[-1].state == "too_few_units"
    assert result[0].pct == 58


def test_stop_rankings_exclude_only_active_informed_cancellations():
    from datetime import UTC, datetime

    from transit_ops.snapshots.builders.historic.weekly_ranking import cancelled_stop_ids
    from transit_ops.snapshots.contract import Alert

    alerts = [
        Alert(
            id="closed",
            severity="watch",
            header_key="",
            stops=["closed"],
            effect="NO_SERVICE",
            start_utc="2026-01-01T00:00:00Z",
        ),
        Alert(
            id="future",
            severity="watch",
            header_key="",
            stops=["future"],
            effect="NO_SERVICE",
            start_utc="2027-01-01T00:00:00Z",
        ),
        Alert(
            id="expired",
            severity="watch",
            header_key="",
            stops=["expired"],
            effect="NO_SERVICE",
            end_utc="2026-01-01T00:00:00Z",
        ),
        Alert(
            id="normalized",
            severity="watch",
            header_key="",
            stops=["normalized"],
            description="Cet arrêt est annulé en raison de travaux.",
        ),
    ]
    assert cancelled_stop_ids(alerts, datetime(2026, 6, 1, tzinfo=UTC)) == {"closed", "normalized"}
