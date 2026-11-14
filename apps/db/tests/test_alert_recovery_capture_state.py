from dataclasses import replace
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from transit_ops.history.alert_recovery_capture_state import fold_alert_snapshots
from transit_ops.silver.i3 import RawI3AlertSnapshot, alert_message_provenance

START = datetime(2026, 11, 1, tzinfo=UTC)


def snapshot(number: int, minute: int, *alerts: object) -> RawI3AlertSnapshot:
    return RawI3AlertSnapshot(
        number,
        "fixture",
        "America/Toronto",
        START + timedelta(minutes=minute),
        {"alerts": list(alerts)},
    )


def alert(*routes: str, **fields: object) -> dict[str, object]:
    return {"id": "alert-a", "header": "Travaux", "routes": list(routes), **fields}


def test_repeat_retains_first_child_indexes_and_advances_message() -> None:
    state = fold_alert_snapshots(
        [snapshot(101, 0, alert("10")), snapshot(102, 5, alert("20", "30"))]
    )
    assert [row["route_id"] for row in state.entity_rows] == ["10", "30"]
    (row,) = state.alert_rows
    assert (row["i3_alert_snapshot_id"], row["alert_index"]) == (101, 0)
    assert row["first_seen_at"] == START
    assert row["last_seen_at"] == START + timedelta(minutes=5)
    assert row["captured_at_utc"] == START
    assert row["valid_to"] is None
    assert alert_message_provenance(
        row["raw_alert_json"],
        row["message_snapshot_id"],
        row["message_alert_index"],
        row["last_seen_at"],
    ) == {
        "snapshot_id": "102",
        "alert_index": 0,
        "captured_utc": "2026-11-01T00:05:00Z",
        "header_language": None,
        "description_language": None,
        "url_language": None,
    }


def test_same_capture_hash_duplicate_keeps_first_ordinal_and_children() -> None:
    state = fold_alert_snapshots([snapshot(101, 0, alert("10"), alert("20", "30"))])
    assert [r["alert_index"] for r in state.alert_rows] == [0]
    assert [r["route_id"] for r in state.entity_rows] == ["10"]
    assert state.alert_rows[0]["message_alert_index"] == 0


@pytest.mark.parametrize("dst", [False, True])
def test_instant_order_precedes_numeric_id_even_across_dst(dst: bool) -> None:
    zone = ZoneInfo("America/Toronto")
    first = datetime(2026, 11, 1, 1, 30, tzinfo=zone, fold=0) if dst else START
    last = (
        datetime(2026, 11, 1, 1, 15, tzinfo=zone, fold=1) if dst else START + timedelta(minutes=5)
    )
    inputs = [
        replace(snapshot(10, 0, alert("10")), captured_at_utc=first),
        replace(snapshot(9, 0, alert("20", "30")), captured_at_utc=last),
    ]
    state = fold_alert_snapshots(inputs)
    (row,) = state.alert_rows
    assert [r["route_id"] for r in state.entity_rows] == ["10", "30"]
    assert row["i3_alert_snapshot_id"] == 10
    assert row["first_seen_at"] == first.astimezone(UTC)
    assert row["last_seen_at"] == last.astimezone(UTC)
    assert row["message_snapshot_id"] == 9
    assert row["message_alert_index"] == 0
    assert fold_alert_snapshots(reversed(inputs)) == state


def test_duplicate_dst_instants_refuse_but_equivalent_offsets_agree() -> None:
    first = replace(
        snapshot(101, 0, alert()),
        captured_at_utc=datetime(2026, 11, 1, 1, 30, tzinfo=ZoneInfo("America/Toronto")),
    )
    other = replace(first, captured_at_utc=first.captured_at_utc.replace(fold=1))
    for pair in ([first, other], [other, first]):
        with pytest.raises(ValueError, match="contradictory capture id"):
            fold_alert_snapshots(pair)
    utc = replace(first, captured_at_utc=first.captured_at_utc.astimezone(UTC))
    assert fold_alert_snapshots([first, utc]) == fold_alert_snapshots([utc, first])


@pytest.mark.parametrize(
    "left,right",
    [
        (alert(id=1), alert(id=1.0)),
        (alert(id=1), alert(id=True)),
        (alert(id=1.0), alert(id=True)),
        (alert(header={"es": "Uno", "de": "Zwei"}), alert(header={"de": "Zwei", "es": "Uno"})),
    ],
)
def test_type_or_order_conflicting_duplicate_payloads_refuse(left: object, right: object) -> None:
    inputs = [snapshot(101, 0, left), snapshot(101, 0, right)]
    for pair in (inputs, list(reversed(inputs))):
        with pytest.raises(ValueError, match="contradictory capture id"):
            fold_alert_snapshots(pair)


def test_duplicate_ordinary_key_reordering_preserves_all_rows() -> None:
    first = snapshot(101, 0, {"id": "a", "header": "Travaux", "routes": ["10"]})
    reordered = snapshot(101, 0, {"routes": ["10"], "header": "Travaux", "id": "a"})
    expected = fold_alert_snapshots([first])
    (row,) = expected.alert_rows
    assert (row["alert_id"], row["alert_header_text"]) == ("a", "Travaux")
    assert [r["route_id"] for r in expected.entity_rows] == ["10"]
    assert expected.period_rows == ()
    assert fold_alert_snapshots([first, reordered]) == expected
    assert fold_alert_snapshots([reordered, first]) == expected


def test_empty_batch_keeps_episode_nonempty_disappearance_closes_and_reappearance_restarts() -> (
    None
):
    inputs = [
        snapshot(101, 0, alert("10")),
        snapshot(102, 5),
        snapshot(103, 10, alert("20")),
        snapshot(104, 15, alert(id="other")),
        snapshot(105, 20, alert("30")),
    ]
    state = fold_alert_snapshots(inputs)
    first, other, returned = state.alert_rows
    assert first["last_seen_at"] == START + timedelta(minutes=10)
    assert first["valid_to"] == START + timedelta(minutes=15)
    assert returned["first_seen_at"] == START + timedelta(minutes=20)
    assert returned["valid_to"] is None
    assert returned["content_hash"] == first["content_hash"]
    assert other["valid_to"] == START + timedelta(minutes=20)
    assert [(r["i3_alert_snapshot_id"], r["route_id"]) for r in state.entity_rows] == [
        (101, "10"),
        (105, "30"),
    ]
    assert fold_alert_snapshots(reversed(inputs)) == state


def test_equal_times_use_numeric_capture_id_and_original_alert_index() -> None:
    early = snapshot(9, 0, alert("10"))
    late = snapshot(10, 0, alert(id="other"), alert("20", "30"))
    state = fold_alert_snapshots([late, early])
    row = state.alert_rows[0]
    assert (
        row["i3_alert_snapshot_id"],
        row["message_snapshot_id"],
        row["message_alert_index"],
    ) == (9, 10, 1)
    assert [r["route_id"] for r in state.entity_rows] == ["10", "30"]
    assert fold_alert_snapshots([early, late]) == state
    assert fold_alert_snapshots([late, early, early]) == state


def test_translation_url_and_raw_update_together_and_nulls_replace_enrichment() -> None:
    first = alert(
        header={"fr": "Travaux", "en": "Work"},
        description={"fr": "Retard", "en": "Delay"},
        url={"fr": "old", "en": "old-en"},
    )
    latest = alert(
        header={"fr": "Travaux", "en": "Works"},
        description={"fr": "Retard", "en": "Late"},
        url={"fr": "new", "en": "new-en"},
    )
    state = fold_alert_snapshots([snapshot(101, 0, first), snapshot(102, 5, latest)])
    (row,) = state.alert_rows
    assert (row["alert_header_text_en"], row["description_text_en"], row["url"], row["url_en"]) == (
        "Works",
        "Late",
        "new",
        "new-en",
    )
    assert row["raw_alert_json"] == latest
    assert row["message_snapshot_id"] == 102
    cleared = fold_alert_snapshots(
        [snapshot(101, 0, first), snapshot(102, 5, alert(description="Retard"))]
    )
    (row,) = cleared.alert_rows
    assert (row["alert_header_text_en"], row["description_text_en"], row["url"], row["url_en"]) == (
        None,
        None,
        None,
        None,
    )


def test_period_indexes_keep_first_subsecond_bounds_but_new_hash_starts_episode() -> None:
    first = alert(activePeriods=[{"start": 100.1, "end": 200.1}])
    repeat = alert(activePeriods=[{"start": 100.9, "end": 200.9}])
    changed = alert(activePeriods=[{"start": 100.1, "end": 200.1}, {"start": 300}])
    state = fold_alert_snapshots(
        [snapshot(101, 0, first), snapshot(102, 5, repeat), snapshot(103, 10, changed)]
    )
    original, newer = state.alert_rows
    assert original["content_hash"] != newer["content_hash"]
    assert original["valid_to"] == START + timedelta(minutes=10)
    assert [
        (r["i3_alert_snapshot_id"], r["period_index"], r["start_utc"], r["end_utc"])
        for r in state.period_rows
    ] == [
        (101, 0, datetime.fromtimestamp(100.1, UTC), datetime.fromtimestamp(200.1, UTC)),
        (103, 0, datetime.fromtimestamp(100.1, UTC), datetime.fromtimestamp(200.1, UTC)),
        (103, 1, datetime.fromtimestamp(300, UTC), None),
    ]


@pytest.mark.parametrize(
    "field,value",
    [
        ("header", "Changed"),
        ("severity", "high"),
        ("cause", "construction"),
        ("effect", "delay"),
        ("publishedAt", 100),
        ("updatedAt", 200),
    ],
)
def test_hash_field_changes_close_old_episode(field: str, value: object) -> None:
    state = fold_alert_snapshots(
        [snapshot(101, 0, alert()), snapshot(102, 5, alert(**{field: value}))]
    )
    old, new = state.alert_rows
    assert old["content_hash"] != new["content_hash"]
    assert old["valid_to"] == START + timedelta(minutes=5)
    assert new["valid_to"] is None


@pytest.mark.parametrize("payload", [None, {}, {"alerts": {}}, {"alerts": [None]}, [42]])
def test_invalid_container_refuses_instead_of_empty_state(payload: object) -> None:
    with pytest.raises(ValueError, match="invalid alert container"):
        fold_alert_snapshots([replace(snapshot(101, 0), raw_payload_json=payload)])


def test_contradictory_ids_naive_times_and_provider_zones_refuse() -> None:
    original = snapshot(101, 0, alert())
    for other, reason in [
        (snapshot(101, 0, alert("20")), "contradictory capture id"),
        (snapshot(101, 5, alert()), "contradictory capture id"),
        (replace(snapshot(102, 5), captured_at_utc=START.replace(tzinfo=None)), "must be aware"),
        (replace(snapshot(102, 5), provider_timezone="UTC"), "contradictory provider timezone"),
        (replace(snapshot(102, 5), i3_alert_snapshot_id=0), "positive integer"),
    ]:
        with pytest.raises(ValueError, match=reason):
            fold_alert_snapshots([original, other])


def test_provider_isolation_and_limitations_even_for_empty_state() -> None:
    inputs = [
        snapshot(101, 0, alert("10")),
        replace(snapshot(102, 5, alert("20")), provider_id="second"),
        snapshot(103, 10, alert(id="other")),
    ]
    state = fold_alert_snapshots(inputs)
    assert state.alert_rows[1]["provider_id"] == "second"
    assert state.alert_rows[1]["valid_to"] is None
    empty = fold_alert_snapshots([])
    assert (empty.alert_rows, empty.entity_rows, empty.period_rows) == ((), (), ())
    assert (
        empty.limitations
        == state.limitations
        == (
            "Retained captures only; observations before/after the interval unknown.",
            "Reconstructed from empty state; pre-window Silver state unknown.",
            "Chronological capture order with numeric id ties; original load order unknown.",
        )
    )
