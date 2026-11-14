from importlib import import_module as _import_module
from typing import TYPE_CHECKING as _TYPE_CHECKING

if _TYPE_CHECKING:
    from transit_ops.gold.alert_archive import (
        AlertArchiveSyncResult,
        alert_archive_default_bounds,
        sync_alert_archive,
    )
    from transit_ops.gold.marts import (
        GoldBuildResult,
        GoldRealtimeRefreshResult,
        GoldStaticRefreshResult,
        build_gold_marts,
        refresh_gold_static,
    )
    from transit_ops.gold.realtime import initialize_realtime_serving, refresh_gold_realtime
    from transit_ops.gold.rollups import (
        REBUILDABLE_KINDS,
        WarmRollupBuildResult,
        WarmRollupRebuildResult,
        build_warm_rollups,
        provider_is_seeded,
        rebuild_warm_rollups,
    )

__all__ = [
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
]


_MODULES = (
    "alert_archive delay_cohorts delay_days delay_hours delay_periods "
    "marts reader realtime rollups transactions"
).split()


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__) | set(_MODULES))


def __getattr__(name: str) -> object:
    if name in _MODULES:
        return _import_module(f"{__name__}.{name}")
    for owner, names in (
        ("alert_archive", "AlertArchiveSyncResult alert_archive_default_bounds sync_alert_archive"),
        (
            "marts",
            "GoldBuildResult GoldRealtimeRefreshResult GoldStaticRefreshResult "
            "build_gold_marts refresh_gold_static",
        ),
        ("realtime", "initialize_realtime_serving refresh_gold_realtime"),
        (
            "rollups",
            "REBUILDABLE_KINDS WarmRollupBuildResult WarmRollupRebuildResult "
            "build_warm_rollups provider_is_seeded rebuild_warm_rollups",
        ),
    ):
        if name in names.split():
            value: object = getattr(_import_module(f"{__name__}.{owner}"), name)
            return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
