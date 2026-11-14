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
                "UPDATE raw.realtime_snapshot_index SET captured_at_utc=:t "
                "WHERE realtime_snapshot_id=994602"
            ),
            {"t": replay.SNAPSHOTS[0][3]},
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
            seed.ingestion_objects(c, p, storage_backend="'local'", storage_path="'unreadable.pb'")
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
    assert parsed.frames["rt_trip_updates"].column("trip_id") == ["T_REPLAY"]
    assert parsed.frames["rt_trip_update_stop_times"].column("stop_id") == ["S2"]


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
