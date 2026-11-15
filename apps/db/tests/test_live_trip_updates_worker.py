import gc
import weakref
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256

import pytest
from test_live_captures import POLICY, _capture, _message
from test_orchestration import (
    _fake_registry_without_i3,
    _gold_refresh_result,
    _realtime_ingestion_result,
    _realtime_silver_result,
)

from transit_ops import capture_load, orchestration
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings
from transit_ops.snapshots.live_trip_updates import LiveTripUpdates


@pytest.mark.parametrize("observer_fails", [False, True])
@pytest.mark.parametrize(
    "endpoint", ["trip_updates", "vehicle_positions", "i3_alerts", "service_alerts"]
)
def test_warm_holder_does_not_reread_bronze(monkeypatch, caplog, endpoint, observer_fails):
    payload = _message().SerializeToString()
    receipt = replace(
        _realtime_ingestion_result(endpoint, 20),
        byte_size=len(payload),
        checksum_sha256=sha256(payload).hexdigest(),
    )
    holder = LiveTripUpdates("stm", policy=POLICY, fallback=lambda: pytest.fail("cold read"))
    monkeypatch.setattr(capture_load, "_capture_realtime_feed", lambda *a, **k: (receipt, payload))
    monkeypatch.setattr(
        capture_load,
        "_load_realtime_to_silver",
        lambda *a, **k: _realtime_silver_result(endpoint, 20),
    )
    observed = []

    def observe(body, ref):
        observed.append(ref.capture_row_id)
        if observer_fails:
            raise ValueError("observer https://example.test/?api_key=secret-observer")
        holder.accept(body, ref)

    result = capture_load.capture_and_load_realtime(
        "stm",
        endpoint,
        settings=Settings(_env_file=None),
        registry=object(),
        engine=object(),
        bronze_storage_resolver=lambda _: pytest.fail("unexpected Bronze read"),
        on_trip_updates_loaded=observe,
    )
    assert result.failure is None
    assert result.silver.realtime_snapshot_id == 20
    assert observed == ([20] if endpoint == "trip_updates" else [])
    assert "secret-observer" not in caplog.text
    if endpoint == "trip_updates" and not observer_fails:
        assert holder.latest().frames["rt_trip_updates"].column("trip_id") == [None, "√2"]


@pytest.mark.parametrize("provider", ["stm", "octranspo"])
def test_worker_reuses_last_good_capture_across_cycles(monkeypatch, provider):
    settings = Settings(
        _env_file=None,
        DATABASE_URL="postgresql://unused",
        SNAPSHOT_STORAGE_BACKEND="local",
        REALTIME_STARTUP_DELAY_SECONDS=0,
    )
    registry = ProviderRegistry.from_project_root(settings=settings)
    manifest = registry.get_provider(provider).model_copy(deep=True)
    manifest.feeds = {
        k: v.model_copy(update={"refresh_interval_seconds": 1, "refresh_phase_seconds": None})
        for k, v in manifest.feeds.items()
        if k in ("trip_updates", "vehicle_positions")
    }
    registry = type("Registry", (), {"get_provider": lambda self, p: manifest})()
    monkeypatch.setattr(
        orchestration, "_validate_realtime_worker_startup", lambda *a, **k: manifest
    )
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **k: None)
    monkeypatch.setattr(
        orchestration,
        "_persist_silver_load_failure",
        lambda *a, **k: pytest.fail("observer must not persist failure"),
    )
    monkeypatch.setattr(
        orchestration, "refresh_gold_realtime", lambda *a, **k: _gold_refresh_result()
    )
    payload = _message().SerializeToString()
    polls, seen, references = [], [], []
    import itertools

    ticks = itertools.count()
    monkeypatch.setattr(
        orchestration,
        "utc_now",
        lambda: _capture(payload).captured_at_utc + timedelta(seconds=next(ticks) * 2),
    )

    def capture(p, endpoint, **kwargs):
        if endpoint == "trip_updates":
            polls.append(endpoint)
            if len(polls) == 2:
                raise RuntimeError("poll failed")
        n = len(polls)
        body = b"malformed" if n == 3 else payload
        receipt = replace(
            _realtime_ingestion_result(endpoint, 20 + n, p),
            completed_at_utc=_capture(payload).captured_at_utc + timedelta(seconds=n),
            byte_size=len(body),
            checksum_sha256=sha256(body).hexdigest(),
        )
        return receipt, body

    def publish(p, *, live_trip_updates, **kwargs):
        references.append(weakref.ref(live_trip_updates))
        parsed = live_trip_updates.latest()
        seen.append((parsed.capture.provider_id, parsed.capture.capture_row_id))

    monkeypatch.setattr(capture_load, "_capture_realtime_feed", capture)
    monkeypatch.setattr(
        capture_load,
        "_load_realtime_to_silver",
        lambda p, e, snapshot_id, **k: _realtime_silver_result(e, snapshot_id, p),
    )
    monkeypatch.setattr(orchestration, "publish_snapshot", publish)
    orchestration.run_realtime_worker_loop(
        provider,
        settings=settings,
        registry=registry,
        engine=object(),
        max_cycles=4,
        should_shutdown=lambda: False,
        sleep_fn=lambda _: None,
    )
    assert seen == [(provider, 21), (provider, 21), (provider, 21), (provider, 24)]
    gc.collect()
    assert all(ref() is None for ref in references)


def test_standalone_cycle_uses_a_fresh_holder(monkeypatch):
    settings = Settings(
        _env_file=None, DATABASE_URL="postgresql://unused", SNAPSHOT_STORAGE_BACKEND="local"
    )
    registry = _fake_registry_without_i3()
    real_manifest = ProviderRegistry.from_project_root(settings=settings).get_provider("stm")
    registry.get_provider = lambda _: real_manifest.model_copy(
        update={"feeds": {k: v for k, v in real_manifest.feeds.items() if k == "vehicle_positions"}}
    )
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **k: None)
    monkeypatch.setattr(
        orchestration, "refresh_gold_realtime", lambda *a, **k: _gold_refresh_result()
    )
    monkeypatch.setattr(
        capture_load,
        "_capture_realtime_feed",
        lambda p, e, **k: (_realtime_ingestion_result(e, 20), b"unused"),
    )
    monkeypatch.setattr(
        capture_load, "_load_realtime_to_silver", lambda p, e, **k: _realtime_silver_result(e, 20)
    )
    holders = []
    monkeypatch.setattr(
        orchestration,
        "publish_snapshot",
        lambda *a, live_trip_updates, **k: holders.append(live_trip_updates),
    )
    for _ in range(2):
        orchestration.run_realtime_cycle(
            "stm", settings=settings, registry=registry, engine=object()
        )
    assert holders == [None, None]
