"""Durable identity floors and atomic per-namespace allocation over a real LocalFile."""

import json
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256

import duckdb
import pytest
from test_live_facts import parsed_vehicle
from test_live_local_file import CAPTURE, POLL, SETTINGS
from test_local_alert_seed import AT, bundle

from transit_ops.live.facts import apply_capture
from transit_ops.live.identity import (
    IDENTITY_FORMAT_VERSION,
    IdentityAllocator,
    IdentityFloors,
    IdentityRefused,
    verify_identity_floors,
)
from transit_ops.live.local_file import LocalFile
from transit_ops.live.recording import Recorder
from transit_ops.static.alert_state import seed_alert_state


def empty_seed(*, provider_id: str = "network", global_max: int | None = 500):
    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    return seed.model_copy(
        update={"provider_id": provider_id, "global_max_snapshot_id": global_max}
    )


def write_seed_and_floors(
    tmp_path,
    *,
    seed=None,
    ingestion_run_id: int = 1000,
    ingestion_object_id: int = 2000,
    realtime_snapshot_id: int = 500,
    alert_snapshot_id: int = 500,
):
    seed = empty_seed() if seed is None else seed
    seed_bytes = seed.to_json()
    seed_sha = sha256(seed_bytes).hexdigest()
    seed_path = tmp_path / "alert_seed.json"
    seed_path.write_bytes(seed_bytes)

    floors = IdentityFloors(
        version=1,
        provider_id=seed.provider_id,
        alert_seed_sha256=seed_sha,
        seed_snapshot_at_utc=seed.snapshot_at,
        captured_at_utc=seed.snapshot_at + timedelta(seconds=1),
        ingestion_run_id=ingestion_run_id,
        ingestion_object_id=ingestion_object_id,
        realtime_snapshot_id=realtime_snapshot_id,
        alert_snapshot_id=alert_snapshot_id,
    )
    floors_bytes = floors.to_json()
    floors_sha = sha256(floors_bytes).hexdigest()
    floors_path = tmp_path / "identity_floors.json"
    floors_path.write_bytes(floors_bytes)
    return seed, seed_path, seed_sha, floors, floors_path, floors_sha


def test_allocates_strictly_above_floors_and_supports_same_id_in_separate_namespaces(tmp_path):
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=empty_seed(global_max=100),
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=100,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    db_path = tmp_path / "worker.duckdb"
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        allocator = IdentityAllocator(local, provider_id="network")
        allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)

        rt = allocator.reserve(
            attempt_key="att-rt-1",
            endpoint_key="vehicle_positions",
            index_family="realtime_snapshot",
            outcome="stored",
            request_digest="a" * 64,
        )
        alert = allocator.reserve(
            attempt_key="att-al-1",
            endpoint_key="i3_alerts",
            index_family="alert_snapshot",
            outcome="stored",
            request_digest="b" * 64,
        )
        # Empty local file still starts at floor + 1 (never 1 from max(local rows)).
        assert rt.ingestion_run_id == 101
        assert rt.ingestion_object_id == 101
        assert rt.capture_row_id == 101
        # Alert snapshot namespace is independent and may share numeric ID 101.
        assert alert.ingestion_run_id == 102
        assert alert.ingestion_object_id == 102
        assert alert.capture_row_id == 101

        failed = allocator.reserve(
            attempt_key="att-fail-1",
            endpoint_key="trip_updates",
            index_family="realtime_snapshot",
            outcome="failed",
            request_digest="c" * 64,
        )
        assert failed.ingestion_run_id == 103
        assert failed.ingestion_object_id is None
        assert failed.capture_row_id is None

    # Reopen preserves checkpoints, retries return exact reservation, new attempts advance.
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        allocator = IdentityAllocator(local, provider_id="network")
        allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)
        same_rt = allocator.reserve(
            attempt_key="att-rt-1",
            endpoint_key="vehicle_positions",
            index_family="realtime_snapshot",
            outcome="stored",
            request_digest="a" * 64,
        )
        assert same_rt == rt
        with pytest.raises(IdentityRefused, match="local_identity_reservation_conflict"):
            allocator.reserve(
                attempt_key="att-rt-1",
                endpoint_key="vehicle_positions",
                index_family="realtime_snapshot",
                outcome="stored",
                request_digest="f" * 64,
            )
        rt2 = allocator.reserve(
            attempt_key="att-rt-2",
            endpoint_key="trip_updates",
            index_family="realtime_snapshot",
            outcome="stored",
            request_digest="d" * 64,
        )
        assert (rt2.ingestion_run_id, rt2.ingestion_object_id, rt2.capture_row_id) == (
            104,
            103,
            102,
        )


def test_refuses_allocation_without_initialized_floors_or_alert_seed(tmp_path):
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(tmp_path)
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    with closing(
        LocalFile.open(tmp_path / "unseeded.duckdb", provider_id="network", settings=SETTINGS)
    ) as local:
        allocator = IdentityAllocator(local, provider_id="network")
        with pytest.raises(IdentityRefused, match="local_identity_alert_seed_missing"):
            allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)
        with pytest.raises(IdentityRefused, match="local_identity_alert_seed_missing"):
            allocator.reserve(
                attempt_key="att-1",
                endpoint_key="vehicle_positions",
                index_family="realtime_snapshot",
                outcome="stored",
                request_digest="a" * 64,
            )
        seed_alert_state(local, seed)
        with pytest.raises(IdentityRefused, match="local_identity_floors_missing"):
            allocator.reserve(
                attempt_key="att-1",
                endpoint_key="vehicle_positions",
                index_family="realtime_snapshot",
                outcome="stored",
                request_digest="a" * 64,
            )


@pytest.mark.parametrize(
    ("namespace", "floor_updates"),
    [
        ("ingestion_run", {"ingestion_run_id": 499}),
        ("ingestion_object", {"ingestion_object_id": 499}),
        ("realtime_snapshot", {"realtime_snapshot_id": 499}),
        ("alert_snapshot", {"alert_snapshot_id": 499}),
    ],
)
def test_floor_below_retained_local_evidence_refuses_by_name(tmp_path, namespace, floor_updates):
    seed = empty_seed(global_max=400)
    _, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=seed,
        ingestion_run_id=floor_updates.get("ingestion_run_id", 600),
        ingestion_object_id=floor_updates.get("ingestion_object_id", 600),
        realtime_snapshot_id=floor_updates.get("realtime_snapshot_id", 600),
        alert_snapshot_id=floor_updates.get("alert_snapshot_id", 600),
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    db_path = tmp_path / f"{namespace}.duckdb"
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        local.record_polls(
            [replace(POLL, ingestion_run_id=500, capture_row_id=500)],
            endpoint_key="vehicle_positions",
        )
        local.record_captures(
            [replace(CAPTURE, ingestion_run_id=500, ingestion_object_id=500, capture_row_id=500)],
            endpoint_key="vehicle_positions",
        )
        local.record_captures(
            [
                replace(
                    CAPTURE,
                    index_family="alert_snapshot",
                    ingestion_run_id=450,
                    ingestion_object_id=450,
                    capture_row_id=500,
                    api_version="v1",
                    alert_count=1,
                )
            ],
            endpoint_key="i3_alerts",
        )
        allocator = IdentityAllocator(local, provider_id="network")
        with pytest.raises(
            IdentityRefused, match=f"local_identity_floor_below_evidence:{namespace}"
        ):
            allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)


def test_floor_below_alert_seed_global_max_or_facts_or_cursor_refuses(tmp_path):
    # 1. Seed global_max_snapshot_id > 2**53 must never lose precision or allow a lower floor.
    seeded = bundle()
    seed_bytes = seeded.to_json()
    seed_sha = sha256(seed_bytes).hexdigest()
    floors = IdentityFloors(
        version=1,
        provider_id="network",
        alert_seed_sha256=seed_sha,
        seed_snapshot_at_utc=seeded.snapshot_at,
        captured_at_utc=seeded.snapshot_at,
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=9007199254740992,
    )
    floors_bytes = floors.to_json()
    floors_path = tmp_path / "low_alert.json"
    floors_path.write_bytes(floors_bytes)
    with pytest.raises(IdentityRefused, match="local_identity_floor_below_evidence:alert_snapshot"):
        verify_identity_floors(
            floors_path,
            expected_sha256=sha256(floors_bytes).hexdigest(),
            seed=seeded,
            alert_seed_sha256=seed_sha,
        )

    # 2. Retained fact table row above floor refuses.
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=41,  # parsed_vehicle() has capture_row_id=42
        alert_snapshot_id=500,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    with closing(
        LocalFile.open(tmp_path / "facts.duckdb", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_alert_state(local, seed)
        apply_capture(local, parsed_vehicle(), provider_timezone="America/Toronto")
        with pytest.raises(
            IdentityRefused, match="local_identity_floor_below_evidence:realtime_snapshot"
        ):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed
            )

    # 3. Retained recording_cursor above floor refuses.
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        ingestion_run_id=9,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=500,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    with closing(
        LocalFile.open(tmp_path / "cursor.duckdb", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_alert_state(local, seed)
        Recorder(local, provider_id="network").initialize(initial_run_id=10, seed_sha256=seed_sha)
        with pytest.raises(
            IdentityRefused, match="local_identity_floor_below_evidence:ingestion_run"
        ):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed
            )


def test_floors_artifact_validation_and_format_version_refusals(tmp_path):
    seed, _, seed_sha, floors, floors_path, floors_sha = write_seed_and_floors(tmp_path)

    with pytest.raises(IdentityRefused, match="local_identity_floors_digest_mismatch"):
        verify_identity_floors(
            floors_path, expected_sha256="0" * 64, seed=seed, alert_seed_sha256=seed_sha
        )

    bad_version = json.loads(floors.to_json()) | {"version": 2}
    bad_bytes = json.dumps(bad_version).encode("utf-8")
    bad_path = tmp_path / "v2.json"
    bad_path.write_bytes(bad_bytes)
    with pytest.raises(IdentityRefused, match="local_identity_floors_version_unsupported"):
        verify_identity_floors(
            bad_path,
            expected_sha256=sha256(bad_bytes).hexdigest(),
            seed=seed,
            alert_seed_sha256=seed_sha,
        )

    bool_floor = json.loads(floors.to_json()) | {"realtime_snapshot_id": True}
    bool_bytes = json.dumps(bool_floor).encode("utf-8")
    bool_path = tmp_path / "bool.json"
    bool_path.write_bytes(bool_bytes)
    with pytest.raises(IdentityRefused, match="local_identity_floors_invalid"):
        verify_identity_floors(
            bool_path,
            expected_sha256=sha256(bool_bytes).hexdigest(),
            seed=seed,
            alert_seed_sha256=seed_sha,
        )

    # Changing floors after initialization refuses without mutating the file.
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    db_path = tmp_path / "immutable.duckdb"
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        IdentityAllocator(local, provider_id="network").initialize(
            verified, floors_sha256=floors_sha, seed=seed
        )
    alt = replace(floors, realtime_snapshot_id=floors.realtime_snapshot_id + 10)
    alt_bytes = alt.to_json()
    alt_sha = sha256(alt_bytes).hexdigest()
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        with pytest.raises(IdentityRefused, match="local_identity_floors_changed"):
            IdentityAllocator(local, provider_id="network").initialize(
                alt, floors_sha256=alt_sha, seed=seed
            )

    # Incompatible format version in DuckDB refuses without modifying rows (Live 21).
    with duckdb.connect(str(db_path)) as conn:
        conn.execute(
            "UPDATE local_identity_meta SET format_version = ?", [IDENTITY_FORMAT_VERSION + 1]
        )
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        with pytest.raises(IdentityRefused, match="local_identity_format_version_mismatch"):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed
            )


def test_reopen_refuses_if_checkpoint_falls_behind_retained_evidence(tmp_path):
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=empty_seed(global_max=100),
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=100,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    db_path = tmp_path / "tampered.duckdb"
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        allocator = IdentityAllocator(local, provider_id="network")
        allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)
        # Inject an out-of-band capture above next_id (101) to simulate checkpoint lag.
        local.record_captures(
            [replace(CAPTURE, ingestion_run_id=105, ingestion_object_id=105, capture_row_id=105)],
            endpoint_key="vehicle_positions",
        )
    with closing(LocalFile.open(db_path, provider_id="network", settings=SETTINGS)) as local:
        with pytest.raises(IdentityRefused, match="local_identity_checkpoint_below_evidence"):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed
            )


def test_naive_timestamp_in_floors_document_is_refused(tmp_path):
    seed, _, seed_sha, floors, _, _ = write_seed_and_floors(tmp_path)
    naive = json.loads(floors.to_json()) | {
        "captured_at_utc": datetime(2026, 1, 2, 3, 4, 6).isoformat()
    }
    raw = json.dumps(naive).encode("utf-8")
    path = tmp_path / "naive.json"
    path.write_bytes(raw)
    with pytest.raises(IdentityRefused, match="local_identity_floors_invalid"):
        verify_identity_floors(
            path, expected_sha256=sha256(raw).hexdigest(), seed=seed, alert_seed_sha256=seed_sha
        )
    assert AT.tzinfo is UTC


def test_fresh_install_refuses_when_exported_segments_or_watermarks_exist(tmp_path):
    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.live.segments import SHADOW_SEGMENTS_PREFIX, export_segment

    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=empty_seed(global_max=100),
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=100,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )

    # 1. File deleted after exporting a shadow segment refuses fresh install (and never restarts
    # at floor+1), even when local_dir is moved to an empty directory.
    storage = LocalBronzeStorage("local", tmp_path / "bronze")
    storage.root.mkdir(parents=True, exist_ok=True)
    db1 = tmp_path / "run1" / "provider-network.duckdb"
    db1.parent.mkdir()
    with closing(LocalFile.open(db1, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        alloc = IdentityAllocator(local, provider_id="network")
        alloc.initialize(verified, floors_sha256=floors_sha, seed=seed, segment_storage=storage)
        res = alloc.reserve(
            attempt_key="att-seg",
            endpoint_key="vehicle_positions",
            index_family="realtime_snapshot",
            outcome="stored",
            request_digest="a" * 64,
        )
        assert res.capture_row_id == 101
        local.record_polls(
            [replace(POLL, ingestion_run_id=101, capture_row_id=101)],
            endpoint_key="vehicle_positions",
        )
        local.record_captures(
            [replace(CAPTURE, ingestion_run_id=101, ingestion_object_id=101, capture_row_id=101)],
            endpoint_key="vehicle_positions",
        )
        seg = export_segment(local, storage, root_prefix=SHADOW_SEGMENTS_PREFIX)
        assert seg is not None and seg.prefix.startswith(SHADOW_SEGMENTS_PREFIX + "/")

    db1.unlink()
    db2 = tmp_path / "run2_empty_dir" / "provider-network.duckdb"
    db2.parent.mkdir()
    with closing(LocalFile.open(db2, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        with pytest.raises(IdentityRefused, match="^identity_history_exists$"):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed, segment_storage=storage
            )

    # 2. Exported production segment also refuses fresh install.
    prod_storage = LocalBronzeStorage("local", tmp_path / "prod_bronze")
    prod_storage.root.mkdir(parents=True, exist_ok=True)
    db_prod = tmp_path / "prod_run" / "provider-network.duckdb"
    db_prod.parent.mkdir()
    with closing(LocalFile.open(db_prod, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        local.record_polls(
            [replace(POLL, ingestion_run_id=101, capture_row_id=101)],
            endpoint_key="vehicle_positions",
        )
        assert export_segment(local, prod_storage) is not None
    db_prod_fresh = tmp_path / "prod_fresh" / "provider-network.duckdb"
    db_prod_fresh.parent.mkdir()
    with closing(LocalFile.open(db_prod_fresh, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        with pytest.raises(IdentityRefused, match="^identity_history_exists$"):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed, segment_storage=prod_storage
            )

    # 3. Deleted DB file with surviving identity watermark refuses even with zero segments.
    db_wm = tmp_path / "wm_run" / "provider-network.duckdb"
    db_wm.parent.mkdir()
    with closing(LocalFile.open(db_wm, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        alloc = IdentityAllocator(local, provider_id="network")
        alloc.initialize(verified, floors_sha256=floors_sha, seed=seed)
        alloc.reserve(
            attempt_key="att-wm",
            endpoint_key="vehicle_positions",
            index_family="realtime_snapshot",
            outcome="stored",
            request_digest="b" * 64,
        )
    db_wm.unlink()
    with closing(LocalFile.open(db_wm, provider_id="network", settings=SETTINGS)) as local:
        seed_alert_state(local, seed)
        with pytest.raises(IdentityRefused, match="^identity_history_exists$"):
            IdentityAllocator(local, provider_id="network").initialize(
                verified, floors_sha256=floors_sha, seed=seed
            )

    # 4. Existing committed watermark (or invalid marker) beside fresh DB refuses.
    for suffix in (".committed.json", ".committed.invalid"):
        db_cw = tmp_path / f"cw_{suffix.strip('.')}" / "provider-network.duckdb"
        db_cw.parent.mkdir()
        (db_cw.parent / (db_cw.name + suffix)).write_text("{}", encoding="utf-8")
        with closing(LocalFile.open(db_cw, provider_id="network", settings=SETTINGS)) as local:
            seed_alert_state(local, seed)
            with pytest.raises(IdentityRefused, match="^identity_history_exists$"):
                IdentityAllocator(local, provider_id="network").initialize(
                    verified, floors_sha256=floors_sha, seed=seed
                )


def test_reserve_caches_retained_maxima_per_scope(tmp_path, monkeypatch):
    from transit_ops.live import identity as identity_module

    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=empty_seed(global_max=100),
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=100,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    calls = 0
    real_scan = identity_module._retained_maxima

    def spy_scan(conn):
        nonlocal calls
        calls += 1
        return real_scan(conn)

    monkeypatch.setattr(identity_module, "_retained_maxima", spy_scan)
    with closing(
        LocalFile.open(tmp_path / "cached.duckdb", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_alert_state(local, seed)
        alloc = IdentityAllocator(local, provider_id="network")
        alloc.initialize(verified, floors_sha256=floors_sha, seed=seed)
        assert calls == 1
        for i in range(5):
            res = alloc.reserve(
                attempt_key=f"att-{i}",
                endpoint_key="vehicle_positions",
                index_family="realtime_snapshot",
                outcome="stored",
                request_digest=f"{i:064x}",
            )
            assert res.capture_row_id == 101 + i
        assert calls == 1


def test_verify_identity_floors_refuses_floor_below_initial_cut(tmp_path):
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=empty_seed(global_max=100),
        ingestion_run_id=100,
        ingestion_object_id=100,
        realtime_snapshot_id=100,
        alert_snapshot_id=100,
    )
    with pytest.raises(IdentityRefused, match="local_identity_floor_below_evidence:ingestion_run"):
        verify_identity_floors(
            floors_path,
            expected_sha256=floors_sha,
            seed=seed,
            alert_seed_sha256=seed_sha,
            initial_cut_run_id=101,
        )
