from datetime import UTC, datetime, timedelta

import pytest
from botocore.exceptions import ClientError
from test_snapshots_storage import _StableCasClient

from transit_ops.control import leases as m
from transit_ops.control.objects import SnapshotConditionalObjects
from transit_ops.snapshots.storage import LocalSnapshotStorage, SnapshotStorage

NOW = datetime(2026, 1, 1, microsecond=123456, tzinfo=UTC)
TTL = timedelta(seconds=90)


class LeaseClient(_StableCasClient):
    def head_object(self, **kw):
        return {**super().head_object(**kw), "LastModified": NOW}

    def get_object(self, **kw):
        metadata = self.head_object(**kw)
        if kw.get("IfMatch", metadata["ETag"]) != metadata["ETag"]:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "GetObject")
        return {**super().get_object(**kw), **metadata}


@pytest.fixture(name="objects", params=[False, True])
def control_objects(request, tmp_path):
    store = (
        SnapshotStorage(LeaseClient(), bucket="private", base_prefix="control/v1")
        if request.param
        else LocalSnapshotStorage(str(tmp_path), "control/v1")
    )
    return SnapshotConditionalObjects(store, min_interval_s=0)


def acquire(objects, holder="a", now=NOW):
    return m.acquire_lease(
        objects, provider_id="network:one", lane="live", holder=holder, ttl=TTL, clock=lambda: now
    )


def test_first_acquire_creates_epoch_one(objects):
    lease = acquire(objects)
    assert (lease.epoch, lease.acquired_at_utc, lease.expires_at_utc) == (1, NOW, NOW + TTL)
    assert m.read_lease(objects, provider_id="network:one", lane="live") == lease
    assert objects.read("leases/network%3Aone/live.json") is not None


def test_second_holder_is_refused_while_the_lease_is_live(objects):
    acquire(objects)
    with pytest.raises(m.LeaseHeld):
        acquire(objects, "b")
    assert acquire(objects, now=NOW + timedelta(seconds=1)).epoch == 1


def test_expired_lease_is_taken_over_with_the_next_epoch(objects):
    first = acquire(objects)
    winner = acquire(objects, "b", NOW + TTL)
    assert (winner.holder, winner.epoch) == ("b", 2)
    with pytest.raises(m.LeaseLost):
        m.renew_lease(objects, first, ttl=TTL, clock=lambda: NOW + TTL)
    with pytest.raises(m.LeaseLost):
        m.release_lease(objects, first, clock=lambda: NOW + TTL)
    assert m.read_lease(objects, provider_id="network:one", lane="live") == winner


def test_two_holders_racing_for_an_expired_lease_one_wins(objects, monkeypatch):
    acquire(objects)
    original = objects.replace

    def race(key, payload, *, expected):
        monkeypatch.setattr(objects, "replace", original)
        acquire(objects, "b", NOW + TTL)
        return original(key, payload, expected=expected)

    monkeypatch.setattr(objects, "replace", race)
    with pytest.raises(m.LeaseLost):
        acquire(objects, "c", NOW + TTL)
    assert m.read_lease(objects, provider_id="network:one", lane="live").holder == "b"


def test_release_lets_another_holder_acquire_at_once(objects):
    m.release_lease(objects, acquire(objects), clock=lambda: NOW)
    assert acquire(objects, "b").epoch == 2


def test_naive_clock_is_refused_before_writing(objects):
    with pytest.raises(ValueError):
        acquire(objects, now=NOW.replace(tzinfo=None))
    assert m.read_lease(objects, provider_id="network:one", lane="live") is None


@pytest.mark.parametrize("seconds", [30, 3600])
def test_ttl_bounds_are_inclusive_and_renewal_preserves_the_epoch(objects, seconds):
    first = acquire(objects)
    renewed = m.renew_lease(
        objects, first, ttl=timedelta(seconds=seconds), clock=lambda: NOW + timedelta(seconds=1)
    )
    assert renewed.epoch == first.epoch
    assert renewed.expires_at_utc == NOW + timedelta(seconds=seconds + 1)
    with pytest.raises(m.LeaseLost):
        m.renew_lease(objects, first, ttl=TTL, clock=lambda: NOW + timedelta(seconds=2))


@pytest.mark.parametrize(
    "ttl,lane,holder",
    [(29, "live", "a"), (3601, "live", "a"), (90, "other", "a"), (90, "live", " ")],
)
def test_ttl_outside_bounds_and_unknown_lane_are_refused(objects, ttl, lane, holder):
    with pytest.raises(ValueError):
        m.acquire_lease(
            objects,
            provider_id="p",
            lane=lane,
            holder=holder,
            ttl=timedelta(seconds=ttl),
            clock=lambda: NOW,
        )
