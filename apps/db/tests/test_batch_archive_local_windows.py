"""Logical local days select physical months without losing their row bounds."""

import json
from datetime import UTC, date, datetime, timedelta

import duckdb
import pytest
from test_batch_input_sources import archive, put, store

from transit_ops.batch.build import BuildRequest, InputNeed
from transit_ops.batch.input_sources import SourcesMissing, fetch_replay_inputs, resolve_sources
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.archive_keys import proof_key


def request_for(day, zone="America/Toronto"):
    day = date.fromisoformat(day)
    return BuildRequest(
        "stm",
        (day,),
        datetime.combine(day + timedelta(days=3), datetime.min.time(), UTC),
        14,
        3,
        zone,
    )


def seed(storage, relation, months, *, provider="stm", revision=0):
    column = "period_start_utc" if relation == "gold.stop_delay_hourly" else "provider_local_date"
    kind = "TIMESTAMPTZ" if column.endswith("_utc") else "DATE"
    return [
        archive(
            storage,
            relation,
            month,
            f"SELECT NULL::{kind} AS {column} WHERE false",
            provider=provider,
            revision=revision,
        )
        for month in months
    ]


@pytest.mark.parametrize(
    "relation",
    [
        "gold.stop_delay_hourly",
        "gold.route_delay_spine",
        "gold.stop_delay_spine",
    ],
)
def test_reproduced_november_needs_resolve_with_original_logical_context(tmp_path, relation):
    storage = store(tmp_path)
    keys = seed(storage, relation, ["2026-10", "2026-11"])
    request = request_for("2026-11-12")
    days = [12] if relation.endswith("hourly") else range(9, 13)
    needs = tuple(InputNeed(relation, f"local:2026-11-{d:02}") for d in days)
    sources = resolve_sources(needs, storage, "stm", request.as_of_utc, {}, request=request)
    assert [(s.key, s.needs) for s in sources] == [(keys[1], needs)]


# Expected months are explicit calendar examples, independent of the selector.
@pytest.mark.parametrize(
    "day,zone,months",
    [
        ("2026-10-31", "America/Toronto", ["2026-10", "2026-11"]),
        ("2026-12-31", "America/Toronto", ["2026-12", "2027-01"]),
        ("2026-03-08", "America/Toronto", ["2026-03"]),  # 23 hours
        ("2026-11-01", "America/Toronto", ["2026-11"]),  # 25 hours
        ("2026-11-01", "Asia/Tokyo", ["2026-10", "2026-11"]),
        ("2026-10-31", "UTC", ["2026-10"]),  # end is exactly November 1
    ],
)
@pytest.mark.parametrize("relation", ["gold.stop_delay_hourly", "gold.stop_delay_spine"])
def test_physical_months_follow_declared_clock(tmp_path, day, zone, months, relation):
    storage = store(tmp_path)
    expected = months if relation.endswith("hourly") else [day[:7]]
    keys = seed(storage, relation, sorted(set(months + [day[:7]])))
    request = request_for(day, zone)
    need = InputNeed(relation, "local:" + day)
    sources = resolve_sources([need], storage, "stm", request.as_of_utc, {}, request=request)
    assert [s.receipt["window_key"] for s in sources] == expected
    assert all(s.needs == (need,) and s.key in keys for s in sources)


@pytest.mark.parametrize("fault", ["missing_month", "short_cut", "short_date_bound"])
def test_refuses_original_need_before_payload_reads(tmp_path, monkeypatch, fault):
    storage = store(tmp_path)
    relation = "gold.stop_delay_hourly"
    months = ["2026-10"] if fault == "missing_month" else ["2026-10", "2026-11"]
    seed(storage, relation, months)
    # An older sufficient copy must not replace the current insufficient copy.
    if fault != "missing_month":
        current = seed(storage, relation, ["2026-11"], revision=1)[0]
        record = json.loads(storage.read_bytes(proof_key(current)))
        record.update(partial=True, cut_utc="2026-11-01T09:59:59+00:00")
        if fault == "short_date_bound":
            record.update(cut_utc="2026-11-03T00:00:00+00:00", date_bound="2026-10-31")
        put(storage, proof_key(current), record)
    monkeypatch.setattr(
        LocalBronzeStorage,
        "open_stream",
        lambda *a, **k: pytest.fail("payload read before preflight completed"),
    )
    request = request_for("2026-10-31")
    need = InputNeed(relation, "local:2026-10-31")
    root = tmp_path / "inputs"
    root.mkdir()
    error = SourcesMissing if fault == "missing_month" else ValueError
    match = "missing proven sources" if fault == "missing_month" else "window_coverage"
    with pytest.raises(error, match=match) as caught:
        fetch_replay_inputs(
            storage,
            root,
            "stm",
            request.as_of_utc,
            lambda _: [need],
            bootstrap_editions=False,
            request=request,
        )
    assert need.window in str(caught.value)
    assert list(root.iterdir()) == []


def test_utc_clock_requires_request_and_other_provider_cannot_supply_month(tmp_path):
    storage = store(tmp_path)
    relation = "gold.stop_delay_hourly"
    seed(storage, relation, ["2026-10"])
    seed(storage, relation, ["2026-11"], provider="octranspo")
    request = request_for("2026-10-31")
    need = InputNeed(relation, "local:2026-10-31")
    with pytest.raises(ValueError, match="timezone"):
        resolve_sources([need], storage, "stm", request.as_of_utc, {})
    with pytest.raises(SourcesMissing) as caught:
        resolve_sources([need], storage, "stm", request.as_of_utc, {}, request=request)
    assert caught.value.needs == (need,)


def test_exact_cut_margin_is_checked_for_each_original_need(tmp_path):
    storage = store(tmp_path)
    relation = "gold.stop_delay_hourly"
    keys = seed(storage, relation, ["2026-10", "2026-11"])
    request = request_for("2026-10-31")
    need = InputNeed(relation, "local:2026-10-31")
    for key in keys:
        record = json.loads(storage.read_bytes(proof_key(key)))
        record.update(partial=True, cut_utc="2026-11-01T10:00:00+00:00")
        put(storage, proof_key(key), record)
    assert len(resolve_sources([need], storage, "stm", request.as_of_utc, {}, request=request)) == 2
    # October's part must still cover the original local-day end plus six hours.
    record = json.loads(storage.read_bytes(proof_key(keys[0])))
    record["cut_utc"] = "2026-11-01T09:59:59+00:00"
    put(storage, proof_key(keys[0]), record)
    with pytest.raises(ValueError, match="window_coverage.*local:2026-10-31"):
        resolve_sources([need], storage, "stm", request.as_of_utc, {}, request=request)


def test_date_local_clock_does_not_require_a_guessed_timezone(tmp_path):
    storage = store(tmp_path)
    relation = "gold.stop_delay_spine"
    key = seed(storage, relation, ["2026-11"])[0]
    request = request_for("2026-11-01")
    need = InputNeed(relation, "local:2026-11-01")
    assert resolve_sources([need], storage, "stm", request.as_of_utc, {})[0].key == key


def test_hourly_family_keeps_its_fractional_offset_refusal():
    from transit_ops.batch.families.stop_spine_hours import builder

    with pytest.raises(ValueError, match="fractional_utc_offset"):
        builder.inputs(request_for("2026-11-01", "Asia/Kolkata"))


@pytest.mark.parametrize(
    "day,zone,start,end",
    [
        ("2026-10-31", "America/Toronto", "2026-10-31 04:00:00+00", "2026-11-01 04:00:00+00"),
        ("2026-03-08", "America/Toronto", "2026-03-08 05:00:00+00", "2026-03-09 04:00:00+00"),
        ("2026-11-01", "America/Toronto", "2026-11-01 04:00:00+00", "2026-11-02 05:00:00+00"),
        ("2026-11-01", "Asia/Tokyo", "2026-10-31 15:00:00+00", "2026-11-01 15:00:00+00"),
    ],
)
def test_fetch_filters_exact_local_interval_and_preserves_provenance(
    tmp_path,
    day,
    zone,
    start,
    end,
):
    storage = store(tmp_path)
    relation = "gold.stop_delay_hourly"
    start, end = datetime.fromisoformat(start), datetime.fromisoformat(end)
    instants = [start - timedelta(microseconds=1), start, end - timedelta(microseconds=1), end]
    months = sorted({t.strftime("%Y-%m") for t in instants})
    keys = []
    for month in months:
        rows = ",".join(
            f"({i}, TIMESTAMPTZ '{t.isoformat()}')"
            for i, t in enumerate(instants)
            if t.strftime("%Y-%m") == month
        )
        keys.append(
            archive(
                storage,
                relation,
                month,
                f"SELECT * FROM (VALUES {rows}) t(id,period_start_utc)",
                provider="stm",
            )
        )
    request = request_for(day, zone)
    need = InputNeed(relation, "local:" + day)
    root = tmp_path / "inputs"
    root.mkdir()
    result = fetch_replay_inputs(
        storage,
        root,
        "stm",
        request.as_of_utc,
        lambda _: [need],
        bootstrap_editions=False,
        request=request,
    )
    filename = f"{relation}/local={day}.parquet"
    with duckdb.connect() as conn:
        assert conn.execute(
            "SELECT id FROM read_parquet(?) ORDER BY id", [str(root / filename)]
        ).fetchall() == [(1,), (2,)]
    assert result["needs"] == [dict(relation=relation, window=need.window)]
    receipts = json.loads((root / "fetch-receipts.json").read_bytes())["files"]
    assert list(receipts) == [filename]
    assert {s["key"] for s in receipts[filename]["sources"]} == set(keys)
    assert sum(r["rows_kept"] for r in result["receipts"]) == 2
    assert sum(r["rows_dropped"] for r in result["receipts"]) == 2


def test_date_local_filter_never_shifts_to_previous_utc_date(tmp_path):
    storage = store(tmp_path)
    relation = "gold.stop_delay_spine"
    archive(
        storage,
        relation,
        "2026-11",
        "SELECT * FROM (VALUES (0, DATE '2026-10-31'), (1, DATE '2026-11-01'), "
        "(2, DATE '2026-11-02')) t(id,provider_local_date)",
        provider="stm",
    )
    request = request_for("2026-11-01", "Asia/Tokyo")
    need = InputNeed(relation, "local:2026-11-01")
    root = tmp_path / "inputs"
    root.mkdir()
    fetch_replay_inputs(
        storage,
        root,
        "stm",
        request.as_of_utc,
        lambda _: [need],
        bootstrap_editions=False,
        request=request,
    )
    with duckdb.connect() as conn:
        assert conn.execute(
            "SELECT id FROM read_parquet(?)", [str(root / relation / "local=2026-11-01.parquet")]
        ).fetchall() == [(1,)]
