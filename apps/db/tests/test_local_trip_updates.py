from contextlib import closing
from dataclasses import replace
from datetime import timedelta
from hashlib import sha256

import pytest
from test_live_captures import POLICY, _message
from test_live_local_file import CAPTURE, POLL, opened

from transit_ops.live.captures import CaptureRef
from transit_ops.live.trip_updates import LocalTripUpdatesError, latest_local_trip_updates
from transit_ops.snapshots.live_trip_updates import LiveTripUpdates


def test_holder_reads_latest_raw_once_without_advancing_serving(tmp_path):
    from transit_ops.live.trip_updates import latest_local_trip_updates

    payload = _message().SerializeToString()
    calls = []
    with closing(opened(tmp_path / "worker.db")) as local:
        for capture_id, seconds in [(11, 0), (23, 1), (19, 1)]:
            capture = replace(
                CAPTURE,
                capture_row_id=capture_id,
                ingestion_run_id=capture_id,
                ingestion_object_id=capture_id,
                captured_at_utc=CAPTURE.captured_at_utc + timedelta(seconds=seconds),
                byte_size=len(payload),
                sha256=sha256(payload).hexdigest(),
            )
            local.record_captures([capture], endpoint_key="trip_updates")
            local.record_polls(
                [
                    replace(
                        POLL,
                        ingestion_run_id=capture_id,
                        capture_row_id=capture_id,
                        feed_timestamp_utc=capture.feed_timestamp_utc,
                        time_utc=capture.captured_at_utc,
                        started_at_utc=capture.started_at_utc,
                        completed_at_utc=capture.captured_at_utc,
                    )
                ],
                endpoint_key="trip_updates",
            )

        def resolve(entry):
            calls.append(entry)
            return payload

        holder = LiveTripUpdates(
            "network",
            policy=POLICY,
            fallback=lambda: latest_local_trip_updates(
                "network", local=local, policy=POLICY, resolve_bytes=resolve
            ),
        )
        before = local.connection.execute("SELECT * FROM local_serving").fetchall()
        assert holder.latest().capture.capture_row_id == 23
        assert holder.latest().capture.capture_row_id == 23
        assert [c.capture_row_id for c in calls] == [23]
        assert local.connection.execute("SELECT * FROM local_serving").fetchall() == before


@pytest.fixture
def evidence(tmp_path):
    payload = _message().SerializeToString()
    with closing(opened(tmp_path / "worker.db")) as local:
        entries = []
        for identity in (10, 20):
            entry = replace(
                CAPTURE,
                ingestion_object_id=identity,
                ingestion_run_id=identity,
                capture_row_id=identity,
                packed=False,
                stream=None,
                offset=None,
                captured_at_utc=CAPTURE.captured_at_utc + timedelta(seconds=identity),
                byte_size=len(payload),
                sha256=sha256(payload).hexdigest(),
            )
            local.record_captures([entry], endpoint_key="trip_updates")
            local.record_polls(
                [
                    replace(
                        POLL,
                        ingestion_run_id=identity,
                        capture_row_id=identity,
                        feed_timestamp_utc=entry.feed_timestamp_utc,
                        time_utc=entry.captured_at_utc,
                        started_at_utc=entry.started_at_utc,
                        completed_at_utc=entry.captured_at_utc,
                    )
                ],
                endpoint_key="trip_updates",
            )
            entries.append(entry)
        yield local, payload, entries


def read(local, resolver):
    return latest_local_trip_updates("network", local=local, policy=POLICY, resolve_bytes=resolver)


def test_newer_failed_poll_and_silver_failure_do_not_hide_raw_success(evidence):
    from test_live_local_file import RECORD

    local, payload, _ = evidence
    local.record_polls(
        [
            replace(
                POLL,
                ingestion_run_id=99,
                capture_row_id=None,
                status="failed",
                run_status="failed",
                time_utc=POLL.time_utc + timedelta(days=1),
            )
        ],
        endpoint_key="trip_updates",
    )
    local.record_processing(
        [
            replace(
                RECORD.processing[0],
                ingestion_run_id=100,
                capture_row_id=20,
            )
        ],
        endpoint_key="trip_updates",
    )
    assert read(local, lambda _: payload).capture.capture_row_id == 20


@pytest.mark.parametrize(
    "change",
    [
        "UPDATE captures SET sha256=repeat('0',64) WHERE capture_row_id=20",
        "UPDATE captures SET byte_size=1 WHERE capture_row_id=20",
        "UPDATE captures SET feed_timestamp_utc=NULL WHERE capture_row_id=20",
        "UPDATE captures SET captured_at_utc=NULL WHERE capture_row_id=20",
        "UPDATE captures SET index_family='alert_snapshot' WHERE capture_row_id=20",
        "UPDATE captures SET endpoint_key='vehicle_positions' WHERE capture_row_id=20",
        "UPDATE captures SET storage_path='' WHERE capture_row_id=20",
        "UPDATE polls SET capture_row_id=999 WHERE ingestion_run_id=20",
        "UPDATE polls SET run_status='failed' WHERE ingestion_run_id=20",
        "UPDATE polls SET feed_timestamp_source='capture_time' WHERE ingestion_run_id=20",
        "UPDATE polls SET endpoint_key='vehicle_positions' WHERE ingestion_run_id=20",
        "DELETE FROM polls WHERE ingestion_run_id=20",
        "UPDATE meta SET provider_id='other'",
    ],
)
def test_latest_invalid_evidence_refuses_without_older_fallback(evidence, change):
    local, payload, _ = evidence
    local.connection.execute(change)
    seen = []

    def resolve(entry):
        seen.append(entry.capture_row_id)
        return payload

    with pytest.raises(LocalTripUpdatesError, match="local_trip_updates_"):
        read(local, resolve)
    assert 10 not in seen


@pytest.mark.parametrize("failure", [FileNotFoundError, OSError])
def test_missing_or_storage_error_is_named_and_never_tries_older(evidence, failure):
    local, _, _ = evidence
    seen = []

    def resolve(entry):
        seen.append(entry.capture_row_id)
        raise failure("unavailable")

    with pytest.raises(LocalTripUpdatesError, match=failure.__name__):
        read(local, resolve)
    assert seen == [20]


@pytest.mark.parametrize("missing", ["latest", "all"])
def test_stored_poll_without_capture_refuses_before_reading_older(evidence, missing):
    local, _, _ = evidence
    if missing == "latest":
        local.connection.execute("DELETE FROM captures WHERE capture_row_id=20")
    else:
        local.connection.execute("DELETE FROM captures")
    with pytest.raises(LocalTripUpdatesError, match="local_trip_updates_"):
        read(local, lambda _: pytest.fail("dangling evidence must refuse before reading bytes"))


@pytest.mark.parametrize(
    "change",
    [
        "UPDATE captures SET captured_at_utc=TIMESTAMP '2099-01-01' WHERE capture_row_id=20",
        "UPDATE captures SET captured_at_utc=TIMESTAMP '2000-01-01' WHERE capture_row_id=20",
        "UPDATE polls SET time_utc=TIMESTAMP '2099-01-01' WHERE ingestion_run_id=20",
        "UPDATE polls SET time_utc=TIMESTAMP '2000-01-01' WHERE ingestion_run_id=20",
        "UPDATE polls SET started_at_utc=NULL WHERE ingestion_run_id=20",
        "UPDATE polls SET started_at_utc=TIMESTAMP '2099-01-01' WHERE ingestion_run_id=20",
        "UPDATE polls SET completed_at_utc=NULL WHERE ingestion_run_id=20",
    ],
)
def test_inconsistent_poll_clock_cannot_hide_or_promote_capture(evidence, change):
    local, payload, entries = evidence
    local.connection.execute(change)
    holder = LiveTripUpdates(
        "network", policy=POLICY, fallback=lambda: read(local, lambda _: payload)
    )
    with pytest.raises(LocalTripUpdatesError, match="local_trip_updates_"):
        holder.latest()
    holder.accept(
        payload,
        CaptureRef.from_entry(
            replace(
                entries[1],
                capture_row_id=30,
                captured_at_utc=entries[1].captured_at_utc + timedelta(seconds=1),
            ),
            provider_id="network",
            endpoint_key="trip_updates",
        ),
    )
    assert holder.latest().capture.capture_row_id == 30


def test_real_missing_latest_object_does_not_read_existing_older(evidence, tmp_path):
    from transit_ops.ingestion.storage import LocalBronzeStorage

    local, payload, _ = evidence
    (tmp_path / "older.pb").write_bytes(payload)
    local.connection.execute(
        "UPDATE captures SET storage_path=CASE capture_row_id "
        "WHEN 10 THEN 'older.pb' ELSE 'missing.pb' END"
    )
    storage = LocalBronzeStorage("local", tmp_path)
    with pytest.raises(LocalTripUpdatesError, match="FileNotFoundError"):
        read(local, lambda entry: storage.read_bytes(entry.storage_path))


def test_corrupt_latest_protobuf_is_not_older_success(evidence):
    local, _, _ = evidence
    body = b"invalid protobuf"
    local.connection.execute(
        "UPDATE captures SET byte_size=?, sha256=? WHERE capture_row_id=20",
        [len(body), sha256(body).hexdigest()],
    )
    with pytest.raises(LocalTripUpdatesError, match="CaptureParseError"):
        read(local, lambda _: body)


def test_none_only_without_candidate_and_other_endpoint_is_not_trip(tmp_path):
    with closing(opened(tmp_path / "empty.db")) as local:
        assert read(local, lambda _: pytest.fail("no bytes")) is None
        local.record_captures([CAPTURE], endpoint_key="vehicle_positions")
        local.record_polls(
            [replace(POLL, run_kind="vehicle_positions")], endpoint_key="vehicle_positions"
        )
        assert read(local, lambda _: pytest.fail("no trip bytes")) is None


def test_full_packed_entry_and_read_only_borrowing(evidence, monkeypatch):
    from types import SimpleNamespace

    local, payload, entries = evidence
    local.connection.execute(
        'UPDATE captures SET packed=true, stream=3, "offset"=17 WHERE capture_row_id=20'
    )
    expected = replace(entries[1], packed=True, stream=3, offset=17)
    calls = []

    class ReadOnly:
        def execute(self, sql, *args):
            assert sql.lstrip().upper().startswith("SELECT")
            return local.connection.execute(sql, *args)

    borrowed = SimpleNamespace(connection=ReadOnly())
    monkeypatch.setattr(type(local), "open", lambda *a, **k: pytest.fail("extra open"))
    monkeypatch.setattr(local, "close", lambda: pytest.fail("borrower closed owner"))

    def resolve(entry):
        assert entry == expected
        calls.append(entry)
        return payload

    assert read(borrowed, resolve).capture.capture_row_id == 20
    assert calls == [expected]
    monkeypatch.undo()


def test_holder_accept_supersedes_fallback_and_preserves_original_serving_stamp(evidence):
    local, payload, entries = evidence
    original = entries[0]
    local.connection.execute(
        "INSERT INTO local_serving VALUES ('trip_updates', ?, ?, ?)",
        [10, original.captured_at_utc, original.feed_timestamp_utc],
    )
    before = local.connection.execute("SELECT * FROM local_serving").fetchall()
    calls = []

    def resolve(entry):
        calls.append(entry.capture_row_id)
        return payload

    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: read(local, resolve))
    assert holder.latest().capture.capture_row_id == 20
    holder.accept(
        payload,
        replace(
            holder.latest().capture,
            capture_row_id=30,
            captured_at_utc=entries[1].captured_at_utc + timedelta(seconds=1),
        ),
    )
    assert holder.latest().capture.capture_row_id == 30
    assert calls == [20]
    assert local.connection.execute("SELECT * FROM local_serving").fetchall() == before
