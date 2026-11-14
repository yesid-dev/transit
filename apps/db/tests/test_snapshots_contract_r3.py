import importlib
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
