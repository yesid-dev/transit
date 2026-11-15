"""Source planning and privilege boundaries, without production credentials."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Annotated

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
    fake_lake_cli(monkeypatch, cuts=False, reserve=False)
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


@pytest.mark.parametrize("relation", ["raw.ingestion_runs", "raw.ingestion_objects"])
def test_windowed_all_never_reads_unrelated_historical_months(relation):
    def execute(*args):
        raise AssertionError("must not scan a source holding 23 historical months")

    with pytest.raises(ValueError, match="unbounded_window_need"):
        exact_windows(
            [{"relation": relation, "provider": "stm", "window": "all"}],
            datetime(2026, 11, 15, tzinfo=UTC),
            SimpleNamespace(execute=execute),
        )


def test_select_only_role_passes_the_catalog_result():
    queries = []

    def execute(query, parameters):
        queries.append(query)
        return SimpleNamespace(fetchone=lambda: (False,))

    assert_read_role(SimpleNamespace(execute=execute))
    assert all(
        check in queries[0]
        for check in (
            "'MEMBER'",
            "has_any_column_privilege",
            "TRIGGER",
            "has_sequence_privilege",
            "has_database_privilege",
        )
    )


def fake_lake_cli(monkeypatch, *, cuts=True, reserve=True, callback=None):
    from dataclasses import make_dataclass

    import typer

    from transit_ops.commands import lake
    from transit_ops.lake import table_export

    fields = [("dataset_id", str)] + ([("cut_utc", str | None, None)] if cuts else [])
    monkeypatch.setattr(table_export, "WindowSpec", make_dataclass("CutCapability", fields))
    app = typer.Typer()

    @app.callback()
    def root():
        pass

    if reserve:

        def migrate(
            window: Annotated[list[str] | None, typer.Option("--window")] = None,
            not_after: Annotated[str, typer.Option("--not-after")] = "",
            group_reserve_s: Annotated[int, typer.Option("--group-reserve-s")] = 0,
        ):
            if callback:
                callback(not_after=not_after, group_reserve_s=group_reserve_s)
    else:

        def migrate(
            window: Annotated[list[str] | None, typer.Option("--window")] = None,
            not_after: Annotated[str, typer.Option("--not-after")] = "",
        ):
            pass

    app.command(context_settings={"ignore_unknown_options": True, "allow_extra_args": True})(
        migrate
    )
    monkeypatch.setattr(lake, "app", app)
    return app


@pytest.mark.parametrize("cuts,reserve", [(True, True), (True, False), (False, True)])
def test_group_capability_requires_public_option_and_fixed_cuts(monkeypatch, cuts, reserve):
    from transit_ops.batch.daily_inputs import require_group_reserve_support

    fake_lake_cli(monkeypatch, cuts=cuts, reserve=reserve)
    if cuts and reserve:
        require_group_reserve_support()
        require_window_support([], datetime(2026, 11, 15, tzinfo=UTC))
    else:
        with pytest.raises(ValueError, match="group_reserve_unsupported"):
            require_group_reserve_support()
        if not cuts:
            with pytest.raises(ValueError, match="open_window_unsupported"):
                require_window_support([], datetime(2026, 11, 15, tzinfo=UTC))


def test_future_windowed_all_needs_have_the_same_refusal(monkeypatch):
    from dataclasses import replace

    from transit_ops.batch import daily_inputs
    from transit_ops.history.datasets import get_dataset

    model = get_dataset("raw.ingestion_objects")
    future = replace(
        model,
        dataset_id="silver.rt_entities",
        source=replace(model.source, table="silver.rt_entities"),
    )
    monkeypatch.setattr(daily_inputs, "get_dataset", lambda relation: future)
    with pytest.raises(ValueError, match="unbounded_window_need: silver.rt_entities"):
        exact_windows(
            [{"relation": "silver.rt_entities", "provider": "stm", "window": "all"}],
            datetime(2026, 11, 15, tzinfo=UTC),
            None,
        )


def test_dataset_version_fk_all_refuses_with_unrelated_history_present():
    from transit_ops.batch.build import InputNeed
    from transit_ops.batch.replay import parent_input_needs

    class Catalog:
        def get_foreign_keys(self, name, schema):
            # The two dataset_versions FKs in migration 0093:2104-2109.
            targets = {
                ("core", "dataset_versions"): ("ingestion_runs", "ingestion_objects"),
                ("raw", "ingestion_objects"): ("ingestion_runs",),
            }
            return [
                {"referred_schema": "raw", "referred_table": parent}
                for parent in targets.get((schema, name), ())
            ]

    needs = parent_input_needs((InputNeed("core.dataset_versions", "all"),), Catalog())
    assert {n.relation for n in needs if n.window == "all"} == {
        "core.dataset_versions",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
    }
    history = ["2025-01", "2025-08", "2026-11"]
    queries = []

    def execute(query, parameters):
        queries.append(query)
        return SimpleNamespace(fetchone=lambda: (datetime.fromisoformat(history[0] + "-01"),))

    with pytest.raises(ValueError, match="unbounded_window_need"):
        exact_windows(
            [{"relation": n.relation, "window": n.window, "provider": "stm"} for n in needs],
            datetime(2026, 11, 15, tzinfo=UTC),
            SimpleNamespace(execute=execute),
        )
    assert queries == []
