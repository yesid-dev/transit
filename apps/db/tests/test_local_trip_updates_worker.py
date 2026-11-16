from dataclasses import replace
from hashlib import sha256
from types import SimpleNamespace

import pytest
from test_live_captures import _message
from test_live_local_file import CAPTURE, POLL
from test_live_recording import configured
from test_orchestration import _worker_loop_cycle_result

from transit_ops import orchestration
from transit_ops.live.local_file import LocalFile
from transit_ops.live.settings import LaneSettings
from transit_ops.live.trip_updates import LocalTripUpdatesError
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings


def manifest(settings):
    value = ProviderRegistry.from_project_root(settings=settings).get_provider("stm")
    return value.model_copy(
        update={
            "provider": value.provider.model_copy(update={"provider_id": "network"}),
            "feeds": {k: v for k, v in value.feeds.items() if k == "trip_updates"},
        }
    )


def test_local_requires_owner_and_default_pg_callback_is_unchanged(monkeypatch):
    settings = Settings(_env_file=None)
    value = manifest(settings)
    calls = []
    monkeypatch.setattr(
        orchestration, "latest_stored_trip_updates", lambda *a, **kw: calls.append((a, kw)) or None
    )
    engine, resolver = object(), lambda _: pytest.fail("unexpected bytes")
    holder = orchestration._worker_trip_updates(
        "network",
        settings=settings,
        manifest=value,
        engine=engine,
        bronze_storage_resolver=resolver,
    )
    assert holder.latest() is None
    assert len(calls) == 1
    assert calls[0][1]["engine"] is engine
    assert calls[0][1]["bronze_storage_resolver"] is resolver
    settings.LIGHTER_STORAGE.live.trip_updates_fallback = "local"
    with pytest.raises(LocalTripUpdatesError, match="requires_borrowed_owner"):
        orchestration._worker_trip_updates(
            "network",
            settings=settings,
            manifest=value,
            engine=engine,
            bronze_storage_resolver=resolver,
        )


@pytest.mark.parametrize("selector", ["unknown", "LOCAL", "", None])
def test_unknown_selector_refuses(selector):
    with pytest.raises(ValueError):
        LaneSettings(trip_updates_fallback=selector)


def test_loop_and_standalone_holders_borrow_invocation_owner(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, REALTIME_STARTUP_DELAY_SECONDS=0, REALTIME_POLL_SECONDS=10)
    settings.LIGHTER_STORAGE.live = configured(tmp_path).model_copy(
        update={"trip_updates_fallback": "local"}
    )
    value = manifest(settings)
    registry = SimpleNamespace(get_provider=lambda _: value)
    monkeypatch.setattr(orchestration, "_validate_realtime_worker_startup", lambda *a, **k: value)
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **k: None)
    payload = _message().SerializeToString()
    entry = replace(
        CAPTURE,
        capture_row_id=20,
        ingestion_run_id=20,
        ingestion_object_id=20,
        byte_size=len(payload),
        sha256=sha256(payload).hexdigest(),
        packed=False,
        stream=None,
        offset=None,
        storage_backend="local",
        storage_path="cold.pb",
    )
    opened, closed, holders, locals_seen, reads = [], [], [], [], []
    original_open, original_close = LocalFile.open, LocalFile.close

    def open_file(*args, **kwargs):
        local = original_open(*args, **kwargs)
        opened.append(local)
        local.record_captures([entry], endpoint_key="trip_updates")
        local.record_polls(
            [
                replace(
                    POLL,
                    ingestion_run_id=20,
                    capture_row_id=20,
                    feed_timestamp_utc=entry.feed_timestamp_utc,
                    time_utc=entry.captured_at_utc,
                    started_at_utc=entry.started_at_utc,
                    completed_at_utc=entry.captured_at_utc,
                )
            ],
            endpoint_key="trip_updates",
        )
        return local

    def close_file(local):
        closed.append(local)
        original_close(local)

    monkeypatch.setattr(LocalFile, "open", open_file)
    monkeypatch.setattr(LocalFile, "close", close_file)

    class Storage:
        def read_bytes(self, path):
            assert opened[-1] not in closed
            reads.append(path)
            return payload

    class Scope:
        def __init__(self, *a, **k):
            self.owner_closed = False

        def resolve(self, backend):
            assert not self.owner_closed
            return Storage()

        def close(self):
            assert opened[-1] in closed
            self.owner_closed = True

    monkeypatch.setattr(orchestration, "BronzeStorageScope", Scope)

    def cycle(provider_id, *, live_trip_updates, worker_state, **kwargs):
        holders.append(live_trip_updates)
        locals_seen.append(worker_state.local)
        assert live_trip_updates.latest().capture.capture_row_id == 20
        return _worker_loop_cycle_result(provider_id)

    monkeypatch.setattr(orchestration, "_run_realtime_cycle", cycle)
    orchestration.run_realtime_worker_loop(
        "network",
        settings=settings,
        registry=registry,
        engine=object(),
        max_cycles=2,
        sleep_fn=lambda _: None,
        should_shutdown=lambda: False,
    )
    for _ in range(2):
        orchestration.run_realtime_cycle(
            "network", settings=settings, registry=registry, engine=object()
        )
    assert holders[0] is holders[1]
    assert holders[2] is not holders[3] and holders[2] is not holders[0]
    assert locals_seen[:2] == [opened[0], opened[0]]
    assert locals_seen[2:] == opened[1:]
    assert closed == opened and len(opened) == 3
    assert reads == ["cold.pb"] * 3


def test_worker_refuses_packed_before_reading_whole_object(tmp_path):
    from contextlib import closing

    from test_live_local_file import opened

    settings = Settings(_env_file=None)
    settings.LIGHTER_STORAGE.live.trip_updates_fallback = "local"
    with closing(opened(tmp_path / "worker.db")) as local:
        local.record_captures(
            [replace(CAPTURE, ingestion_object_id=1)], endpoint_key="trip_updates"
        )
        local.record_polls(
            [
                replace(
                    POLL,
                    feed_timestamp_utc=CAPTURE.feed_timestamp_utc,
                    time_utc=CAPTURE.captured_at_utc,
                    started_at_utc=CAPTURE.started_at_utc,
                    completed_at_utc=CAPTURE.captured_at_utc,
                )
            ],
            endpoint_key="trip_updates",
        )
        holder = orchestration._worker_trip_updates(
            "network",
            settings=settings,
            manifest=manifest(settings),
            engine=object(),
            bronze_storage_resolver=lambda _: pytest.fail("whole packed object read"),
            worker_state=SimpleNamespace(local=local),
        )
        with pytest.raises(LocalTripUpdatesError, match="worker_packed_unsupported"):
            holder.latest()
