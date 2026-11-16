"""A pending lower run must become durable input before its horizon is eligible."""

from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_live_facts import seed_fact_edition
from test_live_worker_ordering import trip_enrichment, trip_vehicle
from test_live_worker_ordering import worker as worker

from transit_ops.live import worker_state
from transit_ops.live.local_file import LocalFile
from transit_ops.live.worker_state import WorkerState


def source_with_pending(engine, monkeypatch):
    """Model source identity visibility separately from terminal receipt visibility."""
    engine.pending = {100}
    engine.unfinished = True

    def execute(statement, params=None):
        engine.statement = str(statement)
        if params is not None and "run_ids" in params:
            engine.ids = [i for i in params["run_ids"] if i in engine.visible]
        elif params is not None and "limit" in params:
            engine.requests.append(params)
            if "after" in params:
                identities = set(engine.visible)
                if "completed_at_utc" not in engine.statement:
                    identities |= engine.pending
                engine.ids = sorted(i for i in identities if params["after"] < i <= params["upper"])
            else:
                engine.ids = sorted(
                    (i for i in engine.visible if i > params["initial"]), reverse=True
                )
            engine.ids = engine.ids[: params["limit"]]
        return engine

    monkeypatch.setattr(engine, "execute", execute)


def failed_poll(record, identity):
    return replace(
        record,
        captures=(),
        polls=(
            replace(
                record.polls[0],
                ingestion_run_id=identity,
                capture_row_id=None,
                status="failed",
                run_status="failed",
                error_message="capture_failed",
            ),
        ),
    )


def reopen(state):
    state.local.close()
    local = LocalFile.open(
        state.settings.local_dir / "worker.db", provider_id="network", settings=state.settings
    )
    resumed = WorkerState(
        local,
        engine=state.engine,
        manifest=state.manifest,
        settings=state.settings,
        resolver=state.resolver,
    )
    resumed.recorder.initialize(initial_run_id=0, seed_sha256=state.settings.alert_seed_sha256)
    return resumed


def scenario(worker, monkeypatch):
    state, engine, storage, _ = worker
    source_with_pending(engine, monkeypatch)
    # Edition is the only external data source besides run/receipt visibility.
    monkeypatch.setattr(
        worker_state,
        "load_edition_from_postgres",
        lambda duck, pg, edition: seed_fact_edition(SimpleNamespace(connection=duck)),
    )
    trip, vehicle = trip_vehicle(storage)
    vehicle = replace(
        vehicle,
        captures=(replace(vehicle.captures[0], ingestion_run_id=100),),
        polls=(replace(vehicle.polls[0], ingestion_run_id=100),),
    )
    assert vehicle.captures[0].capture_row_id == 102  # run IDs are a different namespace
    engine.visible = {101: trip, 102: failed_poll(trip, 102), 103: failed_poll(trip, 103)}
    return state, engine, vehicle


@pytest.mark.parametrize("transition", ["no_reopen", "pending", "covered"])
def test_lower_pending_vehicle_finishes_behind_cursor_outside_tail(worker, monkeypatch, transition):
    state, engine, vehicle = scenario(worker, monkeypatch)
    try:
        state.sync()
        state.sync()
        assert state.unavailable is not None
        assert not state.local.connection.execute(
            "SELECT 1 FROM local_applications WHERE endpoint_key='trip_updates' "
            "AND status='succeeded'"
        ).fetchone()
        if transition == "pending":
            state = reopen(state)
        engine.pending.clear()
        engine.unfinished = False
        engine.visible[100] = vehicle
        state.sync(project=transition != "covered")
        if transition == "covered":
            assert state.unavailable is not None
            state = reopen(state)
            state.sync()
        # An empty keyset page cannot release a trip without the lower terminal receipt.
        assert trip_enrichment(state.local) == [("bus-0", 2)]
        assert state.local.connection.execute(
            "SELECT status FROM local_applications WHERE endpoint_key='trip_updates'"
        ).fetchone() == ("succeeded",)
        assert state.unavailable is None
        state = reopen(state)
        state.sync()
        assert trip_enrichment(state.local) == [("bus-0", 2)]
        assert state.unavailable is None
        assert state.local.connection.execute(
            "SELECT count(*) FROM fact_processing"
        ).fetchone() == (2,)
    finally:
        state.local.close()


def test_schema_four_is_refused_without_modification(worker):
    state, _, _, _ = worker
    path = state.settings.local_dir / "worker.db"
    state.local.connection.execute("UPDATE meta SET schema_version=4")
    state.local.connection.execute("DROP TABLE recording_coverage")
    state.local.connection.execute("ALTER TABLE recording_cursor DROP COLUMN covered_through")
    state.local.connection.execute("ALTER TABLE recording_cursor DROP COLUMN sweep_enumerated")
    state.local.close()
    before = path.read_bytes()
    with pytest.raises(RuntimeError, match="meta schema version.*4.*refused.*requires 5"):
        LocalFile.open(path, provider_id="network", settings=state.settings)
    assert path.read_bytes() == before


def test_ready_current_trip_cannot_bypass_a_known_lower_obligation(worker, monkeypatch):
    state = worker[0]
    state.sync()  # durable empty initial coverage precedes the next current batch
    state, engine, vehicle = scenario(worker, monkeypatch)
    try:
        state.sync(current_run_ids=(101,), project=False)
        state.sync()
        state = reopen(state)
        state.sync()
        assert state.unavailable is not None
        assert trip_enrichment(state.local) == []
        engine.pending.clear()
        engine.visible[100] = vehicle
        state.sync()
        assert trip_enrichment(state.local) == [("bus-0", 2)]
        assert state.unavailable is None
    finally:
        state.local.close()


def test_success_without_required_raw_capture_cannot_cover_the_run(worker, monkeypatch):
    worker[0].sync()
    state, engine, vehicle = scenario(worker, monkeypatch)
    engine.pending.clear()
    engine.visible[100] = replace(
        vehicle,
        captures=(),
        polls=(
            replace(
                vehicle.polls[0],
                capture_row_id=None,
                status="capture_missing",
                missing_reason="capture_row_absent",
            ),
        ),
    )
    engine.visible = {100: engine.visible[100]}
    for _ in range(4):
        state.sync()
    assert state.unavailable is not None
    assert trip_enrichment(state.local) == []


def test_failed_raw_commit_retains_obligation_and_reopen_retries(worker, monkeypatch):
    state, engine, vehicle = scenario(worker, monkeypatch)
    state.sync()
    state.sync()
    engine.pending.clear()
    engine.visible[100] = vehicle
    record = state.recorder.record

    def interrupted(raw):
        record(raw)
        if any(p.ingestion_run_id == 100 for p in raw.polls):
            raise RuntimeError("raw_commit_interrupted")

    monkeypatch.setattr(state.recorder, "record", interrupted)
    try:
        state.sync()
        assert state.unavailable == "raw_commit_interrupted"
        assert not state.local.connection.execute(
            "SELECT 1 FROM polls WHERE ingestion_run_id=100"
        ).fetchone()
        state = reopen(state)
        state.sync()
        assert trip_enrichment(state.local) == [("bus-0", 2)]
        assert state.unavailable is None
    finally:
        state.local.close()
