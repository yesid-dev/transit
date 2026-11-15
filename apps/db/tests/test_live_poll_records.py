from contextlib import closing
from dataclasses import replace

import pytest
from history_fixtures import scripted_feed_day

from transit_ops.live.local_file import LocalFile
from transit_ops.live.poll_records import FailedLoadIntegrityError, LocalPollRecords
from transit_ops.live.settings import LaneSettings

SETTINGS = LaneSettings(duckdb_memory_limit_mb=64, duckdb_threads=1, temp_dir_max_mb=32)
RECORD, _ = scripted_feed_day()
DAY = RECORD.feed_day
FAILURE = RECORD.processing[0]


def opened(path):
    return LocalFile.open(path, provider_id=DAY.provider_id, settings=SETTINGS)


def test_verified_failure_survives_reopen_despite_nearer_capture(tmp_path):
    path = tmp_path / "worker.db"
    capture = RECORD.captures[1]
    failure = replace(FAILURE, error_message="[capture_row_id=2] hostile body")
    with closing(opened(path)) as local:
        local.record_polls(RECORD.polls, endpoint_key=DAY.endpoint_key)
        local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key)
        LocalPollRecords(local).record_failure(DAY, failure, verified_capture=capture)
    with closing(opened(path)) as local:
        result = LocalPollRecords(local).processing(DAY)
        assert result == (
            replace(
                failure,
                capture_row_id=1,
                attribution="recorded",
                error_message="[capture_row_id=1] [capture_row_id=2] hostile body",
            ),
        )
        assert local.record_polls(RECORD.polls, endpoint_key=DAY.endpoint_key) == 0
        assert local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key) == 0
    assert failure.error_message == "[capture_row_id=2] hostile body"


@pytest.mark.parametrize(
    "error",
    [
        "legacy failure",
        "[capture_row_id=0] bad",
        "[capture_row_id=01] bad",
        "[capture_row_id=9223372036854775808] bad",
        "[capture_row_id=١] bad",
        "prefix [capture_row_id=1] bad",
        "[capture_row_id=1]bad",
    ],
)
@pytest.mark.parametrize("known", [True, False])
def test_legacy_attribution_is_preserved(tmp_path, error, known):
    failure = replace(
        FAILURE,
        error_message=error,
        capture_row_id=2 if known else None,
        attribution="by_time" if known else None,
    )
    with closing(opened(tmp_path / "worker.db")) as local:
        records = LocalPollRecords(local)
        records.record_failure(DAY, failure)
        assert records.processing(DAY) == (failure,)


def test_exception_before_verification_cannot_supply_its_own_provenance(tmp_path):
    failure = replace(
        FAILURE,
        capture_row_id=None,
        attribution=None,
        error_message="[capture_row_id=1] identity check failed",
    )
    with closing(opened(tmp_path / "worker.db")) as local:
        records = LocalPollRecords(local)
        records.record_failure(DAY, failure)
        (result,) = records.processing(DAY)
        assert result.capture_row_id is None and result.attribution is None
        assert result.error_message == (
            "Unverified failure: [capture_row_id=1] identity check failed"
        )


@pytest.mark.parametrize("body", ["", " leading whitespace", "\tnew\nline"])
def test_verified_tag_keeps_body_whitespace(tmp_path, body):
    with closing(opened(tmp_path / "worker.db")) as local:
        local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key)
        records = LocalPollRecords(local)
        records.record_failure(
            DAY, replace(FAILURE, error_message=body), verified_capture=RECORD.captures[1]
        )
        (result,) = records.processing(DAY)
        assert result.capture_row_id == 1 and result.attribution == "recorded"
        assert result.error_message == "[capture_row_id=1] " + body


@pytest.mark.parametrize("change", ["provider", "endpoint", "family", "receipt", "missing"])
def test_mismatched_receipt_is_refused_without_a_failure_record(tmp_path, change):
    with closing(opened(tmp_path / "worker.db")) as local:
        receipt = RECORD.captures[1]
        if change != "missing":
            local.record_captures([receipt], endpoint_key=DAY.endpoint_key)
        day, failure = DAY, FAILURE
        if change == "provider":
            day = replace(day, provider_id="other")
        elif change == "endpoint":
            day = replace(day, endpoint_key="other")
        elif change == "family":
            day = replace(day, index_family="alert_snapshot")
            failure = replace(failure, index_family="alert_snapshot")
            receipt = replace(receipt, index_family="alert_snapshot")
        elif change == "receipt":
            receipt = replace(receipt, sha256="f" * 64)
        records = LocalPollRecords(local)
        with pytest.raises(FailedLoadIntegrityError):
            records.record_failure(day, failure, verified_capture=receipt)
        assert records.processing(DAY) == ()


def test_same_integer_in_two_families_keeps_separate_provenance(tmp_path):
    alert_record, _ = scripted_feed_day(index_family="alert_snapshot", endpoint_key="alerts")
    with closing(opened(tmp_path / "worker.db")) as local:
        records = LocalPollRecords(local)
        for record in (RECORD, alert_record):
            local.record_captures(record.captures, endpoint_key=record.feed_day.endpoint_key)
            records.record_failure(
                record.feed_day, record.processing[0], verified_capture=record.captures[1]
            )
        for day in (DAY, alert_record.feed_day):
            (result,) = records.processing(day)
            assert result.capture_row_id == 1 and result.index_family == day.index_family


@pytest.mark.parametrize(
    "damage",
    [
        "DELETE FROM captures WHERE capture_row_id=1",
        "UPDATE captures SET endpoint_key='other' WHERE capture_row_id=1",
        "UPDATE processing SET capture_row_id=2",
        "UPDATE processing SET error_message='lost tag'",
    ],
)
def test_dangling_or_mismatched_recorded_identity_fails_on_reopen(tmp_path, damage):
    path = tmp_path / "worker.db"
    with closing(opened(path)) as local:
        local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key)
        LocalPollRecords(local).record_failure(DAY, FAILURE, verified_capture=RECORD.captures[1])
        local.connection.execute(damage)
    with closing(opened(path)) as local:
        with pytest.raises(FailedLoadIntegrityError):
            LocalPollRecords(local).processing(DAY)


def test_cycle_rollback_leaves_no_half_record(tmp_path):
    path = tmp_path / "worker.db"
    with closing(opened(path)) as local:
        with pytest.raises(RuntimeError, match="cycle failed"), local.transaction():
            local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key)
            LocalPollRecords(local).record_failure(
                DAY, FAILURE, verified_capture=RECORD.captures[1]
            )
            raise RuntimeError("cycle failed")
    with closing(opened(path)) as local:
        assert LocalPollRecords(local).processing(DAY) == ()
        assert local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key) == 4


def test_read_is_scoped_to_endpoint_and_utc_day(tmp_path):
    with closing(opened(tmp_path / "worker.db")) as local:
        records = LocalPollRecords(local)
        records.record_failure(DAY, FAILURE)
        assert records.processing(replace(DAY, endpoint_key="other")) == ()
        assert records.processing(replace(DAY, utc_date=DAY.utc_date.replace(day=3))) == ()


def test_leading_tag_overrides_legacy_time_attribution(tmp_path):
    failure = replace(FAILURE, error_message="[capture_row_id=1] verified failure")
    with closing(opened(tmp_path / "worker.db")) as local:
        local.record_captures(RECORD.captures, endpoint_key=DAY.endpoint_key)
        local.record_processing([failure], endpoint_key=DAY.endpoint_key)
        assert LocalPollRecords(local).processing(DAY) == (
            replace(failure, capture_row_id=1, attribution="recorded"),
        )
