import importlib
import json
import socket

import boto3
import pytest
import sqlalchemy
from pydantic import ValidationError

from transit_ops import settings
from transit_ops.snapshots import contract, storage
from transit_ops.snapshots import contract_r3 as r3
from transit_ops.snapshots.serialization import snapshot_json_bytes


def test_unmeasured_values_remain_null_and_keep_the_reason():
    value = r3.ReadingValues(state="not_measured", reason="capture_gap", evidence="tentative")
    assert value.model_dump(mode="json") == {
        "state": "not_measured",
        "reason": "capture_gap",
        "evidence": "tentative",
        "reading_count": None,
        "on_time_count": None,
        "late_count": None,
        "early_count": None,
        "trip_count": None,
        "service_day_count": None,
        "measured_day_count": None,
        "on_time_pct": None,
        "late_pct": None,
        "early_pct": None,
        "avg_delay_min": None,
        "late_avg_min": None,
    }
    with pytest.raises(ValidationError):
        r3.ReadingValues(state="not_measured", evidence="tentative")


def test_service_counts_preserve_full_basis_and_weaker_basis():
    data = dict(
        state="measured",
        basis="facts",
        scheduled_trip_days=10,
        delivered_trip_days=9,
        cancelled_trip_days=0,
        missing_trip_days=0,
        not_measured_trip_days=1,
        not_reported_lines=None,
        no_live_data=None,
    )
    assert r3.ServiceValues(**data).model_dump()["not_measured_trip_days"] == 1
    with pytest.raises(ValidationError):
        r3.ServiceValues(**(data | {"delivered_trip_days": 10}))
    weaker = r3.ServiceValues(**(data | {"basis": "stored_counts", "missing_trip_days": None}))
    assert weaker.missing_trip_days is None
    assert weaker.basis == "stored_counts"


def test_population_does_not_default_or_mix_bases():
    excluded = dict.fromkeys(
        [
            "not_in_schedule",
            "line_not_counted",
            "not_scheduled",
            "no_delay",
            "clock_change",
            "no_edition_record",
            "other_edition",
            "before_start",
            "prediction_passed",
            "ambiguous_instance",
            "vehicle_feed_gap",
            "no_vehicle",
            "set_aside_extreme",
        ]
    )
    data = dict(
        excluded=excluded,
        coverage={
            "vehicle_positions": {
                "covered_pct": None,
                "slot_fill_pct": 0,
                "basis": None,
            }
        },
    )
    with pytest.raises(ValidationError):
        r3.Population(**data)
    value = r3.Population(basis="vehicle_evidence", **data)
    assert value.model_dump()["excluded"] == excluded
    assert value.model_dump()["coverage"] == data["coverage"]
    assert value != r3.Population(basis="scheduled_window", **data)
    with pytest.raises(ValidationError):
        r3.Population(basis="vehicle_evidence", **(data | {"excluded": {"stale": 0}}))


def test_a_measured_zero_is_distinct_from_not_measured():
    zero = r3.ReadingValues(
        state="measured",
        evidence="tentative",
        reading_count=0,
        on_time_count=0,
        late_count=0,
        early_count=0,
        trip_count=0,
    )
    missing = r3.ReadingValues(
        state="not_measured", reason="no_capture_record", evidence="tentative"
    )
    assert zero.reading_count == 0 and zero.on_time_pct is None
    assert missing.reading_count is None
    assert snapshot_json_bytes(zero) != snapshot_json_bytes(missing)


@pytest.mark.parametrize(
    "reason",
    [
        "schedule_not_kept",
        "captures_not_available",
        "no_capture_record",
        "capture_gap",
        "window_too_short",
        "applicability_unresolved",
        "schedule_mismatch",
    ],
)
def test_not_measured_reasons_round_trip(reason):
    value = r3.ReadingValues(state="not_measured", reason=reason, evidence="tentative")
    assert value.model_dump(mode="json")["reason"] == reason


@pytest.mark.parametrize(
    "reason",
    [
        "not_tracked",
        "not_published",
        "no_live_data",
        "missing",
        "stale",
        "unsupported",
        "not_applicable",
        "other",
    ],
)
def test_not_measured_reasons_do_not_admit_absence_states(reason):
    with pytest.raises(ValidationError):
        r3.ReadingValues(state="not_measured", reason=reason, evidence="tentative")


@pytest.mark.parametrize(
    "field,value",
    [
        ("reading_count", -1),
        ("trip_count", True),
        ("on_time_count", 1.5),
        ("late_pct", -0.1),
        ("early_pct", 100.1),
        ("on_time_pct", float("nan")),
        ("avg_delay_min", float("inf")),
        ("late_avg_min", float("-inf")),
        ("otp_pct", 50),
        ("severe_pct", 1),
        ("wilson_lo", 20),
        ("vehicles", 2),
        ("rider_impact_score", 1),
        ("service_states", {}),
    ],
)
def test_readings_refuse_invalid_numbers_and_legacy_fields(field, value):
    with pytest.raises(ValidationError):
        r3.ReadingValues(state="measured", evidence="counts", **{field: value})


def test_reading_state_and_reason_cannot_contradict_values():
    with pytest.raises(ValidationError):
        r3.ReadingValues(state="measured", reason="capture_gap", evidence="counts")
    with pytest.raises(ValidationError):
        r3.ReadingValues(
            state="not_measured", reason="capture_gap", evidence="tentative", reading_count=0
        )


def test_service_keeps_no_live_data_separate_and_absent_lists_unknown():
    value = r3.ServiceValues(
        state="measured",
        basis="facts",
        scheduled_trip_days=10,
        delivered_trip_days=9,
        cancelled_trip_days=0,
        missing_trip_days=1,
        not_measured_trip_days=0,
        not_reported_lines=None,
        no_live_data={
            "line_count": 1,
            "scheduled_trip_days": 20,
            "lines": [{"id": "rail", "short": "R", "scheduled_trip_days": 20}],
        },
    )
    assert value.scheduled_trip_days == 10
    assert value.model_dump()["no_live_data"]["scheduled_trip_days"] == 20
    assert value.not_reported_lines is None
    with pytest.raises(ValidationError):
        r3.NoLiveData(line_count=0, scheduled_trip_days=0)
    absent = r3.ServiceValues(
        state="not_measured",
        reason="schedule_not_kept",
        basis="facts",
        not_reported_lines=None,
        no_live_data=None,
    )
    assert absent.scheduled_trip_days is None
    capture_gap_json = (
        '{"state":"not_measured","reason":"capture_gap","basis":"facts",'
        '"scheduled_trip_days":10,"delivered_trip_days":null,"cancelled_trip_days":null,'
        '"missing_trip_days":null,"not_measured_trip_days":null,'
        '"service_completeness_pct":null,"not_reported_lines":null,"no_live_data":null}'
    )
    capture_gap = r3.ServiceValues(**json.loads(capture_gap_json))
    assert json.loads(snapshot_json_bytes(capture_gap)) == json.loads(capture_gap_json)
    with pytest.raises(ValidationError):
        r3.ServiceValues(**(absent.model_dump() | {"delivered_trip_days": 0}))
    with pytest.raises(ValidationError):
        r3.ServiceValues(**(absent.model_dump() | {"reason": None}))


def test_revision_three_contract_import_has_no_runtime_io(monkeypatch):
    old_schemas = contract.export_schemas()
    receipt = contract.Receipt(generated_utc="2026-11-01", date="2026-10-31", alerts=0)
    trend = contract.NetworkTrend(generated_utc="2026-11-01")
    old_bytes = [snapshot_json_bytes(receipt), snapshot_json_bytes(trend)]

    def forbidden(*args, **kwargs):
        pytest.fail("constructing evidence attempted runtime I/O or settings access")

    with monkeypatch.context() as guard:
        guard.setattr(socket, "socket", forbidden)
        guard.setattr(sqlalchemy, "create_engine", forbidden)
        guard.setattr(boto3, "client", forbidden)
        guard.setattr(settings, "Settings", forbidden)
        guard.setattr(storage, "SnapshotStorage", forbidden)
        guard.setattr(storage, "LocalSnapshotStorage", forbidden)
        guard.setattr(storage, "build_snapshot_storage", forbidden)
        importlib.reload(r3)
        r3.Receipt.model_validate(receipt_payload())
        r3.NetworkTrend.model_validate(trend_payload())
        r3.ReadingValues(state="measured", evidence="tentative", reading_count=0)
        r3.Population(basis="scheduled_window", excluded={}, coverage={})
        r3.ServiceValues(
            state="not_measured",
            reason="capture_gap",
            basis="facts",
            not_reported_lines=None,
            no_live_data=None,
        )
    assert contract.export_schemas() == old_schemas
    assert [snapshot_json_bytes(receipt), snapshot_json_bytes(trend)] == old_bytes


def receipt_payload():
    return {
        "schema_version": 1,
        "methodology_version": "receipt-2",
        "generated_utc": "2026-11-14T12:00:00Z",
        "publish_generation_id": None,
        "data_through": "2026-11-13",
        "date": "2026-11-13",
        "state": "not_measured",
        "reason": "capture_gap",
        "evidence": "tentative",
        "population": {"basis": "vehicle_evidence", "excluded": {}, "coverage": {}},
        "service": {
            "state": "not_measured",
            "reason": "capture_gap",
            "basis": "facts",
            "scheduled_trip_days": 10,
            "not_reported_lines": None,
            "no_live_data": None,
        },
        "worst_line": None,
        "worst_stop": None,
        "alerts": None,
        "alerts_reason": "not_tracked",
        "alerts_not_measured_reason": None,
    }


def test_percentile_open_edges_are_not_exact_values():
    for edges in ({"lower_s": 3600, "upper_s": None}, {"lower_s": None, "upper_s": -3600}):
        assert r3.PercentileBin.model_validate(edges).model_dump() == edges
    with pytest.raises(ValidationError):
        r3.PercentileBin(lower_s=60, upper_s=0)
    histogram = {"layout": 2, "bins": [0, 160], "n": [0, 1]}
    assert r3.DelayHistogram.model_validate(histogram).model_dump() == histogram
    for invalid in (
        {"n": [1]},
        {"bins": [160, 0]},
        {"bins": [0, 0]},
        {"bins": [0, 161]},
        {"n": [-1, 1]},
        {"layout": 1},
        {"counts": [0, 1]},
    ):
        with pytest.raises(ValidationError):
            r3.DelayHistogram.model_validate(histogram | invalid)


def trend_point():
    return {
        "date": "2026-11-13",
        "state": "measured",
        "evidence": "tentative",
        "reading_count": 0,
        "population": {"basis": "vehicle_evidence", "excluded": {}, "coverage": {}},
        "service": receipt_payload()["service"],
        "p50_bin": None,
        "p90_bin": None,
        "delay_hist": {"layout": 2, "bins": [80], "n": [0]},
        "vehicles_reporting": None,
        "vehicles_on_trip": None,
        "alert_cell": None,
    }


def trend_payload():
    return {
        "methodology_version": "reliability-3",
        "generated_utc": "2026-11-14T12:00:00Z",
        "data_through": "2026-11-13",
        "series": [trend_point()],
    }


def test_revision_three_tokens_are_isolated_and_family_specific():
    assert dict(r3.METHODOLOGY_TOKENS) == {
        "reliability": "reliability-3",
        "receipt": "receipt-2",
        "alerts": "alerts-3",
        "history": "history-2",
        "provenance": "provenance-2",
        "revision": "revision-1",
        "registry": "registry-1",
        "matrix": "matrix-1",
    }
    with pytest.raises(TypeError):
        r3.METHODOLOGY_TOKENS["receipt"] = "receipt-1"
    assert dict(r3.SCHEMA_MODELS) == {
        "historic_receipt": r3.Receipt,
        "historic_network_trend": r3.NetworkTrend,
    }
    r3.Receipt.model_validate(receipt_payload())
    r3.NetworkTrend.model_validate(trend_payload())
    for token in ("receipt-2", "reliability-2", "alerts-3"):
        with pytest.raises(ValidationError):
            r3.NetworkTrend.model_validate(trend_payload() | {"methodology_version": token})


@pytest.mark.parametrize(
    "dates",
    [
        ["2026-11-13", "2026-11-13"],
        ["2026-11-13", "2026-11-12"],
        ["2026-11-14"],
        ["2026-02-30"],
        [f"2026-10-{day:02d}" for day in range(1, 32)] + [f"2026-11-{d:02d}" for d in range(1, 6)],
    ],
)
def test_network_recent_dates_are_closed_ordered_and_bounded(dates):
    with pytest.raises(ValidationError):
        r3.NetworkTrend.model_validate(
            trend_payload()
            | {
                "series": [trend_point() | {"date": day} for day in dates],
            }
        )


def test_trend_keeps_supplied_zero_absence_and_open_percentiles():
    wire = json.loads(snapshot_json_bytes(r3.NetworkTrend.model_validate(trend_payload())))
    assert len(wire["series"]) == 1
    point = wire["series"][0]
    assert point["reading_count"] == 0 and point["on_time_pct"] is None
    assert point["vehicles_reporting"] is None and point["p90_bin"] is None
    assert point["delay_hist"] == {"layout": 2, "bins": [80], "n": [0]}
    supplied = trend_point() | {
        "vehicles_reporting": 4,
        "vehicles_on_trip": 2,
        "delay_hist": {"layout": 2, "bins": [160], "n": [1]},
        "p90_bin": {"lower_s": 3600, "upper_s": None},
    }
    assert r3.NetworkTrendPoint.model_validate(supplied).model_dump(mode="json")["p90_bin"] == {
        "lower_s": 3600,
        "upper_s": None,
    }


def test_zero_histogram_population_has_no_percentile():
    with pytest.raises(ValidationError):
        r3.NetworkTrendPoint.model_validate(
            trend_point()
            | {
                "p90_bin": {"lower_s": 0, "upper_s": 10},
            }
        )


def test_trend_missing_day_and_missing_evidence_stay_missing():
    missing = trend_point() | {
        "state": "not_measured",
        "reason": "capture_gap",
        "reading_count": None,
        "date": "2026-11-11",
        "delay_hist": None,
    }
    value = r3.NetworkTrend.model_validate(trend_payload() | {"series": [missing, trend_point()]})
    wire = json.loads(snapshot_json_bytes(value))
    assert [point["date"] for point in wire["series"]] == ["2026-11-11", "2026-11-13"]
    assert wire["series"][0]["reading_count"] is None
    assert wire["series"][0]["reason"] == "capture_gap"
    assert wire["series"][0]["delay_hist"] is None
    for field in ("methodology_version", "data_through", "series", "generated_utc"):
        payload = trend_payload()
        del payload[field]
        with pytest.raises(ValidationError):
            r3.NetworkTrend.model_validate(payload)


def alert_cell():
    return {
        "provider_id": "provider",
        "revision": 3,
        "scope": "network",
        "entity_id": "",
        "service_date": "2026-11-13",
        "cause": "not_given",
        "effect": "not_given",
        "alert_days_active": 2,
        "episodes_started": 1,
        "episodes_ended": 0,
        "active_seconds": 8640000000,
        "episodes_open_at_day_start": 1,
        "attribution": "approximate",
        "built": "backfill",
    }


def test_network_alert_cell_is_typed_supplied_evidence():
    point = r3.NetworkTrendPoint.model_validate(trend_point() | {"alert_cell": alert_cell()})
    assert isinstance(point.alert_cell, r3.NetworkAlertCell)
    assert point.model_dump(mode="json")["alert_cell"] == alert_cell()
    for invalid in (
        {},
        {"active_seconds": -1},
        {"entity_id": "line"},
        {"attribution": "guessed"},
        {"built": "now"},
        {"opaque": 0},
    ):
        cell = {} if not invalid else alert_cell() | invalid
        with pytest.raises(ValidationError):
            r3.NetworkTrendPoint.model_validate(trend_point() | {"alert_cell": cell})


@pytest.mark.parametrize(
    "field,value",
    [
        ("otp_pct", 50),
        ("vehicles", 2),
        ("weekly", []),
        ("p90_min", 60),
        ("vehicles_reporting", -1),
        ("vehicles_on_trip", True),
    ],
)
def test_trend_refuses_legacy_fields_and_invalid_vehicles(field, value):
    with pytest.raises(ValidationError):
        r3.NetworkTrendPoint.model_validate(trend_point() | {field: value})


def test_existing_public_models_and_bytes_are_unchanged():
    before = json.dumps(contract.export_schemas(), sort_keys=True)
    old = contract.NetworkTrend(generated_utc="2026-11-14")
    old_bytes = snapshot_json_bytes(old)
    exports = r3.export_schemas()
    assert set(exports) == {"historic_receipt", "historic_network_trend"}
    assert exports["historic_network_trend"] == r3.NetworkTrend.model_json_schema()
    assert exports["historic_receipt"] == r3.Receipt.model_json_schema()
    assert json.dumps(contract.export_schemas(), sort_keys=True) == before
    assert snapshot_json_bytes(old) == old_bytes
    assert contract.TOP_LEVEL_MODELS["historic_network_trend"] is contract.NetworkTrend


def test_receipt_envelope_and_shared_values_keep_absence():
    value = r3.Receipt.model_validate(receipt_payload())
    wire = json.loads(snapshot_json_bytes(value))
    assert wire["data_through"] == "2026-11-13"
    assert wire["methodology_version"] == "receipt-2"
    assert wire["reading_count"] is None
    assert wire["service"]["scheduled_trip_days"] == 10
    assert wire["service"]["delivered_trip_days"] is None
    assert wire["worst_line"] is None and wire["worst_stop"] is None
    assert isinstance(value.population, r3.Population)
    assert isinstance(value.service, r3.ServiceValues)
    assert r3.Receipt.model_validate_json(snapshot_json_bytes(value)) == value


@pytest.mark.parametrize(
    "alerts,reason,detail",
    [(0, None, None), (None, "not_tracked", None)]
    + [
        (None, "not_measured", detail)
        for detail in (
            "schedule_not_kept",
            "captures_not_available",
            "no_capture_record",
            "capture_gap",
            "window_too_short",
            "applicability_unresolved",
            "schedule_mismatch",
        )
    ],
)
def test_receipt_alert_absence_and_zero_have_distinct_shapes(alerts, reason, detail):
    payload = receipt_payload() | {
        "alerts": alerts,
        "alerts_reason": reason,
        "alerts_not_measured_reason": detail,
    }
    wire = json.loads(snapshot_json_bytes(r3.Receipt.model_validate(payload)))
    assert (wire["alerts"], wire["alerts_reason"], wire["alerts_not_measured_reason"]) == (
        alerts,
        reason,
        detail,
    )


@pytest.mark.parametrize(
    "alerts,reason,detail",
    [
        (None, None, None),
        (0, "not_tracked", None),
        (1, "not_measured", "capture_gap"),
        (None, "not_measured", None),
        (None, "not_tracked", "capture_gap"),
        (0, None, "capture_gap"),
        (None, "not_measured", "stale"),
        (None, "unsupported", None),
        (None, "not_applicable", None),
        (-1, None, None),
        (True, None, None),
        (1.5, None, None),
    ],
)
def test_receipt_refuses_contradictory_or_invalid_alerts(alerts, reason, detail):
    with pytest.raises(ValidationError):
        r3.Receipt.model_validate(
            receipt_payload()
            | {
                "alerts": alerts,
                "alerts_reason": reason,
                "alerts_not_measured_reason": detail,
            }
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("otp_pct", 50),
        ("severe_pct", 1),
        ("vehicles", 2),
        ("rider_impact_score", 1),
        ("service_states", {}),
        ("wilson_lo", 10),
        ("wilson_hi", 90),
        ("on_time_ci_lower", 10),
        ("on_time_ci_upper", 90),
        ("rank", 1),
        ("league", []),
        ("p90_min", 60),
    ],
)
def test_receipt_does_not_accept_revision_two_dead_fields(field, value):
    with pytest.raises(ValidationError, match="extra_forbidden"):
        r3.Receipt.model_validate(receipt_payload() | {field: value})


@pytest.mark.parametrize("token", ["receipt-1", "reliability-2", "reliability-3", "alerts-3"])
def test_receipt_rejects_other_family_or_legacy_tokens(token):
    with pytest.raises(ValidationError, match="literal_error"):
        r3.Receipt.model_validate(receipt_payload() | {"methodology_version": token})


@pytest.mark.parametrize("field", ["data_through", "methodology_version", "population", "service"])
def test_receipt_requires_explicit_envelope_and_evidence(field):
    payload = receipt_payload()
    del payload[field]
    with pytest.raises(ValidationError, match="missing"):
        r3.Receipt.model_validate(payload)


@pytest.mark.parametrize("field", ["date", "data_through"])
def test_receipt_requires_real_service_dates(field):
    with pytest.raises(ValidationError):
        r3.Receipt.model_validate(receipt_payload() | {field: "2026-02-30"})


def test_headline_values_are_data_not_a_ranking_engine():
    line = {
        "id": " opaque/line ",
        "short": "L",
        "name": None,
        "on_time_pct": 0,
        "on_time_delta_pts": None,
    }
    stop = {
        "id": " opaque/stop ",
        "code": "0042",
        "name": "Terminus",
        "on_time_pct": None,
        "on_time_delta_pts": -2.5,
    }
    value = r3.Receipt.model_validate(
        receipt_payload()
        | {
            "worst_line": line,
            "worst_stop": stop,
        }
    )
    wire = json.loads(snapshot_json_bytes(value))
    assert wire["worst_line"] == line
    assert wire["worst_stop"] == stop
    assert isinstance(value.worst_line, r3.HeadlineLine)
    assert isinstance(value.worst_stop, r3.HeadlineStop)


@pytest.mark.parametrize("field,identity", [("worst_line", "short"), ("worst_stop", "code")])
def test_headlines_refuse_missing_identity_and_rankings(field, identity):
    headline = {"id": "x", "name": None, "on_time_pct": None, "on_time_delta_pts": None}
    for invalid in (headline, headline | {identity: "X", "rank": 1}):
        with pytest.raises(ValidationError):
            r3.Receipt.model_validate(receipt_payload() | {field: invalid})


@pytest.mark.parametrize("field,identity", [("worst_line", "short"), ("worst_stop", "code")])
@pytest.mark.parametrize(
    "id_fields",
    [{}, {"id": 17}, {"id": None}, {"id": {}}, {"id": []}, {"id": True}],
    ids=["missing", "integer", "null", "mapping", "list", "boolean"],
)
def test_headlines_refuse_missing_or_non_string_ids(field, identity, id_fields):
    headline = {
        identity: "X",
        "name": None,
        "on_time_pct": None,
        "on_time_delta_pts": None,
    } | id_fields
    with pytest.raises(ValidationError) as error:
        r3.Receipt.model_validate(receipt_payload() | {field: headline})
    assert [item["loc"] for item in error.value.errors()] == [(field, "id")]


def test_receipt_measured_readings_can_coexist_with_unmeasured_service():
    value = r3.Receipt.model_validate(
        receipt_payload()
        | {
            "state": "measured",
            "reason": None,
            "reading_count": 0,
            "on_time_count": 0,
            "late_count": 0,
            "early_count": 0,
            "trip_count": 0,
        }
    )
    wire = json.loads(snapshot_json_bytes(value))
    assert wire["reading_count"] == 0 and wire["on_time_pct"] is None
    assert wire["service"]["state"] == "not_measured"
    assert wire["service"]["scheduled_trip_days"] == 10
    with pytest.raises(ValidationError, match="reading values must be null"):
        r3.Receipt.model_validate(receipt_payload() | {"reading_count": 0})
