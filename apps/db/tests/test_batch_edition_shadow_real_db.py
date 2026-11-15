from dataclasses import replace
from uuid import uuid4

import duckdb
from sqlalchemy import create_engine, event, text
from test_family_occupancy_crowding import DAY, REQUEST, write_inputs
from typer.testing import CliRunner

from transit_ops.batch.build import FamilyOutput
from transit_ops.batch.families import registry
from transit_ops.commands import batch


def test_public_mixed_shadow_reads_editions_only_for_cancellation(
    real_db_engine, seed_provider, tmp_path, monkeypatch
):
    from transit_ops.db import connection

    provider = "edition_shadow_" + uuid4().hex
    with real_db_engine.begin() as conn:
        seed_provider(conn, provider, display_name=provider)
        ident = conn.execute(
            text("""
            WITH endpoint AS (
                INSERT INTO core.feed_endpoints(provider_id, endpoint_key, feed_kind, source_format)
                VALUES (:p, 'schedule', 'static_schedule', 'gtfs_schedule_zip')
                RETURNING feed_endpoint_id
            ), run AS (
                INSERT INTO raw.ingestion_runs(provider_id, feed_endpoint_id, run_kind, status)
                SELECT :p, feed_endpoint_id, 'static_schedule', 'succeeded' FROM endpoint
                RETURNING ingestion_run_id, feed_endpoint_id
            ) INSERT INTO core.dataset_versions(provider_id, feed_endpoint_id,
                source_ingestion_run_id, content_hash, is_current)
              SELECT :p, feed_endpoint_id, ingestion_run_id, repeat('c',64), true FROM run
              RETURNING dataset_version_id
        """),
            {"p": provider},
        ).scalar_one()
    engine = create_engine(real_db_engine.url)
    observed = []

    @event.listens_for(engine, "before_cursor_execute")
    def check_read_only(conn, cursor, statement, parameters, context, executemany):
        if "FROM core.dataset_versions" in statement:
            cursor.execute("SHOW transaction_read_only")
            observed.append(("postgres", cursor.fetchone()[0]))

    occupancy = registry.resolve_builder("occupancy_crowding")

    class Cancellation:
        family_id = "cancellations_service_states"
        tables = ()
        published_keys = ()
        variants = {}

        def inputs(self, request):
            assert request.edition_by_day == {DAY: ident}
            assert request.edition_source == "current_at_build"
            observed.append(("cancellation", "inputs"))
            return ()

        def build(self, session, request):
            assert request.edition_by_day == {DAY: ident}
            assert request.edition_source == "current_at_build"
            observed.append(("cancellation", "build"))
            return FamilyOutput({}, {})

    class Occupancy:
        family_id = occupancy.family_id
        tables = occupancy.tables
        published_keys = occupancy.published_keys
        variants = occupancy.variants
        invariants = occupancy.invariants

        def inputs(self, request):
            assert request.edition_by_day is None and request.edition_source is None
            observed.append(("occupancy", "inputs"))
            return occupancy.inputs(request)

        def build(self, session, request):
            assert request.edition_by_day is None and request.edition_source is None
            observed.append(("occupancy", "build"))
            return occupancy.build(session, request)

    monkeypatch.setattr(connection, "make_engine", lambda settings: engine)
    monkeypatch.setattr(
        registry,
        "resolve_builder",
        lambda name: Cancellation() if name == Cancellation.family_id else Occupancy(),
    )
    monkeypatch.setattr(batch, "_code_commit", lambda: "a" * 40)
    request = replace(REQUEST, provider_id=provider, local_dates=(DAY,))
    inputs = tmp_path / "inputs"
    write_inputs(inputs, request)
    with duckdb.connect() as conn:
        conn.execute(
            "COPY (SELECT ?::TEXT provider_id, ?::TEXT timezone) TO ? (FORMAT parquet)",
            [provider, request.timezone, str(inputs / "core.providers" / "all.parquet")],
        )
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", str(request.fact_retention_days))
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", str(request.open_window_days))
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    (tmp_path / "objects").mkdir()
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(tmp_path / "objects"))
    try:
        response = CliRunner().invoke(
            batch.app,
            [
                "shadow-build",
                "--provider",
                provider,
                "--date",
                DAY.isoformat(),
                "--as-of",
                request.as_of_utc.isoformat(),
                "--inputs",
                str(inputs),
                "--workdir",
                str(tmp_path / "work"),
                "--family",
                "cancellations_service_states",
                "--family",
                "occupancy_crowding",
            ],
        )
        assert response.exit_code == 0, response.output + str(response.exception)
        assert ("postgres", "on") in observed
        assert ("cancellation", "inputs") in observed and ("cancellation", "build") in observed
        assert ("occupancy", "inputs") in observed and ("occupancy", "build") in observed
        assert len(list((tmp_path / "objects").rglob("manifest.json"))) == 2
    finally:
        engine.dispose()
        with real_db_engine.begin() as conn:
            for relation in (
                "core.dataset_versions",
                "raw.ingestion_runs",
                "core.feed_endpoints",
                "core.providers",
            ):
                conn.execute(text(f"DELETE FROM {relation} WHERE provider_id=:p"), {"p": provider})
