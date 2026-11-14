import json
from dataclasses import replace
from datetime import date, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import event, text
from test_alert_recovery_capture_records import NOW, candidates, snapshot

from transit_ops.gold.alert_archive import _write_params, sync_alert_archive_on_connection
from transit_ops.silver.i3 import load_i3_snapshot_to_silver


@pytest.mark.parametrize(
    "fields,expected",
    [
        ({}, "fixture-alert-2a69138641d3"),
        ({"id": " ", "header": "", "description": ""}, "fixture-alert-2a69138641d3"),
        (
            {
                "header": "Été 🚇",
                "description": "Retard",
                "activePeriods": [{"start": 100.125, "end": 200.875}],
            },
            "fixture-alert-3849e3974dbd",
        ),
    ],
)
def test_postgresql_anonymous_identity_literals(real_db_engine, fields, expected):
    with real_db_engine.connect() as connection, connection.begin():
        connection.execute(text("SET TRANSACTION READ ONLY"))
        (candidate,) = candidates([snapshot(101, fields)], connection)
        assert candidate.alert_id == expected
        if not fields:
            assert (
                connection.execute(
                    text('SELECT MD5(\'["", "", null, null]\'::jsonb::text)')
                ).scalar_one()
                == "2a69138641d386ed38f4c38ea2578118"
            )
        assert connection.execute(text("SHOW transaction_read_only")).scalar_one() == "on"


first = {
    "id": "alert-a",
    "header": {"fr": "Travaux", "en": "Work"},
    "routes": ["10"],
    "severity": "high",
    "activePeriods": [{"start": "2010-03-01T00:30:00Z"}, {"end": 200.875}],
}
repeat = {
    **first,
    "routes": ["20", "30"],
    "header": {"fr": "Travaux", "en": "Works"},
    "url": {"fr": "new", "en": "new-en"},
}
# Tied observation times exercise both message and enrichment tie breakers.
payloads = [
    [first, {}],
    [repeat, {}],
    [{"id": "other"}],
    [first],
    [{"id": "alert-a", "header": "Changed"}],
    [],
]


def _load(oracle, provider):
    endpoint = oracle.execute(
        text(
            "INSERT INTO core.feed_endpoints (provider_id, endpoint_key, feed_kind, "
            "source_format) VALUES (:p, 'alerts', 'i3_alerts', 'api_i3_json') "
            "RETURNING feed_endpoint_id"
        ),
        {"p": provider},
    ).scalar_one()
    snapshots = []
    for index, alerts in enumerate(payloads):
        captured = NOW + timedelta(minutes=max(0, index - 1))
        run = oracle.execute(
            text(
                "INSERT INTO raw.ingestion_runs "
                "(provider_id, feed_endpoint_id, run_kind, status, requested_at_utc, "
                "started_at_utc, completed_at_utc, feed_timestamp_utc, entity_count) "
                "VALUES (:p, :e, 'i3_alerts', 'succeeded', :t, :t, :t, :t, :n) "
                "RETURNING ingestion_run_id"
            ),
            {"p": provider, "e": endpoint, "t": captured, "n": len(alerts)},
        ).scalar_one()
        number = oracle.execute(
            text(
                "INSERT INTO raw.i3_alert_snapshots (provider_id, feed_endpoint_id, "
                "ingestion_run_id, captured_at_utc, raw_payload_json) "
                "VALUES (:p, :e, :r, :t, CAST(:j AS jsonb)) RETURNING i3_alert_snapshot_id"
            ),
            {
                "p": provider,
                "e": endpoint,
                "r": run,
                "t": captured,
                "j": json.dumps({"alerts": alerts}),
            },
        ).scalar_one()
        item = replace(snapshot(number, *alerts, provider=provider), captured_at_utc=captured)
        snapshots.append(item)
        load_i3_snapshot_to_silver(oracle, snapshot=item, loaded_at_utc=NOW)
    return snapshots


def test_normal_sync_differential_parity(real_db_engine, seed_provider):
    provider = "capture-oracle-" + uuid4().hex[:10]
    with real_db_engine.connect() as oracle:
        transaction = oracle.begin()
        try:
            seed_provider(oracle, provider, display_name="Capture oracle")
            snapshots = _load(oracle, provider)
            messages = {}

            @event.listens_for(oracle, "before_execute")
            def capture_messages(conn, clause, multiparams, params, options):
                for row in multiparams:
                    if "message" in row:
                        messages[row["alert_id"]] = row["message"]

            sync_alert_archive_on_connection(
                oracle,
                provider_id=provider,
                from_date=date(2026, 10, 1),
                to_date=date(2026, 11, 30),
                synced_at_utc=NOW,
            )
            with real_db_engine.connect() as reader, reader.begin():
                reader.execute(text("SET TRANSACTION READ ONLY"))
                prepared = candidates(reversed(snapshots), reader, provider)
                assert reader.execute(text("SHOW transaction_read_only")).scalar_one() == "on"
            actual = list(
                oracle.execute(
                    text(
                        "SELECT * FROM gold.alert_archive_entry WHERE provider_id = :p "
                        "ORDER BY archive_month, alert_id"
                    ),
                    {"p": provider},
                ).mappings()
            )
            assert [c.alert_id for c in prepared] == [r["alert_id"] for r in actual]
            for candidate, normal in zip(prepared, actual, strict=True):
                assert candidate.record == {k: normal[k] for k in candidate.record}
                assert _write_params(candidate.record)["message"] == messages[candidate.alert_id]
            a = next(c.record for c in prepared if c.alert_id == "alert-a")
            assert a["route_ids"] == ["10", "30"]
            assert a["archive_month"] == date(2010, 2, 1)
            assert a["header_text"] == "Changed"
            assert a["header_text_en"] is None
            assert a["message"]["snapshot_id"] == str(snapshots[4].i3_alert_snapshot_id)
        finally:
            transaction.rollback()
