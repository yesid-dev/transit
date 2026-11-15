from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from unittest.mock import patch

from transit_ops.gold.realtime import initialize_realtime_serving, refresh_gold_realtime
from transit_ops.ingestion.common import project_root
from transit_ops.ingestion.storage import BronzeStorageResolver
from transit_ops.live.oracle.database import OracleDatabase, PinnedClock, oracle_database
from transit_ops.live.oracle.seed import admit_polls, seed_static
from transit_ops.live.oracle.sink import RecordingSink
from transit_ops.live.oracle.window import CycleSpec, ReplayWindow
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings
from transit_ops.silver.realtime_gtfs import (
    RealtimeSilverLoadResult,
    find_realtime_bronze_snapshots,
    load_realtime_snapshot_to_silver,
    manifest_provider_bounds,
)
from transit_ops.snapshots import publish


@dataclass(frozen=True)
class CycleOutcome:
    generated_utc: datetime
    written: tuple[tuple[str, bytes], ...]
    public: Mapping[str, bytes]


class ReplayFailed(RuntimeError):
    def __init__(self, generated_utc: datetime) -> None:
        self.generated_utc = generated_utc
        super().__init__(f"Live oracle cycle {generated_utc.isoformat()} failed")


def _load_capture(
    oracle: OracleDatabase,
    window: ReplayWindow,
    capture_id: int,
    settings: Settings,
    registry: ProviderRegistry,
    bronze: BronzeStorageResolver,
) -> RealtimeSilverLoadResult:
    record, capture = window.capture("realtime_snapshot", capture_id)
    manifest = registry.get_provider(window.provider_id)
    with oracle.engine.begin() as connection:
        snapshots = find_realtime_bronze_snapshots(
            connection,
            provider_id=window.provider_id,
            start_utc=capture.captured_at_utc,
            end_utc=capture.captured_at_utc + timedelta(microseconds=1),
            settings=settings,
            project_root=project_root(),
            bronze_storage_resolver=bronze,
        )
        snapshot = next(
            (
                s
                for s in snapshots
                if s.realtime_snapshot_id == capture_id
                and s.endpoint_key == record.feed_day.endpoint_key
            ),
            None,
        )
        if snapshot is None:
            raise ValueError(f"Recorded realtime capture {capture_id} is not admitted")
        return load_realtime_snapshot_to_silver(
            connection,
            snapshot=snapshot,
            bronze_storage=bronze(snapshot.storage_backend),
            provider_bounds=manifest_provider_bounds(manifest),
            max_vehicle_speed_kmh=manifest.provider.max_vehicle_speed_kmh,
        )


def _apply_cycle(
    oracle: OracleDatabase,
    window: ReplayWindow,
    cycle: CycleSpec,
    settings: Settings,
    registry: ProviderRegistry,
    bronze: BronzeStorageResolver,
) -> None:
    receipts = []
    for family, capture_id in cycle.captures:
        if family == "alert_snapshot":
            raise NotImplementedError("Alert capture replay requires OR3b")
        receipts.append(_load_capture(oracle, window, capture_id, settings, registry, bronze))
    initialize_realtime_serving(
        window.provider_id,
        [r.endpoint_key for r in receipts],
        settings=settings,
        engine=oracle.engine,
    )
    if receipts:
        refresh_gold_realtime(
            window.provider_id,
            snapshots=receipts,
            settings=settings,
            registry=registry,
            engine=oracle.engine,
        )


def replay_window(
    window: ReplayWindow,
    *,
    admin_url: str,
    environment: Mapping[str, str],
    settings: Settings,
    registry: ProviderRegistry,
    bronze: BronzeStorageResolver,
    prior_manifest: bytes | None = None,
    keep_database: bool = False,
) -> Iterator[CycleOutcome]:
    clock = PinnedClock(window.serving_initialized_at_utc)
    sink = RecordingSink({"manifest.json": prior_manifest} if prior_manifest is not None else {})
    sequential = settings.model_copy(update={"SNAPSHOT_PUBLISH_CONCURRENCY": 1})
    with oracle_database(
        admin_url, clock=clock, environment=environment, keep=keep_database
    ) as oracle:
        seed_static(oracle, window, settings=settings, registry=registry, bronze=bronze)
        for cycle in window.cycles:
            try:
                clock.set(cycle.generated_utc)
                admit_polls(oracle, window, until_utc=clock.instant, bronze=bronze)
                _apply_cycle(oracle, window, cycle, settings, registry, bronze)
                with patch.object(publish, "utc_now", return_value=clock.instant):
                    publish.publish_snapshot(
                        window.provider_id,
                        tier="live",
                        settings=sequential,
                        registry=registry,
                        engine=oracle.engine,
                        storage=sink,
                    )
                written = tuple((key, sink.objects[key]) for key in sink.take_written())
                outcome = CycleOutcome(clock.instant, written, dict(sink.objects))
            except Exception as exc:
                raise ReplayFailed(cycle.generated_utc) from exc
            yield outcome
