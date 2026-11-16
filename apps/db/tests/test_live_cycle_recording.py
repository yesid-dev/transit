from test_orchestration import (
    _fake_registry_with_intervals,
    _install_realtime_cycle_stubs,
    _pipeline_settings,
)

from transit_ops import orchestration


def test_source_receipts_are_observed_once_before_batch_projection(monkeypatch):
    events = []
    _install_realtime_cycle_stubs(monkeypatch, events)
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **kw: None)
    monkeypatch.setattr(orchestration, "_best_effort_publish_live", lambda *a, **kw: 0)

    class Observer:
        def sync(self, *, current_run_ids=(), project=True):
            events.append((project, current_run_ids))

    result = orchestration._run_realtime_cycle(
        "stm",
        settings=_pipeline_settings(),
        registry=_fake_registry_with_intervals(),
        engine=object(),
        bronze_storage_resolver=lambda _: None,
        worker_state=Observer(),
    )
    assert result.status == "succeeded"
    observed = [e for e in events if isinstance(e, tuple)]
    expected = [(False, (e.capture_result["ingestion_run_id"],)) for e in result.endpoint_results]
    assert observed == [(True, ()), *expected, (True, ())]
    assert [e for e in events if isinstance(e, str) and e.startswith("capture:")] == [
        "capture:trip_updates",
        "capture:vehicle_positions",
        "capture:i3_alerts",
    ]
    assert events.index((True, ()), 1) < events.index("refresh-gold-realtime")
