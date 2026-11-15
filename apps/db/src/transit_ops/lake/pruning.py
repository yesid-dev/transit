"""Avoid copying windows which an active age-based pruner may already be deleting."""

from collections.abc import Callable
from datetime import UTC, datetime, time, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from transit_ops.lake.migration import PlannedWindow

from transit_ops.history.datasets import TableSource, get_dataset, window_start
from transit_ops.lake.table_export import WindowSpec
from transit_ops.maintenance.bronze import RAW_BRONZE_METADATA_TABLES
from transit_ops.maintenance.gold import GOLD_FACT_TABLES
from transit_ops.maintenance.i3 import MIN_SILVER_I3_CLOSED_RETENTION_DAYS
from transit_ops.maintenance.silver import REALTIME_SILVER_TABLES
from transit_ops.settings import Settings

# Runs and snapshots last minutes; a skew this large means a broken registration.
PRUNER_CLOCK_SKEW_MARGIN = timedelta(days=30)


def retention_days(dataset: str, settings: Settings) -> int | None:
    if dataset in GOLD_FACT_TABLES:
        days = settings.GOLD_FACT_RETENTION_DAYS
    elif dataset == "raw.realtime_snapshot_index":
        days = settings.BRONZE_REALTIME_RETENTION_DAYS
    elif dataset in RAW_BRONZE_METADATA_TABLES:
        # These parents are deleted by realtime, static and I3 pruning.
        enabled = [
            d
            for d in (
                settings.BRONZE_REALTIME_RETENTION_DAYS,
                settings.BRONZE_STATIC_RETENTION_DAYS,
                settings.BRONZE_I3_RETENTION_DAYS,
            )
            if d > 0
        ]
        return min(enabled) if enabled else None
    elif dataset == "raw.i3_alert_snapshots":
        days = settings.BRONZE_I3_RETENTION_DAYS
    elif dataset in REALTIME_SILVER_TABLES:
        days = settings.SILVER_REALTIME_RETENTION_DAYS
    elif dataset in ("silver.i3_alerts", "silver.i3_alert_informed_entities"):
        days = settings.SILVER_I3_CLOSED_RETENTION_DAYS
        days = max(days, MIN_SILVER_I3_CLOSED_RETENTION_DAYS) if days > 0 else 0
    else:
        # Warm rollup age pruning is a no-op. Edition retention is count-based.
        return None
    return days if days > 0 else None


def window_in_pruning(spec: WindowSpec, now: datetime, settings: Settings) -> bool:
    dataset = get_dataset(spec.dataset_id)
    source = dataset.source
    if not isinstance(source, TableSource) or source.window_column is None:
        return False  # Whole-state month labels are not data interval bounds.
    days = retention_days(spec.dataset_id, settings)
    first = window_start(dataset, spec.window_key)
    margin = (
        PRUNER_CLOCK_SKEW_MARGIN if spec.dataset_id in RAW_BRONZE_METADATA_TABLES else timedelta(0)
    )
    return (
        days is not None
        and first is not None
        and datetime.combine(first, time(), UTC)
        < now - timedelta(days=days) + timedelta(days=1) + margin
    )


def record_pruning_skip(
    window: "PlannedWindow",
    now: datetime,
    settings: Settings,
    outcomes: dict[str, dict[str, int]],
    record: dict[str, object],
    log: Callable[[dict[str, object]], None],
) -> bool:
    if window.archive_copy is not None:
        return False
    spec = window.spec
    if window.skip_reason != "window_in_pruning" and not window_in_pruning(spec, now, settings):
        return False
    record.update(outcome="skipped", reason="window_in_pruning", seconds=0.0)
    log(record)
    counts = outcomes.setdefault(get_dataset(spec.dataset_id).archive_grain, {})
    counts["skipped"] = counts.get("skipped", 0) + 1
    return True
