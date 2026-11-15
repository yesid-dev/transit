from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from history_fixtures import seed_stored_capture, seed_working_day
from sqlalchemy import text
from test_history_writers_use_ledger_store import verification as verification
from test_seal_captures_real_db import (
    DAY,
    PROVIDER,
    START,
    manifest,
    packed,
)
from test_seal_captures_real_db import (
    engine as engine,
)

from transit_ops.history import ledger_select, seal_captures
from transit_ops.history.ledger_store import WindowChanged, WindowIdentity
from transit_ops.history.seal_captures import CopyContentMissing
from transit_ops.history.store import seal
from transit_ops.history.working_captures import rows_fingerprint
from transit_ops.ingestion.storage import BronzeStorageError, LocalBronzeStorage, S3BronzeStorage


@pytest.fixture(params=["trip_updates", "i3_alerts"])
def endpoint(request):
    return request.param


def identity(endpoint):
    return WindowIdentity("capture." + endpoint, PROVIDER, DAY.isoformat())


def run(engine, root, endpoint, storage=None):
    with engine.connect() as conn:
        return seal(
            conn,
            storage or (lambda backend: LocalBronzeStorage("local", root)),
            dataset_id="capture." + endpoint,
            provider_id=PROVIDER,
            window_key=DAY.isoformat(),
            archive_backend="local",
            sealed_by="test",
        )


def add(engine, root, endpoint, n, payload=b"late"):
    with engine.begin() as conn:
        seed_stored_capture(
            conn,
            root,
            provider_id=PROVIDER,
            endpoint_key=endpoint,
            run_id=771000 + n,
            capture_id=771000 + n,
            started_at_utc=START + timedelta(seconds=n * 30),
            payload=payload,
        )


def promote(engine, endpoint, copy):
    with (
        engine.begin() as conn,
        ledger_select.ledger_for(conn).session(identity(endpoint)) as window,
    ):
        window.make_current(copy.content_version, verified_at=window.now(), actor="test")


def snapshot(engine, endpoint):
    with engine.begin() as conn:
        store = ledger_select.ledger_for(conn)
        key = identity(endpoint)
        return (
            store.window_state(key),
            store.find_copies(dataset_id=key.dataset_id, provider_id=PROVIDER, start=DAY, end=DAY),
            store.events(key),
        )


def record_remainder(conn, endpoint):
    # Synthetic trim evidence: no production trim command is invoked.
    fp = rows_fingerprint(conn, provider_id=PROVIDER, endpoint_key=endpoint, utc_date=DAY)
    conn.execute(
        text(
            "INSERT INTO core.history_event "
            "(dataset_id,provider_id,revision,window_key,kind,details,actor) "
            "VALUES (:d,:p,0,:day,'trim',jsonb_build_object("
            "'remainder_fingerprint',CAST(:fp AS text)),'test')"
        ),
        dict(d="capture." + endpoint, p=PROVIDER, day=DAY.isoformat(), fp=fp),
    )


def trim(engine, root, endpoint, state="trimmed", remainder=True):
    add(engine, root, endpoint, 1, b"old bytes")
    first = run(engine, root, endpoint)
    promote(engine, endpoint, first)
    old = manifest(root, first)
    with engine.begin() as conn:
        for table in (
            "realtime_snapshot_index",
            "i3_alert_snapshots",
            "ingestion_objects",
            "ingestion_runs",
        ):
            conn.execute(text(f"DELETE FROM raw.{table} WHERE provider_id=:p"), {"p": PROVIDER})
        conn.execute(
            text(
                "UPDATE core.history_window SET working_state=:s, "
                "trimmed_at_utc=clock_timestamp() WHERE provider_id=:p"
            ),
            {"p": PROVIDER, "s": state},
        )
        if remainder:
            record_remainder(conn, endpoint)
    (root / old.captures[0].storage_path).unlink()
    return first, old


def test_late_capture_in_a_trimmed_day_is_sealed_with_the_old_bytes(engine, tmp_path, endpoint):
    first, old = trim(engine, tmp_path, endpoint)
    add(engine, tmp_path, endpoint, 2)
    second = run(engine, tmp_path, endpoint)
    new = manifest(tmp_path, second)
    assert packed(tmp_path, second, new) == [b"old bytes", b"late"]
    assert [(c.capture_row_id, c.byte_size) for c in new.captures] == [(771001, 9), (771002, 4)]
    assert new.captures[0].sha256 == old.captures[0].sha256
    assert (second.state, new.supersedes, second.details["union_base_version"]) == ("sealed", 1, 1)
    assert (tmp_path / first.storage_path).exists()


def test_partial_day_reseal_keeps_failed_unfinished_and_unpacked_entries(
    engine, tmp_path, endpoint
):
    add(engine, tmp_path, endpoint, 1, b"old bytes")
    add(engine, tmp_path, endpoint, 2, b"missing")
    (tmp_path / "capture/771002").unlink()
    with engine.begin() as conn:
        for n, status in [(3, "failed"), (4, "running")]:
            seed_working_day(
                conn,
                provider_id=PROVIDER,
                endpoint_key=endpoint,
                run_id=771000 + n,
                started_at_utc=START + timedelta(seconds=n * 30),
                status=status,
                with_capture=False,
            )
    first = run(engine, tmp_path, endpoint)
    old = manifest(tmp_path, first)
    promote(engine, endpoint, first)
    with engine.begin() as conn:
        for table in (
            "realtime_snapshot_index",
            "i3_alert_snapshots",
            "ingestion_objects",
            "ingestion_runs",
        ):
            conn.execute(text(f"DELETE FROM raw.{table} WHERE provider_id=:p"), {"p": PROVIDER})
        conn.execute(
            text("UPDATE core.history_window SET working_state='partial' WHERE provider_id=:p"),
            {"p": PROVIDER},
        )
        record_remainder(conn, endpoint)
    (tmp_path / old.captures[0].storage_path).unlink()
    add(engine, tmp_path, endpoint, 5)
    result = run(engine, tmp_path, endpoint)
    new = manifest(tmp_path, result)
    assert [(p.ingestion_run_id, p.status) for p in new.polls] == [
        (771001, "stored"),
        (771002, "capture_missing"),
        (771003, "failed"),
        (771004, "unfinished"),
        (771005, "stored"),
    ]
    assert new.captures[1].byte_size == 7 and not new.captures[1].packed
    assert new.processing[: len(old.processing)] == old.processing
    assert packed(tmp_path, result, new) == [b"old bytes", b"late"]


def test_union_seal_keeps_the_old_current_version_and_working_state(engine, tmp_path, endpoint):
    trim(engine, tmp_path, endpoint, state="partial")
    before = snapshot(engine, endpoint)[0]
    add(engine, tmp_path, endpoint, 2)
    run(engine, tmp_path, endpoint)
    after = snapshot(engine, endpoint)[0]
    assert (
        after.current_version,
        after.working_state,
        after.trimmed_at_utc,
        after.remainder_fingerprint,
        after.hold_reason,
        after.hold_until_utc,
    ) == (
        1,
        "partial",
        before.trimmed_at_utc,
        before.remainder_fingerprint,
        before.hold_reason,
        before.hold_until_utc,
    )


def test_unchanged_trimmed_day_reuses_its_current_copy_without_object_reads(
    engine, tmp_path, endpoint
):
    first, _ = trim(engine, tmp_path, endpoint, remainder=False)
    before = snapshot(engine, endpoint)

    def forbidden(backend):
        pytest.fail("unchanged seal accessed storage")

    assert run(engine, tmp_path, endpoint, forbidden).content_version == first.content_version
    assert snapshot(engine, endpoint) == before


def test_waiting_union_is_reused_only_for_the_same_base_and_remainder(engine, tmp_path, endpoint):
    trim(engine, tmp_path, endpoint)
    add(engine, tmp_path, endpoint, 2)
    second = run(engine, tmp_path, endpoint)
    assert run(engine, tmp_path, endpoint) == second
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE core.history_archive_copy SET details=details || "
                "jsonb_build_object('union_base_version',99) "
                "WHERE provider_id=:p AND content_version=2"
            ),
            {"p": PROVIDER},
        )
    third = run(engine, tmp_path, endpoint)
    assert third.content_version == 3
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE core.history_window SET working_changed_at_utc=clock_timestamp() "
                "WHERE provider_id=:p"
            ),
            {"p": PROVIDER},
        )
    fourth = run(engine, tmp_path, endpoint)
    assert fourth.content_version == 4
    add(engine, tmp_path, endpoint, 3, b"new remainder")
    assert run(engine, tmp_path, endpoint).content_version == 5


def test_union_seal_refuses_a_baseline_changed_during_packing(
    engine, tmp_path, endpoint, monkeypatch
):
    trim(engine, tmp_path, endpoint)
    add(engine, tmp_path, endpoint, 2)
    before = snapshot(engine, endpoint)
    original = seal_captures.pack_union_day

    def changed(*args, **kwargs):
        result = original(*args, **kwargs)
        with engine.begin() as other:
            other.execute(
                text(
                    "UPDATE core.history_window SET working_changed_at_utc=clock_timestamp() "
                    "WHERE provider_id=:p"
                ),
                {"p": PROVIDER},
            )
        return result

    monkeypatch.setattr(seal_captures, "pack_union_day", changed)
    with pytest.raises(WindowChanged, match="baseline changed"):
        run(engine, tmp_path, endpoint)
    after = snapshot(engine, endpoint)
    assert after[0].next_version == before[0].next_version
    assert after[1:] == before[1:]


def test_union_seal_keeps_marker_authority_after_an_interrupted_write(
    engine, tmp_path, endpoint, monkeypatch
):
    trim(engine, tmp_path, endpoint)
    add(engine, tmp_path, endpoint, 2)
    original = seal_captures._write_objects

    def interrupted(conn, storage, copy, *args):
        original(conn, storage, copy, *args)
        seal_captures.reject_capture_copy(conn, storage, copy, reason="interrupted")
        raise RuntimeError("writer died")

    with monkeypatch.context() as patch:
        patch.setattr(seal_captures, "_write_objects", interrupted)
        with pytest.raises(RuntimeError, match="writer died"):
            run(engine, tmp_path, endpoint)
    result = run(engine, tmp_path, endpoint)
    _, copies, events = snapshot(engine, endpoint)
    assert [(c.content_version, c.state) for c in copies] == [
        (1, "verified"),
        (2, "rejected"),
        (3, "sealed"),
    ]
    assert [(e.kind, e.content_version) for e in events if e.kind in ("reject", "seal")] == [
        ("seal", 1),
        ("reject", 2),
        ("seal", 3),
    ]
    assert packed(tmp_path, result, manifest(tmp_path, result)) == [b"old bytes", b"late"]


def test_present_day_loss_is_not_repaired_by_union(engine, tmp_path, endpoint):
    add(engine, tmp_path, endpoint, 1)
    first = run(engine, tmp_path, endpoint)
    promote(engine, endpoint, first)
    with engine.begin() as conn:
        for table in ("realtime_snapshot_index", "i3_alert_snapshots"):
            conn.execute(text(f"DELETE FROM raw.{table} WHERE provider_id=:p"), {"p": PROVIDER})
    before = snapshot(engine, endpoint)
    with pytest.raises(CopyContentMissing):
        run(engine, tmp_path, endpoint)
    assert snapshot(engine, endpoint) == before


@pytest.mark.parametrize(
    "damage", ["no_current", "unverified", "manifest", "pack", "partial_unknown"]
)
def test_union_source_must_be_verified_and_intact(engine, tmp_path, endpoint, damage):
    first, _ = trim(
        engine,
        tmp_path,
        endpoint,
        state="partial" if damage == "partial_unknown" else "trimmed",
        remainder=damage != "partial_unknown",
    )
    add(engine, tmp_path, endpoint, 2)
    if damage in ("no_current", "unverified"):
        with engine.begin() as conn:
            sql = (
                "UPDATE core.history_window SET current_version=NULL"
                if damage == "no_current"
                else "UPDATE core.history_archive_copy SET verified_at_utc=NULL"
            )
            conn.execute(text(sql + " WHERE provider_id=:p"), {"p": PROVIDER})
    elif damage in ("manifest", "pack"):
        (
            tmp_path / (first.manifest_path if damage == "manifest" else first.storage_path)
        ).write_bytes(b"corrupt")
    before = snapshot(engine, endpoint)
    with pytest.raises(CopyContentMissing):
        run(engine, tmp_path, endpoint)
    assert snapshot(engine, endpoint) == before


def test_union_manifest_distinguishes_absence_from_storage_failure(verification, monkeypatch):
    v = verification
    v.store.copy = replace(v.copy, verified_at_utc=v.now, storage_backend="s3")
    state = v.store.state()
    state.current_version, state.working_state = 1, "trimmed"
    state.working_changed_at_utc, state.remainder_fingerprint = v.now, "a" * 64
    v.connection.execute = lambda *a, **kw: SimpleNamespace(
        scalar_one=lambda: v.now,
        one_or_none=lambda: SimpleNamespace(feed_endpoint_id=1, feed_kind="trip_updates"),
    )
    monkeypatch.setattr(seal_captures, "rows_fingerprint", lambda *a, **kw: "b" * 64)
    for read_code, head_code in (
        ("NoSuchKey", "NoSuchKey"),
        ("NoSuchKey", None),
        ("AccessDenied", None),
        ("transport", None),
        ("NoSuchKey", "AccessDenied"),
        ("AccessDenied", "transport"),
    ):

        def failure(code, operation):
            if code == "transport":
                return EndpointConnectionError(endpoint_url="https://storage.invalid")
            return ClientError({"Error": {"Code": code}}, operation)

        read_error = failure(read_code, "GetObject")
        head_error = failure(head_code, "HeadObject") if head_code else None
        client = Mock()
        client.get_object.side_effect, client.head_object.side_effect = read_error, head_error
        storage = S3BronzeStorage("s3", "synthetic", "https://storage.invalid", client)
        expected = CopyContentMissing if head_code == "NoSuchKey" else BronzeStorageError
        with pytest.raises(expected) as error:
            seal(
                v.connection,
                lambda _, store=storage: store,
                dataset_id="capture.trip_updates",
                provider_id="network",
                window_key=DAY.isoformat(),
                archive_backend="local",
                sealed_by="test",
            )
        if expected is BronzeStorageError:
            assert error.value.__cause__ is (head_error or read_error)
        assert v.calls == []
