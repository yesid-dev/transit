import json
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest

from transit_ops.gold.alert_archive import _write_params
from transit_ops.history.alert_recovery_capture_records import prepare_capture_candidates
from transit_ops.silver.i3 import RawI3AlertSnapshot

NOW = datetime(2026, 11, 1, tzinfo=UTC)


def jsonb_result(statement, parameters):
    """Offline result double; the real-DB oracle verifies PostgreSQL behavior."""
    value = json.loads(
        parameters["raw"],
        object_pairs_hook=lambda pairs: dict(
            sorted(pairs, key=lambda p: (len(p[0].encode()), p[0].encode()))
        ),
    )
    return SimpleNamespace(scalar_one=lambda: value)


def snapshot(number, *alerts, provider="fixture"):
    return RawI3AlertSnapshot(number, provider, "America/Toronto", NOW, {"alerts": list(alerts)})


def candidates(snapshots, connection=None, provider="fixture"):
    return prepare_capture_candidates(
        connection if connection is not None else SimpleNamespace(execute=jsonb_result),
        snapshots=snapshots,
        provider_id=provider,
        provider_timezone="America/Toronto",
        recovered_at_utc=NOW,
        source_locator="fixture:bounded-window",
    )


def test_exact_projection_keeps_children_latest_message_and_old_local_month():
    first = {
        "id": " alert-a ",
        "header": {"fr": "Travaux", "en": "Work"},
        "routes": ["10"],
        "activePeriods": [{"start": "2010-03-01T00:30:00Z"}],
    }
    latest = {
        **first,
        "header": {"fr": "Travaux", "en": "Works"},
        "routes": ["20", "30"],
        "url": "new",
    }
    inputs = [snapshot(101, first), snapshot(102, latest)]
    (candidate,) = candidates(inputs)
    assert candidates(reversed(inputs)) == (candidate,)
    assert (
        candidate.provider_id,
        candidate.alert_id,
        candidate.archive_month,
        candidate.source_kind,
        candidate.source_locator,
    ) == ("fixture", "alert-a", date(2010, 2, 1), "capture", "fixture:bounded-window")
    row = dict(candidate.record)
    assert len(row.pop("content_hash")) == 64
    assert row == {
        "provider_id": "fixture",
        "alert_id": "alert-a",
        "archive_month": date(2010, 2, 1),
        "header_text": "Travaux",
        "header_text_en": "Works",
        "description_text": None,
        "description_text_en": None,
        "severity": None,
        "cause": None,
        "effect": None,
        "route_ids": ["10", "30"],
        "stop_ids": [],
        "start_utc": datetime(2010, 3, 1, 0, 30, tzinfo=UTC),
        "end_utc": None,
        "active_periods": [{"start_utc": "2010-03-01T00:30:00Z", "end_utc": None}],
        "url": "new",
        "url_en": None,
        "first_seen_utc": NOW,
        "last_seen_utc": NOW,
        "updated_at_utc": NOW,
        "message": {
            "snapshot_id": "102",
            "alert_index": 0,
            "captured_utc": "2026-11-01T00:00:00Z",
            "header_language": "fr",
            "description_language": None,
            "url_language": None,
        },
    }


def test_message_order_differs_from_latest_nonnull_order_and_ids_sort_naturally():
    inputs = [
        snapshot(
            9,
            {
                "id": "a",
                "header": "Old",
                "severity": "high",
                "informedEntities": [
                    {"routeId": "10", "stopId": "S10"},
                    {"routeId": "2", "stopId": "S2"},
                ],
            },
        ),
        snapshot(
            10,
            {"id": "a", "header": "New", "severity": "low"},
            {"id": "a", "header": "Old", "severity": "high", "url": "new"},
        ),
    ]
    (candidate,) = candidates(inputs)
    row = candidate.record
    assert (row["header_text"], row["severity"], row["route_ids"], row["stop_ids"]) == (
        "Old",
        "low",
        ["2", "10"],
        ["S2", "S10"],
    )
    assert row["message"] == {
        "snapshot_id": "10",
        "alert_index": 1,
        "captured_utc": "2026-11-01T00:00:00Z",
        "header_language": None,
        "description_language": None,
        "url_language": None,
    }
    assert row["archive_month"] == date(2026, 10, 1)
    assert candidates(reversed(inputs)) == (candidate,)


def test_empty_and_mismatched_provider_scope():
    assert candidates([]) == ()
    with pytest.raises(ValueError, match="provider"):
        candidates([snapshot(1, {"id": "a"}, provider="other")])


@pytest.mark.parametrize("fields", [("header",), ("header", "description", "url")])
def test_jsonb_provenance_ignores_duplicate_capture_enumeration(fields):
    inputs = [
        snapshot(101, {"id": "a", **dict.fromkeys(fields, translations)})
        for translations in ({"es": "Detour", "en": "Detour"}, {"en": "Detour", "es": "Detour"})
    ]
    forward = candidates(inputs)[0].record
    reverse = candidates(reversed(inputs))[0].record
    assert _write_params(forward)["message"] == _write_params(reverse)["message"]
    assert forward["content_hash"] == reverse["content_hash"]
    for field in fields:
        assert forward["message"][field + "_language"] == "en"
