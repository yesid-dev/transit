"""Publication health records; publication content is fenced by the manifest."""

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta

from transit_ops.control.leases import Lease, LeaseLost, read_lease, renew_lease
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
    for name in ("files_written", "files_skipped", "files_total", "stable_files_total"):
        value = getattr(beat, name)
        if value is None and name == "stable_files_total":
            continue
        if type(value) is not int or value < 0:
            raise HeartbeatInvalid(f"{name} must be a nonnegative integer")
    if type(beat.lease_epoch) is not int or beat.lease_epoch < 1:
        raise HeartbeatInvalid("lease_epoch must be a positive integer")
    payload = asdict(beat)
    for name in ("generated_utc", "recorded_at_utc"):
        payload[name] = _stamp(getattr(beat, name), name)
    for name in ("gate", "telemetry"):
        value = getattr(beat, name)
        if value is not None and not isinstance(value, Mapping):
            raise HeartbeatInvalid(f"{name} must be a mapping or None")
    if beat.gate is not None:
        gate = dict(beat.gate)
        for name in ("gate_checks_run", "gate_errors", "gate_warnings"):
            value = gate.get(name)
            if value is not None and (type(value) is not int or value < 0):
                raise HeartbeatInvalid(f"{name} must be a nonnegative integer or None")
        if gate.get("gate_verdict") is not None and type(gate["gate_verdict"]) is not str:
            raise HeartbeatInvalid("gate_verdict must be a string or None")
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
        if (beat.provider_id, beat.tier) != (provider_id, tier):
            raise ValueError("identity")
        _encode(beat)
        return beat
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise HeartbeatInvalid("invalid heartbeat") from exc


def verify_ownership(
    objects: ConditionalObjects, lease: Lease, *, clock: Callable[[], datetime]
) -> datetime:
    """Read-only check of the exact owned token, including time spent reading it."""
    current = read_lease(objects, provider_id=lease.provider_id, lane=lease.lane)
    now = clock()
    if now.utcoffset() is None:
        raise ValueError("lease clock must be timezone aware")
    now = now.astimezone(UTC)
    if current != lease or not lease.last_updated_utc <= now < lease.expires_at_utc:
        raise LeaseLost("lease changed, expired or clock moved backwards")
    return now


def _write_then_renew(
    objects: ConditionalObjects,
    lease: Lease,
    payload: Mapping[str, object],
    *,
    ttl: timedelta,
    clock: Callable[[], datetime],
) -> Lease:
    if not timedelta(seconds=30) <= ttl <= timedelta(hours=1):
        raise ValueError("TTL from 30 seconds to one hour required")
    last = lease.last_updated_utc.astimezone(UTC)

    def checked_clock() -> datetime:
        nonlocal last
        now = clock()
        if now.utcoffset() is None:
            raise ValueError("lease clock must be timezone aware")
        now = now.astimezone(UTC)
        if now < last:
            raise LeaseLost("clock moved backwards")
        last = now
        return now

    key = f"heartbeats/{key_part(lease.provider_id)}/{key_part(lease.lane)}.json"
    for attempt in range(2):
        verify_ownership(objects, lease, clock=checked_clock)
        try:
            prior = objects.read(key)
            if (
                prior is not None
                and _decode(prior.body, lease.provider_id, lease.lane).lease_epoch > lease.epoch
            ):
                raise LeaseLost("newer heartbeat epoch")
            verify_ownership(objects, lease, clock=checked_clock)
            objects.replace(key, payload, expected=None if prior is None else prior.token)
            verify_ownership(objects, lease, clock=checked_clock)
            renewed = renew_lease(objects, lease, ttl=ttl, clock=checked_clock)
            verify_ownership(objects, renewed, clock=checked_clock)
            return renewed
        except ObjectConflict as exc:
            if attempt:
                raise LeaseLost("heartbeat changed twice") from exc
    raise AssertionError("unreachable")


def write_heartbeat(
    objects: ConditionalObjects,
    lease: Lease,
    beat: PublishHeartbeat,
    *,
    ttl: timedelta,
    clock: Callable[[], datetime],
    renew_after_write: bool = False,
) -> Lease:
    """Return renewed ownership after recording health with the caller's TTL.

    Between renewal and the separate heartbeat CAS, a pause past expiry can let
    a replaced holder write one last heartbeat if no higher epoch is stored yet.
    This health-data window is accepted; the manifest (LS3.2b) fences publication
    content. A heartbeat never replaces a higher stored epoch. One conflict gets
    one fresh read and one replacement attempt; another conflict is LeaseLost.
    After any exception other than LeaseLost the lease may already be renewed;
    re-establish ownership with acquire_lease using the same holder before retrying.

    Explicit renew_after_write leaves ownership untouched on heartbeat write failure.
    The two objects are not atomic: a later renewal failure still raises, even if
    health was stored. Callers must not infer ownership from that health record.
    """
    if (beat.provider_id, beat.tier) != (lease.provider_id, lease.lane):
        raise ValueError("heartbeat provider or tier differs from lease")
    payload = _encode(replace(beat, lease_epoch=lease.epoch))
    if renew_after_write:
        return _write_then_renew(objects, lease, payload, ttl=ttl, clock=clock)
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
