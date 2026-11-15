"""Source planning and privilege boundaries, without production credentials."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from transit_ops.batch.daily_inputs import (
    assert_group_deadline,
    assert_read_role,
    exact_windows,
    group_deadline,
    require_window_support,
)


@pytest.mark.parametrize("can_write", [True, None])
def test_role_can_write_or_unknown_refuses(can_write):
    seen = []

    def execute(query, parameters):
        seen.append((query, parameters))
        return SimpleNamespace(fetchone=lambda: (can_write,))

    with pytest.raises(ValueError, match="role_can_write"):
        assert_read_role(SimpleNamespace(execute=execute))
    query, (tables, schemas) = seen[0]
    assert tables == schemas == ["core", "raw", "silver", "gold"]
    assert all(
        check in query
        for check in (
            "rolsuper",
            "pg_has_role",
            "has_table_privilege",
            "INSERT,UPDATE,DELETE,TRUNCATE",
            "CREATE",
        )
    )


def test_exact_windows_keep_provider_days_months_and_current_edition():
    stamp = datetime(2026, 11, 15, 12, tzinfo=UTC)

    def execute(query, parameters):
        assert parameters == ("stm",)
        return SimpleNamespace(fetchall=lambda: [("c" * 64,)])

    windows = exact_windows(
        [
            {
                "relation": "gold.fact_trip_delay_snapshot",
                "provider": "stm",
                "window": "2026-11-14",
            },
            {
                "relation": "gold.fact_trip_delay_snapshot",
                "provider": "stm",
                "window": "2026-11-15",
            },
            {"relation": "raw.realtime_snapshot_index", "provider": "stm", "window": "2026-11-14"},
            {"relation": "core.providers", "provider": "stm", "window": "all"},
            {"relation": "silver.trips", "provider": "stm", "window": "edition:1"},
        ],
        stamp,
        SimpleNamespace(execute=execute),
    )
    assert windows == (
        "core.providers:stm:2026-11",
        "gold.fact_trip_delay_snapshot:stm:2026-11-14",
        "gold.fact_trip_delay_snapshot:stm:2026-11-15",
        "raw.realtime_snapshot_index:stm:2026-11",
        "silver.trips:stm:" + "c" * 64,
    )


def test_alerts_are_the_only_all_provider_exception():
    conn = SimpleNamespace(
        execute=lambda query: SimpleNamespace(fetchall=lambda: [("stm",), ("octranspo",), ("sto",)])
    )
    windows = exact_windows(
        [
            {"relation": "silver.i3_alerts", "provider": "stm", "window": "all"},
            {"relation": "silver.i3_alert_active_periods", "provider": "stm", "window": "all"},
            {"relation": "core.providers", "provider": "stm", "window": "all"},
        ],
        datetime(2026, 11, 15, tzinfo=UTC),
        conn,
    )
    assert windows == (
        "core.providers:stm:2026-11",
        "silver.i3_alert_active_periods:_shared:2026-11",
        "silver.i3_alerts:octranspo:2026-11",
        "silver.i3_alerts:stm:2026-11",
        "silver.i3_alerts:sto:2026-11",
    )


def test_local_day_crossing_month_requires_both_utc_months():
    windows = exact_windows(
        [
            {
                "relation": "gold.stop_delay_hourly",
                "provider": "stm",
                "window": "local:2026-10-31",
                "timezone": "America/Toronto",
            },
            {
                "relation": "gold.route_delay_spine",
                "provider": "stm",
                "window": "local:2026-10-31",
                "timezone": "America/Toronto",
            },
        ],
        datetime(2026, 11, 15, tzinfo=UTC),
        None,
    )
    assert windows == (
        "gold.route_delay_spine:stm:2026-10",
        "gold.stop_delay_hourly:stm:2026-10",
        "gold.stop_delay_hourly:stm:2026-11",
    )


def test_open_windows_refuse_before_the_ls19e_interface_exists(monkeypatch):
    from transit_ops.commands import lake

    monkeypatch.setattr(lake, "migrate", lambda: None)
    with pytest.raises(ValueError, match="open_window_unsupported"):
        require_window_support(
            [
                {
                    "relation": "raw.realtime_snapshot_index",
                    "provider": "stm",
                    "window": "2026-11-14",
                }
            ],
            datetime(2026, 11, 15, tzinfo=UTC),
        )


def test_fresh_group_deadline_does_not_spend_reserve_on_prior_copies(monkeypatch):
    from transit_ops.batch import daily_inputs

    started = datetime.now(UTC)
    after_ordinary = started + timedelta(seconds=3750)

    class Clock:
        @staticmethod
        def now(zone):
            return after_ordinary

    monkeypatch.setattr(daily_inputs, "datetime", Clock)
    deadline = group_deadline(3, now=after_ordinary)
    assert (deadline - after_ordinary).total_seconds() == 4860
    assert_group_deadline(deadline, 3)
    # A fixed deadline with only the weakened library margin must refuse.
    with pytest.raises(ValueError, match="not_after"):
        assert_group_deadline(after_ordinary + timedelta(seconds=4350), 3)
    with pytest.raises(ValueError, match="not_after"):
        assert_group_deadline(after_ordinary + timedelta(seconds=4500), 3)
    assert_group_deadline(after_ordinary + timedelta(seconds=4501), 3)
