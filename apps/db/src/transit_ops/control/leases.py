"""Conditional publisher ownership. Each process must use a unique holder id."""

import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Final
from uuid import uuid4

from transit_ops.control.objects import ConditionalObjects, ObjectConflict, key_part

LANES: Final = frozenset({"live", "static", "historic", "historic-gc"})


@dataclass(frozen=True)
class Lease:
    provider_id: str
    lane: str
    holder: str
    epoch: int
    acquired_at_utc: datetime
    expires_at_utc: datetime
    token: str
    last_updated_utc: datetime
    mutation_id: str


class LeaseHeld(RuntimeError):
    """Another holder owns the live lease."""


class LeaseLost(RuntimeError):
    """Ownership changed; publishing must stop."""


class LeaseInvalid(ValueError):
    """The stored lease is corrupt."""


def _now(clock: Callable[[], datetime]) -> datetime:
    now = clock()
    if now.utcoffset() is None:
        raise ValueError("lease clock must be timezone aware")
    return now.astimezone(UTC)


def _key(provider_id: str, lane: str) -> str:
    if lane not in LANES:
        raise ValueError("unknown publication lane")
    return f"leases/{key_part(provider_id)}/{lane}.json"


def read_lease(objects: ConditionalObjects, *, provider_id: str, lane: str) -> Lease | None:
    obj = objects.read(_key(provider_id, lane))
    if obj is None:
        return None
    try:
        data = json.loads(obj.body)
        for name in ("acquired_at_utc", "expires_at_utc", "last_updated_utc"):
            stamp = datetime.fromisoformat(data[name])
            if stamp.utcoffset() is None:
                raise ValueError("naive lease timestamp")
            data[name] = stamp.astimezone(UTC)
        result = Lease(**data, token=obj.token)
        if (result.provider_id, result.lane) != (provider_id, lane) or (
            not isinstance(result.epoch, int)
            or result.epoch < 1
            or not result.holder.strip()
            or not result.mutation_id
            or result.acquired_at_utc > result.last_updated_utc
            or result.last_updated_utc > result.expires_at_utc
        ):
            raise ValueError("invalid fields")
        return result
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise LeaseInvalid("invalid lease") from exc


def _write(
    objects: ConditionalObjects,
    lease: Lease,
    expected: str | None,
    clock: Callable[[], datetime],
    *,
    active: bool = True,
) -> Lease:
    lease = replace(lease, mutation_id=str(uuid4()))
    payload = asdict(lease)
    del payload["token"]
    for name in ("acquired_at_utc", "expires_at_utc", "last_updated_utc"):
        payload[name] = getattr(lease, name).astimezone(UTC).isoformat(timespec="microseconds")
    try:
        objects.replace(_key(lease.provider_id, lease.lane), payload, expected=expected)
        stored = read_lease(objects, provider_id=lease.provider_id, lane=lease.lane)
    except ObjectConflict as exc:
        raise LeaseLost("lease changed") from exc
    if stored is None or replace(stored, token=lease.token) != lease:
        raise LeaseLost("lease changed after write")
    if active and _now(clock) >= stored.expires_at_utc:
        raise LeaseLost("lease expired during write")
    return stored


def acquire_lease(
    objects: ConditionalObjects,
    *,
    provider_id: str,
    lane: str,
    holder: str,
    ttl: timedelta,
    clock: Callable[[], datetime],
) -> Lease:
    if not holder.strip() or not timedelta(seconds=30) <= ttl <= timedelta(hours=1):
        raise ValueError("nonblank holder and TTL from 30 seconds to one hour required")
    now = _now(clock)
    prior = read_lease(objects, provider_id=provider_id, lane=lane)
    if prior is not None and now < prior.expires_at_utc:
        if prior.holder != holder:
            raise LeaseHeld(prior.holder)
        return renew_lease(objects, prior, ttl=ttl, clock=clock)
    lease = Lease(
        provider_id,
        lane,
        holder,
        1 if prior is None else prior.epoch + 1,
        now,
        now + ttl,
        "",
        now,
        "",
    )
    return _write(objects, lease, None if prior is None else prior.token, clock)


def renew_lease(
    objects: ConditionalObjects, lease: Lease, *, ttl: timedelta, clock: Callable[[], datetime]
) -> Lease:
    if not timedelta(seconds=30) <= ttl <= timedelta(hours=1):
        raise ValueError("TTL from 30 seconds to one hour required")
    now = _now(clock)
    if now < lease.last_updated_utc or now >= lease.expires_at_utc:
        raise LeaseLost("lease expired or clock moved backwards")
    return _write(
        objects, replace(lease, expires_at_utc=now + ttl, last_updated_utc=now), lease.token, clock
    )


def release_lease(
    objects: ConditionalObjects, lease: Lease, *, clock: Callable[[], datetime]
) -> None:
    now = _now(clock)
    if now < lease.last_updated_utc:
        raise LeaseLost("clock precedes last update")
    _write(
        objects,
        replace(lease, expires_at_utc=now, last_updated_utc=now),
        lease.token,
        clock,
        active=False,
    )
