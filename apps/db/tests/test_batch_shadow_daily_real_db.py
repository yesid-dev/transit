"""Controller integration with real PostgreSQL/DuckDB and create-only local shadow.

The existing small rescue fixture supplies the local input layout. Archive proof
resolution is covered by the input_sources tests; this test exercises the next
boundary through the public replay and shadow commands, without production keys.
"""

import json
import os
import runpy
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import duckdb
import pytest
import yaml
from sqlalchemy import create_engine
from test_batch_replay_real_db import DAY, STAMP
from test_batch_replay_real_db import replay_inputs as replay_inputs
from test_rescue_fact_day import fact_source as fact_source
from typer.testing import CliRunner

from transit_ops.batch.families import occupancy_crowding
from transit_ops.commands import batch

OCCUPANCY = occupancy_crowding.builder


def test_manual_archive_plan_with_workflow_libpq_environment(real_db_engine, tmp_path):
    github = Path(__file__).resolve().parents[3] / ".github"
    workflow = yaml.safe_load((github / "workflows/batch-shadow.yml").read_text(encoding="utf8"))
    step = next(
        s for s in workflow["jobs"]["shadow"]["steps"] if "batch-shadow.py plan" in s.get("run", "")
    )
    script_dir = tmp_path / ".github/scripts"
    script_dir.mkdir(parents=True)
    shutil.copyfile(github / "scripts/batch-shadow.py", script_dir / "batch-shadow.py")
    workdir = tmp_path / "apps/db"
    workdir.mkdir(parents=True)
    if os.name == "nt":
        # Use the native shell shipped with Git on Windows.
        git = shutil.which("git")
        assert git is not None
        bash = str(Path(git).resolve().parents[1] / "bin/bash.exe")
    else:
        bash = "bash"
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper()
        in {"PATH", "SYSTEMROOT", "TEMP", "TMP", "LANG", "WINDIR", "LOCALAPPDATA", "APPDATA"}
    }
    env.update(
        {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_SHA": "a" * 40,
            "BATCH_SHADOW_PROVISIONED": "false",
            "AS_OF": "2026-11-13T07:00:00Z",
            "DAY": "2026-11-12",
            "PROVIDERS": "stm",
            "FAMILIES": "occupancy_crowding",
            "INPUT_MODE": "archive",
            "BRONZE_STORAGE_BACKEND": "s3",
            "VIRTUAL_ENV": sys.prefix,
            "UV_OFFLINE": "1",
            "TRANSIT_REPLAY_DATABASE_URL": real_db_engine.url.render_as_string(hide_password=False),
            "TRANSIT_TEST_DATABASE_DISPOSABLE": "I_UNDERSTAND_THIS_DATABASE_IS_DISPOSABLE",
        }
    )
    env.update(
        dict.fromkeys(
            (
                "PGHOST",
                "PGHOSTADDR",
                "PGPORT",
                "PGDATABASE",
                "PGUSER",
                "PGSERVICE",
                "PGSERVICEFILE",
                "PGOPTIONS",
            ),
            "",
        )
    )
    result = subprocess.run(
        [bash, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step["run"]],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    plan = json.loads((workdir / "artifacts/batch-shadow/daily-inputs.json").read_bytes())
    assert plan["code_commit"] == env["GITHUB_SHA"]
    assert plan["input_mode"] == "archive"
    assert plan["planned_at"] == "2026-11-13T07:00:00+00:00"
    assert plan["matrix"] == [
        {
            "provider": "stm",
            "day": "2026-11-12",
            "families": ["occupancy_crowding"],
            "alerts": False,
            "timezone": "America/Toronto",
        }
    ]
    assert plan["family_refusals"] == []
    assert set(plan["datasets"]) == {
        "gold.fact_trip_delay_snapshot",
        "gold.fact_vehicle_snapshot",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
        "raw.realtime_snapshot_index",
        "core.providers",
        "core.feed_endpoints",
    }


def test_source_role_catalog_refuses_the_disposable_writer(real_db_engine):
    from transit_ops.batch.daily_inputs import assert_read_role

    raw = real_db_engine.raw_connection()
    try:
        with pytest.raises(ValueError, match="role_can_write"):
            assert_read_role(raw.driver_connection)
    finally:
        raw.close()


@pytest.fixture
def real_db_engine(real_db_engine):
    # A private database: replay deliberately replaces its tables. No OS skip.
    from parallel_db import _database_url, _execute, guarded_connect_kwargs

    base = real_db_engine.url.render_as_string(hide_password=False)
    template = guarded_connect_kwargs(real_db_engine.url)["dbname"].split("_xdist_")[0]
    name = f"{template}_xdist_{uuid4().hex[:16]}_gw0"
    target = _database_url(base, name)
    guarded_connect_kwargs(target)
    quote = real_db_engine.dialect.identifier_preparer.quote_identifier
    _execute(base, f"CREATE DATABASE {quote(name)} TEMPLATE {quote(template)}")
    isolated = create_engine(target)
    try:
        yield isolated
    finally:
        isolated.dispose()
        _execute(base, f"DROP DATABASE {quote(name)} WITH (FORCE)")


def test_daily_controller_replays_seed_and_writes_accepted_content(
    replay_inputs, tmp_path, monkeypatch
):
    database, sources, provider = replay_inputs
    script = Path(__file__).resolve().parents[3] / ".github/scripts/batch-shadow.py"
    controller = runpy.run_path(str(script))["main"].__globals__
    area, objects = tmp_path / "daily", tmp_path / "objects"
    area.mkdir()
    objects.mkdir()
    monkeypatch.setitem(controller, "ROOT", area)
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda p: SimpleNamespace(free=25_000_000_000)
    )
    monkeypatch.setattr(occupancy_crowding, "builder", OCCUPANCY)
    monkeypatch.setattr(batch, "_code_commit", lambda: "a" * 40)
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(objects))
    monkeypatch.setenv(
        "TRANSIT_REPLAY_DATABASE_URL", database.engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", "30")
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", "7")
    observed = []

    def invoke(args, receipt, *, env=None):
        if args[1] == "fetch-inputs":
            target = Path(args[args.index("--inputs") + 1])
            assert target.is_dir() and not any(target.iterdir())
            shutil.copytree(sources, target, dirs_exist_ok=True)
            receipt.parent.mkdir(parents=True, exist_ok=True)
            receipt.write_text('{"fixture":"small generated rescue inputs"}')
            return
        if env is not None:
            assert env["DATABASE_URL"] == os.environ["TRANSIT_REPLAY_DATABASE_URL"]
        response = CliRunner().invoke(batch.app, args[1:], env=env)
        assert response.exit_code == 0, response.output + str(response.exception)
        receipt.write_text(response.output)
        observed.append(args[1])

    monkeypatch.setitem(controller, "invoke", invoke)
    row = {
        "provider": provider,
        "day": DAY.isoformat(),
        "families": ["occupancy_crowding"],
        "timezone": "UTC",
    }
    controller["run_row"](row, 0, STAMP.isoformat(), "a" * 40)
    assert observed == ["replay-day", "shadow-build"]
    accepted = list(objects.rglob("accepted.json"))
    assert len(accepted) == 1
    assert accepted[0].relative_to(objects).parts[:2] == ("shadow", "v1")
    assert json.loads((area / "0/complete.json").read_bytes())["accepted"] is True
    parquet = list(objects.rglob("*.parquet"))
    assert parquet
    with duckdb.connect() as conn:
        assert (
            sum(
                conn.execute(
                    "SELECT count(*) FROM read_parquet(?, hive_partitioning=false)", [str(p)]
                ).fetchone()[0]
                for p in parquet
            )
            > 0
        )


def test_default_export_plan_resolves_against_the_real_registry_and_catalog(
    real_db_engine, monkeypatch
):
    from transit_ops.batch.daily_inputs import EDITION_REFERENCES, require_bounded_needs
    from transit_ops.batch.families.registry import FAMILIES

    script = Path(__file__).resolve().parents[3] / ".github/scripts/batch-shadow.py"
    controller = runpy.run_path(str(script))["main"].__globals__
    monkeypatch.setenv(
        "TRANSIT_REPLAY_DATABASE_URL", real_db_engine.url.render_as_string(hide_password=False)
    )
    monkeypatch.setenv(
        "TRANSIT_TEST_DATABASE_DISPOSABLE", "I_UNDERSTAND_THIS_DATABASE_IS_DISPOSABLE"
    )
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    monkeypatch.setenv("PROVIDERS", "stm")
    monkeypatch.setenv("INPUT_MODE", "export")
    for name in ("FAMILIES", "DAY", "AS_OF"):
        monkeypatch.delenv(name, raising=False)
    planned = controller["plan"](datetime(2026, 11, 19, 12, tzinfo=UTC))
    excluded = {r["family"]: r["reason"] for r in planned["family_refusals"]}
    assert excluded == {
        "route_spine_hours": "input_not_archived:silver.rt_feed_snapshots",
        "hotspots": "family_not_replayable",
        "trend_history_partitions": "family_not_replayable",
        "alerts_provenance": "family_not_replayable",
    }
    selected = {family for row in planned["matrix"] for family in row["families"]}
    assert selected == set(FAMILIES) - set(excluded)
    assert "cancellations_service_states" in selected and "occupancy_crowding" in selected
    edition_parents = {
        n["window"]
        for n in planned["needs"]
        if n["relation"] in {"raw.ingestion_objects", "raw.ingestion_runs"}
        and not n["window"][:1].isdigit()
    }
    assert edition_parents == {EDITION_REFERENCES}
    require_bounded_needs(planned["needs"])


def test_edition_reference_months_are_row_aware_and_index_backed(real_db_engine, seed_provider):
    from sqlalchemy import text

    from transit_ops.batch.daily_inputs import (
        EDITION_REFERENCE_MONTHS,
        EDITION_REFERENCES,
        edition_reference_windows,
    )

    with real_db_engine.begin() as conn:
        seed_provider(conn, "refs", display_name="References", ignore_existing=True)
        conn.execute(
            text("""
            WITH endpoint AS (
              INSERT INTO core.feed_endpoints(provider_id, endpoint_key, feed_kind, source_format)
              VALUES ('refs', 'schedule', 'static_schedule', 'gtfs_schedule_zip')
              RETURNING feed_endpoint_id
            ), runs AS (
              INSERT INTO raw.ingestion_runs(ingestion_run_id, provider_id, feed_endpoint_id,
                run_kind, status, started_at_utc)
              SELECT r.id, 'refs', e.feed_endpoint_id, 'static_schedule', 'succeeded', r.at
              FROM endpoint e CROSS JOIN (VALUES
                (900001, TIMESTAMPTZ '2025-07-31 23:59:58+00'),
                (900002, TIMESTAMPTZ '2025-08-02 00:00:00+00'),
                (900003, TIMESTAMPTZ '2025-09-15 00:00:00+00'),
                (900004, TIMESTAMPTZ '2026-11-10 00:00:00+00')) r(id, at)
              RETURNING ingestion_run_id, feed_endpoint_id
            ), objects AS (
              INSERT INTO raw.ingestion_objects(ingestion_object_id, ingestion_run_id,
                provider_id, object_kind, storage_backend, storage_path, created_at_utc)
              SELECT o.id, o.run, 'refs', 'static_schedule', 'local', o.path, o.at
              FROM (VALUES
                (900005, 900001, 'a', TIMESTAMPTZ '2025-08-01 00:00:05+00'),
                (900006, 900003, 'b', TIMESTAMPTZ '2025-09-15 00:00:05+00'),
                (900007, 900004, 'c', TIMESTAMPTZ '2026-11-10 00:00:05+00')) o(id, run, path, at)
              WHERE EXISTS (SELECT 1 FROM runs)
              RETURNING ingestion_object_id
            )
            INSERT INTO core.dataset_versions(provider_id, feed_endpoint_id,
              source_ingestion_run_id, source_ingestion_object_id, content_hash, is_current)
            SELECT 'refs', e.feed_endpoint_id, v.run, v.object, repeat(v.hash, 64), v.current
            FROM endpoint e CROSS JOIN (VALUES
              (900002, 900005, 'c', false),
              (900004, NULL::bigint, 'd', true)) v(run, object, hash, current)
            WHERE EXISTS (SELECT 1 FROM objects)
            """)
        )
    raw = real_db_engine.raw_connection()
    try:
        connection = raw.driver_connection
        needs = [
            {"relation": r, "window": EDITION_REFERENCES, "provider": "refs"}
            for r in ("raw.ingestion_objects", "raw.ingestion_runs")
        ]
        # The September run and object exist but no edition row references them.
        assert edition_reference_windows(needs, connection) == {
            "refs": [
                "raw.ingestion_objects:refs:2025-08",
                "raw.ingestion_runs:refs:2025-07",
                "raw.ingestion_runs:refs:2025-08",
                "raw.ingestion_runs:refs:2026-11",
            ]
        }
        with connection.transaction():
            connection.execute("SET LOCAL enable_seqscan = off")
            plan = connection.execute(
                "EXPLAIN (FORMAT JSON) " + EDITION_REFERENCE_MONTHS, ("refs",)
            ).fetchone()[0]
    finally:
        raw.close()
    scans = []

    def walk(node):
        scans.append((node["Node Type"], node.get("Relation Name")))
        for child in node.get("Plans", ()):
            walk(child)

    walk((json.loads(plan) if isinstance(plan, str) else plan)[0]["Plan"])
    for relation in ("dataset_versions", "ingestion_objects", "ingestion_runs"):
        assert ("Seq Scan", relation) not in scans, scans
        assert any(
            name == relation and kind in {"Index Scan", "Index Only Scan", "Bitmap Heap Scan"}
            for kind, name in scans
        ), scans
