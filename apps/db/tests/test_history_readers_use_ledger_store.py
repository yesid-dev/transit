from dataclasses import fields, replace
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from ledger_store_contract import r2_store as store_fixture

from transit_ops.history import daily_selection as selection
from transit_ops.history import ledger, ledger_select, reader
from transit_ops.history.ledger_r2_transitions import LedgerTransitionCommitted
from transit_ops.history.ledger_store import WindowIdentity

DATASET = "capture.trip_updates"
DAY = date(2026, 11, 2)
NOW = datetime(2026, 11, 5, tzinfo=UTC)
store = store_fixture


def test_list_windows_recovers_a_committed_first_projection(store, monkeypatch):
    r2_store = store
    identity = WindowIdentity(DATASET, "network/quoted", DAY.isoformat())
    replace_object = r2_store.objects.replace

    def fail(*a, **kw):
        raise OSError("projection unavailable")

    monkeypatch.setattr(r2_store.objects, "replace", fail)
    with pytest.raises(LedgerTransitionCommitted), r2_store.session(identity) as session:
        session.mark_changed()
    monkeypatch.setattr(r2_store.objects, "replace", replace_object)
    (state,) = r2_store.list_windows(dataset_id=DATASET, provider_id="network/quoted")
    assert (state.provider_id, state.window_key, state.working_state) == (
        "network/quoted",
        "2026-11-02",
        "present",
    )


def window(provider, day):
    return ledger.WindowState(
        DATASET, provider, 0, day.isoformat(), day, "empty", NOW, 1, None, None, None, None, None
    )


def test_selection_unions_ledger_only_days_and_providers_in_order(monkeypatch):
    windows = [window("z", DAY), window("a", DAY), window("a", DAY - timedelta(days=1))]
    store = NS(list_windows=lambda **kw: windows if kw["dataset_id"] == DATASET else [])
    monkeypatch.setattr(ledger_select, "ledger_for", lambda c: store)
    conn = Mock()
    conn.execute.side_effect = [Mock(scalars=lambda: ["z", "raw"]), [("raw", DAY), ("z", DAY)]]
    result = selection.capture_days(
        conn, datasets=[DATASET], start=DAY - timedelta(days=1), end=DAY, empty_since=None
    )
    assert [(d.provider_id, d.utc_date) for d in result] == [
        ("a", DAY),
        ("raw", DAY),
        ("z", DAY),
        ("a", DAY - timedelta(days=1)),
    ]
    conn.execute.side_effect = None
    conn.execute.return_value.scalars.return_value = ["z", "raw"]
    assert selection.capture_providers(conn, now=NOW) == ["a", "raw", "z"]


def test_reader_keeps_current_overlap_including_last_equal_start(monkeypatch):
    start = datetime(2026, 11, 3, tzinfo=UTC)
    end = start + timedelta(hours=1)
    values = {f.name: None for f in fields(ledger.ArchiveCopy)}
    values.update(
        dataset_id=DATASET,
        provider_id="network",
        revision=0,
        content_version=1,
        schema_version=1,
        storage_backend="local",
        details={},
        is_current=True,
        allocated_at_utc=start,
        verified_at_utc=start,
        sealed_at_utc=start,
    )
    copies = [
        ledger.ArchiveCopy(
            **(
                values
                | dict(
                    window_key=day.isoformat(),
                    window_start=day,
                    first_time_utc=first,
                    last_time_utc=last,
                )
            )
        )
        for day, first, last in [
            (date(2026, 11, 1), start - timedelta(hours=1), start),
            (DAY, start - timedelta(hours=1), start - timedelta(microseconds=1)),
            (date(2026, 10, 31), end, end),
        ]
    ]
    copies.append(replace(copies[0], window_key="2026-10-30", is_current=False))
    windows = [
        replace(
            window("network", date.fromisoformat(c.window_key)),
            current_version=1,
            working_state="trimmed",
        )
        for c in copies
    ]
    store = NS(find_copies=lambda **kw: copies, list_windows=lambda **kw: windows)
    monkeypatch.setattr(ledger_select, "ledger_for", lambda c: store)

    # Archive planning needs metadata only; all these copies contain no polls.
    def execute(sql, params=None):
        query = str(sql)
        if "SELECT now()" in query:
            return NS(scalar_one=lambda: NOW)
        if "SELECT feed_endpoint_id" in query:
            return NS(
                mappings=lambda: NS(
                    one_or_none=lambda: {
                        "feed_endpoint_id": 1,
                        "created_at_utc": start - timedelta(days=30),
                    }
                )
            )
        if "raw.ingestion_runs" in query:
            return NS(scalars=lambda: [])
        raise AssertionError(query)

    monkeypatch.setattr(reader, "rows_fingerprint", lambda *a, **kw: "same")
    store.window_state = lambda identity: replace(windows[0], remainder_fingerprint="same")
    store.find_copies = lambda **kw: [
        replace(
            c,
            details={
                "rows_fingerprint": "same",
                "declared_interval_seconds": None,
                "observed_interval_ms": None,
            },
        )
        for c in copies
        if kw["start"] <= c.window_start <= kw["end"]
    ]
    result = reader.open_window(
        "network", ["trip_updates"], start, end, connection=NS(execute=execute), storage=Mock()
    )
    assert [d.utc_date for d in result.days] == [date(2026, 11, 1), date(2026, 11, 3)]
