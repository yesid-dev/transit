"""Publication records fenced by publisher ownership."""

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta

from transit_ops.control.leases import Lease, LeaseLost, renew_lease
from transit_ops.control.objects import ConditionalObjects, ObjectConflict, key_part


@dataclass(frozen=True)
class PublishHeartbeat:
    provider_id: str
    tier: str
    generated_utc: datetime
    files_written: int
    files_skipped: int
    files_total: int
    stable_files_total: int
    gate: Mapping[str, object] | None
    telemetry: Mapping[str, object] | None
    lease_epoch: int
    recorded_at_utc: datetime


def write_heartbeat(
    objects: ConditionalObjects,
    lease: Lease,
    beat: PublishHeartbeat,
    *,
    clock: Callable[[], datetime],
) -> None:
    if (beat.provider_id, beat.tier, beat.lease_epoch) != (
        lease.provider_id,
        lease.lane,
        lease.epoch,
    ):
        raise LeaseLost("heartbeat does not belong to lease")
    renew_lease(
        objects,
        lease,
        ttl=min(lease.expires_at_utc - lease.acquired_at_utc, timedelta(hours=1)),
        clock=clock,
    )
    key = f"heartbeats/{key_part(beat.provider_id)}/{key_part(beat.tier)}.json"
    prior = objects.read(key)
    if prior is not None and json.loads(prior.body)["lease_epoch"] > beat.lease_epoch:
        raise LeaseLost("newer heartbeat epoch")
    payload = asdict(beat)
    for name in ("generated_utc", "recorded_at_utc"):
        payload[name] = getattr(beat, name).astimezone(UTC).isoformat(timespec="microseconds")
    try:
        objects.replace(key, payload, expected=None if prior is None else prior.token)
    except ObjectConflict as exc:
        raise LeaseLost("heartbeat changed") from exc


def read_heartbeat(
    objects: ConditionalObjects, *, provider_id: str, tier: str
) -> PublishHeartbeat | None:
    obj = objects.read(f"heartbeats/{key_part(provider_id)}/{key_part(tier)}.json")
    if obj is None:
        return None
    data = json.loads(obj.body)
    for name in ("generated_utc", "recorded_at_utc"):
        data[name] = datetime.fromisoformat(data[name])
    return PublishHeartbeat(**data)
