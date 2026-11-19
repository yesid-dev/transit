"""Local capture mode with durable spool, verified floors, and canonical recording."""

from __future__ import annotations

import json
import subprocess
import sys
from contextlib import closing
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from urllib.error import HTTPError

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from test_live_builders_status import context as status_context
from test_live_facts import seed_fact_edition, trip_message, vehicle_message
from test_live_identity import empty_seed, write_seed_and_floors
from test_live_local_file import SETTINGS as LANE_SETTINGS
from test_local_alert_apply import ALERT

from transit_ops.core.models import ProviderManifest
from transit_ops.failed_load_tag import parse_failed_load_capture_row_id
from transit_ops.history.poll_record import FeedDayKey
from transit_ops.ingestion.common import DownloadedArtifact
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.builders_status import build_alerts
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.facts import apply_capture
from transit_ops.live.identity import IdentityAllocator, verify_identity_floors
from transit_ops.live.ingest import (
    LocalIngestIntegrityError,
    LocalIngestor,
)
from transit_ops.live.local_file import LocalFile
from transit_ops.live.poll_records import LocalPollRecords
from transit_ops.live.recording import Recorder
from transit_ops.live.segments import export_segment, read_segment
from transit_ops.settings import Settings
from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_state import seed_alert_state

AT = datetime(2026, 3, 25, 12, 0, 0, tzinfo=UTC)


def build_manifest(
    *,
    provider_id: str = "network",
    with_signed_auth: bool = False,
) -> ProviderManifest:
    auth_block = (
        {
            "auth_type": "api_key_signed",
            "credential_env_var": "STM_API_KEY",
            "signing_secret_env_var": "BRONZE_S3_SECRET_KEY",
            "auth_query_param": "key",
            "signature_query_param": "hash",
            "signature_scheme": "sha256_utc_minute",
        }
        if with_signed_auth
        else {
            "auth_type": "api_key",
            "credential_env_var": "STM_API_KEY",
            "auth_header_name": "Ocp-Apim-Subscription-Key",
        }
    )
    return ProviderManifest.model_validate(
        {
            "provider": {
                "provider_id": provider_id,
                "display_name": "Network",
                "timezone": "America/Toronto",
                "is_active": True,
            },
            "feeds": {
                "static_schedule": {
                    "endpoint_key": "static_schedule",
                    "feed_kind": "static_schedule",
                    "source_format": "gtfs_schedule_zip",
                    "source_url": "https://example.invalid/static.zip",
                    "auth": {"auth_type": "none"},
                    "refresh_interval_seconds": 86400,
                },
                "trip_updates": {
                    "endpoint_key": "trip_updates",
                    "feed_kind": "trip_updates",
                    "source_format": "gtfs_rt_trip_updates",
                    "source_url": "https://example.invalid/trip-updates.pb",
                    "auth": auth_block,
                    "refresh_interval_seconds": 20,
                },
                "vehicle_positions": {
                    "endpoint_key": "vehicle_positions",
                    "feed_kind": "vehicle_positions",
                    "source_format": "gtfs_rt_vehicle_positions",
                    "source_url": "https://example.invalid/vehicle-positions.pb",
                    "auth": auth_block,
                    "refresh_interval_seconds": 20,
                },
                "i3_alerts": {
                    "endpoint_key": "i3_alerts",
                    "feed_kind": "i3_alerts",
                    "source_format": "api_i3_json",
                    "source_url": "https://example.invalid/i3-alerts.json",
                    "auth": auth_block,
                    "refresh_interval_seconds": 60,
                },
                "service_alerts": {
                    "endpoint_key": "service_alerts",
                    "feed_kind": "service_alerts",
                    "source_format": "gtfs_rt_service_alerts",
                    "source_url": "https://example.invalid/service-alerts.pb",
                    "auth": {"auth_type": "none"},
                    "refresh_interval_seconds": 60,
                },
            },
        }
    )


def app_settings(tmp_path: Path, *, bronze_root: Path | None = None) -> Settings:
    root = bronze_root or (tmp_path / "bronze")
    root.mkdir(parents=True, exist_ok=True)
    return Settings(
        _env_file=None,
        DATABASE_URL=None,
        STM_API_KEY="top-secret-api-key-123",
        BRONZE_S3_SECRET_KEY="top-secret-signing-456",
        BRONZE_STORAGE_BACKEND="local",
        BRONZE_LOCAL_ROOT=str(root),
    )


def empty_pb_bytes(timestamp: int | None = None) -> bytes:
    header: dict[str, object] = {"gtfs_realtime_version": "2.0"}
    if timestamp is not None:
        header["timestamp"] = timestamp
    return pb.FeedMessage(header=header).SerializeToString()


def service_alert_pb_bytes(*, alert_id: str = "sa-1", text: str = "Service normal") -> bytes:
    message = pb.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = int(AT.timestamp())
    if alert_id:
        entity = message.entity.add()
        entity.id = alert_id
        translation = entity.alert.header_text.translation.add()
        translation.text = text
        translation.language = "fr"
    return message.SerializeToString()


class ScriptedFetcher:
    """In-memory HTTP boundary writing verified temp files like download_to_tempfile."""

    def __init__(self, responses: list[bytes | Exception]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(
        self,
        *,
        source_url: str,
        temp_dir: Path,
        headers: dict[str, str] | None = None,
        default_filename: str = "artifact.bin",
        ssl_context: object = None,
        deadline: float | None = None,
    ) -> DownloadedArtifact:
        self.calls.append((source_url, dict(headers or {})))
        if not self.responses:
            raise AssertionError("unexpected duplicate HTTP request")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        temp_dir.mkdir(parents=True, exist_ok=True)
        path = temp_dir / f"dl_{len(self.calls)}_{default_filename}"
        path.write_bytes(item)
        return DownloadedArtifact(
            temp_path=path,
            byte_size=len(item),
            checksum_sha256=sha256(item).hexdigest(),
            http_status_code=200,
            source_url=source_url,
        )


class StepClock:
    def __init__(self, start: datetime = AT, step_seconds: int = 1) -> None:
        self.current = start
        self.step = timedelta(seconds=step_seconds)

    def __call__(self) -> datetime:
        value = self.current
        self.current += self.step
        return value


def setup_ingestor(
    tmp_path: Path,
    fetcher: ScriptedFetcher,
    *,
    floors_values: dict[str, int] | None = None,
    manifest: ProviderManifest | None = None,
    clock: StepClock | None = None,
    after_commit=None,
):
    tmp_path.mkdir(parents=True, exist_ok=True)
    fv = floors_values or {
        "ingestion_run_id": 100,
        "ingestion_object_id": 100,
        "realtime_snapshot_id": 100,
        "alert_snapshot_id": 100,
    }
    seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path,
        seed=empty_seed(global_max=fv["alert_snapshot_id"]),
        **fv,
    )
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    settings = app_settings(tmp_path)
    storage = LocalBronzeStorage("local", Path(settings.BRONZE_LOCAL_ROOT))
    db_path = tmp_path / "provider-network.duckdb"
    spool_dir = tmp_path / "spool-network"
    local = LocalFile.open(db_path, provider_id="network", settings=LANE_SETTINGS)
    seed_alert_state(local, seed)
    allocator = IdentityAllocator(local, provider_id="network")
    allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)
    recorder = Recorder(local, provider_id="network")
    recorder.initialize(initial_run_id=verified.ingestion_run_id, seed_sha256=seed_sha)
    ingestor = LocalIngestor(
        local,
        manifest=manifest or build_manifest(),
        settings=settings,
        resolver=lambda _: storage,
        spool_dir=spool_dir,
        recorder=recorder,
        allocator=allocator,
        clock=clock or StepClock(),
        fetcher=fetcher,
        after_commit=after_commit,
    )
    return local, ingestor, storage, spool_dir, seed, verified, floors_sha, settings


def test_captures_each_endpoint_once_with_same_numeric_id_in_separate_namespaces(tmp_path):
    vp_bytes = vehicle_message().SerializeToString()
    tu_bytes = trip_message().SerializeToString()
    i3_bytes = json.dumps({"apiVersion": "2.1", "alerts": [ALERT]}).encode("utf-8")
    sa_bytes = service_alert_pb_bytes()
    fetcher = ScriptedFetcher([vp_bytes, i3_bytes, tu_bytes, sa_bytes])
    local, ingestor, storage, spool_dir, _, _, _, _ = setup_ingestor(tmp_path, fetcher)
    with closing(local):
        vp = ingestor.capture_endpoint("vehicle_positions")
        al = ingestor.capture_endpoint("i3_alerts")
        tu = ingestor.capture_endpoint("trip_updates")
        sa = ingestor.capture_endpoint("service_alerts")

        assert len(fetcher.calls) == 4
        # Separate capture namespaces both start strictly above floor 100 -> both get 101!
        assert (vp.index_family, vp.capture_row_id) == ("realtime_snapshot", 101)
        assert (al.index_family, al.capture_row_id) == ("alert_snapshot", 101)
        assert (tu.index_family, tu.capture_row_id) == ("realtime_snapshot", 102)
        assert (sa.index_family, sa.capture_row_id) == ("alert_snapshot", 102)
        assert [
            vp.ingestion_run_id,
            al.ingestion_run_id,
            tu.ingestion_run_id,
            sa.ingestion_run_id,
        ] == [
            101,
            102,
            103,
            104,
        ]
        # Verified bytes durably persisted in Bronze storage and readable; staging spool clean.
        for outcome, raw in ((vp, vp_bytes), (al, i3_bytes), (tu, tu_bytes), (sa, sa_bytes)):
            assert outcome.storage_path is not None
            assert storage.read_bytes(outcome.storage_path) == raw
        assert not list(spool_dir.glob("*.spool.json"))
        assert not list(spool_dir.glob("*.payload"))
        # Canonical segment export succeeds cleanly over locally ingested records.
        segment = export_segment(local, storage)
        assert segment is not None
        frames = read_segment(local, storage, segment)
        assert len(frames["captures"].rows) == 4
        assert len(frames["polls"].rows) == 4


def test_records_failed_duplicate_empty_and_corrected_outcomes_with_redaction_and_alert_provenance(
    tmp_path,
):
    secret_url = (
        "https://user:supersecret@example.invalid/vehicle-positions.pb"
        "?key=top-secret-api-key-123&hash=deadbeefcafebabe"
    )
    http_err = HTTPError(
        secret_url,
        503,
        "Backend error for https://user:supersecret@example.invalid/?token=abc999 "
        "header top-secret-api-key-123",
        hdrs=None,  # type: ignore[arg-type]
        fp=None,
    )
    empty_vp = empty_pb_bytes(int(AT.timestamp()))
    valid_vp = vehicle_message().SerializeToString()
    alert_v1 = json.dumps({"apiVersion": "2.0", "alerts": [ALERT]}).encode("utf-8")
    corrected_alert = dict(ALERT)
    corrected_alert["header"] = {"fr": "Avis é雪", "en": "Notice updated"}
    alert_v2 = json.dumps({"apiVersion": "2.0", "alerts": [corrected_alert]}).encode("utf-8")
    empty_alerts = json.dumps({"apiVersion": "2.0", "alerts": []}).encode("utf-8")

    fetcher = ScriptedFetcher(
        [
            http_err,
            b"not-valid-protobuf",
            empty_vp,
            valid_vp,
            valid_vp,  # duplicate with deduplicate_identical=True -> skipped_identical
            valid_vp,  # duplicate stored (default PG parity)
            alert_v1,
            alert_v2,  # corrected English text on same content_hash
            empty_alerts,
        ]
    )
    manifest = build_manifest(with_signed_auth=True)
    local, ingestor, storage, _, _, _, _, _ = setup_ingestor(
        tmp_path, fetcher, manifest=manifest, clock=StepClock(AT, step_seconds=5)
    )
    with closing(local):
        # 1. Failed HTTP poll -> redacted error, no capture/object ID allocated.
        failed_http = ingestor.capture_endpoint("vehicle_positions")
        assert failed_http.outcome == "failed"
        assert failed_http.http_status_code == 503
        assert failed_http.capture_row_id is None
        assert failed_http.error_message is not None
        for secret in ("supersecret", "top-secret-api-key-123", "abc999", "top-secret-signing-456"):
            assert secret not in failed_http.error_message

        # 2. Failed decode poll -> recorded failed, no Bronze reference.
        failed_decode = ingestor.capture_endpoint("vehicle_positions")
        assert failed_decode.outcome == "failed"
        assert failed_decode.capture_row_id is None

        # 3. Empty GTFS-RT capture -> stored with entity_count=0 and applies cleanly.
        empty_res = ingestor.capture_endpoint("vehicle_positions")
        assert (empty_res.outcome, empty_res.entity_count, empty_res.capture_row_id) == (
            "stored",
            0,
            101,
        )
        assert empty_res.capture_entry is not None
        apply_capture(
            local,
            parse_capture(
                empty_vp,
                CaptureRef.from_entry(
                    empty_res.capture_entry, provider_id="network", endpoint_key="vehicle_positions"
                ),
                ParsePolicy.from_manifest(manifest),
            ),
            provider_timezone="America/Toronto",
        )

        # 4. Corrected valid capture after failure/empty -> stored with capture_row_id=102.
        valid_res = ingestor.capture_endpoint("vehicle_positions")
        assert (valid_res.outcome, valid_res.capture_row_id) == ("stored", 102)

        # 5. Duplicate capture with deduplicate_identical=True -> skipped_identical referencing 102.
        dup_skip = ingestor.capture_endpoint("vehicle_positions", deduplicate_identical=True)
        assert (dup_skip.outcome, dup_skip.capture_row_id, dup_skip.duplicate_of_row_id) == (
            "skipped_identical",
            None,
            102,
        )

        # 6. Duplicate capture with default mode -> stored as capture_row_id=103.
        dup_stored = ingestor.capture_endpoint("vehicle_positions")
        assert (dup_stored.outcome, dup_stored.capture_row_id) == ("stored", 103)

        # 7 & 8. Alert + corrected alert preserve alert ID & advance message.snapshot_id.
        al1 = ingestor.capture_endpoint("i3_alerts")
        al2 = ingestor.capture_endpoint("i3_alerts")
        al_empty = ingestor.capture_endpoint("i3_alerts")
        assert (al1.capture_row_id, al2.capture_row_id, al_empty.capture_row_id) == (101, 102, 103)
        assert al_empty.alert_count == 0

        for res, raw in ((al1, alert_v1), (al2, alert_v2), (al_empty, empty_alerts)):
            assert res.capture_entry is not None
            payload_json = json.loads(raw.decode("utf-8"))
            apply_alert_snapshot(
                local,
                RawI3AlertSnapshot(
                    res.capture_entry.capture_row_id,
                    "network",
                    "America/Toronto",
                    res.capture_entry.captured_at_utc,
                    payload_json,
                ),
                loaded_at_utc=res.capture_entry.captured_at_utc,
            )

        ctx = replace(
            status_context(endpoints=("i3_alerts",)), cycle=AT + timedelta(minutes=5)
        )
        published_alerts = build_alerts(local, ctx, enabled=True)
        assert len(published_alerts.alerts) == 1
        published = published_alerts.alerts[0]
        assert published.id == ALERT["id"]
        assert published.message is not None
        assert published.message.snapshot_id == "102"  # strictly above floor 100!
        assert published.header_text_en == "Notice updated"
        # First-seen provenance stays 101 while message provenance advances to 102.
        assert local.connection.execute(
            "SELECT i3_alert_snapshot_id, message_snapshot_id FROM silver.i3_alerts "
            "WHERE valid_to IS NULL"
        ).fetchall() == [(101, 102)]

        # 9. Failed local application records canonical [capture_row_id=N] tag via failed_load_tag.
        assert valid_res.capture_entry is not None
        fail_run_id = ingestor.record_application_failure(
            "vehicle_positions",
            valid_res.capture_entry,
            error=RuntimeError("boom https://user:pw@host/?api_key=secret77"),
            started_at_utc=valid_res.completed_at_utc,
            completed_at_utc=valid_res.completed_at_utc,
            attempt_key="appfail-vp-102",
        )
        assert fail_run_id > al_empty.ingestion_run_id
        # Explicit retry of the same failure attempt returns the same run ID idempotently.
        assert (
            ingestor.record_application_failure(
                "vehicle_positions",
                valid_res.capture_entry,
                error=RuntimeError("boom https://user:pw@host/?api_key=secret77"),
                started_at_utc=valid_res.completed_at_utc,
                completed_at_utc=valid_res.completed_at_utc,
                attempt_key="appfail-vp-102",
            )
            == fail_run_id
        )
        with pytest.raises(
            LocalIngestIntegrityError, match="local_ingest_attempt_outcome_mismatch"
        ):
            ingestor.capture_endpoint("vehicle_positions", attempt_key="appfail-vp-102")
        day = FeedDayKey("network", "vehicle_positions", "realtime_snapshot", AT.date())
        (proc,) = LocalPollRecords(local).processing(day)
        assert proc.attribution == "recorded"
        assert proc.capture_row_id == 102
        assert parse_failed_load_capture_row_id(proc.error_message) == 102
        assert "secret77" not in (proc.error_message or "")
        assert "pw" not in (proc.error_message or "")


def test_torn_bytes_and_immutable_conflict_refuse_before_recording(tmp_path):
    vp_bytes = vehicle_message().SerializeToString()

    # 1. Torn staging payload between spool commit and bronze/identity commit.
    fetcher = ScriptedFetcher([vp_bytes])
    halted: list[str] = []

    def stop_at_spool(stage: str) -> None:
        if stage == "spool":
            halted.append(stage)
            raise RuntimeError("stop_after_spool")

    local, ingestor, storage, spool_dir, _, _, _, _ = setup_ingestor(
        tmp_path / "torn_spool", fetcher, after_commit=stop_at_spool
    )
    with closing(local):
        with pytest.raises(RuntimeError, match="stop_after_spool"):
            ingestor.capture_endpoint("vehicle_positions", attempt_key="att-torn")
        payload_file = spool_dir / "att-torn.payload"
        payload_file.write_bytes(vp_bytes[:-3])  # truncate staging bytes
        ingestor.after_commit = None
        with pytest.raises(LocalIngestIntegrityError, match="local_ingest_torn_bytes"):
            ingestor.capture_endpoint("vehicle_positions", attempt_key="att-torn")
        assert len(fetcher.calls) == 1  # never retried HTTP on torn spool
        assert local.connection.execute("SELECT count(*) FROM captures").fetchone() == (0,)

    # 2. Torn Bronze object after bronze upload before identity/record commit.
    fetcher2 = ScriptedFetcher([vp_bytes])

    def stop_at_bronze(stage: str) -> None:
        if stage == "bronze":
            raise RuntimeError("stop_after_bronze")

    local2, ingestor2, storage2, spool_dir2, _, _, _, _ = setup_ingestor(
        tmp_path / "torn_bronze", fetcher2, after_commit=stop_at_bronze
    )
    with closing(local2):
        with pytest.raises(RuntimeError, match="stop_after_bronze"):
            ingestor2.capture_endpoint("vehicle_positions", attempt_key="att-bronze")
        receipt_doc = json.loads((spool_dir2 / "att-bronze.spool.json").read_text("utf-8"))
        bronze_file = storage2.root / receipt_doc["storage_path"]
        bronze_file.write_bytes(b"corrupted-bronze-bytes")
        ingestor2.after_commit = None
        with pytest.raises(
            LocalIngestIntegrityError,
            match="local_ingest_immutable_byte_conflict|local_ingest_torn_bytes",
        ):
            ingestor2.capture_endpoint("vehicle_positions", attempt_key="att-bronze")
        assert local2.connection.execute("SELECT count(*) FROM captures").fetchone() == (0,)

    # 3. Corrupt spool receipt JSON refuses by name.
    fetcher3 = ScriptedFetcher([vp_bytes])
    local3, ingestor3, _, spool_dir3, _, _, _, _ = setup_ingestor(
        tmp_path / "corrupt_json", fetcher3
    )
    with closing(local3):
        spool_dir3.mkdir(parents=True, exist_ok=True)
        (spool_dir3 / "bad.spool.json").write_bytes(b'{"version": 1, "truncated')
        with pytest.raises(LocalIngestIntegrityError, match="local_ingest_spool_corrupt"):
            ingestor3.capture_endpoint("vehicle_positions")
        assert len(fetcher3.calls) == 0


def test_idempotent_retry_of_recorded_attempt_does_no_duplicate_http_work(tmp_path):
    vp_bytes = vehicle_message().SerializeToString()
    fetcher = ScriptedFetcher([vp_bytes])
    local, ingestor, _, _, _, _, _, _ = setup_ingestor(tmp_path, fetcher)
    with closing(local):
        first = ingestor.capture_endpoint("vehicle_positions", attempt_key="fixed-attempt-1")
        second = ingestor.capture_endpoint("vehicle_positions", attempt_key="fixed-attempt-1")
        assert len(fetcher.calls) == 1
        assert first.ingestion_run_id == second.ingestion_run_id == 101
        assert first.capture_row_id == second.capture_row_id == 101
        assert second.resumed_from_spool is True
        assert local.connection.execute("SELECT count(*) FROM captures").fetchone() == (1,)


_CRASH_CHILD = """
import os, sys
from pathlib import Path
from contextlib import closing
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import test_live_ingest as mod
from test_live_facts import vehicle_message
from test_live_identity import empty_seed, write_seed_and_floors
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.identity import IdentityAllocator, verify_identity_floors
from transit_ops.live.ingest import LocalIngestor
from transit_ops.live.local_file import LocalFile
from transit_ops.live.recording import Recorder
from transit_ops.static.alert_state import seed_alert_state

work = Path(sys.argv[2])
target_stage = sys.argv[3]
attempt_key = sys.argv[4]

vp_bytes = vehicle_message().SerializeToString()
fetcher = mod.ScriptedFetcher([vp_bytes])
seed, _, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
    work,
    seed=empty_seed(global_max=100),
    ingestion_run_id=100,
    ingestion_object_id=100,
    realtime_snapshot_id=100,
    alert_snapshot_id=100,
)
verified = verify_identity_floors(
    floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
)
settings = mod.app_settings(work)
storage = LocalBronzeStorage("local", Path(settings.BRONZE_LOCAL_ROOT))
db_path = work / "provider-network.duckdb"
spool_dir = work / "spool-network"

def crash_on(stage: str) -> None:
    if stage == target_stage:
        os._exit(42)

local = LocalFile.open(db_path, provider_id="network", settings=mod.LANE_SETTINGS)
seed_alert_state(local, seed)
allocator = IdentityAllocator(local, provider_id="network")
allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)
recorder = Recorder(local, provider_id="network")
recorder.initialize(initial_run_id=verified.ingestion_run_id, seed_sha256=seed_sha)
ingestor = LocalIngestor(
    local,
    manifest=mod.build_manifest(),
    settings=settings,
    resolver=lambda _: storage,
    spool_dir=spool_dir,
    recorder=recorder,
    allocator=allocator,
    clock=mod.StepClock(),
    fetcher=fetcher,
    after_commit=crash_on,
)
ingestor.capture_endpoint("vehicle_positions", attempt_key=attempt_key)
"""


@pytest.mark.parametrize("stage", ["spool", "bronze", "identity", "record"])
def test_subprocess_crash_at_each_commit_boundary_recovers_with_zero_duplicate_http(
    tmp_path, stage
):
    work = tmp_path / f"crash_{stage}"
    work.mkdir()
    result = subprocess.run(
        [sys.executable, "-c", _CRASH_CHILD, __file__, str(work), stage, "crash-attempt-1"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 42, result.stderr

    # Reopen the real DuckDB file (replaying WAL) and retry with a zero-HTTP fetcher.
    seed_bytes = (work / "alert_seed.json").read_bytes()
    seed_sha = sha256(seed_bytes).hexdigest()
    from transit_ops.static.alert_seed_contract import AlertSeed

    seed = AlertSeed.from_json(seed_bytes)
    floors_path = work / "identity_floors.json"
    floors_sha = sha256(floors_path.read_bytes()).hexdigest()
    verified = verify_identity_floors(
        floors_path, expected_sha256=floors_sha, seed=seed, alert_seed_sha256=seed_sha
    )
    settings = app_settings(work)
    storage = LocalBronzeStorage("local", Path(settings.BRONZE_LOCAL_ROOT))
    db_path = work / "provider-network.duckdb"
    spool_dir = work / "spool-network"

    vp_bytes = vehicle_message().SerializeToString()
    retry_fetcher = ScriptedFetcher([])  # ZERO HTTP calls allowed on retry!
    with closing(LocalFile.open(db_path, provider_id="network", settings=LANE_SETTINGS)) as local:
        allocator = IdentityAllocator(local, provider_id="network")
        allocator.initialize(verified, floors_sha256=floors_sha, seed=seed)
        recorder = Recorder(local, provider_id="network")
        ingestor = LocalIngestor(
            local,
            manifest=build_manifest(),
            settings=settings,
            resolver=lambda _: storage,
            spool_dir=spool_dir,
            recorder=recorder,
            allocator=allocator,
            clock=StepClock(AT + timedelta(seconds=30)),
            fetcher=retry_fetcher,
        )
        # Retry WITHOUT passing attempt_key too (worker-loop restart behavior!).
        recovered = ingestor.capture_endpoint("vehicle_positions")
        assert retry_fetcher.calls == []
        assert recovered.resumed_from_spool is True
        assert (
            recovered.ingestion_run_id,
            recovered.ingestion_object_id,
            recovered.capture_row_id,
        ) == (101, 101, 101)
        assert recovered.storage_path is not None
        assert storage.read_bytes(recovered.storage_path) == vp_bytes
        assert not list(spool_dir.glob("*.spool.json"))
        assert not list(spool_dir.glob("*.payload"))
        assert local.connection.execute(
            "SELECT ingestion_run_id, capture_row_id FROM captures"
        ).fetchall() == [(101, 101)]
        assert local.connection.execute(
            "SELECT ingestion_run_id, terminal_recorded FROM recording_coverage"
        ).fetchall() == [(101, True)]

        # Next fresh capture advances strictly to 102 with 1 HTTP call (never reuses 101).
        retry_fetcher.responses.append(vp_bytes)
        following = ingestor.capture_endpoint("vehicle_positions")
        assert len(retry_fetcher.calls) == 1
        assert (
            following.ingestion_run_id,
            following.ingestion_object_id,
            following.capture_row_id,
        ) == (102, 102, 102)
        # First Bronze object was never pruned.
        assert storage.exists(recovered.storage_path)
        assert following.storage_path is not None and storage.exists(following.storage_path)


def test_missing_spool_for_unrecorded_reservation_refuses_by_name(tmp_path):
    vp_bytes = vehicle_message().SerializeToString()
    fetcher = ScriptedFetcher([vp_bytes])

    def stop_at_identity(stage: str) -> None:
        if stage == "identity":
            raise RuntimeError("stop_after_identity")

    local, ingestor, _, spool_dir, _, _, _, _ = setup_ingestor(
        tmp_path, fetcher, after_commit=stop_at_identity
    )
    with closing(local):
        with pytest.raises(RuntimeError, match="stop_after_identity"):
            ingestor.capture_endpoint("vehicle_positions", attempt_key="lost-spool")
        (spool_dir / "lost-spool.spool.json").unlink()
        ingestor.after_commit = None
        with pytest.raises(
            LocalIngestIntegrityError, match="local_ingest_spool_missing:lost-spool"
        ):
            ingestor.capture_endpoint("vehicle_positions")


def test_spool_write_error_propagates_and_cleans_orphan_payload(tmp_path, monkeypatch):
    from transit_ops.live import ingest as ingest_module

    vp_bytes = vehicle_message().SerializeToString()
    fetcher = ScriptedFetcher([vp_bytes])
    local, ingestor, _, spool_dir, _, _, _, _ = setup_ingestor(tmp_path, fetcher)
    real_write = ingest_module._write_file_durable
    calls = 0

    def fail_on_receipt(path: Path, data: bytes) -> None:
        nonlocal calls
        calls += 1
        if path.name.endswith(".spool.json"):
            raise OSError("disk full writing spool receipt")
        real_write(path, data)

    monkeypatch.setattr(ingest_module, "_write_file_durable", fail_on_receipt)
    with closing(local):
        with pytest.raises(OSError, match="disk full writing spool receipt"):
            ingestor.capture_endpoint("vehicle_positions", attempt_key="spool-fail")
        assert calls == 2
        # Orphan payload is cleaned up and no fabricated failed poll row is recorded.
        assert not (spool_dir / "spool-fail.payload").exists()
        assert not (spool_dir / "spool-fail.spool.json").exists()
        assert local.connection.execute("SELECT count(*) FROM polls").fetchone() == (0,)
        assert local.connection.execute("SELECT count(*) FROM captures").fetchone() == (0,)


def test_crash_after_identity_drains_first_on_different_attempt_key_without_id_reuse(tmp_path):
    vp1 = vehicle_message().SerializeToString()
    vp2 = empty_pb_bytes(int(AT.timestamp()) + 15)
    fetcher = ScriptedFetcher([vp1, vp2])

    def stop_at_identity(stage: str) -> None:
        if stage == "identity":
            raise RuntimeError("crash_after_identity")

    local, ingestor, storage, spool_dir, _, _, _, _ = setup_ingestor(
        tmp_path, fetcher, after_commit=stop_at_identity
    )
    with closing(local):
        with pytest.raises(RuntimeError, match="crash_after_identity"):
            ingestor.capture_endpoint("vehicle_positions", attempt_key="first-attempt")
        assert len(fetcher.calls) == 1
        assert local.connection.execute("SELECT count(*) FROM captures").fetchone() == (0,)

        ingestor.after_commit = None
        second = ingestor.capture_endpoint("vehicle_positions", attempt_key="second-attempt")
        assert len(fetcher.calls) == 2
        assert (second.ingestion_run_id, second.capture_row_id) == (102, 102)
        rows = local.connection.execute(
            "SELECT capture_row_id, ingestion_run_id, storage_path FROM captures ORDER BY 1"
        ).fetchall()
        assert [(r[0], r[1]) for r in rows] == [(101, 101), (102, 102)]
        assert storage.read_bytes(rows[0][2]) == vp1
        assert storage.read_bytes(rows[1][2]) == vp2
        assert not list(spool_dir.glob("*.spool.json"))
        assert not list(spool_dir.glob("*.payload"))


def test_local_trip_updates_applied_after_seeded_edition_with_zero_postgres(tmp_path):
    vp_bytes = vehicle_message().SerializeToString()
    tu_bytes = trip_message().SerializeToString()
    fetcher = ScriptedFetcher([vp_bytes, tu_bytes])
    manifest = build_manifest()
    local, ingestor, _, _, _, _, _, _ = setup_ingestor(tmp_path, fetcher, manifest=manifest)
    with closing(local):
        seed_fact_edition(local)
        vp = ingestor.capture_endpoint("vehicle_positions")
        tu = ingestor.capture_endpoint("trip_updates")
        assert vp.capture_entry is not None and tu.capture_entry is not None
        policy = ParsePolicy.from_manifest(manifest)
        for endpoint, entry, raw in (
            ("vehicle_positions", vp.capture_entry, vp_bytes),
            ("trip_updates", tu.capture_entry, tu_bytes),
        ):
            parsed = parse_capture(
                raw,
                CaptureRef.from_entry(entry, provider_id="network", endpoint_key=endpoint),
                policy,
            )
            apply_capture(local, parsed, provider_timezone="America/Toronto")
        assert local.connection.execute(
            "SELECT realtime_snapshot_id, delay_seconds FROM fact_trip_delay_snapshot"
        ).fetchall() == [(102, 180)]


def local_ingress_settings(tmp_path: Path, *, floors_values: dict[str, int] | None = None):
    fv = floors_values or {
        "ingestion_run_id": 200,
        "ingestion_object_id": 200,
        "realtime_snapshot_id": 200,
        "alert_snapshot_id": 200,
    }
    seed, seed_path, seed_sha, _, floors_path, floors_sha = write_seed_and_floors(
        tmp_path, seed=empty_seed(global_max=fv["alert_snapshot_id"]), **fv
    )
    lane = LANE_SETTINGS.model_copy(
        update={
            "ingress": "local",
            "local_dir": tmp_path / "local_state",
            "alert_seed_path": seed_path,
            "alert_seed_sha256": seed_sha,
            "identity_floors_path": floors_path,
            "identity_floors_sha256": floors_sha,
            "segment_storage_backend": "local",
        }
    )
    settings = app_settings(tmp_path)
    return (
        settings.model_copy(
            update={"LIGHTER_STORAGE": settings.LIGHTER_STORAGE.model_copy(update={"live": lane})}
        ),
        seed,
    )


@pytest.mark.parametrize(
    "missing_field",
    [
        "alert_seed_path",
        "alert_seed_sha256",
        "identity_floors_path",
        "identity_floors_sha256",
        "local_dir",
        "duckdb_memory_limit_mb",
        "duckdb_threads",
        "temp_dir_max_mb",
        "segment_storage_backend",
    ],
)
def test_local_ingress_refuses_by_name_when_any_seed_floor_or_limit_is_missing(
    tmp_path, missing_field
):
    from transit_ops import orchestration
    from transit_ops.live.ingest import LocalIngestRefused

    settings, _ = local_ingress_settings(tmp_path)
    incomplete = settings.LIGHTER_STORAGE.live.model_copy(update={missing_field: None})
    bad_settings = settings.model_copy(
        update={
            "LIGHTER_STORAGE": settings.LIGHTER_STORAGE.model_copy(update={"live": incomplete})
        }
    )
    with pytest.raises(LocalIngestRefused, match=f"local_ingress_requires_{missing_field}"):
        orchestration.run_realtime_cycle("network", settings=bad_settings)
    with pytest.raises(LocalIngestRefused, match=f"local_ingress_requires_{missing_field}"):
        orchestration.run_realtime_worker_loop("network", settings=bad_settings, max_cycles=1)


def test_orchestration_local_cycle_and_worker_loop_use_zero_postgres_and_one_local_file(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace

    from transit_ops import orchestration
    from transit_ops.live import ingest as ingest_module
    from transit_ops.live.worker_state import worker_state_scope

    settings, _ = local_ingress_settings(tmp_path)
    manifest = build_manifest()
    # Keep endpoints to vehicle_positions + i3_alerts + service_alerts (no edition needed)
    manifest = manifest.model_copy(
        update={"feeds": {k: v for k, v in manifest.feeds.items() if k != "trip_updates"}}
    )
    registry = SimpleNamespace(get_provider=lambda pid: manifest)
    vp_bytes = vehicle_message().SerializeToString()
    i3_bytes = json.dumps({"apiVersion": "2.0", "alerts": [ALERT]}).encode("utf-8")
    sa_bytes = service_alert_pb_bytes()

    fetcher = ScriptedFetcher([vp_bytes, i3_bytes, sa_bytes, vp_bytes, i3_bytes, sa_bytes])
    monkeypatch.setattr(ingest_module, "download_to_tempfile", fetcher)
    # Any attempt to touch PostgreSQL or public cutover publish must fail loudly.
    monkeypatch.setattr(
        orchestration, "make_engine", lambda *a, **k: pytest.fail("touched postgres make_engine")
    )
    monkeypatch.setattr(
        orchestration,
        "require_database_url",
        lambda *a, **k: pytest.fail("required DATABASE_URL in local mode"),
    )
    monkeypatch.setattr(
        orchestration,
        "initialize_realtime_serving",
        lambda *a, **k: pytest.fail("touched postgres serving"),
    )
    monkeypatch.setattr(
        orchestration,
        "refresh_gold_realtime",
        lambda *a, **k: pytest.fail("touched postgres gold"),
    )
    monkeypatch.setattr(
        orchestration,
        "_best_effort_publish_live",
        lambda *a, **k: pytest.fail("enabled cutover publish"),
    )

    # 1. One-shot local cycle succeeds without DATABASE_URL.
    cycle_result = orchestration.run_realtime_cycle(
        "network", settings=settings, registry=registry
    )
    assert cycle_result.status == "succeeded"
    assert cycle_result.successful_endpoint_count == 3
    assert len(fetcher.calls) == 3

    # 2. Worker loop runs one cycle, borrows the single LocalFile, and releases it on stop.
    orchestration.run_realtime_worker_loop(
        "network",
        settings=settings.model_copy(update={"REALTIME_POLL_SECONDS": 20}),
        registry=registry,
        max_cycles=1,
        sleep_fn=lambda _: None,
        should_shutdown=lambda: False,
    )
    assert len(fetcher.calls) == 6

    # 3. Verify durable state, separate namespaces, segments, and PG sync refusal.
    storage = LocalBronzeStorage("local", Path(settings.BRONZE_LOCAL_ROOT))
    with worker_state_scope(
        settings=settings.LIGHTER_STORAGE.live,
        app_settings=settings,
        engine=None,
        manifest=manifest,
        resolver=lambda _: storage,
    ) as state:
        assert state is not None
        with pytest.raises(ValueError, match="local_ingress_forbids_postgres_sync"):
            state.sync()
        rt_ids = state.local.connection.execute(
            "SELECT capture_row_id FROM captures WHERE index_family='realtime_snapshot' ORDER BY 1"
        ).fetchall()
        al_ids = state.local.connection.execute(
            "SELECT capture_row_id FROM captures WHERE index_family='alert_snapshot' ORDER BY 1"
        ).fetchall()
        assert rt_ids == [(201,), (202,)]
        assert al_ids == [(201,), (202,), (203,), (204,)]
        assert state.local.connection.execute(
            "SELECT count(*) FROM segment_exports WHERE completed"
        ).fetchone()[0] >= 2
        assert state.local.connection.execute(
            "SELECT count(*) FROM fact_vehicle_snapshot"
        ).fetchone()[0] >= 2
