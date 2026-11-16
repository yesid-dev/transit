import json
from contextlib import closing
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256
from types import SimpleNamespace

import pytest
from test_live_facts import parsed_vehicle
from test_live_local_file import RECORD, SETTINGS
from test_local_alert_seed import bundle

from transit_ops.history.poll_record import ProcessingEntry
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live import recording, worker_state
from transit_ops.live.local_file import LocalFile
from transit_ops.live.recording import Recorder
from transit_ops.live.segments import export_segment
from transit_ops.live.worker_state import worker_state_scope


def test_raw_survives_failed_application_and_retry_after_reopen(tmp_path):
    path = tmp_path / "worker.db"
    record = replace(RECORD, processing=())
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id="network")
        recorder.record(record)

        def fail():
            local.connection.execute("CREATE TABLE should_rollback (n INTEGER)")
            raise ValueError("derived_failure")

        with pytest.raises(ValueError, match="derived_failure"):
            recorder.apply("vehicle_positions", 42, fail)
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        assert local.connection.execute("SELECT count(*) FROM polls").fetchone()[0]
        assert not local.connection.execute(
            "SELECT 1 FROM duckdb_tables() WHERE table_name='should_rollback'"
        ).fetchone()
        recorder = Recorder(local, provider_id="network")
        parsed = parsed_vehicle()
        from transit_ops.live.facts import apply_capture

        def operation():
            return apply_capture(local, parsed, provider_timezone="America/Toronto")

        assert recorder.apply("vehicle_positions", 42, operation)
        assert not recorder.apply("vehicle_positions", 42, operation)
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (1,)


def configured(tmp_path):
    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    path = tmp_path / "seed.json"
    payload = seed.to_json()
    path.write_bytes(payload)
    cut_path = tmp_path / "cut.json"
    cut_payload = json.dumps(
        dict(
            version=1,
            provider_id=seed.provider_id,
            initial_run_id=0,
            alert_seed_sha256=sha256(payload).hexdigest(),
            seed_snapshot_at_utc=seed.snapshot_at.isoformat(),
        )
    ).encode()
    cut_path.write_bytes(cut_payload)
    return SETTINGS.model_copy(
        update=dict(
            recording=True,
            local_dir=tmp_path,
            initial_cut_path=cut_path,
            initial_cut_sha256=sha256(cut_payload).hexdigest(),
            alert_seed_path=path,
            alert_seed_sha256=sha256(payload).hexdigest(),
            segment_storage_backend="local",
        )
    )


MANIFEST = SimpleNamespace(provider=SimpleNamespace(provider_id="network"))


def test_default_off_never_opens_or_resolves(tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError("default-off accessed local resources")

    with worker_state_scope(
        settings=SETTINGS, engine=None, manifest=None, resolver=forbidden
    ) as state:
        assert state is None
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "field",
    [
        "initial_cut_path",
        "initial_cut_sha256",
        "alert_seed_path",
        "alert_seed_sha256",
        "local_dir",
        "duckdb_memory_limit_mb",
        "duckdb_threads",
        "temp_dir_max_mb",
        "segment_storage_backend",
    ],
)
def test_enabled_requires_each_named_input(tmp_path, field):
    settings = configured(tmp_path).model_copy(update={field: None})
    with pytest.raises(ValueError, match="requires_" + field):
        with worker_state_scope(settings=settings, engine=None, manifest=MANIFEST, resolver=None):
            pytest.fail("missing activation input accepted")


def test_failed_startup_releases_real_file(tmp_path, monkeypatch):
    settings = configured(tmp_path)
    original = worker_state.seed_alert_state

    def fail(*args):
        raise ValueError("startup_failure")

    monkeypatch.setattr(worker_state, "seed_alert_state", fail)
    with pytest.raises(ValueError, match="startup_failure"):
        with worker_state_scope(settings=settings, engine=None, manifest=MANIFEST, resolver=None):
            pass
    monkeypatch.setattr(worker_state, "seed_alert_state", original)
    with worker_state_scope(settings=settings, engine=None, manifest=MANIFEST, resolver=None):
        pass


def test_failure_duplicate_empty_and_namespace_evidence_reopens(tmp_path):
    path = tmp_path / "raw.db"
    first = RECORD.captures[1]
    failure = ProcessingEntry(
        "silver_load",
        first.index_family,
        first.capture_row_id,
        "recorded",
        "failed",
        first.started_at_utc,
        first.captured_at_utc,
        "silver_failure",
        None,
        999,
    )
    record = replace(
        RECORD,
        processing=(failure,),
        captures=tuple(replace(c, entity_count=0) if c == first else c for c in RECORD.captures),
    )
    alert = replace(
        record,
        feed_day=replace(record.feed_day, endpoint_key="i3_alerts", index_family="alert_snapshot"),
        polls=tuple(replace(p, index_family="alert_snapshot") for p in record.polls),
        captures=tuple(replace(c, index_family="alert_snapshot") for c in record.captures),
        processing=(),
    )
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id="network")
        recorder.record(record)
        recorder.record(record)
        recorder.record(alert)
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        assert local.connection.execute(
            "SELECT count(*) FROM polls WHERE status='failed'"
        ).fetchone() == (2,)
        assert local.connection.execute(
            "SELECT count(*) FROM captures WHERE entity_count=0"
        ).fetchone() == (2,)
        assert local.connection.execute("SELECT attribution FROM processing").fetchall() == [
            ("recorded",)
        ]


class PageEngine:
    def __init__(self):
        self.visible = {}
        self.requests = []

    def connect(self):
        return self

    def begin(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, statement, params=None):
        self.statement = str(statement)
        if params is not None and "limit" in params:
            self.requests.append(params)
            if "after" in params:
                self.ids = sorted(i for i in self.visible if params["after"] < i <= params["upper"])
            else:
                self.ids = sorted((i for i in self.visible if i > params["initial"]), reverse=True)
            self.ids = self.ids[: params["limit"]]
        return self

    def scalar_one(self):
        if "EXISTS" in self.statement:
            return getattr(self, "unfinished", False)
        return max(self.visible, default=0)

    def scalars(self):
        return self.ids


def test_bounded_sweeps_recover_observer_gap_late_commit_and_midnight(tmp_path, monkeypatch):
    engine = PageEngine()
    first = replace(RECORD, processing=())
    late = replace(
        first,
        feed_day=replace(first.feed_day, utc_date=first.feed_day.utc_date + timedelta(days=1)),
        polls=tuple(replace(p, ingestion_run_id=p.ingestion_run_id + 100) for p in first.polls),
        captures=tuple(
            replace(
                c, capture_row_id=c.capture_row_id + 100, ingestion_run_id=c.ingestion_run_id + 100
            )
            for c in first.captures
        ),
    )
    engine.visible[20] = first
    monkeypatch.setattr(
        recording,
        "read_working_runs",
        lambda pg, provider_id, run_ids: tuple(engine.visible[i] for i in run_ids),
    )
    path = tmp_path / "cursor.db"
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id="network")
        recorder.initialize(initial_run_id=0, seed_sha256="seed")
        recorder.catch_up(engine, page_size=1)
    engine.visible[10] = late  # lower identity commits after the higher identity
    engine.visible[30] = first  # new traffic must not extend the sweep indefinitely
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        recorder = Recorder(local, provider_id="network")
        recorder.initialize(initial_run_id=0, seed_sha256="seed")
        recorder.catch_up(engine, page_size=1)  # completes the old sweep
        recorder.catch_up(engine, page_size=1)  # discovers the late commit
        assert local.connection.execute("SELECT count(*) FROM polls").fetchone() == (12,)
        assert all(p["limit"] == 1 for p in engine.requests)


def test_pending_export_is_retried_before_new_cut(tmp_path, monkeypatch):
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    path = tmp_path / "segments.db"
    original = storage.__class__.put_if_absent

    def fail(*args):
        raise OSError("upload_failed")

    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        Recorder(local, provider_id="network").record(replace(RECORD, processing=()))
        monkeypatch.setattr(storage.__class__, "put_if_absent", fail)
        with pytest.raises(OSError, match="upload_failed"):
            export_segment(local, storage)
        pending = local.connection.execute(
            "SELECT first_seq, last_seq FROM segment_exports"
        ).fetchone()
        local.record_polls([replace(RECORD.polls[0], ingestion_run_id=1000)], endpoint_key="feed")
    monkeypatch.setattr(storage.__class__, "put_if_absent", original)
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        segment = export_segment(local, storage)
        assert (segment.first_seq, segment.last_seq) == pending
        assert export_segment(local, storage).first_seq == pending[1] + 1


def test_worker_records_before_edition_failure_and_reports_unavailable(tmp_path, monkeypatch):
    settings = configured(tmp_path)
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    engine = PageEngine()
    engine.visible[1] = replace(RECORD, processing=())
    monkeypatch.setattr(
        recording,
        "read_working_runs",
        lambda pg, provider_id, run_ids: tuple(engine.visible[i] for i in run_ids),
    )

    def fail(*args, **kwargs):
        raise ValueError("edition_missing")

    monkeypatch.setattr(worker_state, "current_edition_id", fail)
    with worker_state_scope(
        settings=settings, engine=engine, manifest=MANIFEST, resolver=lambda _: storage
    ) as state:
        state.sync()
        assert state.local.connection.execute("SELECT count(*) FROM polls").fetchone() == (6,)
        state.sync()  # complete input collection before attempting edition/application
        assert state.unavailable == "edition_missing"
        assert state.local.connection.execute(
            "SELECT completed FROM segment_exports"
        ).fetchall() == [(True,)]
        assert not state.local.connection.execute("SELECT * FROM local_serving").fetchall()


def test_enabled_loop_cycles_borrow_one_file_and_close_on_shutdown(tmp_path, monkeypatch):
    from test_orchestration import _patch_worker_startup, _worker_loop_cycle_result

    from transit_ops import orchestration
    from transit_ops.settings import Settings

    settings = Settings(_env_file=None, REALTIME_STARTUP_DELAY_SECONDS=0, REALTIME_POLL_SECONDS=10)
    settings.LIGHTER_STORAGE.live = configured(tmp_path)
    registry = SimpleNamespace(get_provider=lambda _: MANIFEST)
    _patch_worker_startup(monkeypatch)
    monkeypatch.setattr(orchestration, "_worker_trip_updates", lambda *a, **kw: None)
    seen = []

    def cycle(provider_id, **kwargs):
        seen.append(kwargs["worker_state"].local)
        if len(seen) == 1:
            raise ValueError("unexpected_cycle_failure")
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
    assert seen[0] is seen[1]
    orchestration.run_realtime_cycle(
        "network", settings=settings, registry=registry, engine=object()
    )
    assert seen[2] is not seen[0]
    with worker_state_scope(
        settings=settings.LIGHTER_STORAGE.live, engine=None, manifest=MANIFEST, resolver=None
    ) as state:
        assert state.local is not seen[0]


def test_schema_three_refuses_before_new_metadata_is_created(tmp_path):
    path = tmp_path / "old.db"
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        local.connection.execute("UPDATE meta SET schema_version=3")
    with pytest.raises(RuntimeError, match="schema version.*3.*refused"):
        LocalFile.open(path, provider_id="network", settings=SETTINGS)


def test_worker_applies_verified_empty_capture_atomically_with_serving(tmp_path):
    from google.transit import gtfs_realtime_pb2 as pb
    from test_realtime_silver import _build_manifest

    manifest = _build_manifest()
    manifest = manifest.model_copy(
        update={"provider": manifest.provider.model_copy(update={"provider_id": "network"})}
    )
    payload = pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")).SerializeToString()
    storage = LocalBronzeStorage("local", tmp_path)
    (tmp_path / "empty.pb").write_bytes(payload)
    capture = replace(
        RECORD.captures[1],
        byte_size=len(payload),
        sha256=sha256(payload).hexdigest(),
        storage_backend="local",
        storage_path="empty.pb",
        entity_count=0,
    )
    with closing(
        LocalFile.open(tmp_path / "empty.db", provider_id="network", settings=SETTINGS)
    ) as local:
        state = worker_state.WorkerState(
            local, engine=None, manifest=manifest, settings=SETTINGS, resolver=lambda _: storage
        )
        state.recorder.apply(
            "vehicle_positions",
            capture.capture_row_id,
            lambda: state._apply("vehicle_positions", capture),
            capture=capture,
        )
        assert local.connection.execute("SELECT row_count FROM fact_processing").fetchall() == [
            (0,)
        ]
        assert local.connection.execute("SELECT capture_row_id FROM local_serving").fetchall() == [
            (capture.capture_row_id,)
        ]
