from dataclasses import replace
from datetime import timedelta

import pytest
from test_live_facts import parsed_vehicle, vehicle_message
from test_live_publish import case as case
from test_live_publish import lease, run
from test_live_publish import local as local
from test_live_running import AT
from test_snapshots_publish import FakeSettings

from transit_ops.control.heartbeats import read_heartbeat
from transit_ops.control.leases import LeaseHeld, LeaseLost, acquire_lease, renew_lease
from transit_ops.control.objects import ObjectRateLimited
from transit_ops.live.facts import apply_capture
from transit_ops.live.publish import TTL
from transit_ops.snapshots import publish


@pytest.mark.parametrize("failure", ["renewal", "stale_token", "other_holder"])
def test_publication_fails_on_ownership_loss_without_overwriting_winner(case, monkeypatch, failure):
    owner, _, store, control, clock = case
    if failure == "other_holder":
        acquire_lease(
            control, provider_id="network", lane="live", holder="winner", ttl=TTL, clock=lambda: AT
        )
        with pytest.raises(LeaseHeld):
            run(case)
        assert store.calls == [] and lease(control).holder == "winner"
        return
    run(case)
    original_lease = lease(control)
    clock[0] += timedelta(seconds=10)
    if failure == "stale_token":
        winner = renew_lease(control, original_lease, ttl=TTL, clock=lambda: clock[0])
        store.calls.clear()
        with pytest.raises(LeaseLost):
            run(case)
        assert store.calls == [] and lease(control) == winner
    else:
        original = control.replace

        def fail(key, *args, **kwargs):
            if key.startswith("leases/"):
                raise ObjectRateLimited("renewal unavailable")
            return original(key, *args, **kwargs)

        monkeypatch.setattr(control, "replace", fail)
        with pytest.raises(ObjectRateLimited):
            run(case)
        assert lease(control) == original_lease
        # Content and health may be stored; ownership was not renewed and no success returned.
        assert (
            read_heartbeat(control, provider_id="network", tier="live").recorded_at_utc == clock[0]
        )


@pytest.mark.parametrize("wrong", ["provider_id", "lane"])
def test_manifest_target_checks_lease_identity_before_io(case, wrong):
    owner, _, store, control, _ = case
    run(case)
    stored = lease(control)
    store.calls.clear()
    invalid = replace(stored, **{wrong: "other" if wrong == "provider_id" else "static"})
    with pytest.raises(ValueError, match="differs from lease"):
        owner.target.publish_manifest({}, objects=control, lease=invalid, clock=lambda: AT)
    assert store.calls == []
    for key, tier in (
        ("manifest.json", "live"),
        ("../manifest.json", "live"),
        ("live/trips.json", "static"),
    ):
        with pytest.raises(ValueError):
            owner.target.put_json(key, {}, tier=tier)
    assert store.calls == []


@pytest.mark.parametrize(
    "invalid", ["missing", "duplicate", "tier", "captures", "cycle", "provider"]
)
def test_source_contract_refuses_before_any_content_upload(case, invalid):
    owner, source, store, control, _ = case

    def bad(cycle):
        items, captures = source(cycle)
        if invalid == "missing":
            items.pop(0)
        elif invalid == "duplicate":
            items[0] = items[1]
        elif invalid == "tier":
            key, payload, _ = items[0]
            items[0] = key, payload, "static"
        elif invalid == "captures":
            captures.pop("static_schedule")
        elif invalid == "cycle":
            items[0][1].generated_utc = "2000-01-01T00:00:00Z"
        else:
            items[-1][1].provider = "other"
        return items, captures

    with pytest.raises(ValueError):
        owner.publish(
            bad,
            provider_id="network",
            cycle=AT,
            settings=FakeSettings(),
        )
    assert store.calls == []
    assert read_heartbeat(control, provider_id="network", tier="live") is None


def test_local_source_preserves_capture_report_and_context_stamps(case):
    owner, source, store, _, _ = case
    from test_live_builders_status import context

    message = vehicle_message()
    del message.entity[1:]
    reported = AT - timedelta(seconds=30)
    message.entity[0].vehicle.timestamp = int(reported.timestamp())
    parsed = parsed_vehicle(message)
    apply_capture(source.local, parsed, provider_timezone="America/Toronto")
    captured = parsed.capture.captured_at_utc
    source.local.connection.execute(
        "INSERT INTO local_serving VALUES ('vehicle_positions',42,?,?)", [captured, captured]
    )
    actual = replace(source, context=context(endpoints=("vehicle_positions",)))
    before = source.local.connection.execute("SELECT * FROM local_serving").fetchall()
    owner.publish(actual, provider_id="network", cycle=AT, settings=FakeSettings())
    vehicles = store.get_json(owner.target.key("live/vehicles.json"))
    assert vehicles["vehicles"][0]["updated_utc"] == "2026-06-20T12:10:00Z"
    assert vehicles["vehicles"][0]["reported_utc"] == "2026-06-20T12:09:30Z"
    manifest = store.get_json(owner.target.key("manifest.json"))
    assert (
        manifest["files"]["live"]["input_captures"]["vehicle_positions"] == "2026-06-20T12:10:00Z"
    )
    assert manifest["files"]["live"]["input_captures"]["static_schedule"] == "2026-06-19T12:10:00Z"
    assert source.local.connection.execute("SELECT * FROM local_serving").fetchall() == before


@pytest.mark.parametrize("name", ["provider", "endpoints", "editions", "tiers", "feeds"])
def test_local_source_refuses_missing_context(case, name):
    owner, source, store, _, _ = case
    incomplete = replace(source, context=replace(source.context, **{name: None}))
    with pytest.raises(ValueError, match=name):
        owner.publish(incomplete, provider_id="network", cycle=AT, settings=FakeSettings())
    assert store.calls == []


def test_explicit_clock_opt_in_is_live_only():
    for tier in ("static", "historic"):
        with pytest.raises(ValueError, match="requires tier='live'"):
            publish.publish_snapshot("stm", tier=tier, cycle=AT)


def test_retained_token_must_belong_to_target_before_objects(case):
    owner, _, store, control, _ = case
    owner.lease = acquire_lease(
        control,
        provider_id="other",
        lane="live",
        holder=owner.holder,
        ttl=TTL,
        clock=lambda: AT,
    )
    with pytest.raises(ValueError, match="differs from publication target"):
        run(case)
    assert store.calls == []
