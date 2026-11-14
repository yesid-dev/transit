from dataclasses import replace
from datetime import UTC, datetime, timedelta
from io import BytesIO
from zoneinfo import ZoneInfo

import pytest
from history_fixtures import scripted_feed_day

from transit_ops.history.capture_union import union_capture_record
from transit_ops.history.manifest import build_manifest
from transit_ops.history.pack import write_pack
from transit_ops.history.poll_record import PollRecordInvalid


def archived(family="realtime_snapshot"):
    record, payloads = scripted_feed_day(index_family=family)
    pack = write_pack(payloads, BytesIO())
    return record, build_manifest(
        record,
        feed_endpoint_id=1,
        feed_kind="synthetic",
        content_version=1,
        supersedes=None,
        pack_path="archive.pack.xz",
        pack=pack,
        sealed_at_utc=datetime(2026, 1, 4, tzinfo=UTC),
        sealed_by="test",
    )


@pytest.mark.parametrize("family", ["realtime_snapshot", "alert_snapshot"])
def test_union_keeps_archived_only_polls_captures_and_processing(family):
    record, current = archived(family)
    empty = replace(record, polls=(), captures=(), processing=())
    result = union_capture_record(current, empty)
    assert [p.ingestion_run_id for p in result.polls] == [0, 1, 2, 3, 4, 5]
    assert [p.status for p in result.polls] == [
        "stored",
        "stored",
        "stored",
        "failed",
        "unfinished",
        "capture_missing",
    ]
    assert [(c.index_family, c.capture_row_id) for c in result.captures] == [
        (family, 0),
        (family, 1),
        (family, 2),
        (family, 5),
    ]
    assert [
        (p.capture_row_id, p.status, p.rows) for p in result.processing if p.stage == "gold_facts"
    ] == [
        (0, "observed", 2),
        (1, "none_observed", 0),
        (2, "not_observed", None),
        (5, "failed", None),
    ]
    assert all(not c.packed and c.stream is None and c.offset is None for c in result.captures)
    assert [c.storage_path for c in result.captures] == [
        "capture/0",
        "capture/1",
        "capture/2",
        "capture/5",
    ]
    assert current.captures[0].packed


def test_union_overlays_a_late_result_without_merging_distinct_equal_payloads():
    record, current = archived()
    late = replace(
        record.captures[1],
        capture_row_id=40,
        ingestion_run_id=4,
        ingestion_object_id=40,
        packed=False,
        stream=None,
        offset=None,
    )
    poll = replace(
        record.polls[4],
        status="stored",
        run_status="succeeded",
        capture_row_id=40,
        completed_at_utc=late.captured_at_utc,
    )
    load = replace(record.processing[0], capture_row_id=40, error_message="later failure")
    working = replace(
        record,
        polls=(poll, record.polls[5]),
        captures=(late, record.captures[3]),
        processing=(load,),
    )
    result = union_capture_record(current, working)
    assert [c.capture_row_id for c in result.captures] == [0, 1, 40, 2, 5]
    assert [(p.ingestion_run_id, p.status, p.capture_row_id) for p in result.polls][4] == (
        4,
        "stored",
        40,
    )
    assert result.polls[5].missing_reason == "absent"
    assert [p.error_message for p in result.processing if p.stage == "silver_load"] == [
        "later failure",
    ]


def test_union_does_not_claim_unverified_working_bytes_recover_missing_capture():
    record, current = archived()
    working = replace(
        record,
        polls=(replace(record.polls[5], status="stored", missing_reason=None),),
        processing=(),
    )
    result = union_capture_record(current, working)
    assert result.polls[5].status == "capture_missing"
    assert result.polls[5].missing_reason == "absent"
    assert result.polls[0].status == "stored"


@pytest.mark.parametrize(
    "change",
    [
        {"sha256": "0" * 64},
        {"byte_size": 100},
        {"storage_path": "other"},
        {"ingestion_object_id": 99},
        {"source_url": "https://other.invalid"},
    ],
)
def test_union_refuses_changed_bytes_for_an_existing_capture(change):
    record, current = archived()
    working = replace(record, captures=(replace(record.captures[0], **change),))
    with pytest.raises(PollRecordInvalid, match="network/feed/2026-01-02.*realtime_snapshot.*0"):
        union_capture_record(current, working)


@pytest.mark.parametrize(
    "field,value",
    [
        ("provider_id", "elsewhere"),
        ("endpoint_key", "other"),
        ("index_family", "alert_snapshot"),
        ("utc_date", datetime(2026, 1, 3).date()),
    ],
)
def test_union_refuses_another_feed_day(field, value):
    record, current = archived()
    working = replace(record, feed_day=replace(record.feed_day, **{field: value}))
    with pytest.raises(PollRecordInvalid, match="feed-day"):
        union_capture_record(current, working)


def test_union_carries_declared_interval_and_recomputes_observed_interval():
    record, current = archived()
    current = replace(current, polls=(record.polls[0], record.polls[4]))
    new = replace(
        record.polls[3],
        ingestion_run_id=90,
        started_at_utc=record.polls[0].started_at_utc + timedelta(seconds=45),
    )
    result = union_capture_record(
        current,
        replace(
            record,
            polls=(new,),
            captures=(),
            processing=(),
            declared_interval_seconds=999,
            observed_interval_ms=999,
        ),
    )
    assert result.declared_interval_seconds == 30
    assert result.observed_interval_ms == 45_000


def test_union_compares_processing_instants_across_dst_and_preserves_unknown():
    record, current = archived()
    zone = ZoneInfo("America/Toronto")
    before = datetime(2026, 11, 1, 1, 50, tzinfo=zone, fold=0)
    after = datetime(2026, 11, 1, 1, 10, tzinfo=zone, fold=1)
    old = replace(record.processing[1], completed_at_utc=before)
    fresh = replace(old, completed_at_utc=after, rows=7)
    current = replace(current, processing=(old, record.processing[3]))
    working = replace(record, processing=(fresh,))
    result = union_capture_record(current, working)
    assert [(p.capture_row_id, p.rows) for p in result.processing] == [(0, 7), (2, None)]
    assert result.processing[1].status == "not_observed"
    assert (
        union_capture_record(current, replace(working, processing=(old,))).processing[0].rows == 2
    )
    newer = replace(current, processing=(fresh,))
    assert union_capture_record(newer, replace(working, processing=(old,))).processing[0].rows == 7
    conflict = replace(fresh, completed_at_utc=after.astimezone(UTC), rows=8)
    with pytest.raises(PollRecordInvalid, match="network/feed/2026-01-02.*gold_facts.*0"):
        union_capture_record(newer, replace(working, processing=(conflict,)))


@pytest.mark.parametrize(
    "change",
    [
        {"run_kind": "other"},
        {"started_at_utc": datetime(2026, 1, 2, 1, tzinfo=UTC)},
        {"capture_row_id": 99},
    ],
)
def test_union_refuses_changed_poll_source_identity(change):
    record, current = archived()
    working = replace(record, polls=(replace(record.polls[0], **change),))
    with pytest.raises(PollRecordInvalid, match="network/feed/2026-01-02.*poll 0"):
        union_capture_record(current, working)


def test_union_preserves_packed_poll_usability_and_unattributed_failures():
    record, current = archived()
    missing = replace(record.polls[0], status="capture_missing", missing_reason="object_absent")
    unknown_load = replace(
        record.processing[0],
        ingestion_run_id=None,
        capture_row_id=None,
        attribution=None,
        error_message="unattributed",
    )
    unrelated = replace(unknown_load, error_message="another failure")
    current = replace(current, processing=(unknown_load, record.processing[0]))
    working = replace(record, polls=(missing,), processing=(unrelated,))
    result = union_capture_record(current, working)
    assert result.polls[0].status == "stored"
    assert result.polls[0].missing_reason is None
    assert {p.error_message for p in result.processing} == {
        "unattributed",
        "another failure",
        "load failed",
    }


def test_union_accepts_equal_source_instants_and_discards_physical_coordinates():
    record, current = archived()
    capture = record.captures[0]
    working_capture = replace(
        capture,
        packed=False,
        stream=None,
        offset=None,
        captured_at_utc=capture.captured_at_utc.astimezone(ZoneInfo("America/Toronto")),
    )
    result = union_capture_record(current, replace(record, captures=(working_capture,)))
    assert result.captures[0].captured_at_utc == datetime(2026, 1, 2, tzinfo=UTC)
    assert result.captures[0].stream is None
