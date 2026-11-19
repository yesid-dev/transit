"""Paired shadow worker: PostgreSQL publishes; the local candidate is compared, never gated."""

import json
import logging
from dataclasses import replace
from datetime import timedelta

import pytest
from snapshot_storage_fixtures import MemorySnapshotStore
from test_control_leases import LeaseClient
from test_live_builders_status import context
from test_live_facts import parsed_vehicle
from test_live_running import AT, Holder, inputs
from test_live_running import local as local
from test_orchestration import (
    _fake_registry_with_intervals,
    _install_realtime_cycle_stubs,
    _pipeline_settings,
    _worker_loop_cycle_result,
)

from transit_ops import orchestration
from transit_ops.batch.build import TableRows
from transit_ops.control.objects import SnapshotConditionalObjects
from transit_ops.live.facts import apply_capture, read_trip_facts, read_vehicle_facts
from transit_ops.live.oracle.sink import RecordingSink
from transit_ops.live.publish import LocalBuildSource, ShadowTarget
from transit_ops.live.settings import LaneSettings
from transit_ops.live.shadow import PairedShadow, ShadowRefused, admit_role
from transit_ops.snapshots.publish import build_live_from_source
from transit_ops.snapshots.storage import SnapshotStorage

ROLE = dict(
    recording=True,
    shadow="postgres_authoritative",
    shadow_budget_seconds=30.0,
    shadow_rss_limit_mb=512,
)
SHADOW_PREFIX = "_shadow/v1/network/live/"


def context_at(cycle, endpoints=()):
    base = context(endpoints=endpoints)
    rows = {
        name: replace(getattr(base, name), captured_at=cycle)
        for name in ("provider", "endpoints", "editions", "tiers", "feeds")
    }
    return replace(base, cycle=cycle, **rows)


class State:
    def __init__(self, local):
        self.local, self.unavailable = local, None


class Clock:
    def __init__(self, at=AT):
        self.at = at

    def __call__(self):
        return self.at


def control():
    return SnapshotConditionalObjects(
        SnapshotStorage(LeaseClient(), bucket="private", base_prefix="control/v1"),
        min_interval_s=0,
    )


def recorded_postgres(local, *, endpoints=(), mutate=lambda key, payload: payload):
    """The authoritative candidate's recorded publication for each cycle."""

    def publish(sink, cycle):
        source = LocalBuildSource(local, Holder(None), inputs(local), context_at(cycle, endpoints))
        items = build_live_from_source(
            source, provider_id="network", cycle=cycle, prior=sink.get_json("manifest.json")
        )
        for key, payload, tier in items:
            sink.put_json(key, mutate(key, payload), tier=tier)
        return 0

    return publish


def postgres_vehicle_rows(local, change=None, ids=(42,)):
    vehicles, trips = read_vehicle_facts(local), read_trip_facts(local)
    rows = [list(row) for row in vehicles.rows if row[1] in ids]
    if change is not None:
        change({name: index for index, name in enumerate(vehicles.columns)}, rows)
    key = ("provider_id", "realtime_snapshot_id", "entity_index")
    return {
        "fact_trip_delay_snapshot": TableRows(
            "fact_trip_delay_snapshot", trips.columns, key, trips.rows
        ),
        "fact_vehicle_snapshot": TableRows(
            "fact_vehicle_snapshot", vehicles.columns, key, tuple(map(tuple, rows))
        ),
    }


def shadow(local, *, settings=ROLE, rows=None, endpoints=(), **options):
    options.setdefault("public", RecordingSink())
    options.setdefault("store", MemorySnapshotStore())
    options.setdefault("objects", control())
    options.setdefault("clock", Clock())
    options.setdefault("rss", lambda: (64 * 2**20, None))
    options.setdefault("state", State(local))
    return PairedShadow(
        provider_id="network",
        settings=LaneSettings(**settings),
        publish_settings=_pipeline_settings(),
        context_source=options.pop("context_source", lambda cycle: context_at(cycle, endpoints)),
        postgres_rows=rows or (lambda ids, alerts: postgres_vehicle_rows(local, ids=ids)),
        trips=Holder(None),
        **options,
    )


@pytest.fixture
def recorded(local):
    apply_capture(local, parsed_vehicle(), provider_timezone="America/Toronto")
    return local


def test_default_off_is_todays_worker_and_inverted_roles_refuse_by_name():
    assert admit_role(LaneSettings()) is False
    with pytest.raises(ShadowRefused) as refused:
        admit_role(LaneSettings(**{**ROLE, "shadow": "local_authoritative"}))
    assert refused.value.reason == "local_ingress_unavailable"
    for missing, reason in (
        ("recording", "shadow_requires_recording"),
        ("shadow_budget_seconds", "shadow_requires_shadow_budget_seconds"),
        ("shadow_rss_limit_mb", "shadow_requires_shadow_rss_limit_mb"),
    ):
        settings = {k: v for k, v in ROLE.items() if k != missing}
        with pytest.raises(ShadowRefused, match=reason):
            admit_role(LaneSettings(**settings), context_source=context_at)
    # No owner captures a PostgreSQL publication context yet: refuse, never guess one.
    with pytest.raises(ShadowRefused, match="publication_context_capture_unavailable"):
        admit_role(LaneSettings(**ROLE))
    assert admit_role(LaneSettings(**ROLE), context_source=context_at) is True


def test_worker_selector_refuses_before_any_capture(monkeypatch):
    settings = _pipeline_settings().model_copy(
        update={
            "LIGHTER_STORAGE": _pipeline_settings().LIGHTER_STORAGE.model_copy(
                update={"live": LaneSettings(**{**ROLE, "shadow": "local_authoritative"})}
            )
        }
    )
    monkeypatch.setattr(
        orchestration, "_run_realtime_worker_loop", lambda *a, **k: pytest.fail("ran")
    )
    with pytest.raises(ShadowRefused, match="local_ingress_unavailable"):
        orchestration.run_realtime_worker_loop("stm", settings=settings, max_cycles=1)
    with pytest.raises(ShadowRefused, match="local_ingress_unavailable"):
        orchestration.run_realtime_cycle("stm", settings=settings)


def test_postgres_authoritative_cycle_classifies_differences_without_gating(recorded, caplog):
    def postgres_measure_differs(columns, rows):
        rows[0][columns["bearing"]] = (rows[0][columns["bearing"]] or 0.0) + 1.0

    public = RecordingSink()

    def network_differs(key, payload):
        if key == "live/network.json":
            return payload.model_copy(update={"vehicles_in_service": 99})
        return payload

    paired = shadow(
        recorded,
        public=public,
        rows=lambda ids, alerts: postgres_vehicle_rows(recorded, postgres_measure_differs),
    )
    caplog.set_level(logging.INFO, logger="transit_ops.live.shadow")
    failures = paired.run_cycle(
        recorded_postgres(recorded, mutate=network_differs), snapshot_ids=(42,)
    )

    assert failures == 0
    assert json.loads(public.objects["live/network.json"])["vehicles_in_service"] == 99
    evidence = paired.evidence
    assert evidence.status == "compared" and evidence.reason is None
    assert evidence.counts == {
        "publication:live/network.json:unadjudicated": 1,
        "facts:fact_vehicle_snapshot:unadjudicated": 1,
    }
    assert evidence.identity["cycle"] == AT.isoformat()
    assert evidence.identity["realtime_snapshot_ids"] == [42]
    assert evidence.identity["edition"] == 7
    assert evidence.identity["public_keys_written"] == sorted(public.objects)
    shown = evidence.display_dict()
    for name in ("shadow_seconds", "p95_seconds", "rss_peak_bytes"):
        assert shown[name] is not None
    logged = [r for r in caplog.records if r.message.startswith("paired_shadow ")]
    assert json.loads(logged[-1].message.removeprefix("paired_shadow "))["status"] == "compared"


def test_identical_candidates_compare_clean_and_clock_fields_are_projected(recorded):
    later = Clock()
    paired = shadow(recorded, clock=later)
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    assert paired.evidence.counts == {}
    later.at = AT + timedelta(seconds=30)
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=())
    assert paired.evidence.status == "compared" and paired.evidence.counts == {}
    assert paired.evidence.p95_seconds is not None


def test_representation_and_missing_rows_have_their_own_classes():
    from transit_ops.live.compare import Difference
    from transit_ops.live.shadow import publication_class

    assert publication_class(Difference("k", "<bytes>", '{"a":1}', '{"a":1.0}')) == (
        "representation"
    )
    assert publication_class(Difference("k", "<bytes>", "<absent>", "{}")) == "extra"
    assert publication_class(Difference("k", "<bytes>", "{}", "<absent>")) == "missing"
    assert publication_class(Difference("k", "a", "1", "2")) == "unadjudicated"


def test_missing_postgres_fact_row_is_counted_as_extra_local_row(recorded):
    paired = shadow(
        recorded, rows=lambda ids, alerts: postgres_vehicle_rows(recorded, lambda c, r: r.pop())
    )
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    assert paired.evidence.counts == {"facts:fact_vehicle_snapshot:extra": 1}


def test_upload_isolation_shadow_never_addresses_public_keys(recorded):
    public, store = RecordingSink(), MemorySnapshotStore()
    paired = shadow(recorded, public=public, store=store)
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    assert store.keys and all(key.startswith(SHADOW_PREFIX) for key in store.keys)
    assert not any(key.startswith("_shadow/") for key in public.objects)
    assert {key.removeprefix(SHADOW_PREFIX) for key in store.keys} == set(public.objects)
    with pytest.raises(ValueError, match="unknown shadow publication key"):
        ShadowTarget("network", store).key("../manifest.json")


def test_shadow_exception_invalidates_only_shadow_evidence(recorded):
    public = RecordingSink()
    calls = []

    def context_source(cycle):
        calls.append(cycle)
        if len(calls) == 1:
            raise RuntimeError("context read failed")
        return context_at(cycle)

    paired = shadow(recorded, public=public, context_source=context_source)
    assert paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,)) == 0
    assert paired.evidence.status == "invalid"
    assert paired.evidence.reason == "RuntimeError: context read failed"
    assert paired.evidence.counts == {}
    assert "manifest.json" in public.objects  # Public output never waits on the shadow.
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    assert paired.evidence.status == "compared"


def test_public_failure_is_not_compared_and_keeps_its_failure_count(recorded):
    paired = shadow(recorded)
    assert paired.run_cycle(lambda sink, cycle: 1, snapshot_ids=(42,)) == 1
    assert (paired.evidence.status, paired.evidence.reason) == (
        "invalid",
        "public_publication_failed",
    )
    paired.run_cycle(lambda sink, cycle: 0, snapshot_ids=())
    assert paired.evidence.reason == "public_publication_absent"


def test_overrun_invalidates_then_backs_off_one_cycle(recorded):
    ticks = iter([0.0, 5.0, 10.0, 10.0, 20.0, 20.5])
    paired = shadow(
        recorded, settings={**ROLE, "shadow_budget_seconds": 1.0}, perf=lambda: next(ticks)
    )
    publish = recorded_postgres(recorded)
    paired.run_cycle(publish, snapshot_ids=(42,))
    assert (paired.evidence.status, paired.evidence.reason) == ("invalid", "shadow_overrun")
    assert paired.evidence.counts == {} and paired.evidence.shadow_seconds == 5.0
    paired.run_cycle(publish, snapshot_ids=(42,))
    assert paired.evidence.reason == "shadow_admission_refused:previous_overrun"
    paired.run_cycle(publish, snapshot_ids=(42,))
    assert paired.evidence.status == "compared"
    assert paired.evidence.p95_seconds == 5.0


@pytest.mark.parametrize(
    ("rss", "unavailable", "reason"),
    [
        ((600 * 2**20, None), None, "shadow_admission_refused:rss_limit"),
        ((None, "no probe"), None, "shadow_admission_refused:rss_unavailable"),
        ((1, None), "local_recovery_pending", "shadow_admission_refused:local_recovery_pending"),
    ],
)
def test_admission_refusal_is_named_and_public_still_publishes(recorded, rss, unavailable, reason):
    public, store, state = RecordingSink(), MemorySnapshotStore(), State(recorded)
    state.unavailable = unavailable
    paired = shadow(recorded, public=public, store=store, rss=lambda: rss, state=state)
    assert paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,)) == 0
    assert (paired.evidence.status, paired.evidence.reason) == ("refused", reason)
    assert "manifest.json" in public.objects and store.keys == []


def test_graceful_stop_releases_lease_and_restart_resumes(recorded):
    store, objects, clock = MemorySnapshotStore(), control(), Clock()
    first = shadow(recorded, store=store, objects=objects, clock=clock)
    first.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    first.close()
    clock.at = AT + timedelta(seconds=30)
    second = shadow(recorded, store=store, objects=objects, clock=clock)
    # The restarted owner rebuilds its public map: keys it has not yet seen are unobserved.
    second.run_cycle(recorded_postgres(recorded), snapshot_ids=())
    assert second.evidence.status == "compared"
    assert not any(key.endswith(":unadjudicated") for key in second.evidence.counts)


def test_alert_state_is_compared_per_cycle(local):
    from test_local_alert_apply import ALERT
    from test_local_alert_seed import bundle

    from transit_ops.live.shadow import local_rows
    from transit_ops.silver.i3 import RawI3AlertSnapshot
    from transit_ops.static.alert_apply import apply_alert_snapshot
    from transit_ops.static.alert_state import seed_alert_state

    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    seed_alert_state(local, seed)
    apply_alert_snapshot(
        local, RawI3AlertSnapshot(101, "network", "America/Toronto", AT, [ALERT]), loaded_at_utc=AT
    )
    mine = local_rows(local, "network", ())
    alerts = mine["silver.i3_alerts"]
    header = alerts.columns.index("alert_header_text")
    changed = [list(row) for row in alerts.rows]
    changed[0][header] = "other"
    pg = {**mine, "silver.i3_alerts": replace(alerts, rows=tuple(map(tuple, changed)))}
    endpoints = ("i3_alerts",)
    paired = shadow(local, rows=lambda ids, alerts: pg, endpoints=endpoints)
    paired.run_cycle(recorded_postgres(local, endpoints=endpoints), snapshot_ids=())
    assert paired.evidence.counts == {"alerts:silver.i3_alerts:unadjudicated": 1}


def test_cycle_routing_one_capture_stream_one_instant_public_first(monkeypatch):
    events = []
    _install_realtime_cycle_stubs(monkeypatch, events)
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **kw: None)
    published = {}

    def publish_live(provider_id, **kwargs):
        events.append("public-publish")
        published.update(kwargs)
        return 0

    monkeypatch.setattr(orchestration, "_best_effort_publish_live", publish_live)

    class Shadow:
        def run_cycle(self, publish, *, snapshot_ids):
            events.append("shadow-start")
            sink = object()
            failures = publish(sink, AT)
            events.append(("shadow-compare", snapshot_ids))
            assert published["storage"] is sink and published["cycle"] == AT
            return failures

    result = orchestration._run_realtime_cycle(
        "stm",
        settings=_pipeline_settings(),
        registry=_fake_registry_with_intervals(),
        engine=object(),
        bronze_storage_resolver=lambda _: None,
        shadow=Shadow(),
    )
    assert result.status == "succeeded" and result.live_publish_failures == 0
    captures = [e for e in events if isinstance(e, str) and e.startswith("capture:")]
    assert len(captures) == len(set(captures)) == 3  # No second agency fetch.
    assert events.index("refresh-gold-realtime") < events.index("shadow-start")
    assert events[-2:] == ["public-publish", ("shadow-compare", (20, 21))]


def test_partial_endpoint_failure_shadows_only_succeeded_captures(monkeypatch):
    events = []
    _install_realtime_cycle_stubs(monkeypatch, events)
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **kw: None)
    monkeypatch.setattr(orchestration, "_best_effort_publish_live", lambda *a, **kw: 0)
    real = orchestration._capture_and_load_realtime_source

    def failing_vehicles(provider_id, endpoint_key, **kwargs):
        result = real(provider_id, endpoint_key, **kwargs)
        if endpoint_key == "vehicle_positions":
            return replace(result, status="failed", silver_load_result=None, error_message="x")
        return result

    monkeypatch.setattr(orchestration, "_capture_and_load_realtime_source", failing_vehicles)
    seen = []

    class Shadow:
        def run_cycle(self, publish, *, snapshot_ids):
            seen.append(snapshot_ids)
            return publish(object(), AT)

    result = orchestration._run_realtime_cycle(
        "stm",
        settings=_pipeline_settings(),
        registry=_fake_registry_with_intervals(),
        engine=object(),
        bronze_storage_resolver=lambda _: None,
        shadow=Shadow(),
    )
    assert result.status == "partial_failure"
    assert seen == [(20,)]


def test_default_cycle_publishes_exactly_as_before(monkeypatch):
    events = []
    _install_realtime_cycle_stubs(monkeypatch, events)
    monkeypatch.setattr(orchestration, "initialize_realtime_serving", lambda *a, **kw: None)
    calls = []
    monkeypatch.setattr(
        orchestration, "_best_effort_publish_live", lambda *a, **kw: calls.append(kw) or 0
    )
    orchestration._run_realtime_cycle(
        "stm",
        settings=_pipeline_settings(),
        registry=_fake_registry_with_intervals(),
        engine=object(),
        bronze_storage_resolver=lambda _: None,
    )
    assert len(calls) == 1 and "storage" not in calls[0] and "cycle" not in calls[0]


def test_worker_loop_routes_the_shadow_to_every_cycle(monkeypatch):
    registry = _fake_registry_with_intervals()
    manifest = registry.get_provider("stm")
    monkeypatch.setattr(
        orchestration, "_validate_realtime_worker_startup", lambda *a, **kw: manifest
    )
    seen = []

    def cycle(provider_id, **kwargs):
        seen.append(kwargs.get("shadow"))
        return _worker_loop_cycle_result(provider_id)

    monkeypatch.setattr(orchestration, "_run_realtime_cycle", cycle)
    marker = object()
    orchestration._run_realtime_worker_loop(
        "stm",
        settings=_pipeline_settings(),
        registry=registry,
        engine=object(),
        sleep_fn=lambda _: None,
        max_cycles=2,
        should_shutdown=lambda: False,
        bronze_storage_resolver=lambda _: None,
        shadow=marker,
    )
    assert seen == [marker, marker]
