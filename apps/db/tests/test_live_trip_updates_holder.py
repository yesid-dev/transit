from dataclasses import replace
from types import SimpleNamespace

import pytest
from test_live_captures import AT, POLICY, _capture, _message
from test_realtime_silver import FakeBronzeStorage, FakeEngine, FakeResult, _build_snapshot_row

from transit_ops.live.captures import CaptureIntegrityError, CaptureParseError, parse_capture
from transit_ops.settings import Settings
from transit_ops.snapshots.live_trip_updates import LiveTripUpdates, latest_stored_trip_updates


def test_holder_keeps_the_last_good_capture_when_a_poll_fails():
    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: None)
    payload = _message().SerializeToString()
    holder.accept(payload, _capture(payload))
    good = holder.latest()
    with pytest.raises(CaptureParseError):
        holder.accept(b"\xff", replace(_capture(b"\xff"), capture_row_id=43))
    assert holder.latest() is good
    assert good.capture.captured_at_utc == AT


def test_no_capture_yields_nothing_not_an_error():
    attempts = []
    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: attempts.append(1))
    assert holder.latest() is None
    assert holder.latest() is None
    assert attempts == [1]


def test_empty_success_replaces_nonempty_capture():
    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: None)
    payload = _message().SerializeToString()
    holder.accept(payload, _capture(payload))
    message = _message()
    message.ClearField("entity")
    empty = message.SerializeToString()
    holder.accept(empty, replace(_capture(empty), capture_row_id=43))
    assert holder.latest().entity_count == 0
    assert holder.latest().capture.capture_row_id == 43


def test_holder_isolates_provider_endpoint_and_capture_order():
    payload = _message().SerializeToString()
    capture = _capture(payload)
    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: None)
    for invalid in (
        replace(capture, provider_id="other"),
        replace(capture, endpoint_key="vehicle_positions"),
    ):
        with pytest.raises(ValueError, match="identity"):
            holder.accept(payload, invalid)
    holder.accept(
        payload, replace(capture, capture_row_id=43, feed_timestamp_utc=AT.replace(hour=1))
    )
    good = holder.latest()
    holder.accept(payload, replace(capture, capture_row_id=99, captured_at_utc=AT.replace(hour=1)))
    holder.accept(payload, capture)
    holder.accept(payload, good.capture)
    assert holder.latest() is good
    with pytest.raises(ValueError, match="identity"):
        holder.accept(payload, replace(good.capture, feed_timestamp_utc=AT.replace(hour=2)))


@pytest.mark.parametrize("fault", ["size", "hash", "protobuf"])
def test_capture_integrity_failure_keeps_last_good(fault):
    payload = _message().SerializeToString()
    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: None)
    holder.accept(payload, _capture(payload))
    good = holder.latest()
    bad = replace(_capture(b"\xff"), capture_row_id=43)
    if fault == "size":
        bad = replace(bad, byte_size=99)
    if fault == "hash":
        bad = replace(bad, sha256="0" * 64)
    with pytest.raises(CaptureParseError if fault == "protobuf" else CaptureIntegrityError):
        holder.accept(b"\xff", bad)
    assert holder.latest() is good


def test_payload_tag_text_cannot_change_capture_identity():
    message = _message()
    message.entity[0].id = "[capture_row_id=999]"
    message.entity[0].trip_update.trip.trip_id = "[capture_row_id=999]"
    payload = message.SerializeToString()
    holder = LiveTripUpdates("network", policy=POLICY, fallback=lambda: None)
    holder.accept(payload, _capture(payload))
    assert holder.latest().capture.capture_row_id == 42
    assert holder.latest().frames["rt_trip_updates"].column("trip_id")[0] == "[capture_row_id=999]"


def test_fallback_is_lazy_validated_and_failure_does_not_poison_holder():
    payload = _message().SerializeToString()
    parsed = parse_capture(payload, _capture(payload), POLICY)
    attempts = []

    def fallback():
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("storage unavailable")
        return parsed

    holder = LiveTripUpdates("network", policy=POLICY, fallback=fallback)
    assert attempts == []
    with pytest.raises(OSError):
        holder.latest()
    assert holder.latest() is parsed
    assert holder.latest() is parsed
    assert attempts == [1, 1]
    wrong = LiveTripUpdates("other", policy=POLICY, fallback=lambda: parsed)
    with pytest.raises(ValueError, match="identity"):
        wrong.latest()


def _adapter_case(fault, tmp_path):
    payload = _message().SerializeToString()
    path = tmp_path / "capture.pb"
    path.write_bytes(payload)
    row = _build_snapshot_row(
        path, provider_id="network", endpoint_key="trip_updates", realtime_snapshot_id=42
    )
    row["byte_size"] = None
    storage = FakeBronzeStorage(payload)
    if fault == "checksum":
        row["checksum_sha256"] = "0" * 64
    if fault == "identity":
        row["feed_timestamp_utc"] = None

    def execute(*args):
        if fault == "database":
            raise RuntimeError("database failed")
        return FakeResult(mapping_value=None if fault == "absent" else row)

    def resolve(backend):
        if fault == "missing":
            raise FileNotFoundError("missing object")
        return storage

    engine = FakeEngine(SimpleNamespace(execute=execute), None)

    def lookup():
        return latest_stored_trip_updates(
            "network",
            settings=Settings(_env_file=None),
            policy=POLICY,
            engine=engine,
            bronze_storage_resolver=resolve,
        )

    return lookup, storage


@pytest.mark.parametrize("fault", ["absent", "missing", "database", "checksum", "identity", "ok"])
def test_adapter_failure_contract_without_database(fault, tmp_path):
    lookup, storage = _adapter_case(fault, tmp_path)
    if fault == "absent":
        assert lookup() is None
        assert storage.read_calls == []
    elif fault == "ok":
        parsed = lookup()
        assert parsed.capture.capture_row_id == 42
        assert parsed.capture.byte_size == len(storage.payload)
        assert parsed.frames["rt_entities"].column("entity_id") == ["Côte-Vertu", "second"]
    else:
        error = {
            "missing": FileNotFoundError,
            "database": RuntimeError,
            "checksum": CaptureIntegrityError,
            "identity": ValueError,
        }[fault]
        with pytest.raises(error):
            lookup()
