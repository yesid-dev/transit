from dataclasses import asdict, replace
from datetime import timedelta

import pytest
from test_control_leases import NOW, TTL, acquire, control_objects  # noqa: F401

from transit_ops.control import heartbeats as m
from transit_ops.control.leases import LeaseLost, acquire_lease, read_lease, renew_lease
from transit_ops.control.objects import ObjectConflict

KEY = "heartbeats/network%3Aone/live.json"


def beat(**changes):
    return replace(
        m.PublishHeartbeat(
            provider_id="network:one",
            tier="live",
            generated_utc=NOW,
            files_written=2,
            files_skipped=3,
            files_total=5,
            stable_files_total=None,
            gate=None,
            telemetry=None,
            lease_epoch=1,
            recorded_at_utc=NOW,
        ),
        **changes,
    )


def write(objects, lease, value=None, now=NOW, ttl=TTL):
    return m.write_heartbeat(
        objects, lease, beat() if value is None else value, ttl=ttl, clock=lambda: now
    )


def seed(objects, epoch):
    value = asdict(beat(lease_epoch=epoch))
    for name in ("generated_utc", "recorded_at_utc"):
        value[name] = NOW.isoformat(timespec="microseconds")
    prior = objects.read(KEY)
    objects.replace(KEY, value, expected=None if prior is None else prior.token)


def test_consecutive_heartbeats_and_a_renew_by_the_holder_succeed(objects):
    lease = acquire(objects)
    for seconds in (30, 60, 90):
        now = NOW + timedelta(seconds=seconds)
        lease = write(objects, lease, now=now, ttl=timedelta(seconds=60))
        assert lease.expires_at_utc == now + timedelta(seconds=60)
    assert renew_lease(objects, lease, ttl=TTL, clock=lambda: now).epoch == 1


@pytest.mark.parametrize("nulls", [False, True])
def test_full_publication_row_round_trips_and_preserves_nulls(objects, nulls):
    gate = dict(
        gate_checks_run=12,
        gate_errors=0,
        gate_warnings=2,
        gate_verdict="warn",
        gate_generated_utc=NOW,
    )
    telemetry = dict(
        historic_files_reused=1,
        historic_scopes_reused=2,
        historic_scopes_rebuilt=3,
        historic_source_digest_ms=1.5,
        historic_build_ms=2.5,
        historic_gate_ms=3.5,
        historic_upload_ms=4.5,
        historic_parent_compose_ms=5.5,
        historic_compatibility_ms=6.5,
        historic_receipt_persist_ms=7.5,
        historic_receipt_rows_attempted=2,
        historic_receipt_rows_changed=1,
        historic_phase_detail={"build_ms": 2.5},
    )
    if nulls:
        gate, telemetry = dict.fromkeys(gate), dict.fromkeys(telemetry)
    value = beat(
        tier="historic",
        gate=gate,
        telemetry=telemetry,
        stable_files_total=None if nulls else 4,
        files_total=5 if nulls else 6,
    )
    lease = acquire_lease(
        objects, provider_id="network:one", lane="historic", holder="a", ttl=TTL, clock=lambda: NOW
    )
    write(objects, lease, value)
    assert m.read_heartbeat(objects, provider_id="network:one", tier="historic") == value


@pytest.mark.parametrize(
    "field", ["generated_utc", "recorded_at_utc", "gate_generated_utc", "unencodable"]
)
def test_invalid_payload_is_refused_before_renewal(objects, field):
    lease = acquire(objects)
    if field == "unencodable":
        value = beat(telemetry={"bad": object()})
    elif field == "gate_generated_utc":
        value = beat(gate={field: NOW.replace(tzinfo=None)})
    else:
        value = beat(**{field: NOW.replace(tzinfo=None)})
    with pytest.raises((ValueError, TypeError)) as error:
        write(objects, lease, value, now=NOW + timedelta(seconds=1))
    if field != "unencodable":
        assert field in str(error.value)
    assert read_lease(objects, provider_id="network:one", lane="live") == lease
    assert objects.read(KEY) is None


@pytest.mark.parametrize("field,value", [("provider_id", "other"), ("tier", "static")])
def test_caller_mismatch_is_a_value_error_without_writes(objects, field, value):
    lease = acquire(objects)
    with pytest.raises(ValueError):
        write(objects, lease, beat(**{field: value}))
    assert read_lease(objects, provider_id="network:one", lane="live") == lease


def test_epoch_is_taken_from_the_lease(objects):
    lease = acquire(objects)
    write(objects, lease, beat(lease_epoch=99))
    assert m.read_heartbeat(objects, provider_id="network:one", tier="live").lease_epoch == 1


@pytest.mark.parametrize("operation", ["read", "replace"])
@pytest.mark.parametrize("epoch", [1, 2, 3])
def test_conflicts_recover_once_unless_a_newer_epoch_exists(objects, monkeypatch, operation, epoch):
    acquire(objects, now=NOW - TTL)
    lease = acquire(objects, "b")
    original = getattr(objects, operation)

    def conflict(key, *args, **kwargs):
        if key == KEY:
            monkeypatch.setattr(objects, operation, original)
            seed(objects, epoch)
            raise ObjectConflict("interleaved heartbeat")
        return original(key, *args, **kwargs)

    monkeypatch.setattr(objects, operation, conflict)
    if epoch > lease.epoch:
        with pytest.raises(LeaseLost):
            write(objects, lease)
        assert m.read_heartbeat(objects, provider_id="network:one", tier="live").lease_epoch == 3
    else:
        assert write(objects, lease).epoch == 2
        assert m.read_heartbeat(objects, provider_id="network:one", tier="live") == beat(
            lease_epoch=2
        )


def test_second_conflict_is_terminal(objects, monkeypatch):
    lease, original, attempts = acquire(objects), objects.replace, []

    def conflict(key, *args, **kwargs):
        if key == KEY:
            attempts.append(key)
            raise ObjectConflict("busy")
        return original(key, *args, **kwargs)

    monkeypatch.setattr(objects, "replace", conflict)
    with pytest.raises(LeaseLost):
        write(objects, lease)
    assert attempts == [KEY, KEY]


def test_stale_token_heartbeat_cannot_adopt_another_renewal(objects):
    stale = acquire(objects)
    renew_lease(objects, stale, ttl=TTL, clock=lambda: NOW + timedelta(seconds=30))
    with pytest.raises(LeaseLost):
        write(objects, stale, now=NOW + timedelta(seconds=30))
    assert objects.read(KEY) is None


def test_lost_lease_cannot_write_over_a_newer_heartbeat(objects):
    stale = acquire(objects)
    winner = acquire(objects, "b", NOW + TTL)
    write(objects, winner, now=NOW + TTL)
    prior = objects.read(KEY)
    with pytest.raises(LeaseLost):
        write(objects, stale, now=NOW + TTL)
    assert objects.read(KEY) == prior


def test_one_last_health_heartbeat_can_land_after_takeover(objects, monkeypatch):
    lease, read = acquire(objects), objects.read

    def takeover(key):
        if key == KEY:
            monkeypatch.setattr(objects, "read", read)
            acquire(objects, "b", NOW + TTL * 2)
        return read(key)

    monkeypatch.setattr(objects, "read", takeover)
    write(objects, lease)
    assert read_lease(objects, provider_id="network:one", lane="live").epoch == 2
    assert m.read_heartbeat(objects, provider_id="network:one", tier="live").lease_epoch == 1


@pytest.mark.parametrize("value", [{}, {"lease_epoch": "bad"}])
def test_corrupt_heartbeat_raises_a_named_error(objects, value):
    objects.replace(KEY, value, expected=None)
    with pytest.raises(ValueError, match="invalid heartbeat"):
        m.read_heartbeat(objects, provider_id="network:one", tier="live")
