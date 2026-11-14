from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from transit_ops.history.poll_record import (
    FeedDayKey,
    PollRecord,
    PollRecordInvalid,
    ProcessingEntry,
    poll_record_sha256,
)
from transit_ops.history.rewrite_evidence import (
    decode_processing_evidence,
    processing_evidence_details,
)


def test_old_processing_evidence_remains_readable():
    details = {
        "command": "replay-realtime-silver",
        "completed_at_utc": "2026-11-01T12:00:00.000001Z",
        "index_family": "realtime_snapshot",
        "rows_by_capture": {"17": 0, "18": 5},
    }
    assert decode_processing_evidence(details, index_family="realtime_snapshot", sequence=9) == (
        datetime(2026, 11, 1, 12, 0, 0, 1, UTC),
        {17: 0, 18: 5},
    )


def rewrite_metadata():
    return {
        "schema": 1,
        "operation_id": "rewrite-17",
        "expected_current_version": 3,
        "expected_working_changed_at_utc": "2026-11-01T11:00:00.000000Z",
        "edition": {
            "provider_id": "network",
            "dataset_version_id": 42,
            "checksum_sha256": "a" * 64,
        },
        "provenance": {
            "command": "replay-realtime-silver",
            "mode": "gold",
            "capture_ids": [17, 18],
            "source_hashes": {"17": "b" * 64, "18": None},
            "code_revision": None,
            "code_revision_unknown_reason": "not supplied",
        },
    }


def test_rewrite_evidence_keeps_expected_version_edition_and_provenance():
    rewrite = rewrite_metadata()
    details = processing_evidence_details(
        command="replay-realtime-silver",
        completed_at_utc=datetime(2026, 11, 1, 12, tzinfo=UTC),
        index_family="realtime_snapshot",
        rows_by_capture={17: 0, 18: 5},
        rewrite=rewrite,
    )

    assert details == {
        "command": "replay-realtime-silver",
        "completed_at_utc": "2026-11-01T12:00:00.000000Z",
        "index_family": "realtime_snapshot",
        "rows_by_capture": {"17": 0, "18": 5},
        "rewrite": rewrite_metadata(),
    }
    assert decode_processing_evidence(details, index_family="realtime_snapshot", sequence=10) == (
        datetime(2026, 11, 1, 12, tzinfo=UTC),
        {17: 0, 18: 5},
    )


def evidence(**changes):
    return processing_evidence_details(
        **(
            {
                "command": "replay-realtime-silver",
                "completed_at_utc": datetime(2026, 11, 1, 12, tzinfo=UTC),
                "index_family": "realtime_snapshot",
                "rows_by_capture": {17: 0},
                "rewrite": rewrite_metadata(),
            }
            | changes
        )
    )


@pytest.mark.parametrize(
    "section,key,value,error",
    [
        (None, "schema", 2, "unknown evidence version"),
        (None, "schema", True, "unknown evidence version"),
        (None, "expected_current_version", False, "expected_current_version"),
        (None, "expected_working_changed_at_utc", "yesterday", "UTC timestamp"),
        ("edition", "checksum_sha256", "bad", "edition"),
        ("edition", "dataset_version_id", 0, "edition"),
        ("provenance", "code_revision_unknown_reason", None, "provenance"),
        ("provenance", "code_revision", "guessed", "provenance"),
        ("provenance", "capture_ids", [17, 17], "provenance"),
        ("provenance", "source_hashes", {"17": "bad"}, "provenance"),
        ("provenance", "command", "other", "provenance"),
        ("provenance", "argv", "private", "provenance"),
    ],
)
def test_unknown_evidence_version_or_malformed_provenance_refuses(section, key, value, error):
    details = evidence()
    target = details["rewrite"] if section is None else details["rewrite"][section]
    target[key] = value
    with pytest.raises(PollRecordInvalid, match=f"event 23:.*{error}"):
        decode_processing_evidence(details, index_family="realtime_snapshot", sequence=23)


def test_equal_counts_with_a_later_completion_change_the_processing_record():
    records = []
    for microsecond in (1, 2):
        details = evidence(completed_at_utc=datetime(2026, 11, 1, 12, 0, 0, microsecond, UTC))
        completed, counts = decode_processing_evidence(
            details,
            index_family="realtime_snapshot",
            sequence=microsecond,
        )
        records.append(
            PollRecord(
                FeedDayKey("network", "trip_updates", "realtime_snapshot", date(2026, 11, 1)),
                (),
                (),
                (
                    ProcessingEntry(
                        "gold_facts",
                        "realtime_snapshot",
                        17,
                        "recorded",
                        "none_observed",
                        None,
                        completed,
                        None,
                        counts[17],
                        None,
                    ),
                ),
                None,
                None,
            )
        )
    assert records[0].processing[0].rows == records[1].processing[0].rows == 0
    assert poll_record_sha256(records[0]) != poll_record_sha256(records[1])


@pytest.mark.parametrize("outcome", [None, -1, False, "failed"])
def test_missing_or_failed_outcome_is_not_zero(outcome):
    with pytest.raises(PollRecordInvalid, match="capture counts"):
        evidence(rows_by_capture={17: outcome})
    _, counts = decode_processing_evidence(
        evidence(rows_by_capture={}), index_family="realtime_snapshot", sequence=1
    )
    assert counts == {}


def test_unknown_provenance_and_utc_normalization_are_explicit():
    rewrite = rewrite_metadata()
    rewrite["edition"]["checksum_sha256"] = None
    rewrite["expected_current_version"] = None
    rewrite["expected_working_changed_at_utc"] = None
    details = evidence(
        rewrite=rewrite,
        completed_at_utc=datetime(2026, 11, 1, 7, tzinfo=timezone(timedelta(hours=-5))),
    )
    assert details["completed_at_utc"] == "2026-11-01T12:00:00.000000Z"
    assert details["rewrite"] == rewrite
    rewrite["provenance"]["capture_ids"].append(19)
    assert details["rewrite"]["provenance"]["capture_ids"] == [17, 18]
