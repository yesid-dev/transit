from datetime import date, timedelta
from math import copysign, isfinite

from transit_ops.snapshots.builders.historic.repeat_offenders_history import (
    build_repeat_offenders_history_plan_from_rows,
)


def test_departures_require_recurrence_and_rank_frequency_before_actual_lateness():
    rows = []
    # A larger severe share must not outrank more repeated local dates.
    for identity, late_days, late_readings, late_sum_seconds in [
        ("often", 3, 1, 600),
        ("later", 2, 30, 27000),
        ("once", 1, 30, 18000),
        ("twice", 2, 30, 18030),
        ("earlier", 2, 30, 18000),
    ]:
        for offset in range(3):
            rows.append(
                dict(
                    local_date=date(2026, 6, 1) + timedelta(days=offset),
                    entity_kind="trip",
                    entity_id=identity,
                    route_id="36",
                    observation_count=30,
                    severe_count=late_readings if offset < late_days else 0,
                    sum_delay_seconds=late_sum_seconds if offset < late_days else 3600,
                    source_generated_utc="2026-06-04T00:00:00Z",
                )
            )
    rows.sort(key=lambda row: row["local_date"])
    payload = build_repeat_offenders_history_plan_from_rows(
        daily_rows=rows,
        name_rows=[],
        provider_timezone="UTC",
    ).materialize()[-1]
    week = payload.by_grain[0]
    assert [entry.id for entry in week.entries] == ["often", "later", "twice", "earlier"]
    assert [entry.avg_delay_min for entry in week.entries] == [0.3, 10.7, 7.3, 7.3]
    assert "once" in {entry.id for entry in week.tray}
    assert [
        (entry.observation_count, entry.severe_count, entry.severe_pct) for entry in week.entries
    ] == [(90, 3, 3.3), (90, 60, 66.7), (90, 60, 66.7), (90, 60, 66.7)]
    for entry in [*week.entries, *week.tray]:
        assert 0 <= entry.recurrence_days <= entry.observed_days <= entry.window_days
        assert 0 <= entry.severe_count <= entry.observation_count
        for value in (entry.avg_delay_min, entry.severe_pct, entry.wilson_lo, entry.wilson_hi):
            if value is not None:
                assert isfinite(value) and (value != 0 or copysign(1, value) == 1)
        assert 0 <= entry.severe_pct <= 100
        if entry.rank is not None:
            assert 0 <= entry.wilson_lo <= entry.wilson_hi <= 100
    assert next(entry for entry in week.tray if entry.id == "once").avg_delay_min == 4.7


def test_tiny_negative_mean_is_published_as_unsigned_zero():
    rows = [
        dict(
            local_date=date(2026, 6, 1) + timedelta(days=i),
            entity_kind="trip",
            entity_id="zero",
            route_id="36",
            observation_count=30,
            severe_count=1,
            sum_delay_seconds=-1,
            source_generated_utc="2026-06-04T00:00:00Z",
        )
        for i in range(3)
    ]
    payload = build_repeat_offenders_history_plan_from_rows(
        daily_rows=rows, name_rows=[], provider_timezone="UTC"
    ).materialize()[-1]
    for entry in [*payload.by_grain[0].entries, *payload.offenders]:
        assert entry.avg_delay_min == 0
        assert copysign(1, entry.avg_delay_min) == 1
