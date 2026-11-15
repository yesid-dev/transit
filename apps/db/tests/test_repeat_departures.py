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


def test_retained_labels_resolve_at_the_emitted_close_even_without_a_new_observation():
    from datetime import UTC, datetime

    from _sqlfakes import NamedQueryConn, _FakeResult

    from transit_ops.snapshots.builders.historic.repeat_offenders_history import (
        build_repeat_offenders_history_plan,
    )
    from transit_ops.sql_registry import query_name

    class ClosingLabelsConn(NamedQueryConn):
        def __init__(self, mapping):
            super().__init__(mapping)
            self.label_calls = []

        def execute(self, statement, params=None):
            if query_name(statement) == "history.repeat_offenders.labels":
                closing = str(params["local_date"])
                self.label_calls.append((closing, params["ids"], params["routes"]))
                return _FakeResult(
                    [
                        dict(
                            entity_kind="trip",
                            entity_id="T",
                            route_id="36",
                            route_short_name="36",
                            departure_time="08:00:00" if closing == "2026-06-04" else "07:42:00",
                            headsign="New" if closing == "2026-06-04" else "Old",
                        )
                    ]
                )
            return super().execute(statement, params)

    rows = [
        dict(
            local_date=f"2026-06-0{i}",
            entity_kind="trip",
            entity_id="T",
            route_id="36",
            observation_count=30,
            severe_count=30,
            sum_delay_seconds=18000,
            source_generated_utc="2026-06-05T00:00:00Z",
            route_short_name="36",
            departure_time="07:42:00",
            headsign="Old",
        )
        for i in range(1, 4)
    ]
    rows.append(
        dict(
            rows[-1],
            local_date="2026-06-04",
            entity_id="other",
            severe_count=0,
            observation_count=1,
            sum_delay_seconds=0,
        )
    )
    conn = ClosingLabelsConn(
        {
            "history.repeat_offenders.timezone": [{"timezone": "UTC"}],
            "history.repeat_offenders.names": [],
            "history.repeat_offenders.daily": rows,
        }
    )
    days = build_repeat_offenders_history_plan(
        conn, provider_id="review", as_of_utc=datetime(2026, 6, 5, tzinfo=UTC)
    ).materialize()
    assert conn.label_calls == [(f"2026-06-0{i}", ["T"], ["36"]) for i in range(1, 5)]
    entry = days[-1].by_grain[0].entries[0]
    assert (entry.departure_time, entry.headsign) == ("08:00:00", "New")
    assert (
        entry.observation_count,
        entry.severe_count,
        entry.recurrence_days,
        entry.observed_days,
        entry.window_days,
        entry.avg_delay_min,
    ) == (90, 90, 3, 3, 7, 10)


def test_compatibility_scalar_serializes_unsigned_zero_and_preserves_null():
    from decimal import Decimal

    from _sqlfakes import NamedQueryConn

    from transit_ops.snapshots.builders.historic.small_surfaces import build_repeat_offenders
    from transit_ops.snapshots.serialization import snapshot_json_bytes

    # One +600, twenty-eight -21 and one -15 second reading: -3 seconds / 30 = -0.1.
    assert 600 + 28 * -21 - 15 == -3
    conn = NamedQueryConn(
        {
            "repeat.offenders": [
                dict(
                    entity_kind="trip",
                    entity_id=str(i),
                    route_id="36",
                    recurrence_days=3,
                    window_days=14,
                    avg_delay_seconds=value,
                    severity_label="watch",
                )
                for i, value in enumerate((Decimal("-0.1"), None, Decimal("0")))
            ],
            "static.route_names": [],
            "repeat.offenders.spine.anchor": [{"anchor": None}],
        }
    )
    payload = build_repeat_offenders(
        conn, provider_id="review", generated_utc="2026-06-04T00:00:00Z"
    )
    assert [entry.avg_delay_min for entry in payload.offenders] == [0.0, None, 0.0]
    for entry in (payload.offenders[0], payload.offenders[2]):
        assert isfinite(entry.avg_delay_min) and copysign(1, entry.avg_delay_min) == 1
    assert b'"avg_delay_min":-0.0' not in snapshot_json_bytes(payload)
    assert b'"avg_delay_min":null' in snapshot_json_bytes(payload)
