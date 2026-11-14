import hashlib
import io
from datetime import UTC, datetime, timedelta
from threading import RLock

import pytest
from botocore.exceptions import ClientError
from test_snapshots_storage import _StableCasClient

from transit_ops.control import leases as m
from transit_ops.control.objects import SnapshotConditionalObjects
from transit_ops.snapshots.storage import LocalSnapshotStorage, SnapshotStorage

NOW = datetime(2026, 1, 1, microsecond=123456, tzinfo=UTC)
TTL = timedelta(seconds=90)


class LeaseClient(_StableCasClient):
    def __init__(self):
        super().__init__()
        self._state_lock = RLock()
        self.tick = 0

    def put_object(self, **kw):
        with self._state_lock:
            result = super().put_object(**kw)
            self.tick += 1
            self.objects[kw["Key"]]["LastModified"] = NOW + timedelta(microseconds=self.tick)
            return result

    def head_object(self, **kw):
        with self._state_lock:
            return {
                **super().head_object(**kw),
                "LastModified": self.objects[kw["Key"]]["LastModified"],
            }

    def get_object(self, **kw):
        with self._state_lock:
            obj = self.objects[kw["Key"]]
            if kw.get("IfMatch", obj["ETag"]) != obj["ETag"]:
                raise ClientError({"Error": {"Code": "PreconditionFailed"}}, "GetObject")
            return {
                "Body": io.BytesIO(obj["Body"]),
                "ETag": obj["ETag"],
                "LastModified": obj["LastModified"],
                "ContentLength": len(obj["Body"]),
            }


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


@pytest.mark.parametrize("operation", ["renew", "release", "aba"])
def test_stale_identical_mutations_never_regain_authority(objects, operation):
    first = acquire(objects)
    if operation == "release":
        m.release_lease(objects, first, clock=lambda: NOW)
    else:
        current = m.renew_lease(
            objects, first, ttl=timedelta(seconds=120), clock=lambda: NOW + timedelta(seconds=10)
        )
        if operation == "aba":
            m.renew_lease(
                objects,
                current,
                ttl=timedelta(seconds=70),
                clock=lambda: NOW + timedelta(seconds=20),
            )
    prior = objects.read("leases/network%3Aone/live.json")
    with pytest.raises(m.LeaseLost):
        if operation == "release":
            m.release_lease(objects, first, clock=lambda: NOW)
        else:
            m.renew_lease(
                objects,
                first,
                ttl=timedelta(seconds=120),
                clock=lambda: NOW + timedelta(seconds=21 if operation == "aba" else 10),
            )
    assert objects.read(prior.key) == prior


@pytest.mark.parametrize("operation", ["renew", "release"])
def test_clock_before_last_update_is_refused_without_writing(objects, operation):
    lease = m.renew_lease(
        objects, acquire(objects), ttl=TTL, clock=lambda: NOW + timedelta(seconds=60)
    )
    prior = objects.read("leases/network%3Aone/live.json")
    with pytest.raises(m.LeaseLost, match="clock"):
        if operation == "renew":
            m.renew_lease(objects, lease, ttl=TTL, clock=lambda: NOW + timedelta(seconds=30))
        else:
            m.release_lease(objects, lease, clock=lambda: NOW + timedelta(seconds=30))
    assert objects.read(prior.key) == prior


@pytest.mark.parametrize("operation", ["acquire", "renew", "reacquire"])
def test_expiry_is_checked_after_slow_readback(objects, monkeypatch, operation):
    lease = acquire(objects) if operation != "acquire" else None
    now, read = [NOW], objects.read

    def delayed(key):
        result = read(key)
        if result is not None:
            now[0] = NOW + TTL * 2
        return result

    monkeypatch.setattr(objects, "read", delayed)
    with pytest.raises(m.LeaseLost):
        if operation == "renew":
            m.renew_lease(objects, lease, ttl=TTL, clock=lambda: now[0])
        else:
            m.acquire_lease(
                objects,
                provider_id="network:one",
                lane="live",
                holder="a",
                ttl=TTL,
                clock=lambda: now[0],
            )


@pytest.mark.parametrize("payload", [{}, {"epoch": "bad"}])
def test_corrupt_lease_has_a_named_error(objects, payload):
    objects.replace("leases/network%3Aone/live.json", payload, expected=None)
    with pytest.raises(ValueError, match="invalid lease"):
        m.read_lease(objects, provider_id="network:one", lane="live")


def test_fake_get_keeps_body_and_metadata_from_one_snapshot(monkeypatch):
    client = LeaseClient()
    client.put_object(Key="a", Body=b"old")
    head = client.head_object

    def interleave(**kw):
        metadata = head(**kw)
        client.put_object(Key="a", Body=b"new")
        return metadata

    monkeypatch.setattr(client, "head_object", interleave)
    result = client.get_object(Key="a")
    assert result["ETag"] == '"' + hashlib.sha256(result["Body"].read()).hexdigest() + '"'
