import json
from contextlib import closing
from dataclasses import replace
from datetime import datetime, timedelta

import duckdb
import pytest
from test_local_alert_seed import AT, bundle, opened, persisted_state

from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import KEYS, SCHEMAS, TABLES
from transit_ops.static.alert_state import seed_alert_state

ALERT = {
    "id": "avis",
    "header": {"fr": "Avis é雪", "en": "Notice"},
    "description": None,
    "routes": ["first"],
    "activePeriods": [{"start": "2026-01-01T00:00:00.123456Z"}],
}


@pytest.fixture()
def local(tmp_path):
    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    with closing(opened(tmp_path / "worker.db")) as store:
        seed_alert_state(store, seed)
        yield store


def capture(payload, sid=101, seconds=0):
    return RawI3AlertSnapshot(
        sid, "network", "America/Toronto", AT + timedelta(seconds=seconds), payload
    )


def apply(local, snapshot):
    return apply_alert_snapshot(local, snapshot, loaded_at_utc=AT)


def read(local, table=TABLES[0]):
    conn = local.connection
    columns = list(SCHEMAS[table])
    fields = [
        f"strftime({c}, '%Y-%m-%dT%H:%M:%S.%f+00:00')"
        if SCHEMAS[table][c] == "timestamp with time zone"
        else c
        for c in columns
    ]
    rows = conn.execute(
        f"SELECT {', '.join(fields)} FROM {table} ORDER BY {', '.join(KEYS[table])}"
    ).fetchall()
    return [
        {
            c: datetime.fromisoformat(v)
            if v is not None and SCHEMAS[table][c] == "timestamp with time zone"
            else v
            for c, v in zip(columns, row, strict=True)
        }
        for row in rows
    ]


def test_same_hash_keeps_old_child_values_but_accepts_new_indexes(local):
    apply(local, capture([ALERT]))
    changed = ALERT | {
        "routes": ["changed", "new"],
        "header": {"fr": "Avis é雪", "en": "Updated"},
        "activePeriods": [{"start": "2026-01-01T00:00:00.987654Z"}],
        "url": "https://example.org/é",
    }
    result = apply(local, capture([changed], 102, 1))
    row = read(local)[0]
    assert (row["i3_alert_snapshot_id"], row["first_seen_at"], row["captured_at_utc"]) == (
        101,
        AT,
        AT,
    )
    assert (row["message_snapshot_id"], row["last_seen_at"], row["alert_header_text_en"]) == (
        102,
        AT + timedelta(seconds=1),
        "Updated",
    )
    assert [r["route_id"] for r in read(local, TABLES[1])] == ["first", "new"]
    assert read(local, TABLES[2])[0]["start_utc"].microsecond == 123456
    assert result.alerts_redirected_to_existing == 1
    assert result.informed_entity_rows_inserted == 2


def test_changed_hash_supersedes_and_empty_capture_does_not(local):
    apply(local, capture([ALERT]))
    assert apply(local, capture([], 102, 1)).alerts_superseded == 0
    assert read(local)[0]["valid_to"] is None
    result = apply(local, capture([ALERT | {"description": "changed"}], 103, 2))
    assert result.alerts_superseded == 1
    assert [r["valid_to"] for r in read(local)] == [AT + timedelta(seconds=2), None]


def test_same_hash_accepts_previously_absent_period_index(local):
    alert = ALERT | {"activePeriods": []}
    apply(local, capture([alert]))
    apply(local, capture([alert | {"activePeriods": [{"start": None, "end": None}]}], 102, 1))
    assert read(local)[0]["i3_alert_snapshot_id"] == 101
    assert read(local, TABLES[2]) == [
        {
            "i3_alert_snapshot_id": 101,
            "alert_index": 0,
            "period_index": 0,
            "start_utc": None,
            "end_utc": None,
        }
    ]


def test_duplicate_equal_and_repeated_snapshot_match_old_loader(local):
    first = capture([ALERT, ALERT | {"routes": ["discarded"]}])
    result = apply(local, first)
    assert (result.alert_rows_inserted, result.informed_entity_rows_inserted) == (1, 1)
    apply(local, capture([ALERT | {"routes": ["changed", "new"]}], 102))
    # Equal time is admitted; repeating the identity-owning capture rebuilds its children.
    result = apply(local, first)
    assert result.alerts_redirected_to_existing == 0
    assert [r["route_id"] for r in read(local, TABLES[1])] == ["first"]
    assert read(local)[0]["message_snapshot_id"] == 101


def test_older_capture_preserves_alerts_and_message_provenance(local):
    apply(local, capture([ALERT]))
    before = [read(local, table) for table in TABLES[:3]]
    result = apply(local, capture([{"id": "older"}], 102, -86400))
    assert result.skipped_older_capture
    assert [read(local, table) for table in TABLES[:3]] == before
    assert {r["alert_logical_id"] for r in read(local, TABLES[4])} == {"id:avis", "id:older"}


def test_null_empty_jsonb_unicode_multi_period_and_microsecond_parity(local):
    alert = ALERT | {"url": "", "description": None, "extra": {"zzz": 1, "é": "雪", "a": []}}
    alert["activePeriods"] = [*ALERT["activePeriods"], {"end": "2027-01-01T00:00:00.654321Z"}]
    apply(local, capture([alert]))
    row = read(local)[0]
    assert row["description_text"] is None and row["url"] is None
    assert row["captured_at_utc"] == AT
    decoded = json.loads(row["raw_alert_json"])
    assert decoded == alert
    assert list(decoded["extra"]) == ["a", "é", "zzz"]
    assert [r["end_utc"] for r in read(local, TABLES[2])] == [
        None,
        AT.replace(year=2027, month=1, day=1, hour=0, minute=0, second=0, microsecond=654321),
    ]


def test_failure_leaves_no_partial_cycle(local):
    apply(local, capture([ALERT]))
    local.connection.execute("ALTER TABLE silver.i3_alert_informed_entities RENAME TO saved")
    ddl = local.connection.execute(
        "SELECT sql FROM duckdb_tables() WHERE schema_name='silver' AND table_name='saved'"
    ).fetchone()[0]
    local.connection.execute(
        ddl.replace("silver.saved", "silver.i3_alert_informed_entities").replace(
            "route_id VARCHAR", "route_id VARCHAR CHECK (route_id <> 'refused')"
        )
    )
    before = persisted_state(local.connection)
    with pytest.raises(duckdb.Error):
        apply(local, capture([ALERT | {"id": "new", "routes": ["refused"]}], 102, 1))
    assert persisted_state(local.connection) == before


def test_wrong_provider_refused_without_changes(local):
    before = persisted_state(local.connection)
    with pytest.raises(ValueError, match="provider"):
        apply(local, replace(capture([ALERT]), provider_id="other"))
    assert persisted_state(local.connection) == before
