import json
from copy import deepcopy
from datetime import UTC, datetime
from itertools import combinations
from pathlib import Path
from random import Random
from types import FunctionType

import pytest

import transit_ops.silver.i3 as silver
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


def test_period_error_precedes_invalid_parent_timestamp():
    payload = [{"activePeriod": {"start": "bad-period"}, "publishedAt": "bad-parent"}]
    with pytest.raises(ValueError) as old:
        normalize_i3_alert_payload(
            RawI3AlertSnapshot(**META, provider_timezone="UTC", raw_payload_json=payload)
        )
    with pytest.raises(type(old.value)) as new:
        stm_json_alerts(payload)
    assert str(new.value) == str(old.value) == "Invalid isoformat string: 'bad-period'"


ALIAS_FAMILIES = {
    "root": ("alerts", "messages", "data", "items", "results"),
    "id": ("id", "alertId", "messageId"),
    "header": ("header", "title", "summary", "header_texts"),
    "description": ("description", "body", "message", "description_texts"),
    "severity": ("severity", "priority"),
    "url": ("url", "link"),
    "published": ("publishedAt", "published_at"),
    "updated": ("updatedAt", "updated_at"),
    "entities": ("informedEntities", "informed_entities", "entities"),
    "routes": ("routes", "routeIds", "route_ids"),
    "stops": ("stops", "stopIds", "stop_ids"),
    "periods": ("activePeriod", "active_period", "activePeriods", "active_periods"),
    "start": ("start", "startTime", "start_time"),
    "end": ("end", "endTime", "end_time"),
    "route": ("routeId", "route_id", "route", "route_short_name"),
    "stop": ("stopId", "stop_id", "stop", "stop_code"),
    "trip": ("tripId", "trip_id", "trip"),
    "area": ("areaId", "area_id", "area"),
    "translation": ("text", "value"),
}


def _independent_normalizer():
    # Separate helper globals keep adapter-side mutations out of the unchanged oracle.
    namespace = vars(silver).copy()
    for name, fn in vars(silver).items():
        if isinstance(fn, FunctionType) and fn.__module__ == silver.__name__:
            clone = FunctionType(fn.__code__, namespace, name, fn.__defaults__, fn.__closure__)
            clone.__kwdefaults__ = fn.__kwdefaults__
            namespace[name] = clone
    return namespace["normalize_i3_alert_payload"]


def _json_bytes(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=lambda item: item.isoformat(),
    ).encode("utf-8")


def _outcome(call, payload):
    supplied = deepcopy(payload)
    try:
        result = call(supplied)
    except Exception as error:
        assert _json_bytes(supplied) == _json_bytes(payload)
        return "error", type(error), str(error)
    assert _json_bytes(supplied) == _json_bytes(payload)
    return "ok", result, _json_bytes(result)


def _shaped(family, values):
    if family == "root":
        return values
    if family in {"route", "stop", "trip", "area"}:
        return [{"entities": [values]}]
    if family in {"start", "end"}:
        return [{"activePeriod": [values]}]
    if family == "translation":
        return [{key: values for key in ("header", "description", "url")}]
    return [values]


def _distinct_values(family):
    if family == "root":
        return [{"id": " ÉTa  À "}], [{"id": "Late"}]
    if family == "entities":
        return [{"routeId": " RÖuTe  À "}], [{"routeId": "Late"}]
    if family == "periods":
        return [{"start": 0, "end": 1}], [{"start": 100, "end": 101}]
    if family in {"routes", "stops"}:
        return [" RÖuTe  À ", "Other"], ["Late"]
    if family in {"start", "end", "published", "updated"}:
        return 0, 100
    return " ÉTa  À ", "Late"


def _alias_cases():
    for family, aliases in ALIAS_FAMILIES.items():
        first_value, second_value = _distinct_values(family)
        for first, second in combinations(aliases, 2):
            cases = [{first: first_value}, {second: second_value}]
            cases += [
                {first: leading, second: second_value}
                for leading in (first_value, None, "", [], {}, False, 0, "  ")
            ]
            for values in cases:
                yield f"{family}:{first}/{second}:{values!r}", _shaped(family, values)
    for family in ("published", "updated", "start", "end", "periods"):
        for alias in ALIAS_FAMILIES[family]:
            for text in ("2026-11-12t12:00:00z", "2026-11-12  12:00:00Z", "bad-Value"):
                value = [{"start": text}] if family == "periods" else text
                yield f"timestamp:{alias}:{text}", _shaped(family, {alias: value})


def _text_and_composed_cases():
    texts = [
        {"en": "English", "fra": " Français  ÉTÉ "},
        {"eng": " English  ÉTÉ "},
        {" en_US ": " English  ÉTÉ ", " fra ": " Français  ÉTÉ "},
        [
            {"language": "  FR-CA  ", "text": " Déjà  Vu "},
            {"language": "fra", "value": "Second"},
            {"language": "en_US", "value": "Åland"},
        ],
        {"text": None, "value": {"es": "Primero", "en": "Second"}},
        {"text": "", "value": " FaLlBaCk  ÉTÉ "},
        {"value": " VaLuE  ÉTÉ "},
        {"text": " FiRsT  ÉTÉ ", "value": "Second"},
    ]
    boundaries = (
        "id",
        "header",
        "description",
        "severity",
        "url",
        "cause",
        "effect",
        "route",
        "stop",
        "trip",
        "area",
    )
    for family in boundaries:
        for value in [" MiXeD  ÉTÉ ", *texts]:
            yield f"text:{family}:{value!r}", _shaped(family, {family: value})
    rng = Random(975)
    scalars = [None, "", False, 0, 2.5, " MiXeD  ÉTÉ ", *texts]
    for index in range(500):
        raw, selector = {}, {}
        for family in boundaries:
            aliases = ALIAS_FAMILIES.get(family, (family,))
            target = selector if family in {"route", "stop", "trip", "area"} else raw
            for key in rng.sample(aliases, rng.randrange(len(aliases) + 1)):
                target[key] = deepcopy(rng.choice(scalars))
        raw["entities"] = [False, selector, {"routeId": "Other"}]
        yield f"seeded:{index}", [False, raw, deepcopy(raw)]


def test_finite_differential_corpus_matches_independent_old_path():
    oracle = _independent_normalizer()

    def old(payload):
        return oracle(RawI3AlertSnapshot(**META, provider_timezone="UTC", raw_payload_json=payload))

    def new(payload):
        return alert_rows(stm_json_alerts(payload), **META)

    for name, payload in (*_alias_cases(), *_text_and_composed_cases()):
        assert _outcome(new, payload) == _outcome(old, payload), name


def test_root_first_list_and_field_first_present_are_distinct():
    assert rows({"alerts": None, "messages": [{"id": "B"}]})[0][0]["alert_id"] == "B"
    assert rows({"alerts": [], "messages": [{"id": "B"}]}) == ([], [], [])
    assert rows([{"informedEntities": None, "entities": [{"routeId": "B"}]}])[1] == []
    assert (
        rows([{"header": {"text": "", "value": " Déjà  Vu "}}])[0][0]["alert_header_text"]
        == "Déjà  Vu"
    )


def test_language_aliases_keep_complete_maps_and_nested_selector_text():
    text = [
        {"language": "  FR-CA  ", "text": " Français  ÉTÉ "},
        {"language": "fra", "text": "Later"},
        {"language": "en_US", "value": "English"},
    ]
    raw = {
        "header": text,
        "description": {"eng": "English", "fra": "Français"},
        "entities": [
            {
                "route": {"text": " RÖuTe  À ", "value": "Later"},
                "stop": {"text": None, "value": " StÖp  À "},
            }
        ],
    }
    (record,) = stm_json_alerts([raw])
    assert record.header == {"fr": "Français  ÉTÉ", "en": "English"}
    assert record.description == {"en": "English", "fr": "Français"}
    parent, entities, _ = rows([raw])
    assert parent[0]["description_text"] == "Français"
    assert parent[0]["description_text_en"] == "English"
    assert (entities[0]["route_id"], entities[0]["stop_id"]) == ("RÖuTe  À", "StÖp  À")
