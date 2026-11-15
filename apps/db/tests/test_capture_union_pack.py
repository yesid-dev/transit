import hashlib
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from io import BytesIO

import pytest
from history_fixtures import scripted_feed_day
from history_reader_bytes_fixtures import _store_example

from transit_ops.history.capture_pack import pack_union_day
from transit_ops.history.capture_union import union_capture_record
from transit_ops.history.manifest import encode_manifest
from transit_ops.history.pack import PackCorrupt, read_pack, write_pack
from transit_ops.history.seal_captures import pack_working_day
from transit_ops.ingestion.storage import BronzeStorageError, LocalBronzeStorage


@pytest.fixture(params=["realtime_snapshot", "alert_snapshot"])
def day(tmp_path, request):
    record, payloads = scripted_feed_day(index_family=request.param)
    store = LocalBronzeStorage("local", tmp_path / "objects")
    store.root.mkdir()
    out = BytesIO()
    pack = write_pack(payloads, out)
    record, current, copy, _ = _store_example(store.root, record, pack, out.getvalue(), payloads)
    copy = replace(
        copy,
        byte_size=pack.byte_size,
        sha256=pack.sha256,
        content_sha256=current.content_sha256,
        poll_record_sha256=current.poll_record_sha256,
        verified_at_utc=current.sealed_at_utc,
    )
    for c in record.captures[:3]:
        (store.root / c.storage_path).unlink()
    late = replace(
        record.captures[0],
        capture_row_id=40,
        ingestion_run_id=4,
        ingestion_object_id=40,
        captured_at_utc=record.captures[0].captured_at_utc + timedelta(seconds=15),
        storage_path="late",
        packed=False,
        stream=None,
        offset=None,
        byte_size=4,
        sha256=hashlib.sha256(b"late").hexdigest(),
    )
    poll = replace(record.polls[4], status="stored", capture_row_id=40)
    working = replace(record, polls=(poll,), captures=(late,), processing=())
    union = union_capture_record(current, working)
    (store.root / "late").write_bytes(b"late")
    return union, store, copy, current, tmp_path


def test_union_pack_reads_trimmed_bytes_from_the_current_pack(day):
    record, store, copy, current, directory = day
    before = (store.root / copy.storage_path).read_bytes()
    result = pack_union_day(
        record, lambda _: store, current_copy=copy, current=current, directory=directory
    )
    with result.path.open("rb") as source:
        assert list(read_pack(source, result.pack.streams, result.pack.captures)) == [
            b"first",
            b"late",
            b"second",
            b"second",
        ]
    assert [c.capture_row_id for c in result.record.captures if c.packed] == [0, 40, 1, 2]
    statuses = [p.status for p in result.record.polls]
    assert statuses == ["stored", "stored", "stored", "failed", "stored", "capture_missing"]
    assert result.record.polls[-1].missing_reason == "absent"
    assert (store.root / copy.storage_path).read_bytes() == before
    assert (store.root / "late").read_bytes() == b"late"


@pytest.mark.parametrize(
    "damage", ["absent", "corrupt", "checksum", "transport", "manifest", "capture_size"]
)
def test_union_pack_never_downgrades_old_packed_bytes(day, monkeypatch, damage):
    record, store, copy, current, directory = day
    path = store.root / copy.storage_path
    before = path.read_bytes()
    # Even valid original objects must never substitute for a broken archive.
    for i, data in enumerate((b"first", b"second", b"second")):
        original = store.root / f"capture/{i}"
        original.parent.mkdir(exist_ok=True)
        original.write_bytes(data)
    error = PackCorrupt
    if damage == "absent":
        path.unlink()
    elif damage == "corrupt":
        path.write_bytes(before[:-1])
    elif damage == "checksum":
        current = replace(current, pack=replace(current.pack, sha256="0" * 64))
        copy = replace(
            copy,
            sha256="0" * 64,
            manifest_sha256=hashlib.sha256(encode_manifest(current)).hexdigest(),
        )
    elif damage == "manifest":
        copy = replace(copy, manifest_sha256="0" * 64)
        error = ValueError
    elif damage == "capture_size":
        current = replace(
            current, captures=(replace(current.captures[0], byte_size=6), *current.captures[1:])
        )
        record = replace(
            record, captures=(replace(record.captures[0], byte_size=6), *record.captures[1:])
        )
        copy = replace(copy, manifest_sha256=hashlib.sha256(encode_manifest(current)).hexdigest())
    else:

        def fail(*args, **kwargs):
            raise BronzeStorageError("transport")

        monkeypatch.setattr(LocalBronzeStorage, "open_stream", fail)
        error = BronzeStorageError
    with pytest.raises(error):
        pack_union_day(
            record, lambda _: store, current_copy=copy, current=current, directory=directory
        )
    assert not (directory / "2026-01-02.pack.xz").exists()
    assert (store.root / "capture/0").read_bytes() == b"first"
    if damage not in ("absent", "corrupt"):
        assert path.read_bytes() == before


@pytest.mark.parametrize("payload,reason", [(None, "object_absent"), (b"bad", "object_mismatch")])
def test_union_pack_distinguishes_missing_new_bytes_from_archive_corruption(day, payload, reason):
    record, store, copy, current, directory = day
    path = store.root / "late"
    path.unlink() if payload is None else path.write_bytes(payload)
    result = pack_union_day(
        record, lambda _: store, current_copy=copy, current=current, directory=directory
    )
    assert [c.capture_row_id for c in result.record.captures if c.packed] == [0, 1, 2]
    assert result.record.polls[4].missing_reason == reason


def test_union_pack_is_bounded_and_closes_streams_on_failure(day, monkeypatch):
    record, store, copy, current, directory = day
    original = LocalBronzeStorage.open_stream
    active, opened = [], []

    @contextmanager
    def guarded(self, key, **kwargs):
        opened.append(key)
        if key == "late":
            assert active == [copy.storage_path]
            raise BronzeStorageError("late transport failure")
        with original(self, key, **kwargs) as source:
            active.append(key)

            class Bounded:
                def read(self, size=-1):
                    assert 0 < size <= 65536
                    return source.read(size)

            try:
                yield Bounded()
            finally:
                active.remove(key)

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", guarded)
    with pytest.raises(BronzeStorageError, match="late transport"):
        pack_union_day(
            record, lambda _: store, current_copy=copy, current=current, directory=directory
        )
    assert not active and opened == [copy.storage_path, "late"]
    assert not (directory / "2026-01-02.pack.xz").exists()
    (store.root / copy.storage_path).rename(store.root / "closed.xz")


def test_working_pack_propagates_transport_failure_after_oversized_bytes(day, monkeypatch):
    record, store, _, _, directory = day
    record = replace(record, captures=record.captures[:1], polls=record.polls[:1], processing=())

    @contextmanager
    def oversized(self, key, **kwargs):
        class TailFailure:
            calls = 0

            def read(self, size=-1):
                self.calls += 1
                if self.calls == 1:
                    return b"first!"
                raise BronzeStorageError("tail transport")

        yield TailFailure()

    monkeypatch.setattr(LocalBronzeStorage, "open_stream", oversized)
    monkeypatch.setattr(LocalBronzeStorage, "exists", lambda *args: True)
    with pytest.raises(BronzeStorageError, match="tail transport"):
        pack_working_day(record, lambda _: store, directory=directory)
    assert not (directory / "2026-01-02.pack.xz").exists()
