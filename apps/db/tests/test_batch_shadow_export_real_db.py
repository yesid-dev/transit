"""The scheduled export stage, from plan to archive, against a disposable source.

The controller plans an edition-reading family for two providers, then runs the
exact `lake migrate` arguments it builds, in process, as a SELECT-only role under
the workflow's read-only PGOPTIONS. A local archive stands in for S3.
"""

import hashlib
import json
import runpy
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from psycopg import sql
from real_db_seed import replay_static_graph
from sqlalchemy import text
from test_batch_shadow_daily_real_db import real_db_engine as real_db_engine
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.archive_keys import parse_proof_key

SCRIPT = Path(__file__).resolve().parents[3] / ".github/scripts/batch-shadow.py"
PROVIDERS = ("octranspo", "stm")
FAMILY = "cancellations_service_states"


def seed(conn, provider, stamp):
    """One current edition, its parents a month earlier, and facts on both sides of the day."""
    reference, first = stamp - timedelta(days=45), stamp - timedelta(days=3)

    def one(statement, **values):
        return conn.execute(text(statement), {"p": provider, **values}).scalar_one()

    endpoint = (
        "INSERT INTO core.feed_endpoints(provider_id,endpoint_key,feed_kind,source_format) "
        "VALUES (:p,:k,:k,:f) RETURNING feed_endpoint_id"
    )
    run = (
        "INSERT INTO raw.ingestion_runs(provider_id,feed_endpoint_id,run_kind,status,"
        "started_at_utc) VALUES (:p,:e,:k,'succeeded',:at) RETURNING ingestion_run_id"
    )
    obj = (
        "INSERT INTO raw.ingestion_objects(ingestion_run_id,provider_id,object_kind,"
        "storage_backend,storage_path,created_at_utc) VALUES (:r,:p,:k,'local',:path,:at) "
        "RETURNING ingestion_object_id"
    )
    static = one(endpoint, k="static_schedule", f="gtfs_schedule_zip")
    static_run = one(run, e=static, k="static_schedule", at=reference)
    static_object = one(obj, r=static_run, k="static_schedule", path=provider, at=reference)
    digest = hashlib.sha256(provider.encode()).hexdigest()
    version = one(
        "INSERT INTO core.dataset_versions(provider_id,feed_endpoint_id,source_ingestion_run_id,"
        "source_ingestion_object_id,dataset_kind,content_hash,checksum_sha256,is_current) "
        "VALUES (:p,:e,:r,:o,'static_schedule',:h,:h,true) RETURNING dataset_version_id",
        e=static,
        r=static_run,
        o=static_object,
        h=digest,
    )
    replay_static_graph(conn, {"p": provider, "dv": version})
    conn.execute(
        text(
            "INSERT INTO silver.calendar VALUES (:dv,:p,'WK',true,true,true,true,true,false,"
            "false,:start,:end)"
        ),
        {"p": provider, "dv": version, "start": reference.date(), "end": stamp.date()},
    )
    conn.execute(
        text("INSERT INTO silver.calendar_dates VALUES (:dv,:p,'WK',:day,2)"),
        {"p": provider, "dv": version, "day": stamp.date()},
    )
    realtime = one(endpoint, k="trip_updates", f="gtfs_rt_trip_updates")
    for index, at in enumerate((first, stamp)):
        realtime_run = one(run, e=realtime, k="trip_updates", at=at)
        realtime_object = one(obj, r=realtime_run, k="trip_updates", path=f"{provider}{at}", at=at)
        snapshot = one(
            "INSERT INTO raw.realtime_snapshot_index(provider_id,feed_endpoint_id,"
            "ingestion_run_id,ingestion_object_id,feed_timestamp_utc,captured_at_utc,"
            "entity_count) VALUES (:p,:e,:r,:o,:at,:at,1) RETURNING realtime_snapshot_id",
            e=realtime,
            r=realtime_run,
            o=realtime_object,
            at=at,
        )
        conn.execute(
            text(
                "INSERT INTO gold.fact_trip_delay_snapshot(provider_id,realtime_snapshot_id,"
                "entity_index,snapshot_date_key,snapshot_local_date,feed_timestamp_utc,"
                "captured_at_utc,stop_time_update_count) VALUES (:p,:s,:i,:key,:day,:at,:at,0)"
            ),
            {
                "p": provider,
                "s": snapshot,
                "i": index,
                "key": int(f"{at:%Y%m%d}"),
                "day": at.date(),
                "at": at,
            },
        )
    return digest, version


@pytest.fixture
def source(real_db_engine, seed_provider):
    """Seeded editions and facts, read through a fixture-created SELECT-only login."""
    stamp = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=2)
    role, password = "rescue_" + uuid4().hex, uuid4().hex
    with real_db_engine.begin() as conn:
        editions = {}
        for provider in PROVIDERS:
            seed_provider(conn, provider, display_name=provider, ignore_existing=True)
            editions[provider] = seed(conn, provider, stamp)
        cursor = conn.connection.driver_connection.cursor()
        database = conn.execute(text("SELECT current_database()")).scalar_one()
        cursor.execute(
            sql.SQL("REVOKE CREATE ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database))
        )
        cursor.execute("REVOKE CREATE ON SCHEMA core,raw,silver,gold FROM PUBLIC")
        cursor.execute(
            sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOINHERIT").format(
                sql.Identifier(role), sql.Literal(password)
            )
        )
        cursor.execute(
            sql.SQL("GRANT USAGE ON SCHEMA core,raw,silver,gold TO {}").format(sql.Identifier(role))
        )
        cursor.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA core,raw,silver,gold TO {}").format(
                sql.Identifier(role)
            )
        )
    reader = real_db_engine.url.set(drivername="postgresql", username=role, password=password)
    try:
        yield reader.render_as_string(hide_password=False), stamp, editions
    finally:
        with real_db_engine.begin() as conn:
            conn.execute(text(f'DROP OWNED BY "{role}"'))
            conn.execute(text(f'DROP ROLE "{role}"'))


def run_in_process(command, env=None, **_):
    """`uv run --frozen transit-ops ...` without a child interpreter, so storage stays local."""
    assert command[:4] == ["uv", "run", "--frozen", "transit-ops"] and env is None
    result = CliRunner().invoke(app, command[4:])
    assert not result.exception or isinstance(result.exception, SystemExit), result.exception
    return subprocess.CompletedProcess(command, result.exit_code, result.stdout, result.stderr)


def test_scheduled_export_copies_the_planned_windows_read_only(
    source, real_db_engine, tmp_path, monkeypatch
):
    from transit_ops.history import storage
    from transit_ops.settings import get_settings

    url, stamp, editions = source
    (tmp_path / "archive").mkdir()
    archive = LocalBronzeStorage("local", tmp_path / "archive")
    controller = runpy.run_path(str(SCRIPT))["main"].__globals__
    # The workflow's libpq options stay confined to the export; fixture teardown writes.
    with monkeypatch.context() as patch:
        patch.setitem(controller, "ROOT", tmp_path / "shadow")
        patch.setitem(controller, "subprocess", SimpleNamespace(run=run_in_process))
        patch.setattr(
            controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=25_000_000_000)
        )
        patch.setattr(
            storage,
            "history_storage",
            lambda settings=None: SimpleNamespace(
                resolve=lambda backend: archive, close=lambda: None
            ),
        )
        for name, value in {
            "TRANSIT_REPLAY_DATABASE_URL": real_db_engine.url.render_as_string(hide_password=False),
            "TRANSIT_TEST_DATABASE_DISPOSABLE": "I_UNDERSTAND_THIS_DATABASE_IS_DISPOSABLE",
            "GITHUB_SHA": "a" * 40,
            "INPUT_MODE": "export",
            "FAMILIES": FAMILY,
            "PROVIDERS": ",".join(PROVIDERS),
            "BATCH_SHADOW_PROVISIONED": "true",
            "BRONZE_STORAGE_BACKEND": "s3",
            "BRONZE_S3_BUCKET": "archive",
            "BRONZE_S3_ACCESS_KEY": "unused",
            "BRONZE_S3_SECRET_KEY": "unused",
            "DATABASE_URL": url,
            "PGOPTIONS": "-c default_transaction_read_only=on",
        }.items():
            patch.setenv(name, value)
        for name in ("DAY", "AS_OF"):
            patch.delenv(name, raising=False)
        get_settings.cache_clear()
        try:
            data = controller["plan"](stamp)
            assert [row["provider"] for row in data["matrix"]] == sorted(PROVIDERS)
            controller["export_inputs"](data)
        finally:
            get_settings.cache_clear()
    summary = json.loads((tmp_path / "shadow/public/export-ordinary.json").read_bytes())
    assert summary["refusal"] is None
    for provider, (digest, version) in editions.items():
        assert f"silver.trips:{provider}:{digest}.v{version}" in data["windows"]
        proofs = archive.list_keys(f"archive/v1/tables/silver.trips/{provider}/")
        assert f"{digest}.v{version}" in {
            parts.window_key for key in proofs if (parts := parse_proof_key(key)) is not None
        }
    copied = {r["spec"]["window_key"] for r in summary["records"] if r.get("outcome") == "copied"}
    assert {f"{d}.v{v}" for d, v in editions.values()} <= copied
