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
from transit_ops.live.shadow import (
    PairedShadow,
    PostgresEvidence,
    ShadowRefused,
    admit_role,
)
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


def postgres_vehicle_rows(local, change=None, ids=(42,), now=AT):
    vehicles, trips = read_vehicle_facts(local), read_trip_facts(local)
    rows = [list(row) for row in vehicles.rows if row[1] in ids]
    if change is not None:
        change({name: index for index, name in enumerate(vehicles.columns)}, rows)
    key = ("provider_id", "realtime_snapshot_id", "entity_index")
    return PostgresEvidence(
        now,
        {
            "fact_trip_delay_snapshot": TableRows(
                "fact_trip_delay_snapshot", trips.columns, key, trips.rows
            ),
            "fact_vehicle_snapshot": TableRows(
                "fact_vehicle_snapshot", vehicles.columns, key, tuple(map(tuple, rows))
            ),
        },
    )


def shadow(local, *, settings=ROLE, rows=None, endpoints=(), **options):
    options.setdefault("public", RecordingSink())
    options.setdefault("store", MemorySnapshotStore())
    options.setdefault("objects", control())
    options.setdefault("clock", Clock())
    options.setdefault("rss", lambda: 64 * 2**20)
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
            admit_role(LaneSettings(**settings))
    # The PostgreSQL publication context is captured in production (LS3.9b2).
    assert admit_role(LaneSettings(**ROLE)) is True


def role_settings(role=ROLE, **updates):
    return _pipeline_settings().model_copy(
        update={
            "LIGHTER_STORAGE": _pipeline_settings().LIGHTER_STORAGE.model_copy(
                update={"live": LaneSettings(**role)}
            ),
            **updates,
        }
    )


def test_worker_selector_refuses_before_any_capture(monkeypatch):
    settings = role_settings({**ROLE, "shadow": "local_authoritative"})
    monkeypatch.setattr(
        orchestration, "_run_realtime_worker_loop", lambda *a, **k: pytest.fail("ran")
    )
    with pytest.raises(ShadowRefused, match="local_ingress_unavailable"):
        orchestration.run_realtime_worker_loop("stm", settings=settings, max_cycles=1)
    with pytest.raises(ShadowRefused, match="local_ingress_unavailable"):
        orchestration.run_realtime_cycle("stm", settings=settings)
    # A one-shot cycle has no LocalFile owner: refuse rather than drop the shadow.
    with pytest.raises(ShadowRefused, match="shadow_requires_worker_loop"):
        orchestration.run_realtime_cycle("stm", settings=role_settings())


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
    assert evidence.identity["postgres_now"] == AT.isoformat()
    for name in ("shadow_seconds", "p95_seconds", "rss_bytes", "process_peak_rss_bytes"):
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
    # Admitted cycles time the context capture and the comparison; a refusal only the latter.
    ticks = iter([0.0, 1.0, 1.0, 5.0, 10.0, 10.0, 20.0, 20.0, 20.0, 20.5])
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
        (600 * 2**20, None, "shadow_admission_refused:rss_limit"),
        (None, None, "shadow_admission_refused:rss_unavailable"),
        (1, "local_recovery_pending", "shadow_admission_refused:local_recovery_pending"),
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
    paired = shadow(local, rows=lambda ids, alerts: PostgresEvidence(AT, pg), endpoints=endpoints)
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


class Closing:
    def __init__(self):
        self.closed = 0

    def close(self):
        self.closed += 1


def worker_loop(monkeypatch, cycle, shadow, **options):
    registry = _fake_registry_with_intervals()
    manifest = registry.get_provider("stm")
    monkeypatch.setattr(
        orchestration, "_validate_realtime_worker_startup", lambda *a, **kw: manifest
    )
    monkeypatch.setattr(orchestration, "_run_realtime_cycle", cycle)
    orchestration._run_realtime_worker_loop(
        "stm",
        settings=_pipeline_settings(),
        registry=registry,
        engine=object(),
        sleep_fn=options.pop("sleep_fn", lambda _: None),
        max_cycles=2,
        should_shutdown=options.pop("should_shutdown", lambda: False),
        bronze_storage_resolver=lambda _: None,
        shadow=shadow,
    )


def test_worker_loop_routes_the_shadow_and_closes_it_on_graceful_stop(monkeypatch):
    seen, owner = [], Closing()

    def cycle(provider_id, **kwargs):
        seen.append(kwargs.get("shadow"))
        assert owner.closed == 0
        return _worker_loop_cycle_result(provider_id)

    stops = iter([False, True])
    worker_loop(monkeypatch, cycle, owner, should_shutdown=lambda: next(stops))
    assert seen == [owner] and owner.closed == 1


def test_worker_loop_closes_the_shadow_when_the_loop_raises(monkeypatch):
    owner = Closing()

    def cycle(provider_id, **kwargs):
        return _worker_loop_cycle_result(provider_id)

    def interrupted(_):
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        worker_loop(monkeypatch, cycle, owner, sleep_fn=interrupted)
    assert owner.closed == 1


def test_refused_role_records_no_worker_start(monkeypatch):
    import typer

    from transit_ops import cli

    settings = _pipeline_settings().model_copy(
        update={
            "LIGHTER_STORAGE": _pipeline_settings().LIGHTER_STORAGE.model_copy(
                update={"live": LaneSettings(**{**ROLE, "shadow": "local_authoritative"})}
            )
        }
    )
    monkeypatch.setattr(cli, "get_settings", lambda: settings)
    monkeypatch.setattr(cli, "_install_worker_shutdown_handlers", lambda: lambda: False)
    monkeypatch.setattr(cli, "observe_start", lambda _: pytest.fail("start recorded"))
    with pytest.raises(typer.BadParameter, match="local_ingress_unavailable"):
        cli.run_realtime_worker_command("stm", max_cycles=1)


def test_files_built_at_different_cycles_are_unpaired_not_compared(recorded):
    """A refused cycle lets the public side rebuild; later files pair by generation only."""
    public, state, clock = RecordingSink(), State(recorded), Clock()
    paired = shadow(recorded, public=public, state=state, clock=clock)
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    assert paired.evidence.counts == {}

    def rebuilt_differently(sink, cycle):
        source = LocalBuildSource(recorded, Holder(None), inputs(recorded), context_at(cycle))
        items = build_live_from_source(source, provider_id="network", cycle=cycle, prior=None)
        for key, payload, tier in items:
            if key == "live/network.json":
                payload = payload.model_copy(update={"vehicles_in_service": 99})
            sink.put_json(key, payload, tier=tier)
        return 0

    state.unavailable, clock.at = "local_recovery_pending", AT + timedelta(seconds=30)
    paired.run_cycle(rebuilt_differently, snapshot_ids=())
    assert paired.evidence.status == "refused"
    state.unavailable, clock.at = None, AT + timedelta(seconds=60)
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=())
    counts = paired.evidence.counts
    assert paired.evidence.status == "compared"
    assert counts["publication:live/network.json:unpaired"] == 1
    assert not any(key.endswith(":unadjudicated") for key in counts)


def test_postgres_now_window_departures_are_clock_skew(recorded):
    """PG keeps ETAs before its now() + 60 min; the local build uses the cycle instant."""
    skew = timedelta(seconds=5)
    inside = (AT + timedelta(minutes=60, seconds=2)).isoformat()
    outside = (AT + timedelta(minutes=60, seconds=9)).isoformat()

    def window(key, payload):
        if key != "live/trips.json":
            return payload
        data = payload.model_dump(mode="json")
        data["trips"]["skewed"] = {
            "route": "r",
            "status": "unknown",
            "delay_min": None,
            "stops": [{"stop": "s", "eta_utc": inside, "delay_min": None}],
        }
        data["trips"]["late"] = {
            "route": "r",
            "status": "unknown",
            "delay_min": None,
            "stops": [{"stop": "s", "eta_utc": outside, "delay_min": None}],
        }
        return data

    paired = shadow(
        recorded,
        rows=lambda ids, alerts: postgres_vehicle_rows(recorded, ids=ids, now=AT + skew),
    )
    paired.run_cycle(recorded_postgres(recorded, mutate=window), snapshot_ids=(42,))
    evidence = paired.evidence
    assert evidence.identity["postgres_now"] == (AT + skew).isoformat()
    assert evidence.counts["publication:live/trips.json:clock_skew"] == 1
    assert evidence.counts["publication:live/trips.json:unadjudicated"] >= 1  # "late" stays.
    assert "skewed" not in " ".join(evidence.samples)


def test_rss_spike_refuses_that_cycle_and_admission_returns(recorded):
    readings = iter([600 * 2**20, 64 * 2**20])
    paired = shadow(recorded, rss=lambda: next(readings), peak=lambda: (600 * 2**20, None))
    publish = recorded_postgres(recorded)
    paired.run_cycle(publish, snapshot_ids=(42,))
    assert paired.evidence.reason == "shadow_admission_refused:rss_limit"
    paired.run_cycle(publish, snapshot_ids=(42,))
    assert paired.evidence.status == "compared"
    shown = paired.evidence.display_dict()
    assert (shown["rss_bytes"], shown["process_peak_rss_bytes"]) == (64 * 2**20, 600 * 2**20)


def test_context_is_captured_before_the_public_publication_records_its_tier_state(recorded):
    public, seen = RecordingSink(), []

    def context_source(cycle):
        seen.append(sorted(public.objects))
        return context_at(cycle)

    paired = shadow(recorded, public=public, context_source=context_source)
    paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,))
    assert seen == [[]] and "manifest.json" in public.objects
    assert paired.evidence.status == "compared"
    assert len(paired.evidence.identity["context_sha256"]) == 64


def test_capture_refusal_is_named_shadow_evidence_and_public_still_publishes(recorded):
    from transit_ops.live.context_capture import ContextMissing

    def context_source(cycle):
        raise ContextMissing("tiers")

    public = RecordingSink()
    paired = shadow(recorded, public=public, context_source=context_source)
    assert paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,)) == 0
    assert (paired.evidence.status, paired.evidence.reason) == (
        "invalid",
        "ContextMissing: publication_context_missing:tiers",
    )
    assert "manifest.json" in public.objects


def test_worker_loop_starts_postgres_authoritative_and_runs_a_paired_cycle(recorded, monkeypatch):
    """End to end: production capture -> local candidate -> classified evidence."""
    from test_live_context_capture import Engine, manifest, registry, sources

    from transit_ops.live import shadow as shadow_module
    from transit_ops.live.context_capture import assemble
    from transit_ops.snapshots import live_scope

    endpoints = ("vehicle_positions",)
    declared = manifest(feeds=endpoints)
    providers = registry(declared)
    rows = sources(endpoints=endpoints)
    public, store, objects = RecordingSink(), MemorySnapshotStore(), control()
    monkeypatch.setattr(live_scope, "worker_live_storage", lambda provider_id, settings: public)
    monkeypatch.setattr(shadow_module, "_private_store", lambda settings: store)
    monkeypatch.setattr(shadow_module, "_private_objects", lambda settings: objects)
    monkeypatch.setattr(
        orchestration, "_validate_realtime_worker_startup", lambda *a, **kw: declared
    )
    built = []

    def cycle(provider_id, **kwargs):
        paired = kwargs["shadow"]
        built.append(paired)
        # Deterministic probes for this cycle; the production defaults read the host.
        paired.clock, paired.rss = Clock(), lambda: 64 * 2**20

        def publish(sink, at):
            # The authority publishes this cycle from the same PostgreSQL facts.
            ctx = assemble(
                at, "network", rows, registry=providers, public_base_url="https://example.org"
            )
            source = LocalBuildSource(recorded, Holder(None), inputs(recorded), ctx)
            prior = sink.get_json("manifest.json")
            for key, payload, tier in build_live_from_source(
                source, provider_id="network", cycle=at, prior=prior
            ):
                sink.put_json(key, payload, tier=tier)
            return 0

        paired.run_cycle(publish, snapshot_ids=(42,))
        return _worker_loop_cycle_result(provider_id)

    monkeypatch.setattr(orchestration, "_run_realtime_cycle", cycle)
    settings = role_settings(SNAPSHOT_PUBLIC_BASE_URL="https://example.org")
    orchestration._run_realtime_worker_loop(
        "network",
        settings=settings,
        registry=providers,
        engine=Engine(rows),
        sleep_fn=lambda _: None,
        max_cycles=1,
        should_shutdown=lambda: False,
        bronze_storage_resolver=lambda _: None,
        worker_state=State(recorded),
    )

    (paired,) = built
    evidence = paired.evidence
    assert (evidence.status, evidence.reason) == ("compared", None)
    # The fake authority holds no fact rows: every recorded local row is classified extra.
    recorded_rows = sum(row[1] == 42 for row in read_vehicle_facts(recorded).rows)
    assert recorded_rows and evidence.counts == {"facts:fact_vehicle_snapshot:extra": recorded_rows}
    assert evidence.identity["edition"] == 7
    assert store.keys and all(key.startswith(SHADOW_PREFIX) for key in store.keys)
    assert paired._publisher is None  # The loop's graceful stop released the shadow lease.


def test_admission_error_never_blocks_the_public_publication(recorded):
    def broken_probe():
        raise OSError("probe failed")

    public = RecordingSink()
    paired = shadow(recorded, public=public, rss=broken_probe)
    assert paired.run_cycle(recorded_postgres(recorded), snapshot_ids=(42,)) == 0
    assert (paired.evidence.status, paired.evidence.reason) == (
        "refused",
        "shadow_admission_refused:OSError",
    )
    assert "manifest.json" in public.objects
