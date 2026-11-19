import json
import os
import subprocess
import sys
from dataclasses import replace
from datetime import timedelta
from threading import Barrier, Lock

import pytest
from snapshot_storage_fixtures import MemorySnapshotStore
from test_control_leases import LeaseClient
from test_live_builders_status import context
from test_live_running import AT, Holder, inputs
from test_live_running import local as local
from test_snapshots_publish import FakeEngine, FakeSettings

from transit_ops.control.heartbeats import read_heartbeat
from transit_ops.control.leases import LeaseLost, acquire_lease, read_lease
from transit_ops.control.objects import ObjectRateLimited, SnapshotConditionalObjects
from transit_ops.live.builders_status import build_bundle
from transit_ops.live.publish import TTL, LocalBuildSource, LocalPublisher, ShadowTarget
from transit_ops.snapshots import live_publication, publish
from transit_ops.snapshots.storage import SnapshotStorage


@pytest.fixture
def case(local):
    store = MemorySnapshotStore()
    target = ShadowTarget("network", store)
    control = SnapshotConditionalObjects(
        SnapshotStorage(LeaseClient(), bucket="private", base_prefix="control/v1"),
        min_interval_s=0,
    )
    clock = [AT]
    owner = LocalPublisher(target, control, holder="stable-owner", clock=lambda: clock[0])
    source = LocalBuildSource(local, Holder(None), inputs(local), context())
    return owner, source, store, control, clock


def run(case, **options):
    owner, source, *_ = case
    return owner.publish(
        source, provider_id="network", cycle=AT, settings=FakeSettings(), **options
    )


def lease(control):
    return read_lease(control, provider_id="network", lane="live")


@pytest.mark.parametrize("concurrency", [None, 1])
def test_complete_bundle_canonical_envelopes_and_manifest_last(case, concurrency):
    owner, source, store, control, clock = case
    settings = FakeSettings()
    if concurrency is not None:
        settings.SNAPSHOT_PUBLISH_CONCURRENCY = concurrency
    settings_before, env_before = vars(settings).copy(), os.environ.copy()
    original = build_bundle(source.local, source.holder, source.inputs, source.context)
    result = owner.publish(
        source, provider_id="network", cycle=AT, settings=settings, object_batch_size=2
    )
    assert store.keys[-1] == owner.target.key("manifest.json")
    assert set(store.keys) == {
        owner.target.key(key) for key in {*live_publication.FILES, "manifest.json"}
    }
    for key in {*live_publication.FILES, "manifest.json"}:
        data = json.loads(store.objects[owner.target.key(key)])
        assert data["publish_generation_id"] == "network@2026-06-20T12:10:00Z"
        assert data["methodology_version"] == (
            "manifest-1"
            if key == "manifest.json"
            else "alerts-2"
            if key == "live/alerts.json"
            else "live-2"
        )
        if key != "manifest.json":
            original_key = key.removeprefix("live/")
            expected = (
                original[original_key]
                .replace(
                    b'"publish_generation_id":null',
                    b'"publish_generation_id":"network@2026-06-20T12:10:00Z"',
                )
                .replace(
                    b'"methodology_version":null',
                    b'"methodology_version":"' + data["methodology_version"].encode() + b'"',
                )
            )
            assert store.objects[owner.target.key(key)] == expected
    assert result.lease.holder == "stable-owner"
    assert read_heartbeat(control, provider_id="network", tier="live").files_total == 7
    assert vars(settings) == settings_before and dict(os.environ) == env_before
    assert all(key.startswith("_shadow/v1/network/live/") for key in store.keys)


@pytest.mark.parametrize(
    "changed,expected",
    [
        (None, {"status/data_health.json", "manifest.json"}),
        (
            "vehicle_positions",
            {"live/vehicles.json", "live/network.json", "status/data_health.json", "manifest.json"},
        ),
        ("trip_updates", set(live_publication.FILES) - {"live/alerts.json"} | {"manifest.json"}),
        ("i3_alerts", {"live/alerts.json", "status/data_health.json", "manifest.json"}),
        ("static_schedule", set(live_publication.FILES) | {"manifest.json"}),
    ],
)
def test_selective_inputs_preserve_prior_bytes_and_generations(case, changed, expected):
    owner, source, store, _, clock = case
    run(case)
    before = dict(store.objects)
    clock[0] += timedelta(seconds=20)
    later = replace(
        source,
        context=replace(
            source.context,
            cycle=clock[0],
            **{
                name: replace(getattr(source.context, name), captured_at=clock[0])
                for name in ("provider", "endpoints", "editions", "tiers", "feeds")
            },
        ),
    )

    def changed_source(cycle):
        items, captures = later(cycle)
        if changed:
            captures[changed] = "2026-06-20T12:10:05Z"
        return items, captures

    store.keys.clear()
    owner.publish(changed_source, provider_id="network", cycle=clock[0], settings=FakeSettings())
    assert set(store.keys) == {owner.target.key(key) for key in expected}
    manifest = store.get_json(owner.target.key("manifest.json"))
    for key in live_publication.FILES:
        data = store.get_json(owner.target.key(key))
        assert manifest["files"]["live"]["generations"][key] == data["publish_generation_id"]
        if key not in expected:
            assert store.objects[owner.target.key(key)] == before[owner.target.key(key)]


@pytest.mark.parametrize("fault", ["object", "manifest", "heartbeat"])
def test_failed_attempt_does_not_renew_or_certify_success(case, monkeypatch, fault):
    owner, source, store, control, clock = case
    run(case)
    before_lease, before_beat = (
        lease(control),
        read_heartbeat(control, provider_id="network", tier="live"),
    )
    before_manifest = store.objects[owner.target.key("manifest.json")]
    clock[0] += timedelta(seconds=10)
    # Same complete source/cycle: health + manifest still publish on every attempt.
    if fault != "heartbeat":
        store.fail_key = owner.target.key(
            "status/data_health.json" if fault == "object" else "manifest.json"
        )
    else:
        original = control.replace

        def fail(key, *args, **kwargs):
            if key.startswith("heartbeats/"):
                raise ObjectRateLimited("heartbeat unavailable")
            return original(key, *args, **kwargs)

        monkeypatch.setattr(control, "replace", fail)
    with pytest.raises((RuntimeError, ObjectRateLimited)):
        run(case)
    assert lease(control) == before_lease
    assert read_heartbeat(control, provider_id="network", tier="live") == before_beat
    if fault != "heartbeat":
        assert store.objects[owner.target.key("manifest.json")] == before_manifest


@pytest.mark.parametrize("takeover", [False, True])
def test_upload_expiry_or_takeover_refuses_final_manifest(case, takeover):
    owner, _, store, control, clock = case

    def interleave(key):
        if key.endswith("status/data_health.json"):
            clock[0] = AT + TTL
            if takeover:
                acquire_lease(
                    control,
                    provider_id="network",
                    lane="live",
                    holder="winner",
                    ttl=TTL,
                    clock=lambda: clock[0],
                )

    store.pause = interleave
    with pytest.raises(LeaseLost):
        run(case, object_batch_size=2)
    assert owner.target.key("manifest.json") not in store.objects
    assert read_heartbeat(control, provider_id="network", tier="live") is None
    assert lease(control).holder == ("winner" if takeover else "stable-owner")


def test_parallel_uploads_overlap_and_batches_finish_before_manifest(case):
    _, _, store, _, _ = case
    barrier, lock, in_flight, peak = Barrier(2, timeout=5), Lock(), [0], [0]

    def overlap(key):
        if key.endswith("manifest.json"):
            assert in_flight[0] == 0 and len(store.keys) == 6
            return
        with lock:
            in_flight[0] += 1
            peak[0] = max(peak[0], in_flight[0])
        barrier.wait()
        with lock:
            in_flight[0] -= 1

    store.pause = overlap
    run(case, object_batch_size=2)
    assert peak[0] == 2


def test_partial_batch_failure_drains_and_keeps_manifest_absent(case):
    owner, _, store, control, _ = case
    store.fail_key = owner.target.key("live/trips.json")
    with pytest.raises(RuntimeError):
        run(case, object_batch_size=2)
    assert store.keys == [owner.target.key("live/vehicles.json")]
    assert owner.target.key("manifest.json") not in store.objects
    assert read_heartbeat(control, provider_id="network", tier="live") is None


@pytest.mark.parametrize(
    "provider,lane",
    [
        ("../stm", "live"),
        ("stm/x", "live"),
        ("stm\\x", "live"),
        ("", "live"),
        ("stm", "static"),
        ("stm", "../live"),
    ],
)
def test_malformed_target_refuses_before_io(provider, lane):
    store = MemorySnapshotStore()
    with pytest.raises(ValueError):
        ShadowTarget(provider, store, lane)
    assert store.calls == []


def test_mismatched_provider_naive_cycle_and_context_refuse(case):
    owner, source, store, control, _ = case
    for provider, cycle in (("stm", AT), ("network", AT.replace(tzinfo=None))):
        with pytest.raises(ValueError):
            owner.publish(source, provider_id=provider, cycle=cycle, settings=FakeSettings())
    assert lease(control) is None and store.calls == []
    with pytest.raises(ValueError, match="cycle differs"):
        owner.publish(
            source, provider_id="network", cycle=AT + timedelta(seconds=1), settings=FakeSettings()
        )
    assert store.calls == []


def test_same_holder_recreation_does_not_renew_before_failed_attempt(case):
    owner, _, store, control, clock = case
    run(case)
    before = lease(control)
    clock[0] += timedelta(seconds=10)
    owner.lease = None  # A reconstructed publisher must verify, not reacquire/renew.
    store.fail_key = owner.target.key("status/data_health.json")
    with pytest.raises(RuntimeError):
        run(case)
    assert lease(control) == before


def test_explicit_pg_build_cycle_and_naive_refusal(monkeypatch):
    monkeypatch.setattr(publish, "utc_now", lambda: pytest.fail("hidden build clock"))
    store = MemorySnapshotStore()
    publish.publish_snapshot(
        "stm", settings=FakeSettings(), engine=FakeEngine(), storage=store, cycle=AT
    )
    assert store.get_json("live/trips.json")["generated_utc"] == "2026-06-20T12:10:00Z"
    assert (
        store.get_json("manifest.json")["files"]["live"]["generated_utc"] == "2026-06-20T12:10:00Z"
    )
    with pytest.raises(ValueError, match="aware"):
        publish.publish_snapshot("stm", cycle=AT.replace(tzinfo=None))


def test_dormant_pg_import_does_not_load_local_engine():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import transit_ops.snapshots.publish; "
            "assert 'duckdb' not in sys.modules; "
            "assert 'transit_ops.live.local_file' not in sys.modules",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
