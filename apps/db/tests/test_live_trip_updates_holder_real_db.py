from datetime import UTC, datetime
from pathlib import Path

import pytest
import real_db_seed as seed
import realtime_replay_fixtures as replay
from realtime_replay_fixtures import bronze_root as bronze_root
from realtime_replay_fixtures import engine as engine
from realtime_replay_fixtures import settings as settings
from sqlalchemy import text
from test_live_captures import POLICY
from test_realtime_silver import FakeEngine

from transit_ops.live.captures import CaptureIntegrityError, CaptureParseError
from transit_ops.snapshots.live_trip_updates import latest_stored_trip_updates


def _lookup(engine, settings):
    with engine.connect() as c, c.begin():
        c.exec_driver_sql("SET TRANSACTION READ ONLY")
        return latest_stored_trip_updates(
            replay.PROVIDER, settings=settings, policy=POLICY, engine=FakeEngine(c, None)
        )


def _seed(engine, seed_provider):
    with engine.begin() as c:
        replay._seed_provider_and_static(c, seed_provider)
        # Equal capture clocks must use the raw capture id, never the feed clock.
        replay._seed_raw_realtime_snapshots(c)
        c.execute(
            text(
                "UPDATE raw.realtime_snapshot_index SET captured_at_utc=:t, "
                "feed_timestamp_utc=CASE WHEN realtime_snapshot_id=994601 THEN :later ELSE :t END "
                "WHERE realtime_snapshot_id IN (994601, 994602)"
            ),
            {"t": replay.SNAPSHOTS[0][3], "later": replay.SNAPSHOTS[1][3]},
        )


@pytest.fixture()
def decoys(engine, seed_provider):
    _seed(engine, seed_provider)
    with engine.begin() as c:
        seed_provider(c, "holder_other", display_name="Other")
        seed.feed_endpoints(c, {"e": 994403, "p": "holder_other"})
        seed.feed_endpoints(
            c,
            {"e": 994404, "p": replay.PROVIDER},
            endpoint_key="'vehicle_positions'",
            feed_kind="'vehicle_positions'",
        )
        for i, endpoint, provider, status in (
            (3, replay.TRIP_ENDPOINT_ID, replay.PROVIDER, "failed"),
            (4, 994403, "holder_other", "succeeded"),
            (5, 994404, replay.PROVIDER, "succeeded"),
            (6, replay.TRIP_ENDPOINT_ID, replay.PROVIDER, "succeeded"),
            (7, replay.TRIP_ENDPOINT_ID, replay.PROVIDER, "succeeded"),
        ):
            base = 994600 + i
            p = dict(s=base, r=base + 100, o=base + 300, e=endpoint, p=provider, status=status)
            seed.ingestion_runs(c, p, status=":status")
            seed.ingestion_objects(
                c, p | {"path": f"unreadable/{p['o']}.pb"}, storage_backend="'local'"
            )
            seed.realtime_snapshot_index(
                c, p | dict(ts=replay.WINDOW_END, n=0), ingestion_object_id=":o"
            )
        for table, key, identity in (
            ("ingestion_objects", "ingestion_object_id", 994906),
            ("ingestion_runs", "ingestion_run_id", 994707),
        ):
            c.execute(
                text(f"UPDATE raw.{table} SET provider_id='holder_other' WHERE {key}=:id"),
                {"id": identity},
            )
    yield
    with engine.begin() as c:
        for table, key, lower in (
            ("realtime_snapshot_index", "realtime_snapshot_id", 994603),
            ("ingestion_objects", "ingestion_object_id", 994903),
            ("ingestion_runs", "ingestion_run_id", 994703),
        ):
            c.execute(
                text(f"DELETE FROM raw.{table} WHERE {key} BETWEEN :lo AND :hi"),
                {"lo": lower, "hi": lower + 4},
            )
        c.execute(text("DELETE FROM core.feed_endpoints WHERE provider_id='holder_other'"))
        c.execute(text("DELETE FROM core.providers WHERE provider_id='holder_other'"))


def test_cold_start_reads_the_latest_stored_capture(engine, settings, seed_provider, decoys):
    parsed = _lookup(engine, settings)
    assert parsed.capture.capture_row_id == 994602
    assert parsed.capture.captured_at_utc == replay.SNAPSHOTS[0][3]
    assert parsed.capture.feed_timestamp_utc == datetime(2026, 6, 20, 12, 10, tzinfo=UTC)
    assert parsed.frames["rt_trip_updates"].column("trip_id") == ["T_REPLAY"]
    assert parsed.frames["rt_trip_update_stop_times"].column("stop_id") == ["S2"]
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE raw.realtime_snapshot_index SET captured_at_utc=:t, feed_timestamp_utc=:f "
                "WHERE realtime_snapshot_id=994601"
            ),
            {"t": datetime(2026, 6, 20, 12, 15, tzinfo=UTC), "f": replay.WINDOW_START},
        )
    latest = _lookup(engine, settings).capture
    assert latest.capture_row_id == 994601
    assert latest.captured_at_utc == datetime(2026, 6, 20, 12, 15, tzinfo=UTC)
    assert latest.feed_timestamp_utc == datetime(2026, 6, 20, 12, tzinfo=UTC)


@pytest.mark.parametrize(
    "fault", ["absent", "missing", "corrupt", "protobuf", "identity", "legacy"]
)
def test_cold_start_distinguishes_absence_from_unreadable_capture(
    engine, settings, seed_provider, fault
):
    if fault == "absent":
        assert _lookup(engine, settings) is None
        return
    _seed(engine, seed_provider)
    path = Path(settings.BRONZE_LOCAL_ROOT) / replay._storage_path(994602)
    if fault == "missing":
        # Keep filesystem operations within the disposable fixture root.
        settings = settings.model_copy(update={"BRONZE_LOCAL_ROOT": str(path.parent / "missing")})
    elif fault == "corrupt":
        path.write_bytes(b"corrupt")
    else:
        from hashlib import sha256

        update = {
            "protobuf": "ingestion_objects SET byte_size=1, checksum_sha256=:h "
            "WHERE ingestion_object_id=994902",
            "identity": "ingestion_objects SET checksum_sha256=NULL "
            "WHERE ingestion_object_id=994902",
            "legacy": "ingestion_objects SET byte_size=NULL WHERE ingestion_object_id=994902",
        }[fault]
        with engine.begin() as c:
            c.execute(text("UPDATE raw." + update), {"h": sha256(b"\xff").hexdigest()})
        if fault == "legacy":
            assert _lookup(engine, settings).capture.byte_size == len(path.read_bytes())
            path.write_bytes(b"corrupt")
        if fault == "protobuf":
            path.write_bytes(b"\xff")
    error = {
        "missing": FileNotFoundError,
        "protobuf": CaptureParseError,
        "identity": ValueError,
    }.get(fault, CaptureIntegrityError)
    with pytest.raises(error):
        _lookup(engine, settings)



def test_capture_load_with_holder_keeps_silver_rows(engine, settings, seed_provider, monkeypatch):
    from dataclasses import replace
    from hashlib import sha256

    from test_live_captures import FRAME_COLUMNS
    from test_orchestration import _realtime_ingestion_result
    from test_realtime_silver import FakeBronzeStorage

    from transit_ops import capture_load
    from transit_ops.snapshots.live_trip_updates import LiveTripUpdates

    _seed(engine, seed_provider)
    raw_id, run_id, object_id, at, delay = replay.SNAPSHOTS[0]
    payload = replay._build_trip_update_bytes(captured_at=at, delay_seconds=delay)
    receipt = replace(
        _realtime_ingestion_result("trip_updates", raw_id, replay.PROVIDER),
        ingestion_run_id=run_id, ingestion_object_id=object_id,
        completed_at_utc=at, feed_timestamp_utc=at, byte_size=len(payload),
        checksum_sha256=sha256(payload).hexdigest(),
    )
    monkeypatch.setattr(capture_load, "_capture_realtime_feed", lambda *a, **k: (receipt, payload))
    holder = LiveTripUpdates(replay.PROVIDER, policy=POLICY,
                             fallback=lambda: pytest.fail("warm path used fallback"))
    class NoRead(FakeBronzeStorage):
        def read_bytes(self, storage_path):
            pytest.fail("warm load reread Bronze")
    inventories = []
    for observer in (None, holder.accept):
        result = capture_load.capture_and_load_realtime(
            replay.PROVIDER, "trip_updates", settings=settings, registry=replay._StubRegistry(),
            engine=engine, bronze_storage_resolver=lambda _: NoRead(payload),
            on_trip_updates_loaded=observer,
        )
        assert result.failure is None
        with engine.connect() as c:
            inventories.append({
                table: tuple(tuple(row) for row in c.execute(text(
                    f"SELECT {', '.join(columns)} FROM silver.{table} "
                    "WHERE provider_id=:p ORDER BY entity_index" +
                    (", stop_time_update_index" if table.endswith("stop_times") else "")
                ), {"p": replay.PROVIDER}).all())
                for table, columns in FRAME_COLUMNS.items()
            })
    assert inventories[0] == inventories[1]
    assert inventories[1] == {table: frame.rows for table, frame in holder.latest().frames.items()}
    assert holder.latest().frames["rt_trip_update_stop_times"].column("arrival_time_utc") == [
        datetime(2026, 6, 20, 16, 9, tzinfo=UTC)
    ]
