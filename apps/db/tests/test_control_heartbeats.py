from dataclasses import replace

import pytest
from test_control_leases import NOW, TTL, acquire, control_objects  # noqa: F401

from transit_ops.control import heartbeats as m
from transit_ops.control.leases import LeaseLost, read_lease


@pytest.mark.parametrize("gate", [None, {"gate_verdict": "warn", "gate_warnings": 2}])
def test_heartbeat_round_trips_every_field_and_a_missing_gate_stays_none(objects, gate):
    lease = acquire(objects)
    beat = m.PublishHeartbeat(
        "network:one", "live", NOW, 2, 3, 5, 4, gate, {"phase": "complete"}, 1, NOW
    )
    m.write_heartbeat(objects, lease, beat, clock=lambda: NOW)
    assert m.read_heartbeat(objects, provider_id="network:one", tier="live") == beat


def test_stale_publisher_cannot_overwrite_a_newer_epochs_heartbeat(objects):
    stale = acquire(objects)
    winner = acquire(objects, "b", NOW + TTL)
    beat = m.PublishHeartbeat("network:one", "live", NOW, 1, 0, 1, 1, None, None, 2, NOW)
    m.write_heartbeat(objects, winner, beat, clock=lambda: NOW + TTL)
    with pytest.raises(LeaseLost):
        m.write_heartbeat(objects, stale, replace(beat, lease_epoch=1), clock=lambda: NOW + TTL)
    assert m.read_heartbeat(objects, provider_id="network:one", tier="live") == beat


def test_heartbeat_write_renews_the_lease_first(objects):
    lease = acquire(objects)
    beat = m.PublishHeartbeat("network:one", "live", NOW, 1, 0, 1, 1, None, None, 1, NOW)
    m.write_heartbeat(objects, lease, beat, clock=lambda: NOW + TTL / 2)
    assert read_lease(objects, provider_id="network:one", lane="live").expires_at_utc > NOW + TTL
    acquire(objects, "b", NOW + TTL * 2)
    with pytest.raises(LeaseLost):
        m.write_heartbeat(objects, lease, beat, clock=lambda: NOW + TTL * 2)
    assert m.read_heartbeat(objects, provider_id="network:one", tier="live") == beat


def test_lost_lease_writes_no_heartbeat(objects):
    stale = acquire(objects)
    acquire(objects, "b", NOW + TTL)
    beat = m.PublishHeartbeat("network:one", "live", NOW, 1, 0, 1, 1, None, None, 1, NOW)
    with pytest.raises(LeaseLost):
        m.write_heartbeat(objects, stale, beat, clock=lambda: NOW + TTL)
    assert m.read_heartbeat(objects, provider_id="network:one", tier="live") is None


def test_lower_heartbeat_epoch_is_refused_even_with_a_live_lease(objects):
    lease = acquire(objects)
    objects.replace("heartbeats/network%3Aone/live.json", {"lease_epoch": 2}, expected=None)
    prior = objects.read("heartbeats/network%3Aone/live.json")
    beat = m.PublishHeartbeat("network:one", "live", NOW, 1, 0, 1, 1, None, None, 1, NOW)
    with pytest.raises(LeaseLost):
        m.write_heartbeat(objects, lease, beat, clock=lambda: NOW)
    assert objects.read("heartbeats/network%3Aone/live.json") == prior
