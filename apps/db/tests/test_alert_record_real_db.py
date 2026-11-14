"""Dormant STM projection replayed through the unchanged PostgreSQL writer."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
import real_db_seed as db_seed
from sqlalchemy import text

from transit_ops.providers.alert_record import alert_rows
from transit_ops.providers.formats.alerts_stm_json import stm_json_alerts
from transit_ops.silver import i3
from transit_ops.static.alert_seed_contract import KEYS, SCHEMAS, TABLES

PROVIDER = "alert_record_replay"
BASE = 996020
AT = datetime(2026, 6, 10, 12, tzinfo=UTC)
A = {
    "id": "A",
    "header": {"fr": "Avis", "en": "Notice"},
    "description": "v1",
    "routes": ["10"],
    "url": "https://example.test/old",
}
B = {"id": "B", "header": "Autre", "routes": ["40"]}
CASES = {
    "same_hash_new_capture": [[A], [{**A, "routes": ["20", "30"]}]],
    "changed_content_and_occurrences": [
        [A],
        [
            None,
            {**A, "description": "v2"},
            {**A, "description": "v3"},
            {"header": "Sans id", "routes": ["50"]},
        ],
    ],
    "disappearance_and_reappearance": [[A], [B], [A]],
    "empty_batch": [[A], []],
    "message_and_periods": [
        [{**A, "activePeriods": [{"start": 0}, None, {"end": 60}]}],
        [
            {
                **A,
                "header": {"fr": "Avis", "en": "Updated notice"},
                "url": "https://example.test/new",
                "activePeriods": [{"start": 0}, None, {"end": 60}],
            }
        ],
    ],
    "ordering_and_malformed": [
        [{**A, "header": {"es": "Aviso", "de": "Kurz"}}],
        [B],
        [A],
        [{**A, "publishedAt": "invalid-date"}],
    ],
}


def _query(pg, sql, **params):
    return pg.execute(text(sql), params)


@pytest.fixture()
def replay_db(real_db_engine, seed_provider, request):
    sequence = CASES[request.param]
    with real_db_engine.connect() as pg:
        transaction = pg.begin()
        try:
            seed_provider(pg, PROVIDER, display_name="Disposable alert replay")
            db_seed.feed_endpoints(
                pg,
                {"p": PROVIDER, "e": BASE},
                endpoint_key="'i3_alerts'",
                feed_kind="'i3_alerts'",
                source_format="'api_i3_json'",
            )
            for index, payload in enumerate(sequence):
                at = AT + timedelta(minutes=index)
                if request.param == "ordering_and_malformed" and index == 2:
                    at = AT - timedelta(minutes=1)
                params = {"p": PROVIDER, "e": BASE, "r": BASE + index + 1, "at": at}
                db_seed.ingestion_runs(
                    pg,
                    params,
                    run_kind="'i3_alerts'",
                    started_at_utc=":at",
                    completed_at_utc=":at",
                )
                _query(
                    pg,
                    "INSERT INTO raw.i3_alert_snapshots "
                    "(i3_alert_snapshot_id, provider_id, feed_endpoint_id, ingestion_run_id, "
                    "captured_at_utc, raw_payload_json) "
                    "VALUES (:r, :p, :e, :r, :at, CAST(:body AS jsonb))",
                    **params,
                    body=json.dumps(payload, ensure_ascii=False),
                )
            yield pg, request.param, len(sequence)
        finally:
            transaction.rollback()


def _state(pg):
    result = {}
    for name in TABLES:
        fields = ", ".join(
            f'"{column}"::text AS "{column}"' if kind == "jsonb" else f'"{column}"'
            for column, kind in SCHEMAS[name].items()
        )
        scope = "provider_id=:p"
        if name == "silver.i3_alert_active_periods":
            scope = "i3_alert_snapshot_id IN (SELECT i3_alert_snapshot_id "
            scope += "FROM raw.i3_alert_snapshots WHERE provider_id=:p)"
        result[name] = list(
            _query(
                pg,
                f"SELECT {fields} FROM {name} WHERE {scope} ORDER BY {', '.join(KEYS[name])}",
                p=PROVIDER,
            ).mappings()
        )
    return result


def _replay(pg, size):
    history = []
    for index in range(size):
        before = _state(pg)
        snapshot = i3.find_i3_raw_snapshot(pg, provider_id=PROVIDER, snapshot_id=BASE + index + 1)
        try:
            with pg.begin_nested():
                outcome = i3.load_i3_snapshot_to_silver(
                    pg,
                    snapshot=snapshot,
                    loaded_at_utc=AT + timedelta(hours=1),
                )
        except ValueError as error:
            outcome = (type(error), str(error))
            assert _state(pg) == before
        history.append((outcome, _state(pg)))
    return history


def _literal_checks(case, history):
    first = history[0][1][TABLES[0]][0]
    final = history[-1][1]
    parents = final[TABLES[0]]
    entities = final[TABLES[1]]

    def key(row):
        return row["i3_alert_snapshot_id"], row["alert_index"]

    if case == "same_hash_new_capture":
        assert [(key(r), r["entity_index"], r["route_id"]) for r in entities] == [
            ((BASE + 1, 0), 0, "10"),
            ((BASE + 1, 0), 1, "30"),
        ]
        assert len(parents) == 1 and key(parents[0]) == (BASE + 1, 0)
        assert parents[0]["last_seen_at"] == AT + timedelta(minutes=1)
        assert parents[0]["first_seen_at"] == AT
        assert (parents[0]["message_snapshot_id"], parents[0]["message_alert_index"]) == (
            BASE + 2,
            0,
        )
        assert parents[0]["content_hash"] == first["content_hash"]
    elif case == "changed_content_and_occurrences":
        assert [(key(r), r["alert_id"], r["description_text"], r["valid_to"]) for r in parents] == [
            ((BASE + 1, 0), "A", "v1", AT + timedelta(minutes=1)),
            ((BASE + 2, 1), "A", "v2", None),
            ((BASE + 2, 2), "A", "v3", None),
            ((BASE + 2, 3), None, None, None),
        ]
        assert len({r["content_hash"] for r in parents}) == 4
        assert [(key(r), r["route_id"]) for r in entities] == [
            ((BASE + 1, 0), "10"),
            ((BASE + 2, 1), "10"),
            ((BASE + 2, 2), "10"),
            ((BASE + 2, 3), "50"),
        ]
    elif case == "disappearance_and_reappearance":
        assert [(key(r), r["alert_id"], r["valid_to"]) for r in parents] == [
            ((BASE + 1, 0), "A", AT + timedelta(minutes=1)),
            ((BASE + 2, 0), "B", AT + timedelta(minutes=2)),
            ((BASE + 3, 0), "A", None),
        ]
        assert parents[0]["content_hash"] == parents[2]["content_hash"]
        assert parents[2]["first_seen_at"] == AT + timedelta(minutes=2)
    elif case == "empty_batch":
        assert parents == history[0][1][TABLES[0]]
        assert parents[0]["valid_to"] is None
        assert [(r["alert_count"], r["observed_at_utc"]) for r in final[TABLES[3]]] == [
            (0, AT + timedelta(minutes=1))
        ]
    elif case == "message_and_periods":
        assert len(parents) == 1 and key(parents[0]) == (BASE + 1, 0)
        assert parents[0]["content_hash"] == first["content_hash"]
        assert (
            parents[0]["alert_header_text"],
            parents[0]["alert_header_text_en"],
            parents[0]["url"],
            parents[0]["message_snapshot_id"],
        ) == ("Avis", "Updated notice", "https://example.test/new", BASE + 2)
        assert [
            (key(r), r["period_index"], r["start_utc"], r["end_utc"]) for r in final[TABLES[2]]
        ] == [
            ((BASE + 1, 0), 0, datetime(1970, 1, 1, tzinfo=UTC), None),
            ((BASE + 1, 0), 1, None, None),
            ((BASE + 1, 0), 2, None, datetime(1970, 1, 1, 0, 1, tzinfo=UTC)),
        ]
    else:
        assert first["alert_header_text"] == "Kurz"
        assert history[2][0].skipped_older_capture is True
        assert history[2][1] == history[1][1]
        assert history[3][0] == (ValueError, "Invalid isoformat string: 'invalid-date'")
        assert final == history[2][1]


@pytest.mark.parametrize("replay_db", CASES, indirect=True)
def test_open_and_close_outcomes_match_on_a_replayed_sequence(
    replay_db, monkeypatch, record_property
):
    pg, case, size = replay_db
    savepoint = pg.begin_nested()
    try:
        expected = _replay(pg, size)
        _literal_checks(case, expected)
    finally:
        savepoint.rollback()

    def projected(snapshot):
        return alert_rows(
            stm_json_alerts(snapshot.raw_payload_json),
            provider_id=snapshot.provider_id,
            i3_alert_snapshot_id=snapshot.i3_alert_snapshot_id,
            captured_at_utc=snapshot.captured_at_utc,
        )

    # Mutants live only in this replay's scoped row source, never in product files.
    original = stm_json_alerts
    for mutant in ("route", "drop_entity", "drop_occurrence"):

        def mutated(payload, mutation=mutant):
            records = original(payload)
            if mutation == "drop_occurrence":
                return records[1:]
            return tuple(
                replace(
                    record,
                    informed_entities=()
                    if mutation == "drop_entity"
                    else tuple(
                        replace(entity, route_id="mutated-route")
                        for entity in record.informed_entities
                    ),
                )
                for record in records
            )

        savepoint = pg.begin_nested()
        try:
            with monkeypatch.context() as patch:
                patch.setitem(projected.__globals__, "stm_json_alerts", mutated)
                patch.setattr(i3, "normalize_i3_alert_payload", projected)
                with pytest.raises(AssertionError) as red:
                    assert _replay(pg, size) == expected
                record_property(f"red_{mutant}", str(red.value))
        finally:
            savepoint.rollback()

    with monkeypatch.context() as patch:
        patch.setattr(i3, "normalize_i3_alert_payload", projected)
        actual = _replay(pg, size)
    assert actual == expected
    _literal_checks(case, actual)
