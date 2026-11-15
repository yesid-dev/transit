import json
from copy import deepcopy
from dataclasses import asdict, fields, replace
from hashlib import sha256
from pathlib import Path

import pytest

from transit_ops.ranking import (
    RULES,
    EntityWindow,
    MeasureSpec,
    RankedEntity,
    RankingRules,
    measure_state,
    rank_entities,
    shown_units,
)

VECTORS = Path(__file__).parent / "fixtures" / "ranking_vectors.json"
IDS = (
    "half_exact",
    "half_not_exact_in_binary",
    "half_negative",
    "past_2_53",
    "shared_rank_keeps_exact_order",
    "id_code_point",
    "code_point_beyond_bmp",
    "operands_past_2_53",
    "state_per_measure",
    "scheduled_with_no_reading",
    "capped_floor",
    "unresolved_is_not_measured",
    "network_without_late_reading",
    "exact_tie_uses_pair",
    "equal_values_at_90_of_100",
    "pair_both_unavailable",
    "pair_available_before_unavailable",
)


def integers(value):
    return json.loads(json.dumps(value), parse_int=str)


def spec_from(data):
    data = dict(data)
    assert set(data) == {field.name for field in fields(MeasureSpec)}
    for key in ("precision", "floor_trips", "floor_units"):
        data[key] = None if data[key] is None else int(data[key])
    data["scale"] = tuple(map(int, data["scale"]))
    data["pair"] = None if data["pair"] is None else spec_from(data["pair"])
    return MeasureSpec(**data)


def rules_from(data):
    assert set(data) == {field.name for field in fields(RankingRules)}
    result = {}
    for key, value in data.items():
        sample = getattr(RULES, key)
        if isinstance(sample, int):
            value = int(value)
        elif key == "service_day_base":
            value = {name: int(count) for name, count in value.items()}
        elif key == "service_day_range":
            value = (int(value[0]), tuple(map(int, value[1])))
        elif isinstance(sample, tuple):
            value = tuple(int(item) if isinstance(sample[0], int) else item for item in value)
        result[key] = value
    return RankingRules(**result)


def row_from(data):
    data = dict(data)
    assert set(data) == {field.name for field in fields(EntityWindow)}
    for key in ("scheduled_days", "reading_days"):
        data[key] = int(data[key])
    for key in ("counts", "measured_days"):
        data[key] = {k: int(v) for k, v in data[key].items()}
    data["groups"] = tuple(data["groups"])
    return EntityWindow(**data)


def check_vector(vector_id):
    document = json.loads(VECTORS.read_bytes())
    group = next(case for case in document["vectors"] if case["id"] == vector_id)
    for case in group.get("cases", [group]):
        check_case(case, rules_from(document["rules"]))


def check_case(case, rules):
    spec = spec_from(case["spec"])
    rows = [row_from(row) for row in case["rows"]]
    network = case["network"]
    network = None if network is None else {k: int(v) for k, v in network.items()}
    for ordered in (rows, list(reversed(rows))):
        actual = rank_entities(
            ordered,
            spec=spec,
            window_days=int(case["window_days"]),
            rules=rules,
            network=network,
        )
        assert integers([asdict(row) for row in actual]) == case["expected"]
        for row in actual:
            source = next(item for item in rows if item.entity_id == row.entity_id)
            assert (
                measure_state(
                    source, spec, window_days=int(case["window_days"]), rules=rules, network=network
                )
                == row.state
            )
            if row.shown_units is not None:
                assert shown_units(row.numerator, row.denominator or 1, spec) == row.shown_units
    assert [dict(row.counts) for row in rows] == [
        {k: int(v) for k, v in row["counts"].items()} for row in case["rows"]
    ]
    if case.get("id") == "half_negative":
        assert shown_units(-13500, 100, spec, precision=0) == -2


def test_half_exact():
    check_vector("half_exact")


def test_vectors_file_is_current():
    def no_number(token):
        raise AssertionError(f"JSON numeric token: {token}")

    raw = VECTORS.read_bytes()
    data = json.loads(raw, parse_int=no_number, parse_float=no_number, parse_constant=no_number)
    assert tuple(case["id"] for case in data["vectors"]) == IDS
    assert data["rules"] == integers(asdict(rules_from(data["rules"]))) == integers(asdict(RULES))
    for group in data["vectors"]:
        assert group["both"] is True
        if "cases" in group:
            assert set(group) == {"id", "both", "cases"}
        for case in group.get("cases", [group]):
            identity = {"name"} if "cases" in group else {"id", "both"}
            assert set(case) == identity | {"spec", "window_days", "network", "rows", "expected"}
            assert case["spec"] == integers(asdict(spec_from(case["spec"])))
            assert case["window_days"] == str(int(case["window_days"]))
            for row in case["rows"]:
                assert row == integers(asdict(row_from(row)))
            if case["network"] is not None:
                assert all(v == str(int(v)) for v in case["network"].values())
        check_vector(group["id"])

    def compact(value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

    rebuilt = (
        '{\n"rules":'
        + compact(data["rules"])
        + ',\n"vectors":[\n'
        + ",\n".join(map(compact, data["vectors"]))
        + "\n]\n}\n"
    )
    assert rebuilt.encode("ascii") == raw


def test_half_not_exact_in_binary():
    check_vector("half_not_exact_in_binary")


def test_half_negative():
    check_vector("half_negative")


def test_cross_products_past_2_53():
    check_vector("past_2_53")


def test_inside_a_shared_rank_the_exact_order_holds():
    check_vector("shared_rank_keeps_exact_order")


def test_ids_compare_by_code_point():
    check_vector("id_code_point")


def test_ids_beyond_the_basic_plane_compare_by_code_point():
    check_vector("code_point_beyond_bmp")


def test_operands_beyond_2_to_the_53_stay_exact():
    check_vector("operands_past_2_53")


def test_exact_ties_use_descending_trips_then_code_point_id():
    spec = spec_from(json.loads(VECTORS.read_bytes())["vectors"][5]["spec"])
    rows = [eligible_row("a", 30), eligible_row("z", 60), eligible_row("Z", 60)]
    for ordered in (rows, list(reversed(rows))):
        actual = rank_entities(ordered, spec=spec, window_days=1, rules=RULES)
        assert [(row.entity_id, row.shown_units, row.rank) for row in actual] == [
            ("Z", 900, 1),
            ("z", 900, 1),
            ("a", 900, 1),
        ]


def paired_spec():
    primary = spec_from(json.loads(VECTORS.read_bytes())["vectors"][5]["spec"])
    pair = replace(
        primary,
        id="late_avg",
        numerator="sum_late_delay_s",
        denominator="late",
        scale=(1, 60),
        worse="higher",
        floor_units=30,
        floor_units_of="late",
    )
    return replace(primary, pair=pair)


def pair_row(name, on_time=85, n=100, late=30, delay=18000, trips=30):
    return replace(
        eligible_row(name, trips),
        counts={
            "on_time": on_time,
            "n": n,
            "late": late,
            "sum_late_delay_s": delay,
            "trips": trips,
        },
    )


def test_the_pair_decides_only_between_exactly_equal_values():
    check_vector("exact_tie_uses_pair")
    rows = [pair_row("a_low", 340, 400, 60, 21600, 60), pair_row("z_high", 170, 200, 30, 36000, 30)]
    for ordered in (rows, rows[::-1]):
        actual = rank_entities(ordered, spec=paired_spec(), window_days=1, rules=RULES)
        assert [(r.entity_id, r.shown_units, r.rank) for r in actual] == [
            ("z_high", 850, 1),
            ("a_low", 850, 1),
        ]
    rows = [
        pair_row("a", 8516, 10000, 30, 10800),
        pair_row("z", 8524, 10000, 30, 36000),
        pair_row("better", 9000, 10000),
    ]
    for ordered in (rows, rows[::-1]):
        result = rank_entities(ordered, spec=paired_spec(), window_days=1, rules=RULES)
        assert result == [
            RankedEntity("a", "ranked", None, 1, 8516, 10000, 852),
            RankedEntity("z", "ranked", None, 1, 8524, 10000, 852),
            RankedEntity("better", "ranked", None, 3, 9000, 10000, 900),
        ]


def eligible_row(entity_id, trips):
    data = json.loads(VECTORS.read_bytes())["vectors"][0]["rows"][0]
    return replace(
        row_from(data), entity_id=entity_id, counts={"on_time": 90, "n": 100, "trips": trips}
    )


def test_two_unavailable_pairs_fall_to_trips_then_id():
    check_vector("equal_values_at_90_of_100")
    check_vector("pair_both_unavailable")


def test_an_available_pair_comes_before_an_unavailable_one():
    check_vector("pair_available_before_unavailable")


@pytest.mark.parametrize("direction", ["higher", "lower"])
def test_pair_uses_its_own_direction_and_exact_fraction(direction):
    spec = paired_spec()
    spec = replace(spec, pair=replace(spec.pair, worse=direction))
    a, z = (9007199254740992, 9007199254740993)
    if direction == "lower":
        a, z = z, a
    rows = [
        pair_row("a", late=18014398509481984, delay=a, trips=60),
        pair_row("z", late=18014398509481984, delay=z),
    ]
    assert shown_units(rows[0].counts["sum_late_delay_s"], 18014398509481984, spec.pair) == 0
    assert shown_units(rows[1].counts["sum_late_delay_s"], 18014398509481984, spec.pair) == 0
    for ordered in (rows, rows[::-1]):
        result = rank_entities(ordered, spec=spec, window_days=1, rules=RULES)
        assert [r.entity_id for r in result] == ["z", "a"]
        assert [(r.shown_units, r.rank) for r in result] == [(850, 1), (850, 1)]


@pytest.mark.parametrize(
    "gate,state",
    [
        ("trips", "too_few_trips"),
        ("days", "too_few_service_days"),
        ("units", "too_few_units"),
        ("measurement", "not_measured"),
        ("zero", "not_defined"),
    ],
)
def test_pair_unavailability_uses_its_own_measure_state(gate, state):
    spec = paired_spec()
    pair = replace(spec.pair, series="service", floor_trips_of="pair_trips")
    available = replace(pair_row("z"), measured_days={"reliability": 1, "service": 1})
    available = replace(available, counts=dict(available.counts, pair_trips=30))
    unavailable = replace(available, entity_id="a", counts=dict(available.counts, trips=60))
    if gate == "trips":
        unavailable = replace(unavailable, counts=dict(unavailable.counts, pair_trips=29))
    elif gate in ("days", "measurement"):
        unavailable = replace(unavailable, measured_days={"reliability": 1, "service": 0})
        if gate == "days":
            pair = replace(pair, series="reliability")
            spec = replace(spec, floor_service_days=False)
            unavailable = replace(unavailable, reading_days=0)
    else:
        unavailable = replace(unavailable, counts=dict(unavailable.counts, late=0))
        if gate == "zero":
            pair = replace(pair, floor_units=None)
    spec = replace(spec, pair=pair)
    assert measure_state(unavailable, pair, window_days=1, rules=RULES) == state
    for rows in ([available, unavailable], [unavailable, available]):
        result = rank_entities(rows, spec=spec, window_days=1, rules=RULES)
        assert result == [
            RankedEntity("z", "ranked", None, 1, 85, 100, 850),
            RankedEntity("a", "ranked", None, 1, 85, 100, 850),
        ]


def test_the_network_totals_reach_the_evaluation_of_the_pair():
    spec = paired_spec()
    spec = replace(
        spec,
        pair=replace(spec.pair, numerator="late", denominator_from="network", floor_units=None),
    )
    rows = [pair_row("a", late=10, trips=60), pair_row("z", late=40)]
    for totals, expected in [({"late": 100}, ["z", "a"]), ({"late": 0}, ["a", "z"])]:
        for ordered in (rows, rows[::-1]):
            result = rank_entities(ordered, spec=spec, window_days=1, rules=RULES, network=totals)
            assert [r.entity_id for r in result] == expected
            assert [(r.shown_units, r.rank) for r in result] == [(850, 1), (850, 1)]
    for totals, error in [(None, ValueError), ({}, KeyError), ({"late": -1}, ValueError)]:
        with pytest.raises(error):
            rank_entities(rows, spec=spec, window_days=1, rules=RULES, network=totals)


def test_equal_available_pairs_fall_to_primary_trips_then_code_point_id():
    rows = [pair_row("a"), pair_row("\U00010000", trips=60), pair_row("\ue000", trips=60)]
    for spec in (paired_spec(), replace(paired_spec(), pair=None)):
        for ordered in (rows, rows[::-1]):
            result = rank_entities(ordered, spec=spec, window_days=1, rules=RULES)
            assert [(r.entity_id, r.rank) for r in result] == [
                ("\ue000", 1),
                ("\U00010000", 1),
                ("a", 1),
            ]


def test_pair_does_not_change_primary_absence_or_mutate_inputs():
    spec, network = paired_spec(), {"unused": 12}
    rows = [
        pair_row("ranked"),
        replace(eligible_row("few", 29)),
        replace(eligible_row("absent", 30), scheduled_days=0, counts={}),
        replace(eligible_row("no-live", 30), live_data="no_live_data", counts={}),
    ]
    before = deepcopy((rows, spec, RULES, network))
    result = rank_entities(rows, spec=spec, window_days=1, rules=RULES, network=network)
    assert result == rank_entities(
        rows, spec=replace(spec, pair=None), window_days=1, rules=RULES, network=network
    )
    assert (rows, spec, RULES, network) == before


@pytest.mark.parametrize("direction,expected", [("higher", ["z", "a"]), ("lower", ["a", "z"])])
def test_the_engine_names_no_measure(direction, expected):
    pair = replace(
        paired_spec().pair,
        id="arbitrary",
        numerator="x",
        denominator="y",
        floor_units=None,
        worse=direction,
        floor_trips_of="q",
    )
    spec = replace(
        paired_spec(),
        id="other",
        numerator="u",
        denominator="v",
        floor_trips_of="q",
        pair=pair,
        worse=direction,
    )
    rows = [
        replace(eligible_row(name, 30), counts={"u": 1, "v": 2, "q": 30, "x": x, "y": 1})
        for name, x in [("a", 1), ("z", 2)]
    ]
    assert [
        r.entity_id for r in rank_entities(rows, spec=spec, window_days=1, rules=RULES)
    ] == expected


def test_existing_vector_records_keep_their_bytes():
    lines = VECTORS.read_bytes().splitlines()
    original = b"\n".join([lines[1], *[line.removesuffix(b",") for line in lines[3:16]]])
    assert (
        sha256(original).hexdigest()
        == "5f88135c5518161a7199193bcd1b10554845fc2fa1e4ac682794bff579db1cae"
    )


@pytest.mark.parametrize("missing", ["sum_late_delay_s", "late"])
def test_missing_pair_operands_refuse(missing):
    row = pair_row("a")
    row = replace(row, counts={k: v for k, v in row.counts.items() if k != missing})
    with pytest.raises(KeyError):
        rank_entities([row], spec=paired_spec(), window_days=1, rules=RULES)


@pytest.mark.parametrize("changes", [{"numerator": None}, {"scale": (0, 1)}, {"precision": -1}])
def test_invalid_pair_operands_refuse(changes):
    spec = paired_spec()
    with pytest.raises(ValueError):
        rank_entities(
            [pair_row("a")],
            spec=replace(spec, pair=replace(spec.pair, **changes)),
            window_days=1,
            rules=RULES,
        )


@pytest.mark.parametrize("direction", ["higher", "lower"])
def test_an_available_measured_zero_pair_precedes_an_unavailable_pair(direction):
    spec = paired_spec()
    spec = replace(spec, pair=replace(spec.pair, worse=direction))
    rows = [
        pair_row("z_available", delay=0),
        pair_row("a_unavailable", late=10, delay=12000, trips=60),
    ]
    for ordered in (rows, rows[::-1]):
        assert rank_entities(ordered, spec=spec, window_days=1, rules=RULES) == [
            RankedEntity("z_available", "ranked", None, 1, 85, 100, 850),
            RankedEntity("a_unavailable", "ranked", None, 1, 85, 100, 850),
        ]
