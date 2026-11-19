"""Unwired local publication into an explicitly injected, isolated shadow target.

The caller owns context capture, borrowed state, private control objects and the
stable holder identity. No settings, resources or production adapters are selected.
Manifest fencing is a final read immediately before IO, not a cross-object transaction.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from pydantic import BaseModel

from transit_ops.control.heartbeats import PublishHeartbeat, verify_ownership, write_heartbeat
from transit_ops.control.leases import Lease, LeaseLost, acquire_lease, read_lease
from transit_ops.control.objects import ConditionalObjects
from transit_ops.settings import Settings
from transit_ops.snapshots import gate, uploads
from transit_ops.snapshots.contract import (
    AlertsFile,
    DataHealth,
    Manifest,
    NetworkFile,
    StopDeparturesFile,
    TripsFile,
    VehiclesFile,
)
from transit_ops.snapshots.protocols import PutItem, SnapshotObjectStore, SnapshotPayload
from transit_ops.snapshots.publish import (
    LiveBuildSource,
    PublishResult,
    build_live_from_source,
    live_cycle_stamp,
)
from transit_ops.snapshots.serialization import snapshot_json_bytes

if TYPE_CHECKING:
    from transit_ops.live.local_file import LocalFile
    from transit_ops.live.publication_context import PublicationContext
    from transit_ops.live.running import ScheduleInputs, TripHolder

logger = logging.getLogger(__name__)
TTL = timedelta(seconds=90)
_MODELS: dict[str, type[BaseModel]] = {
    "live/vehicles.json": VehiclesFile,
    "live/trips.json": TripsFile,
    "live/alerts.json": AlertsFile,
    "live/network.json": NetworkFile,
    "live/stop_departures.json": StopDeparturesFile,
    "status/data_health.json": DataHealth,
    "manifest.json": Manifest,
}


@dataclass(frozen=True)
class LocalBuildSource:
    local: LocalFile
    holder: TripHolder
    inputs: ScheduleInputs
    context: PublicationContext

    def __call__(self, cycle: datetime) -> tuple[list[PutItem], dict[str, str | None]]:
        from transit_ops.live.builders_status import _serving_record, build_bundle
        from transit_ops.live.publication_context import aware, event
        from transit_ops.snapshots.builders._helpers import _iso

        if aware(cycle, "cycle") != aware(self.context.cycle, "context cycle"):
            raise ValueError("publication context cycle differs")
        bundle = build_bundle(self.local, self.holder, self.inputs, self.context)
        normalized = {
            key if "/" in key or key == "manifest.json" else f"live/{key}": body
            for key, body in bundle.items()
        }
        if normalized.keys() != _MODELS.keys():
            raise ValueError("local builder requires the complete seven-file bundle")
        items: list[PutItem] = [
            (key, model.model_validate_json(normalized[key]), "live")
            for key, model in _MODELS.items()
        ]
        captures = {
            endpoint: json.loads(normalized[key])["feed_captured_utc"]
            for endpoint, key in (
                ("trip_updates", "live/trips.json"),
                ("i3_alerts", "live/alerts.json"),
            )
        }
        vehicle = _serving_record(self.local, "vehicle_positions", cycle)
        captures["vehicle_positions"] = _iso(vehicle[1]) if vehicle is not None else None
        editions = [
            event(row["loaded_at_utc"], cycle, "edition loaded_at_utc")
            for row in self.context.rows("editions")
        ]
        latest = max((stamp for stamp in editions if stamp is not None), default=None)
        captures["static_schedule"] = _iso(latest) if latest is not None else None
        return items, captures


@dataclass(frozen=True)
class ShadowTarget:
    """Only fixed shadow-relative keys reach the injected object store."""

    provider_id: str
    store: SnapshotObjectStore
    lane: str = "live"

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", self.provider_id) or self.lane != "live":
            raise ValueError("invalid shadow provider/lane")

    def key(self, rel_key: str) -> str:
        if rel_key not in _MODELS:
            raise ValueError("unknown shadow publication key")
        return f"_shadow/v1/{self.provider_id}/{self.lane}/{rel_key}"

    def prior_manifest(self) -> object:
        return self.store.get_json(self.key("manifest.json"))

    def put_json(self, rel_key: str, payload: SnapshotPayload, *, tier: str) -> str:
        if tier != self.lane or rel_key == "manifest.json":
            raise ValueError("manifest requires final fencing; tier must match target")
        return self.store.put_bytes(self.key(rel_key), snapshot_json_bytes(payload), tier=tier)

    def publish_manifest(
        self,
        payload: SnapshotPayload,
        *,
        objects: ConditionalObjects,
        lease: Lease,
        clock: Callable[[], datetime],
    ) -> str:
        if (lease.provider_id, lease.lane) != (self.provider_id, self.lane):
            raise ValueError("manifest target differs from lease")
        body = snapshot_json_bytes(payload)
        key = self.key("manifest.json")
        verify_ownership(objects, lease, clock=clock)
        return self.store.put_bytes(key, body, tier=self.lane)


@dataclass(frozen=True)
class LocalPublishResult:
    publication: PublishResult
    lease: Lease


class LocalPublisher:
    def __init__(
        self,
        target: ShadowTarget,
        objects: ConditionalObjects,
        *,
        holder: str,
        clock: Callable[[], datetime],
    ) -> None:
        if not holder.strip():
            raise ValueError("stable nonblank holder required")
        self.target, self.objects, self.holder, self.clock = target, objects, holder, clock
        self.lease: Lease | None = None
        self._last_clock: datetime | None = None

    def _clock(self) -> datetime:
        now = self.clock()
        live_cycle_stamp(now)
        now = now.astimezone(UTC)
        if self._last_clock is not None and now < self._last_clock:
            raise LeaseLost("publication ownership clock moved backwards")
        self._last_clock = now
        return now

    def _ownership(self) -> Lease:
        target = self.target
        if self.lease is None:
            prior = read_lease(self.objects, provider_id=target.provider_id, lane=target.lane)
            if prior is not None and prior.holder == self.holder:
                # Verification/retry must never renew through acquire_lease.
                self.lease = prior
            else:
                self.lease = acquire_lease(
                    self.objects,
                    provider_id=target.provider_id,
                    lane=target.lane,
                    holder=self.holder,
                    ttl=TTL,
                    clock=self._clock,
                )
        if (self.lease.provider_id, self.lease.lane, self.lease.holder) != (
            target.provider_id,
            target.lane,
            self.holder,
        ):
            raise ValueError("owned lease differs from publication target/holder")
        verify_ownership(self.objects, self.lease, clock=self._clock)
        return self.lease

    def publish(
        self,
        source: LiveBuildSource,
        *,
        provider_id: str,
        cycle: datetime,
        settings: Settings,
        object_batch_size: int = 6,
        gate_enabled: bool = True,
    ) -> LocalPublishResult:
        gen = live_cycle_stamp(cycle)
        if provider_id != self.target.provider_id or object_batch_size < 1:
            raise ValueError("publication target/provider or batch size differs")
        lease = self._ownership()
        items = build_live_from_source(
            source, provider_id=provider_id, cycle=cycle, prior=self.target.prior_manifest()
        )
        report = _gate(items, provider_id, gen) if gate_enabled else None
        written = self._upload(items, settings, object_batch_size, lease)
        beat = _heartbeat(provider_id, cycle, len(written), report, self._clock())
        self.lease = write_heartbeat(
            self.objects,
            lease,
            beat,
            ttl=TTL,
            clock=self._clock,
            renew_after_write=True,
        )
        return LocalPublishResult(
            PublishResult(
                provider_id,
                "live",
                keys_written=written,
                gate_report=report.to_dict() if report else None,
            ),
            self.lease,
        )

    def _upload(
        self,
        items: list[PutItem],
        settings: Settings,
        object_batch_size: int,
        lease: Lease,
    ) -> list[str]:
        written: list[str] = []
        objects = items[:-1]
        for start in range(0, len(objects), object_batch_size):
            written.extend(
                uploads.put_batch(
                    self.target,
                    objects[start : start + object_batch_size],
                    concurrency=uploads.concurrency(settings),
                )
            )
        written.append(
            self.target.publish_manifest(
                items[-1][1],
                objects=self.objects,
                lease=lease,
                clock=self._clock,
            )
        )
        return written


def _heartbeat(
    provider_id: str,
    cycle: datetime,
    written: int,
    report: gate.GateReport | None,
    now: datetime,
) -> PublishHeartbeat:
    summary: dict[str, object] | None = None
    if report is not None:
        summary = {
            "gate_checks_run": report.checks_run,
            "gate_errors": len(report.errors),
            "gate_warnings": len(report.warnings),
            "gate_verdict": "fail" if report.errors else "warn" if report.warnings else "pass",
            "gate_generated_utc": datetime.fromisoformat(report.generated_utc),
        }
    return PublishHeartbeat(
        provider_id, "live", cycle, written, 7 - written, 7, 7, summary, None, now
    )


def _gate(items: list[PutItem], provider_id: str, gen: str) -> gate.GateReport:
    report = gate.new_report(provider_id, "live", gen)
    for key, payload, _ in items:
        try:
            gate.record(report, key, payload)
        except Exception:  # noqa: BLE001 - same live gate policy as PG
            logger.exception("live gate check crashed for %s (cycle continues)", key)
    return report
