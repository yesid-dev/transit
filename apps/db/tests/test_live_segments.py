import json
from contextlib import closing
from dataclasses import asdict, replace
from datetime import UTC

import pytest
from test_live_facts import parsed_vehicle
from test_live_local_file import AT, CAPTURE, POLL, SETTINGS, opened

from transit_ops.history.poll_record import ProcessingEntry
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.facts import apply_capture, read_vehicle_facts
from transit_ops.live.local_file import LocalFile, LocalFileMismatch
from transit_ops.live.segments import SegmentInvalid, export_segment, read_segment


def test_mixed_committed_segment_round_trips(tmp_path):
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    with closing(opened(tmp_path / "live.db")) as local:
        with local.transaction():
            local.record_polls(
                [
                    POLL,
                    replace(
                        POLL,
                        ingestion_run_id=3,
                        capture_row_id=None,
                        status="failed",
                        run_status="failed",
                    ),
                ],
                endpoint_key="vehicles",
            )
            local.record_captures(
                [
                    replace(CAPTURE, captured_at_utc=AT),
                    replace(CAPTURE, capture_row_id=9, captured_at_utc=AT),
                ],
                endpoint_key="vehicles",
            )
        result = export_segment(local, storage)
        with closing(opened(tmp_path / "reader.db")) as reader:
            frames = read_segment(reader, storage, result)
        assert len(frames["polls"].rows) == 2
        capture = dict(zip(frames["captures"].columns, frames["captures"].rows[0], strict=True))
        assert capture["storage_path"] == "é/车辆"
        assert capture["captured_at_utc"] == AT
        assert capture["captured_at_utc"].tzinfo == UTC
        for row, original in zip(
            frames["captures"].rows,
            [
                replace(CAPTURE, captured_at_utc=AT),
                replace(CAPTURE, capture_row_id=9, captured_at_utc=AT),
            ],
            strict=True,
        ):
            restored = dict(zip(frames["captures"].columns, row, strict=True))
            assert {name: restored[name] for name in asdict(original)} == asdict(original)
        assert frames["fact_vehicle_snapshot"].rows == ()
        assert export_segment(local, storage) is None


def store(tmp_path):
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    return storage


def test_facts_raw_and_silver_failure_and_empty_capture_remain_distinct(tmp_path):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        parsed = parsed_vehicle()
        local.record_captures(
            [replace(CAPTURE, capture_row_id=42)], endpoint_key="vehicle_positions"
        )
        apply_capture(local, parsed, provider_timezone="UTC")
        local.record_processing(
            [
                ProcessingEntry(
                    "silver_load",
                    "realtime_snapshot",
                    2,
                    "recorded",
                    "failed",
                    AT,
                    AT,
                    "capture_row_id=2 failed",
                    None,
                    4,
                )
            ],
            endpoint_key="vehicles",
        )
        expected = read_vehicle_facts(local)
        segment = export_segment(local, storage)
        frames = read_segment(local, storage, segment)
        assert frames["fact_vehicle_snapshot"] == expected
        assert len(frames["captures"].rows) == 1
        assert len(frames["processing"].rows) == 1
        assert frames["fact_processing"].rows[0][-1] == len(expected.rows)
        manifest = json.loads(storage.read_bytes(segment.prefix + "/manifest.json"))
        assert all(p["object_sha256"] and p["row_sha256"] for p in manifest["tables"])
        assert all(t != "TIMESTAMP" for p in manifest["tables"] for _, t in p["schema"])


@pytest.mark.parametrize("cut", [1, 3, 6])
def test_upload_loss_pins_range_and_retry_repairs_missing_objects(tmp_path, monkeypatch, cut):
    storage = store(tmp_path)
    original = LocalBronzeStorage.put_if_absent
    calls = 0

    def fail(self, path, key):
        nonlocal calls
        calls += 1
        if calls == cut:
            raise OSError("upload lost")
        return original(self, path, key)

    path = tmp_path / "live.db"
    with closing(opened(path)) as local:
        local.record_polls([POLL], endpoint_key="vehicles")
        with monkeypatch.context() as patch:
            patch.setattr(LocalBronzeStorage, "put_if_absent", fail)
            with pytest.raises(OSError, match="upload lost"):
                export_segment(local, storage)
        assert local.connection.execute("SELECT completed FROM segment_exports").fetchall() == [
            (False,)
        ]
    # Restart and commit newer records; retry must keep the old cut.
    with closing(opened(path)) as local:
        local.record_polls([replace(POLL, ingestion_run_id=100)], endpoint_key="vehicles")
        segment = export_segment(local, storage)
        assert (segment.first_seq, segment.last_seq) == (1, 1)
        assert len(read_segment(local, storage, segment)["polls"].rows) == 1
        newer = export_segment(local, storage)
        assert (newer.first_seq, newer.last_seq) == (2, 2)
        assert export_segment(local, storage) is None


@pytest.mark.parametrize("failure", ["conflict", "readback", "checkpoint"])
def test_failure_never_advances_checkpoint_and_identical_retry_is_safe(
    tmp_path, monkeypatch, failure
):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        local.record_polls([POLL], endpoint_key="vehicles")
        original_put = LocalBronzeStorage.put_if_absent
        original_read = LocalBronzeStorage.open_stream
        conn = local.connection
        damaged_key = []

        def put(self, path, key):
            if failure == "conflict" and not damaged_key:
                path.write_bytes(b"occupied")
                damaged_key.append(key)
            return original_put(self, path, key)

        def read(self, key, **kwargs):
            if failure == "readback":
                raise OSError("readback lost")
            return original_read(self, key, **kwargs)

        class CheckpointFailure:
            def execute(self, sql, *args):
                if sql.startswith("UPDATE segment_exports SET completed=true"):
                    raise OSError("checkpoint lost")
                return conn.execute(sql, *args)

        with monkeypatch.context() as patch:
            patch.setattr(LocalBronzeStorage, "put_if_absent", put)
            patch.setattr(LocalBronzeStorage, "open_stream", read)
            if failure == "checkpoint":
                patch.setattr(local, "connection", CheckpointFailure())
            with pytest.raises((OSError, SegmentInvalid)):
                export_segment(local, storage)
        assert conn.execute("SELECT completed FROM segment_exports").fetchall() == [(False,)]
        if failure == "conflict":
            with pytest.raises(SegmentInvalid, match="object_identity_conflict"):
                export_segment(local, storage)
            assert storage.read_bytes(damaged_key[0]) == b"occupied"
        else:
            segment = export_segment(local, storage)
            assert len(read_segment(local, storage, segment)["polls"].rows) == 1
            assert export_segment(local, storage) is None


def test_transaction_rollback_and_uncommitted_export_cannot_publish(tmp_path):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        with pytest.raises(RuntimeError, match="rollback"):
            with local.transaction():
                local.record_polls([POLL], endpoint_key="vehicles")
                with pytest.raises(LocalFileMismatch, match="committed"):
                    export_segment(local, storage)
                raise RuntimeError("rollback")
        assert list(storage.list_keys("live/")) == []
        assert export_segment(local, storage) is None
        local.record_polls([POLL], endpoint_key="vehicles")
        assert export_segment(local, storage).first_seq == 1


def test_provider_isolation_and_tampered_identity_refuse(tmp_path):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        local.record_polls([POLL], endpoint_key="vehicles")
        segment = export_segment(local, storage)
        with closing(
            LocalFile.open(tmp_path / "other.db", provider_id="other", settings=SETTINGS)
        ) as other:
            with pytest.raises(SegmentInvalid, match="provider_mismatch"):
                read_segment(other, storage, segment)
            other.record_polls([POLL], endpoint_key="vehicles")
            other_segment = export_segment(other, storage)
            assert other_segment.prefix != segment.prefix
        manifest_path = storage.root / segment.prefix / "manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["last"] = 99
        manifest_path.write_text(json.dumps(manifest))
        with pytest.raises(SegmentInvalid, match="identity_mismatch"):
            read_segment(local, storage, segment)


def test_later_fact_application_is_exported_after_raw_capture(tmp_path):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        local.record_captures(
            [replace(CAPTURE, capture_row_id=42)], endpoint_key="vehicle_positions"
        )
        raw = export_segment(local, storage)
        assert read_segment(local, storage, raw)["fact_vehicle_snapshot"].rows == ()
        apply_capture(local, parsed_vehicle(), provider_timezone="UTC")
        silver = export_segment(local, storage)
        frames = read_segment(local, storage, silver)
        assert frames["captures"].rows == ()
        assert frames["fact_vehicle_snapshot"] == read_vehicle_facts(local)
        assert silver.first_seq > raw.last_seq


def test_empty_successful_capture_retains_typed_facts_and_zero_row_receipt(tmp_path):
    from google.transit import gtfs_realtime_pb2 as pb

    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        apply_capture(
            local,
            parsed_vehicle(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0"))),
            provider_timezone="UTC",
        )
        segment = export_segment(local, storage)
        frames = read_segment(local, storage, segment)
        assert frames["fact_vehicle_snapshot"].rows == ()
        assert "latitude" in frames["fact_vehicle_snapshot"].columns
        assert frames["fact_processing"].rows[0][-1] == 0


def test_pending_cut_refuses_changed_source(tmp_path, monkeypatch):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        local.record_polls([POLL], endpoint_key="vehicles")

        def fail(*args):
            raise OSError("offline")

        with monkeypatch.context() as patch:
            patch.setattr(LocalBronzeStorage, "put_if_absent", fail)
            with pytest.raises(OSError):
                export_segment(local, storage)
        local.connection.execute("UPDATE polls SET error_message='changed'")
        with pytest.raises(SegmentInvalid, match="pending_segment_identity_changed"):
            export_segment(local, storage)
        assert list(storage.list_keys("live/")) == []


@pytest.mark.parametrize(
    "table,column", [("polls", "endpoint_key"), ("segment_exports", "manifest")]
)
@pytest.mark.parametrize("new_poll", [False, True])
def test_same_connection_collation_drift_refuses_before_export_or_noop(
    tmp_path, table, column, new_poll
):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        local.record_polls([POLL], endpoint_key="vehicles")
        export_segment(local, storage)
        if new_poll:
            local.record_polls([replace(POLL, ingestion_run_id=9)], endpoint_key="vehicles")
        conn = local.connection
        before = conn.execute("SELECT * FROM segment_exports").fetchall()
        objects = {k: storage.read_bytes(k) for k in storage.list_keys("live/")}
        sql = conn.execute(
            "SELECT sql FROM duckdb_tables() WHERE table_name=?", [table]
        ).fetchone()[0]
        definition = sql.split("(", 1)[1].rsplit(")", 1)[0]
        definition = definition.replace(f"{column} VARCHAR", f"{column} VARCHAR COLLATE NOCASE")
        with local.transaction():
            conn.execute(f"ALTER TABLE {table} RENAME TO old_shape")
            conn.execute(f"CREATE TABLE {table} ({definition})")
            conn.execute(f"INSERT INTO {table} SELECT * FROM old_shape")
            conn.execute("DROP TABLE old_shape")
        with pytest.raises(LocalFileMismatch, match=table + " table shape differs"):
            export_segment(local, storage)
        assert conn.execute("SELECT * FROM segment_exports").fetchall() == before
        assert {k: storage.read_bytes(k) for k in storage.list_keys("live/")} == objects


def test_retry_and_noop_do_not_fetch_retained_fact_payloads(tmp_path, monkeypatch):
    storage = store(tmp_path)
    with closing(opened(tmp_path / "live.db")) as local:
        conn = local.connection
        touched = []

        class CountedResult:
            def __init__(self, result, count):
                self.result, self.count = result, count

            def fetchall(self):
                rows = self.result.fetchall()
                if self.count:
                    touched.extend(rows)
                return rows

            def fetchmany(self, size):
                rows = self.result.fetchmany(size)
                if self.count:
                    touched.extend(rows)
                return rows

            def __getattr__(self, name):
                return getattr(self.result, name)

        class CountedConnection:
            def execute(self, sql, *args):
                return CountedResult(
                    conn.execute(sql, *args),
                    sql.startswith("SELECT ")
                    and "fact_vehicle_snapshot" in sql
                    and "read_parquet" not in sql,
                )

            def __getattr__(self, name):
                return getattr(conn, name)

        monkeypatch.setattr(local, "connection", CountedConnection())
        parsed = parsed_vehicle()
        apply_capture(local, parsed, provider_timezone="UTC")
        first = export_segment(local, storage)
        touched.clear()
        assert export_segment(local, storage) is None
        assert touched == []
        newer = replace(parsed, capture=replace(parsed.capture, capture_row_id=43))
        apply_capture(local, newer, provider_timezone="UTC")

        def fail(*args):
            raise OSError("offline")

        with monkeypatch.context() as patch:
            patch.setattr(LocalBronzeStorage, "put_if_absent", fail)
            with pytest.raises(OSError):
                export_segment(local, storage)
        touched.clear()
        second = export_segment(local, storage)
        assert touched and {r[1] for r in touched} == {43}
        assert len(touched) == 4
        touched.clear()
        assert export_segment(local, storage) is None
        assert touched == []
        assert second.first_seq == first.last_seq + 1


def test_abrupt_exit_after_verified_publication_recovers_original_cut(tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    from transit_ops.live.segments import Segment

    storage = store(tmp_path)
    path = tmp_path / "live.db"
    with closing(opened(path)) as local:
        local.record_polls([POLL], endpoint_key="vehicles")
        apply_capture(local, parsed_vehicle(), provider_timezone="UTC")
        expected = read_vehicle_facts(local)
    program = """
import os, sys
from pathlib import Path
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.local_file import LocalFile
from transit_ops.live.settings import LaneSettings
from transit_ops.live.segments import export_segment
local = LocalFile.open(Path(sys.argv[1]), provider_id='network', settings=LaneSettings(
    duckdb_memory_limit_mb=64, duckdb_threads=1, temp_dir_max_mb=32))
conn = local.connection
class ExitBeforeCheckpoint:
    def execute(self, sql, *args):
        if sql.startswith('UPDATE segment_exports SET completed=true'):
            os._exit(71)
        return conn.execute(sql, *args)
local.connection = ExitBeforeCheckpoint()
export_segment(local, LocalBronzeStorage('local', Path(sys.argv[2])))
"""
    child = subprocess.run(
        [sys.executable, "-c", program, str(path), str(storage.root)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert child.returncode == 71, child.stderr
    assert Path(str(path) + ".wal").is_file()
    manifests = list(storage.list_keys("live/"))
    (manifest_key,) = [k for k in manifests if k.endswith("/manifest.json")]
    manifest = json.loads(storage.read_bytes(manifest_key))
    original = Segment(
        manifest["provider"], manifest["first"], manifest["last"], manifest["content_sha256"]
    )
    with closing(opened(path)) as local:
        assert local.connection.execute("SELECT completed FROM segment_exports").fetchall() == [
            (False,)
        ]
        local.record_polls([replace(POLL, ingestion_run_id=9)], endpoint_key="vehicles")
        recovered = export_segment(local, storage)
        assert recovered == original
        frames = read_segment(local, storage, recovered)
        assert frames["fact_vehicle_snapshot"] == expected
        (poll,) = frames["polls"].rows
        restored = dict(zip(frames["polls"].columns, poll, strict=True))
        assert {n: restored[n] for n in asdict(POLL)} == asdict(POLL)
        following = export_segment(local, storage)
        assert following.first_seq == recovered.last_seq + 1
        (next_poll,) = read_segment(local, storage, following)["polls"].rows
        assert next_poll[0] == 9
        keys = [k for k in storage.list_keys("live/") if k.endswith("/manifest.json")]
        assert sorted(keys) == sorted([manifest_key, following.prefix + "/manifest.json"])
        assert export_segment(local, storage) is None
