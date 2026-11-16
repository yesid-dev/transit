"""Worker scheduling regressions using real files, parsers, facts and seeded alerts."""

import json
from contextlib import closing, contextmanager
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256

import pytest
from test_live_captures import AT
from test_live_facts import seed_fact_edition, trip_message, vehicle_message
from test_live_local_file import RECORD
from test_live_recording import PageEngine, configured
from test_local_alert_apply import ALERT
from test_realtime_silver import _build_manifest

from transit_ops.history.poll_record import FeedDayKey, PollRecord
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live import recording, worker_state
from transit_ops.live.edition import EditionId
from transit_ops.live.local_file import LocalFile
from transit_ops.live.worker_state import WorkerState
from transit_ops.static.alert_seed_contract import AlertSeed
from transit_ops.static.alert_state import seed_alert_state


class SourceEngine(PageEngine):
    transaction_active = False

    @contextmanager
    def begin(self):
        assert not self.transaction_active
        self.transaction_active = True
        try:
            yield self
        finally:
            self.transaction_active = False

    def rollback(self):
        self.transaction_active = False


def capture(storage, endpoint, identity, payload, seconds=0):
    stamp = AT + timedelta(seconds=seconds)
    family = "alert_snapshot" if endpoint == "i3_alerts" else "realtime_snapshot"
    path = f"capture-{identity}.bin"
    (storage.root / path).write_bytes(payload)
    entry = replace(
        RECORD.captures[0],
        index_family=family,
        capture_row_id=identity,
        ingestion_run_id=identity,
        ingestion_object_id=identity,
        packed=False,
        stream=None,
        offset=None,
        byte_size=len(payload),
        sha256=sha256(payload).hexdigest(),
        storage_backend="local",
        storage_path=path,
        started_at_utc=stamp,
        captured_at_utc=stamp,
        feed_timestamp_utc=stamp,
        object_created_at_utc=stamp,
    )
    poll = replace(
        RECORD.polls[0],
        index_family=family,
        ingestion_run_id=identity,
        capture_row_id=identity,
        requested_at_utc=stamp,
        started_at_utc=stamp,
        completed_at_utc=stamp,
        time_utc=stamp,
        feed_timestamp_utc=stamp,
    )
    return PollRecord(
        FeedDayKey("network", endpoint, family, stamp.date()), (poll,), (entry,), (), 30, None
    )


@pytest.fixture
def worker(tmp_path, monkeypatch):
    settings = configured(tmp_path).model_copy(update={"catchup_page_size": 2})
    storage = LocalBronzeStorage("local", tmp_path)
    engine = SourceEngine()
    manifest = _build_manifest()
    manifest = manifest.model_copy(
        update={"provider": manifest.provider.model_copy(update={"provider_id": "network"})}
    )
    monkeypatch.setattr(
        recording,
        "read_working_runs",
        lambda pg, provider_id, run_ids: tuple(
            engine.visible[i] for i in run_ids if i in engine.visible
        ),
    )
    monkeypatch.setattr(
        worker_state, "current_edition_id", lambda *a, **kw: EditionId("network", 7, "seed")
    )
    monkeypatch.setattr(worker_state, "current_dim_versions", lambda *a, **kw: (None, None))
    loads = []

    def load(local, pg, edition):
        assert not pg.transaction_active
        state.local.require_committed()
        loads.append(edition)
        if not local.execute(
            "SELECT 1 FROM duckdb_tables() WHERE table_name='edition_meta'"
        ).fetchone():
            seed_fact_edition(state.local)

    monkeypatch.setattr(worker_state, "load_edition_from_postgres", load)
    with closing(
        LocalFile.open(tmp_path / "worker.db", provider_id="network", settings=settings)
    ) as local:
        seed_alert_state(local, AlertSeed.from_json(settings.alert_seed_path.read_bytes()))
        state = WorkerState(
            local, engine=engine, manifest=manifest, settings=settings, resolver=lambda _: storage
        )
        state.recorder.initialize(initial_run_id=0, seed_sha256=settings.alert_seed_sha256)
        yield state, engine, storage, loads


@pytest.mark.parametrize("history", [8, 16])
def test_current_receipt_does_not_wait_for_history_and_late_commit_survives(worker, history):
    state, engine, storage, _ = worker
    payload = vehicle_message().SerializeToString()
    for identity in range(2, history + 2):
        engine.visible[identity] = capture(storage, "vehicle_positions", identity, payload)
    state.sync()
    current = history + 10
    engine.visible[current] = capture(storage, "vehicle_positions", current, payload)
    state.sync()
    assert state.local.connection.execute(
        "SELECT 1 FROM polls WHERE ingestion_run_id=?", [current]
    ).fetchone() == (1,)
    assert state.unavailable is not None  # old pages cannot certify a complete local cycle
    engine.visible[1] = capture(storage, "vehicle_positions", 1, payload)
    for _ in range(history + 3):
        state.sync()
    assert state.local.connection.execute("SELECT 1 FROM polls WHERE ingestion_run_id=1").fetchone()


@pytest.mark.parametrize("failure", ["missing_bytes", "after_children"])
def test_failed_alert_blocks_later_capture_until_chronological_retry(worker, monkeypatch, failure):
    state, _, storage, _ = worker
    payload = json.dumps({"alerts": [ALERT]}).encode()
    first = capture(storage, "i3_alerts", 101, payload)
    newer = capture(storage, "i3_alerts", 102, payload, seconds=1)
    if failure == "missing_bytes":
        (storage.root / first.captures[0].storage_path).unlink()
    else:
        original = worker_state.apply_alert_snapshot

        def fail_after_children(*args, **kwargs):
            original(*args, **kwargs)
            raise ValueError("after_children")

        monkeypatch.setattr(worker_state, "apply_alert_snapshot", fail_after_children)
    errors = state._apply_records("network", (first, newer))
    assert errors
    assert state.local.connection.execute("SELECT count(*) FROM silver.i3_alerts").fetchone() == (
        0,
    )
    (storage.root / first.captures[0].storage_path).write_bytes(payload)
    if failure == "after_children":
        monkeypatch.setattr(worker_state, "apply_alert_snapshot", original)
    assert state._apply_records("network", ()) == []
    assert state.local.connection.execute(
        "SELECT i3_alert_snapshot_id, message_snapshot_id FROM silver.i3_alerts"
    ).fetchall() == [(101, 102)]
    assert state.local.connection.execute(
        "SELECT DISTINCT i3_alert_snapshot_id FROM silver.i3_alert_informed_entities"
    ).fetchall() == [(101,)]
    assert state.local.connection.execute("SELECT status FROM local_applications").fetchall() == [
        ("succeeded",),
        ("succeeded",),
    ]


def test_unordered_alerts_keep_first_seen_identity_and_children(worker):
    state, _, storage, _ = worker
    payload = json.dumps({"alerts": [ALERT]}).encode()
    first = capture(storage, "i3_alerts", 101, payload)
    newer = capture(storage, "i3_alerts", 102, payload, seconds=1)
    assert state._apply_records("network", (newer, first)) == []
    assert state.local.connection.execute(
        "SELECT i3_alert_snapshot_id FROM silver.i3_alerts"
    ).fetchall() == [(101,)]


def test_already_advanced_alert_refuses_false_convergence(worker):
    state, engine, storage, _ = worker
    payload = json.dumps({"alerts": [ALERT]}).encode()
    first = capture(storage, "i3_alerts", 101, payload)
    newer = capture(storage, "i3_alerts", 102, payload, seconds=1)
    assert state._apply_records("network", (newer,)) == []
    assert state._apply_records("network", (first,)) == ["local_alert_repair_required:101"]
    assert state.local.connection.execute(
        "SELECT status FROM local_applications WHERE capture_row_id=101"
    ).fetchone() == ("failed",)
    engine.visible.update({101: first, 102: newer})
    state.sync()
    assert state.unavailable is not None
    state.sync()
    assert state.unavailable == "local_alert_repair_required:101"


def trip_vehicle(storage):
    trip = capture(storage, "trip_updates", 101, trip_message().SerializeToString())
    vehicle = capture(storage, "vehicle_positions", 102, vehicle_message().SerializeToString())
    return trip, vehicle


def trip_enrichment(local):
    return local.connection.execute(
        "SELECT vehicle_id, occupancy_status FROM fact_trip_delay_snapshot"
    ).fetchall()


def test_trip_before_vehicle_batch_has_same_enrichment(worker):
    state, _, storage, _ = worker
    trip, vehicle = trip_vehicle(storage)
    assert state._apply_records("network", (trip, vehicle)) == []
    assert trip_enrichment(state.local) == [("bus-0", 2)]


def test_visible_inflight_source_run_holds_recovery_projection(worker):
    state, engine, storage, _ = worker
    trip, vehicle = trip_vehicle(storage)
    engine.visible = {101: trip, 102: vehicle}
    engine.pending = {100}
    for _ in range(3):
        state.sync()
    assert trip_enrichment(state.local) == []
    assert state.unavailable == "local_recovery_pending"
    engine.pending.clear()
    engine.visible[100] = replace(
        trip,
        captures=(),
        polls=(
            replace(
                trip.polls[0],
                ingestion_run_id=100,
                capture_row_id=None,
                status="failed",
                run_status="failed",
                error_message="capture_failed",
            ),
        ),
    )
    for _ in range(3):
        state.sync()
    assert trip_enrichment(state.local) == [("bus-0", 2)]


def test_trip_and_vehicle_on_different_recovery_pages(worker):
    state, engine, storage, _ = worker
    state.settings = state.settings.model_copy(update={"catchup_page_size": 1})
    trip, vehicle = trip_vehicle(storage)
    engine.visible = {101: trip, 102: vehicle}
    for _ in range(6):
        state.sync()
    assert trip_enrichment(state.local) == [("bus-0", 2)]
    assert state.local.connection.execute("SELECT status FROM local_applications").fetchall() == [
        ("succeeded",),
        ("succeeded",),
    ]


def test_unchanged_edition_and_empty_batches_do_not_copy(worker):
    state, _, storage, loads = worker
    payload = vehicle_message().SerializeToString()
    first = capture(storage, "vehicle_positions", 101, payload)
    second = capture(storage, "vehicle_positions", 102, payload)
    state._apply_records("network", (first,))
    state._apply_records("network", (second,))
    state._apply_records("network", (first,))
    state._apply_records("network", ())
    assert len(loads) == 1


def test_missing_current_receipt_stays_unavailable_until_verified(worker):
    state, engine, storage, _ = worker
    state.sync(current_run_ids=(101,))
    assert state.unavailable == "local_current_receipt_missing"
    state.sync()
    assert state.unavailable == "local_current_receipt_missing"
    engine.visible[101] = capture(
        storage, "vehicle_positions", 101, vehicle_message().SerializeToString()
    )
    state.sync(project=False)
    assert state.unavailable != "local_current_receipt_missing"
    assert state.local.connection.execute("SELECT ingestion_run_id FROM polls").fetchall() == [
        (101,)
    ]


def test_current_trip_waits_for_end_of_capture_batch(worker):
    state, engine, storage, _ = worker
    state.sync()  # empty startup recovery is complete
    trip, vehicle = trip_vehicle(storage)
    engine.visible[101] = trip
    state.sync(current_run_ids=(101,), project=False)
    assert trip_enrichment(state.local) == []
    engine.visible[102] = vehicle
    state.sync(current_run_ids=(102,), project=False)
    state.sync()
    assert trip_enrichment(state.local) == [("bus-0", 2)]


def test_failed_vehicle_does_not_finalize_dependent_trip(worker):
    state, _, storage, _ = worker
    trip, vehicle = trip_vehicle(storage)
    payload = (storage.root / vehicle.captures[0].storage_path).read_bytes()
    (storage.root / vehicle.captures[0].storage_path).unlink()
    assert state._apply_records("network", (trip, vehicle))
    assert not state.local.connection.execute(
        "SELECT 1 FROM local_applications WHERE endpoint_key='trip_updates' AND status='succeeded'"
    ).fetchone()
    (storage.root / vehicle.captures[0].storage_path).write_bytes(payload)
    assert state._apply_records("network", ()) == []
    assert trip_enrichment(state.local) == [("bus-0", 2)]


def test_same_edition_dimensions_and_new_edition_invalidate_cache(worker, monkeypatch):
    state, _, storage, loads = worker
    dimensions = [None, None]
    version = [7]
    original = worker_state.load_edition_from_postgres
    monkeypatch.setattr(worker_state, "current_dim_versions", lambda *a, **kw: tuple(dimensions))
    monkeypatch.setattr(
        worker_state,
        "current_edition_id",
        lambda *a, **kw: EditionId("network", version[0], "seed"),
    )

    def load(local, pg, edition):
        original(local, pg, edition)
        local.execute(
            "UPDATE edition_meta SET dataset_version_id=?, "
            "routes_dataset_version_id=?, stops_dataset_version_id=?",
            [version[0], *dimensions],
        )

    monkeypatch.setattr(worker_state, "load_edition_from_postgres", load)
    payload = vehicle_message().SerializeToString()
    for identity, expected in ((101, 1), (102, 1), (103, 2), (104, 3)):
        if identity == 103:
            dimensions[:] = [8, 9]
        if identity == 104:
            version[0] = 10
        assert (
            state._apply_records(
                "network", (capture(storage, "vehicle_positions", identity, payload),)
            )
            == []
        )
        assert len(loads) == expected
    dimensions[:] = [11, 12]
    assert state._apply_records("network", ()) == []
    assert len(loads) == 4
    assert state._apply_records("network", ()) == []
    assert len(loads) == 4


def test_new_tail_trip_is_not_projected_from_an_incomplete_recovery_set(worker):
    from google.transit import gtfs_realtime_pb2 as pb

    state, engine, storage, _ = worker
    empty = pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")).SerializeToString()
    engine.visible = {i: capture(storage, "vehicle_positions", i, empty) for i in (2, 3, 4)}
    state.sync()  # fixed historical horizon is 4
    trip, vehicle = trip_vehicle(storage)
    vehicle = replace(
        vehicle,
        captures=(replace(vehicle.captures[0], ingestion_run_id=100),),
        polls=(replace(vehicle.polls[0], ingestion_run_id=100),),
    )
    failed_poll = replace(
        trip.polls[0],
        ingestion_run_id=103,
        capture_row_id=None,
        status="failed",
        run_status="failed",
        error_message="capture_failed",
    )
    empty_failure = replace(trip, captures=(), polls=(failed_poll,), processing=())
    engine.visible.update({100: vehicle, 101: trip, 103: empty_failure})
    state.sync()
    state.sync()  # old horizon completes; tail has trip 101, but has not discovered vehicle 100
    assert trip_enrichment(state.local) == []
    assert state.unavailable is not None
    for _ in range(8):
        state.sync()
    assert trip_enrichment(state.local) == [("bus-0", 2)]
