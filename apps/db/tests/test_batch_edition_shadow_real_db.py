from dataclasses import replace

from sqlalchemy import create_engine, event, text
from test_batch_editions import REQUEST
from test_rescue_fact_day import fact_source as fact_source

from transit_ops.commands.batch import _shadow_editions


def test_shadow_reads_current_edition_in_read_only_transaction(
    real_db_engine, fact_source, monkeypatch
):
    from transit_ops.db import connection

    provider = fact_source[0]
    with real_db_engine.begin() as conn:
        ident = conn.execute(
            text(
                "INSERT INTO core.dataset_versions(provider_id, feed_endpoint_id, "
                "source_ingestion_run_id, content_hash, is_current) "
                "SELECT provider_id, feed_endpoint_id, ingestion_run_id, repeat('c',64), true "
                "FROM raw.ingestion_runs WHERE provider_id=:p LIMIT 1 RETURNING dataset_version_id"
            ),
            {"p": provider},
        ).scalar_one()
    engine = create_engine(real_db_engine.url)
    observed = []

    @event.listens_for(engine, "before_cursor_execute")
    def check_read_only(conn, cursor, statement, parameters, context, executemany):
        if "FROM core.dataset_versions" in statement:
            cursor.execute("SHOW transaction_read_only")
            observed.append(cursor.fetchone()[0])

    monkeypatch.setattr(connection, "make_engine", lambda settings: engine)
    request = replace(REQUEST, provider_id=provider)
    try:
        wired = _shadow_editions(request, ["cancellations_service_states"])
        assert wired.edition_by_day == dict.fromkeys(request.local_dates, ident)
        assert wired.edition_source == "current_at_build"
        assert observed == ["on"]
        assert _shadow_editions(request, ["occupancy_crowding"]) is request
    finally:
        engine.dispose()
        with real_db_engine.begin() as conn:
            conn.execute(
                text("DELETE FROM core.dataset_versions WHERE provider_id=:p"), {"p": provider}
            )
