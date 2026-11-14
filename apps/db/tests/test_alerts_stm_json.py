import json
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

import pytest

from transit_ops.ingestion.i3 import extract_i3_metadata
from transit_ops.providers.alert_record import alert_rows
from transit_ops.providers.formats.alerts_stm_json import stm_json_alerts
from transit_ops.silver.i3 import RawI3AlertSnapshot, normalize_i3_alert_payload

META = dict(
    provider_id="fixture_city",
    i3_alert_snapshot_id=1,
    captured_at_utc=datetime(2026, 11, 12, 12, tzinfo=UTC),
)
ROOT = Path(__file__).parent / "fixtures" / "alerts"


def rows(payload):
    result = alert_rows(stm_json_alerts(payload), **META)
    assert result == normalize_i3_alert_payload(
        RawI3AlertSnapshot(**META, provider_timezone="UTC", raw_payload_json=payload)
    )
    return result


@pytest.mark.parametrize("severity", ["warning", "MiXeD", None, "absent"])
def test_stm_source_strings_survive_unchanged(severity):
    raw = {
        "header": "  Métro interrompu  ",
        "description": "Été",
        "cause": "technical_problem",
        "effect": "custom_effect",
        "publishedAt": 0,
        "updatedAt": "2026-11-12T12:00:00Z",
    }
    if severity != "absent":
        raw["severity"] = severity
    (record,) = stm_json_alerts([raw])
    assert (record.cause, record.effect, record.severity_level) == (
        "technical_problem",
        "custom_effect",
        None if severity == "absent" else severity,
    )
    assert (record.cause_standard, record.effect_standard) == (None, None)
    assert record.header == {"": "Métro interrompu"}
    assert record.published_at == datetime(1970, 1, 1, tzinfo=UTC)
    assert record.updated_at == META["captured_at_utc"]
    assert record.raw == raw
    rows([raw])


@pytest.mark.parametrize(
    "case",
    sorted((ROOT / "corpus" / "stm-etatservice-json").glob("*.json")),
    ids=lambda case: case.stem,
)
def test_stm_rows_and_hashes_match_golden(case):
    payload = json.loads(case.read_text(encoding="utf-8"))
    actual = alert_rows(stm_json_alerts(payload), **META)
    golden = json.loads(
        (ROOT / "golden" / case.parent.name / case.name).read_text(encoding="utf-8")
    )
    encoded = json.loads(
        json.dumps(actual, default=lambda value: value.isoformat(), ensure_ascii=False)
    )
    assert encoded == [golden[key] for key in ("alert_rows", "entity_rows", "period_rows")]


@pytest.mark.parametrize(
    "cause,effect,standard",
    [
        ("TECHNICAL_PROBLEM", "SIGNIFICANT_DELAYS", ("TECHNICAL_PROBLEM", "SIGNIFICANT_DELAYS")),
        ("technical_problem", "significant_delays", (None, None)),
        ("UNKNOWN_CAUSE", "UNKNOWN_EFFECT", ("UNKNOWN_CAUSE", "UNKNOWN_EFFECT")),
        ("WARNING", "WARNING", (None, None)),
    ],
)
def test_only_exact_published_enum_names_are_standard(cause, effect, standard):
    (record,) = stm_json_alerts([{"cause": cause, "effect": effect}])
    assert (record.cause_standard, record.effect_standard) == standard
    assert (record.cause, record.effect) == (cause, effect)


@pytest.mark.parametrize(
    "aliases,column",
    [
        (("id", "alertId", "messageId"), "alert_id"),
        (("header", "title", "summary", "header_texts"), "alert_header_text"),
        (("description", "body", "message", "description_texts"), "description_text"),
        (("severity", "priority"), "severity"),
        (("url", "link"), "url"),
        (("publishedAt", "published_at"), "published_at_utc"),
        (("updatedAt", "updated_at"), "updated_at_utc"),
        (("routeId", "route_id", "route", "route_short_name"), "route_id"),
        (("stopId", "stop_id", "stop", "stop_code"), "stop_id"),
        (("tripId", "trip_id", "trip"), "trip_id"),
        (("areaId", "area_id", "area"), "area_id"),
    ],
)
@pytest.mark.parametrize("leading", [None, "", 0, False, "chosen"])
def test_stm_alias_precedence_is_first_present_not_first_truthy(aliases, column, leading):
    timestamp = column.endswith("_utc")
    if timestamp and leading == "chosen":
        leading = "2026-11-12T12:00:00Z"
    expected = (
        META["captured_at_utc"]
        if leading == "2026-11-12T12:00:00Z"
        else datetime(1970, 1, 1, tzinfo=UTC)
        if timestamp and leading in (0, False)
        else None
        if leading is None or leading == ""
        else str(leading)
    )
    for start in range(len(aliases)):
        values = dict.fromkeys(aliases[start:], "2026-01-01T00:00:00Z" if timestamp else "later")
        values[aliases[start]] = leading
        child = column in {"route_id", "stop_id", "trip_id", "area_id"}
        payload = [{"entities": [values]}] if child else [values]
        parents, entities, _ = rows(payload)
        assert (entities if child else parents)[0][column] == expected


@pytest.mark.parametrize("wrapper", ["alerts", "messages", "data", "items", "results"])
def test_stm_root_and_collection_aliases(wrapper):
    assert (
        stm_json_alerts(
            {wrapper: [], "results": [{"id": "ignored"}]} if wrapper != "results" else {wrapper: []}
        )
        == ()
    )
    assert rows({wrapper: [{"id": "kept"}]})[0][0]["alert_id"] == "kept"
    for aliases in [
        ("informedEntities", "informed_entities", "entities"),
        ("routes", "routeIds", "route_ids"),
        ("stops", "stopIds", "stop_ids"),
        ("activePeriod", "active_period", "activePeriods", "active_periods"),
    ]:
        for start in range(len(aliases)):
            raw = dict.fromkeys(
                aliases[start:], [{"start": 0}] if aliases[0] == "activePeriod" else ["later"]
            )
            raw[aliases[start]] = []
            if aliases[0] == "informedEntities":
                raw["routes"] = ["fallback"]
            _, entities, periods = rows([raw])
            assert (periods if aliases[0] == "activePeriod" else entities) == []


def test_stm_occurrences_keep_gaps_and_children():
    a = {"id": "same", "header": "A", "routes": ["10"], "activePeriod": [{"start": 0}]}
    duplicate = {**a, "routes": ["20"]}
    b = {**a, "header": "B", "routes": ["30"]}
    payload = [False, a, duplicate, b, {"routes": ["40"]}, {"routes": ["50"]}]
    records = stm_json_alerts(payload)
    assert [r.occurrence_index for r in records] == [1, 2, 3, 4, 5]
    assert [r.id for r in records] == ["same", "same", "same", None, None]
    parents, entities, periods = rows(payload)
    assert [p["alert_index"] for p in parents] == [1, 3, 4]
    assert [(e["alert_index"], e["route_id"]) for e in entities] == [
        (1, "10"),
        (3, "30"),
        (4, "40"),
    ]
    assert [p["alert_index"] for p in periods] == [1, 3]


def test_stm_fallback_selectors_and_periods_match_existing_rows():
    for route_key in ("routes", "routeIds", "route_ids"):
        for stop_key in ("stops", "stopIds", "stop_ids"):
            assert [
                (e["route_id"], e["stop_id"])
                for e in rows([{route_key: [10, 20], stop_key: [30, None]}])[1]
            ] == [("10", "30"), ("10", "None")]
    assert [e["route_id"] for e in rows([{"routes": [10, 20]}])[1]] == ["10", "20"]
    assert [e["stop_id"] for e in rows([{"stops": [30, 40]}])[1]] == ["30", "40"]
    for key in ("informedEntities", "informed_entities", "entities"):
        (record,) = stm_json_alerts(
            [
                {
                    key: [
                        False,
                        {"routeId": "10", "agencyId": "x", "routeType": 3},
                        None,
                        {"stopId": "20"},
                    ]
                }
            ]
        )
        assert [(e.agency_id, e.route_type) for e in record.informed_entities] == [(None, None)] * 2
        assert [e["entity_index"] for e in rows([record.raw])[1]] == [0, 1]
    for key in ("activePeriod", "active_period", "activePeriods", "active_periods"):
        for start in ("start", "startTime", "start_time"):
            for end in ("end", "endTime", "end_time"):
                raw = {key: [{start: 0, end: None}, False, {start: 1, end: 2}]}
                (record,) = stm_json_alerts([raw])
                assert record.active_periods == (
                    (datetime(1970, 1, 1, tzinfo=UTC), None),
                    (None, None),
                    (datetime.fromtimestamp(1, UTC), datetime.fromtimestamp(2, UTC)),
                )
                assert [p["period_index"] for p in rows([raw])[2]] == [0, 1, 2]
                reordered = {key: [raw[key][0], raw[key][2], raw[key][1]]}
                assert rows([raw])[0][0]["content_hash"] != rows([reordered])[0][0]["content_hash"]
        assert len(rows([{key: {"start": 0}}])[2]) == 1
    for aliases in (("start", "startTime", "start_time"), ("end", "endTime", "end_time")):
        for leading in (None, "", 0, False):
            (record,) = stm_json_alerts(
                [{"activePeriod": [{**dict.fromkeys(aliases, 100), aliases[0]: leading}]}]
            )
            expected = (
                None if leading is None or leading == "" else datetime(1970, 1, 1, tzinfo=UTC)
            )
            assert record.active_periods[0][0 if aliases[0] == "start" else 1] == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ({"en": "English", "fr": "Français"}, "Français"),
        (
            [{"language": "fr-CA", "text": " premier "}, {"language": "fra", "text": "second"}],
            "premier",
        ),
        ({"es": "Primero", "en": "Second"}, "Primero"),
        ({"en": "Second", "es": "Primero"}, "Second"),
        (42, "42"),
        (" untagged ", "untagged"),
    ],
)
def test_stm_text_selection_and_identity_match_existing_values(text, expected):
    raw = {"header": text, "description": text, "url": text}
    (record,) = stm_json_alerts([raw])
    assert record.identity.alert_header_text == expected
    assert record.identity.description_text == expected
    assert rows([raw])[0][0]["alert_header_text"] == expected
    original = {"header": {"fr": "Français", "en": "English"}, "url": "old"}
    enriched = {"header": {"fr": "Français", "en": "Changed"}, "url": "new"}
    assert rows([original])[0][0]["content_hash"] == rows([enriched])[0][0]["content_hash"]
    assert rows([enriched])[0][0]["alert_header_text_en"] == "Changed"
    assert rows([enriched])[0][0]["url"] == "new"


def test_stm_projection_preserves_raw_json_and_input():
    payload = [
        {
            "id": 0,
            "header": {"en-CA": "  Raw  ", "fr": " Métro "},
            "extra": [False, None, 2.5, {"Été": " été "}],
            "entities": [{"route_id": 0, "stop": " 20 ", "custom": [1, None]}],
            "active_periods": [None, {"start_time": 0}],
        }
    ]
    before = deepcopy(payload)
    records = stm_json_alerts(payload)
    projected = rows(payload)
    old = normalize_i3_alert_payload(
        RawI3AlertSnapshot(**META, provider_timezone="UTC", raw_payload_json=payload)
    )
    assert records[0].raw == before[0] == projected[0][0]["raw_alert_json"]
    assert records[0].informed_entities[0].raw == before[0]["entities"][0]
    for actual, expected in zip(projected[:2], old[:2], strict=True):
        key = "raw_alert_json" if actual is projected[0] else "raw_entity_json"
        for a, b in zip(actual, expected, strict=True):
            # Same encoding proves JSON column value bytes, not original HTTP whitespace.
            assert json.dumps(
                a[key], ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8") == json.dumps(
                b[key], ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
    assert payload == before


@pytest.mark.parametrize("payload", [None, False, 1, "scalar", {}, [], {"alerts": []}])
def test_stm_empty_and_invalid_values_keep_the_existing_contract(payload):
    assert stm_json_alerts(payload) == ()
    assert rows(payload) == ([], [], [])
    for malformed, cause in [(b"\xff", UnicodeDecodeError), (b"{", json.JSONDecodeError)]:
        with pytest.raises(ValueError, match="Failed to parse i3 JSON payload") as failure:
            stm_json_alerts(
                extract_i3_metadata(malformed, provider_id="fixture_city").raw_payload_json
            )
        assert isinstance(failure.value.__cause__, cause)
    with pytest.raises(ValueError, match="must be an object or an array"):
        stm_json_alerts(extract_i3_metadata(b"1", provider_id="fixture_city").raw_payload_json)
    decoded = extract_i3_metadata(
        b'[{"id":"decoded"}]', provider_id="fixture_city"
    ).raw_payload_json
    assert rows(decoded)[0][0]["alert_id"] == "decoded"
    bad = [{"publishedAt": "not-a-timestamp"}]
    with pytest.raises(ValueError) as old:
        normalize_i3_alert_payload(
            RawI3AlertSnapshot(**META, provider_timezone="UTC", raw_payload_json=bad)
        )
    with pytest.raises(type(old.value), match="Invalid isoformat string") as new:
        stm_json_alerts(bad)
    assert str(new.value) == str(old.value)
