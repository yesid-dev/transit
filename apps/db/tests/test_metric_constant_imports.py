"""Public package import compatibility and pure constant-owner imports."""

import subprocess
import sys
import textwrap


def _run(code: str) -> None:
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_metric_constants_import_without_database_modules() -> None:
    _run("""
        import importlib.abc
        import sys

        forbidden = ('sqlalchemy', 'psycopg', 'transit_ops.db')
        def blocked(name):
            return any(name == root or name.startswith(root + '.') for root in forbidden)

        class BlockDatabase(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                assert not blocked(fullname), f'database import attempted: {fullname}'

        assert not any(blocked(name) for name in sys.modules)
        sys.meta_path.insert(0, BlockDatabase())
        from transit_ops.gold.reader.bands import EARLY_BELOW_SECONDS, LATE_ABOVE_SECONDS
        from transit_ops.gold.reader.rates import TRIP_FLOOR, min_service_days
        from transit_ops.gold.reader.delay_hist import DELAY_HIST_LAYOUTS

        assert (EARLY_BELOW_SECONDS, LATE_ABOVE_SECONDS, TRIP_FLOOR) == (-60, 300, 30)
        assert DELAY_HIST_LAYOUTS[2].edges_s[0] == -3600
        assert DELAY_HIST_LAYOUTS[2].edges_s[-1] == 3600
        assert not any(blocked(name) for name in sys.modules)
    """)


def test_gold_public_exports_keep_their_original_objects() -> None:
    _check_exports(
        "transit_ops.gold",
        [
            "REBUILDABLE_KINDS",
            "AlertArchiveSyncResult",
            "GoldBuildResult",
            "GoldRealtimeRefreshResult",
            "GoldStaticRefreshResult",
            "WarmRollupBuildResult",
            "WarmRollupRebuildResult",
            "alert_archive_default_bounds",
            "build_gold_marts",
            "build_warm_rollups",
            "initialize_realtime_serving",
            "provider_is_seeded",
            "rebuild_warm_rollups",
            "refresh_gold_realtime",
            "refresh_gold_static",
            "sync_alert_archive",
        ],
        {
            "transit_ops.gold.alert_archive": [
                "AlertArchiveSyncResult",
                "alert_archive_default_bounds",
                "sync_alert_archive",
            ],
            "transit_ops.gold.marts": [
                "GoldBuildResult",
                "GoldRealtimeRefreshResult",
                "GoldStaticRefreshResult",
                "build_gold_marts",
                "refresh_gold_static",
            ],
            "transit_ops.gold.realtime": ["initialize_realtime_serving", "refresh_gold_realtime"],
            "transit_ops.gold.rollups": [
                "REBUILDABLE_KINDS",
                "WarmRollupBuildResult",
                "WarmRollupRebuildResult",
                "build_warm_rollups",
                "provider_is_seeded",
                "rebuild_warm_rollups",
            ],
        },
    )


def test_reader_public_exports_keep_their_original_objects() -> None:
    _check_exports(
        "transit_ops.gold.reader",
        [
            "EARLY_BELOW_SECONDS",
            "LATE_ABOVE_SECONDS",
            "MIN_N_RATE",
            "POOLED_AVG_DELAY_SECONDS_EXPR",
            "PROJECT_TEMPLATE",
            "REPEAT_PROBLEM_SCORE_EXPR",
            "ROUTE_ENTITY_CLAUSE",
            "ROUTE_HABIT_SPINE_SQL",
            "SHIFT_BOUNDS",
            "SHIFT_DEFAULT",
            "SPINE_HIST_COLS",
            "SPINE_WINDOW_CLAUSE",
            "WILSON_Z",
            "TRIP_FLOOR",
            "DayCount",
            "RateSummary",
            "WindowKind",
            "GrainWindows",
            "all_time_window",
            "avg_delay_min",
            "band_case_sql",
            "band_of",
            "band_pct",
            "bunched_pct",
            "cdf_percentile",
            "cov_case_sql",
            "current_date_trailing_clause",
            "daytype_case_sql",
            "delay_histogram_bins",
            "delay_bins",
            "ewt_min",
            "hist_and_avg",
            "hist_cols",
            "infer_shift",
            "late_avg_min",
            "min_service_days",
            "otp_pct",
            "otp_pct_severe_proxy",
            "pctile_min_from_hist",
            "round_half_away",
            "rate_summary",
            "severe_pct",
            "shift_case_sql",
            "spine_project_sql",
            "wilson_bounds",
            "wilson_hi",
            "wilson_lo",
        ],
        {
            "transit_ops.gold.reader.bands": [
                "EARLY_BELOW_SECONDS",
                "LATE_ABOVE_SECONDS",
                "band_case_sql",
                "band_of",
            ],
            "transit_ops.gold.reader.buckets": [
                "SHIFT_BOUNDS",
                "SHIFT_DEFAULT",
                "daytype_case_sql",
                "infer_shift",
                "shift_case_sql",
            ],
            "transit_ops.gold.reader.histogram": [
                "bunched_pct",
                "cov_case_sql",
                "delay_histogram_bins",
                "ewt_min",
                "hist_and_avg",
                "round_half_away",
            ],
            "transit_ops.gold.reader.percentile": ["cdf_percentile", "pctile_min_from_hist"],
            "transit_ops.gold.reader.projector": [
                "PROJECT_TEMPLATE",
                "ROUTE_ENTITY_CLAUSE",
                "ROUTE_HABIT_SPINE_SQL",
                "SPINE_HIST_COLS",
                "hist_cols",
                "spine_project_sql",
            ],
            "transit_ops.gold.reader.rates": [
                "MIN_N_RATE",
                "TRIP_FLOOR",
                "WILSON_Z",
                "DayCount",
                "RateSummary",
                "WindowKind",
                "avg_delay_min",
                "band_pct",
                "delay_bins",
                "late_avg_min",
                "min_service_days",
                "otp_pct",
                "otp_pct_severe_proxy",
                "rate_summary",
                "severe_pct",
                "wilson_bounds",
                "wilson_hi",
                "wilson_lo",
            ],
            "transit_ops.gold.reader.score": [
                "POOLED_AVG_DELAY_SECONDS_EXPR",
                "REPEAT_PROBLEM_SCORE_EXPR",
                "all_time_window",
            ],
            "transit_ops.gold.reader.window": [
                "SPINE_WINDOW_CLAUSE",
                "GrainWindows",
                "current_date_trailing_clause",
            ],
        },
    )


def _check_exports(package: str, exports: list[str], owners: dict[str, list[str]]) -> None:
    _run(f"""
        import importlib
        package = {package!r}
        exports = {exports!r}
        owners = {owners!r}
        facade = importlib.import_module(package)
        assert facade.__all__ == exports
        assert set(exports) <= set(dir(facade))
        assert {{owner.rsplit('.', 1)[1] for owner in owners}} <= set(dir(facade))
        namespace = {{}}
        exec(f'from {{package}} import *', namespace)
        for module, names in owners.items():
            owner = importlib.import_module(module)
            for name in names:
                expected = getattr(owner, name)
                assert getattr(facade, name) is expected, name
                assert getattr(facade, name) is expected, name
                assert namespace[name] is expected, name
                direct = {{}}
                exec(f'from {{package}} import {{name}}', direct)
                assert direct[name] is expected, name
            # Eager facades also exposed the imported owner submodules.
            child = module.rsplit('.', 1)[1]
            assert getattr(facade, child) is owner
            assert child in dir(facade)
    """)


def test_unknown_facade_name_raises_attribute_error() -> None:
    _run("""
        import importlib
        import sys
        for package in ('transit_ops.gold', 'transit_ops.gold.reader'):
            facade = importlib.import_module(package)
            before = set(sys.modules)
            try:
                getattr(facade, 'missing_metric_export')
            except AttributeError as error:
                assert str(error) == f"module {package!r} has no attribute 'missing_metric_export'"
            else:
                raise AssertionError('unknown attribute accepted')
            assert set(sys.modules) == before
            try:
                exec(f'from {package} import missing_metric_export')
            except ImportError as error:
                assert f"cannot import name 'missing_metric_export' from '{package}'" in str(error)
            else:
                raise AssertionError('unknown import accepted')
            assert 'missing_metric_export' not in dir(facade)
            assert not hasattr(facade, 'missing_metric_export')
    """)


def test_existing_gold_submodule_import_forms() -> None:
    _run("""
        import importlib
        for name in ('delay_cohorts', 'delay_days', 'delay_hours', 'delay_periods',
                     'delay_sums', 'marts', 'rollups'):
            namespace = {}
            exec(f'from transit_ops.gold import {name}', namespace)
            assert namespace[name] is importlib.import_module(f'transit_ops.gold.{name}')
    """)
