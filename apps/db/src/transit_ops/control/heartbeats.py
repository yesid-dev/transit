"""Publication health records; publication content is fenced by the manifest."""

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta

from transit_ops.control.leases import Lease, LeaseLost, renew_lease
from transit_ops.control.objects import ConditionalObjects, ObjectConflict, key_part
from transit_ops.snapshots.serialization import snapshot_json_bytes


@dataclass(frozen=True)
class PublishHeartbeat:
    provider_id: str
    tier: str
    generated_utc: datetime
    files_written: int
    files_skipped: int
    files_total: int
    stable_files_total: int | None
    gate: Mapping[str, object] | None
    telemetry: Mapping[str, object] | None
    recorded_at_utc: datetime
    lease_epoch: int = 0  # Filled from the lease when writing; returned on reads.


class HeartbeatInvalid(ValueError):
    """A heartbeat cannot represent a publication row."""


def _stamp(value: object, name: str) -> str:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise HeartbeatInvalid(f"{name} must be timezone aware")
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def _encode(beat: PublishHeartbeat) -> dict[str, object]:
    payload = asdict(beat)
    for name in ("generated_utc", "recorded_at_utc"):
        payload[name] = _stamp(getattr(beat, name), name)
    for name in ("gate", "telemetry"):
        value = getattr(beat, name)
        if value is not None and not isinstance(value, Mapping):
            raise HeartbeatInvalid(f"{name} must be a mapping or None")
    if beat.gate is not None:
        gate = dict(beat.gate)
        if gate.get("gate_generated_utc") is not None:
            gate["gate_generated_utc"] = _stamp(gate["gate_generated_utc"], "gate_generated_utc")
        payload["gate"] = gate
    snapshot_json_bytes(payload)
    return payload


def _decode(body: bytes, provider_id: str, tier: str) -> PublishHeartbeat:
    try:
        data = json.loads(body)
        for name in ("generated_utc", "recorded_at_utc"):
            data[name] = datetime.fromisoformat(data[name])
        gate = data.get("gate")
        if gate is not None and gate.get("gate_generated_utc") is not None:
            gate["gate_generated_utc"] = datetime.fromisoformat(gate["gate_generated_utc"])
        beat = PublishHeartbeat(**data)
        if (beat.provider_id, beat.tier) != (provider_id, tier) or (
            not isinstance(beat.lease_epoch, int) or beat.lease_epoch < 1
        ):
            raise ValueError("identity or epoch")
        _encode(beat)
        return beat
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise HeartbeatInvalid("invalid heartbeat") from exc


def write_heartbeat(
    objects: ConditionalObjects,
    lease: Lease,
    beat: PublishHeartbeat,
    *,
    ttl: timedelta,
    clock: Callable[[], datetime],
) -> Lease:
    """Return renewed ownership after recording health with the caller's TTL.

    Between renewal and the separate heartbeat CAS, a pause past expiry can let
    a replaced holder write one last heartbeat if no higher epoch is stored yet.
    This health-data window is accepted; the manifest (LS3.2b) fences publication
    content. A heartbeat never replaces a higher stored epoch. One conflict gets
    one fresh read and one replacement attempt; another conflict is LeaseLost.
    """
    if (beat.provider_id, beat.tier) != (lease.provider_id, lease.lane):
        raise ValueError("heartbeat provider or tier differs from lease")
    payload = _encode(replace(beat, lease_epoch=lease.epoch))
    renewed = renew_lease(objects, lease, ttl=ttl, clock=clock)
    key = f"heartbeats/{key_part(beat.provider_id)}/{key_part(beat.tier)}.json"
    for attempt in range(2):
        try:
            prior = objects.read(key)
            if prior is not None and _decode(
                prior.body, beat.provider_id, beat.tier
            ).lease_epoch > (lease.epoch):
                raise LeaseLost("newer heartbeat epoch")
            objects.replace(key, payload, expected=None if prior is None else prior.token)
            return renewed
        except ObjectConflict as exc:
            if attempt:
                raise LeaseLost("heartbeat changed twice") from exc
    raise AssertionError("unreachable")


def read_heartbeat(
    objects: ConditionalObjects, *, provider_id: str, tier: str
) -> PublishHeartbeat | None:
    obj = objects.read(f"heartbeats/{key_part(provider_id)}/{key_part(tier)}.json")
    return None if obj is None else _decode(obj.body, provider_id, tier)
