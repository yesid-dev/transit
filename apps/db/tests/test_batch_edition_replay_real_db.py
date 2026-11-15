import json
import os
from contextlib import nullcontext
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4

import psycopg
import pytest
from sqlalchemy import create_engine, inspect, text
from test_batch_editions import REQUEST

from transit_ops.batch import input_sources, replay
from transit_ops.batch.build import InputNeed
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.pg_load import prepare_replay_database
from transit_ops.history.datasets import get_dataset
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.archive_keys import proof_key, table_copy_key
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window


@pytest.fixture
def edition_replay_database(real_db_engine):
    from parallel_db import _database_url, _execute, guarded_connect_kwargs

    base = real_db_engine.url.render_as_string(hide_password=False)
    template = guarded_connect_kwargs(real_db_engine.url)["dbname"].split("_xdist_")[0]
    name = f"{template}_xdist_{uuid4().hex[:16]}_gw0"
    target = _database_url(base, name)
    guarded_connect_kwargs(target)
    quote = real_db_engine.dialect.identifier_preparer.quote_identifier
    real_db_engine.dispose()
    _execute(base, f"CREATE DATABASE {quote(name)} TEMPLATE {quote(template)}")
    engine = create_engine(target)
    try:
        yield engine
    finally:
        engine.dispose()
        _execute(base, f"DROP DATABASE {quote(name)} WITH (FORCE)")


def archive_relation(engine, storage, relation, window, provider, tmp_path):
    dataset = get_dataset(relation)
    with psycopg.connect(
        **engine.url.translate_connect_args(username="user", database="dbname"), autocommit=True
    ) as conn:
        exported = export_window(
            conn,
            WindowSpec(relation, provider, window),
            tmp_path / f"{relation}-{window}.csv",
            statement_timeout_s=60,
        )
    key = table_copy_key(relation, provider, 0, dataset.archive_grain, window, 1, 1)
    path = storage.root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    written = write_window(exported.csv_path, exported.schema, path, metadata={}, temp_dir=tmp_path)
    record = dict(
        format_version=1,
        kind="table_copy",
        dataset_id=relation,
        provider_id=provider,
        revision=0,
        window_key=window,
        content_version=1,
        schema_version=1,
        key=key,
        object_sha256=written.sha256,
        object_bytes=written.byte_size,
        rows=exported.rows,
        proof=dict(
            verified=True,
            object_sha256=written.sha256,
            object_bytes=written.byte_size,
            rows=exported.rows,
        ),
    )
    receipt = storage.root / proof_key(key)
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps(record))


@pytest.mark.parametrize("mixed", [False, True])
def test_public_fetch_and_replay_schedule_dependencies(
    edition_replay_database, seed_provider, tmp_path, monkeypatch, mixed
):
    engine = edition_replay_database
    provider = "edition_replay_" + uuid4().hex
    request = replace(REQUEST, provider_id=provider, local_dates=REQUEST.local_dates[:1])
    with engine.begin() as conn:
        seed_provider(conn, provider, display_name=provider, timezone="UTC")
        if mixed:
            ident = conn.execute(
                text("""
                WITH endpoint AS (
                    INSERT INTO core.feed_endpoints(provider_id, endpoint_key,
                        feed_kind, source_format)
                    VALUES (:p, 'schedule', 'static_schedule', 'gtfs_schedule_zip')
                    RETURNING feed_endpoint_id
                ), run AS (
                    INSERT INTO raw.ingestion_runs(provider_id, feed_endpoint_id, run_kind,
                        status, started_at_utc)
                    SELECT :p, feed_endpoint_id, 'static_schedule', 'succeeded', :stamp
                    FROM endpoint
                    RETURNING ingestion_run_id, feed_endpoint_id
                ) INSERT INTO core.dataset_versions(provider_id, feed_endpoint_id,
                    source_ingestion_run_id, content_hash, is_current)
                  SELECT :p, feed_endpoint_id, ingestion_run_id, repeat('c',64), true FROM run
                  RETURNING dataset_version_id
            """),
                {"p": provider, "stamp": request.as_of_utc - timedelta(days=2)},
            ).scalar_one()
    storage = LocalBronzeStorage("local", tmp_path / "objects")
    storage.root.mkdir()
    families = ["occupancy_crowding"] + (["cancellations_service_states"] if mixed else [])
    builders = [resolve_builder(family) for family in families]
    planned = (
        replace(
            request,
            edition_by_day={request.local_dates[0]: ident},
            edition_source="current_at_build",
        )
        if mixed
        else request
    )
    needs = {InputNeed("core.providers", "all")}
    for builder in builders:
        needs.update(builder.inputs(planned))
    if mixed:
        needs.update(
            InputNeed(r, "all")
            for r in ("core.feed_endpoints", "raw.ingestion_runs", "raw.ingestion_objects")
        )
        needs.add(InputNeed("silver.stop_times", f"edition:{ident}"))
    for need in needs:
        window = (
            "2026-11"
            if need.window == "all"
            else "c" * 64
            if need.window.startswith("edition:")
            else need.window
        )
        archive_relation(engine, storage, need.relation, window, provider, tmp_path)
    monkeypatch.setattr(input_sources, "replay_catalog", lambda: nullcontext(inspect(engine)))
    root = tmp_path / "inputs"
    root.mkdir()
    fetched = input_sources.fetch_from_catalog(storage, root, request, builders)
    if not mixed:
        assert not (root / "core.dataset_versions").exists()
        assert not list(root.glob("silver.*"))
        assert all(n["relation"] != "core.dataset_versions" for n in fetched["needs"])
    seen = {}
    original = replay.run_family

    def recording(builder, actual_request, **kwargs):
        seen[builder.family_id] = actual_request
        return original(builder, actual_request, **kwargs)

    monkeypatch.setattr(replay, "run_family", recording)
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", str(request.fact_retention_days))
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", str(request.open_window_days))
    database = prepare_replay_database(engine.url.render_as_string(hide_password=False), os.environ)
    try:
        report = replay.replay_day(
            engine=database,
            provider_id=provider,
            local_date=request.local_dates[0],
            as_of_utc=request.as_of_utc,
            inputs_root=root,
            workdir=tmp_path / "work",
            families=families,
            code_commit="a" * 40,
            publish_bodies=False,
        )
        assert all(f.status == "identical" for f in report.families)
        assert seen["occupancy_crowding"].edition_by_day is None
        assert seen["occupancy_crowding"].edition_source is None
        if mixed:
            assert seen["cancellations_service_states"].edition_by_day == {
                request.local_dates[0]: ident
            }
            assert seen["cancellations_service_states"].edition_source == "current_at_build"
    finally:
        database.engine.dispose()
