import json
from datetime import UTC, datetime

import pytest
from test_batch_input_sources import archive, put, store
from typer.testing import CliRunner

from transit_ops.commands.batch import app


def public_fetch(tmp_path, monkeypatch, query=None):
    from transit_ops import providers
    from transit_ops.history import storage as history

    storage = store(tmp_path)
    if query is not None:
        archive(storage, "core.providers", "2026-11", query, provider="stm")
    closed = []

    class Scope:
        def resolve(self, backend):
            return storage

        def close(self):
            closed.append(True)

    monkeypatch.setattr(history, "history_storage", lambda _: Scope())
    monkeypatch.setattr(providers, "load_providers", lambda: pytest.fail("local declarations read"))
    root = tmp_path / "inputs"
    root.mkdir()
    args = [
        "fetch-inputs",
        "--provider",
        "stm",
        "--date",
        "2026-11-12",
        "--family",
        "occupancy_crowding",
        "--inputs",
        str(root),
    ]
    return storage, root, args, closed


@pytest.mark.parametrize(
    "query,reason",
    [
        (None, "missing proven sources: (core.providers, all)"),
        ("SELECT 'other' AS provider_id, 'America/Toronto' AS timezone", "provider_unknown"),
        ("SELECT 'stm' AS provider_id, 'bad/zone' AS timezone", "provider_timezone_invalid"),
        ("SELECT 'stm' AS provider_id, NULL::VARCHAR AS timezone", "provider_timezone_invalid"),
        (
            "SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone FROM range(2)",
            "provider_duplicate",
        ),
    ],
)
def test_public_default_refuses_bad_metadata_before_catalog(tmp_path, monkeypatch, query, reason):
    _, root, args, closed = public_fetch(tmp_path, monkeypatch, query)
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 1
    assert reason in result.output
    assert closed == [True]
    assert not list(root.rglob("*.parquet"))


@pytest.mark.parametrize("fault", ["corrupt", "unproven"])
def test_public_default_requires_digest_and_proof(tmp_path, monkeypatch, fault):
    storage, root, args, closed = public_fetch(
        tmp_path, monkeypatch, "SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone"
    )
    path = next(storage.root.rglob("*.parquet"))
    if fault == "corrupt":
        path.write_bytes(b"corrupt")
    else:
        from transit_ops.lake.archive_keys import proof_key

        key = path.relative_to(storage.root).as_posix()
        record = json.loads((storage.root / proof_key(key)).read_bytes())
        record["proof"]["verified"] = False
        put(storage, proof_key(key), record)
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 1
    assert "core.providers" in result.output
    assert closed == [True]
    assert not list(root.rglob("*.parquet"))


@pytest.mark.parametrize("as_of", [None, "2026-11-14T03:00:00-05:00"])
def test_default_archive_zone_reaches_real_family_planning(tmp_path, monkeypatch, as_of):
    from transit_ops.batch.archive_provider import archived_request, replay_identity
    from transit_ops.batch.families.occupancy_crowding import builder
    from transit_ops.settings import Settings

    storage, root, _, _ = public_fetch(
        tmp_path, monkeypatch, "SELECT 'stm' AS provider_id, 'America/Vancouver' AS timezone"
    )
    day, stamp = replay_identity("stm", "2026-11-12", as_of)
    request = archived_request(storage, root, "stm", day, stamp, Settings())
    assert request.timezone == "America/Vancouver"
    assert request.as_of_utc == (
        datetime(2026, 11, 13, 7, tzinfo=UTC)
        if as_of is None
        else datetime(2026, 11, 14, 8, tzinfo=UTC)
    )
    needs = builder.inputs(request)
    assert any(n.window == "2026-11-13" for n in needs)
    assert list(root.iterdir()) == []


@pytest.mark.parametrize(
    "final,reason",
    [
        ("SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone", None),
        ("SELECT 'stm' AS provider_id, 'America/Vancouver' AS timezone", "timezone_mismatch"),
        ("SELECT 'other' AS provider_id, 'America/Toronto' AS timezone", "provider_unknown"),
        (
            "SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone FROM range(2)",
            "provider_duplicate",
        ),
    ],
)
def test_changed_final_proven_metadata_is_revalidated(tmp_path, monkeypatch, final, reason):
    from transit_ops.batch.archive_provider import (
        archived_request,
        assert_final_provider,
        replay_identity,
    )
    from transit_ops.batch.build import InputNeed
    from transit_ops.batch.input_sources import fetch_replay_inputs
    from transit_ops.settings import Settings

    storage, root, _, _ = public_fetch(
        tmp_path, monkeypatch, "SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone"
    )
    day, stamp = replay_identity("stm", "2026-11-12", None)
    request = archived_request(storage, root, "stm", day, stamp, Settings())
    key = archive(storage, "core.providers", "2026-11", final, provider="stm", revision=1)
    result = fetch_replay_inputs(
        storage,
        root,
        "stm",
        stamp,
        lambda _: (InputNeed("core.providers", "all"),),
        bootstrap_editions=False,
    )
    assert result["receipts"][0]["key"] == key
    if reason:
        with pytest.raises(ValueError, match=reason):
            assert_final_provider(root, request)
    else:
        assert_final_provider(root, request)


def test_public_default_fetch_with_guarded_real_catalog(real_db_engine, tmp_path, monkeypatch):
    from transit_ops.batch.archive_provider import archived_request, replay_identity
    from transit_ops.batch.families.occupancy_crowding import builder
    from transit_ops.settings import Settings

    storage, root, args, closed = public_fetch(
        tmp_path, monkeypatch, "SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone"
    )
    monkeypatch.setenv(
        "TRANSIT_REPLAY_DATABASE_URL", real_db_engine.url.render_as_string(hide_password=False)
    )
    day, stamp = replay_identity("stm", "2026-11-12", None)
    request = archived_request(storage, root, "stm", day, stamp, Settings())
    for need in builder.inputs(request):
        if need.relation == "core.providers":
            continue
        archive(
            storage,
            need.relation,
            need.window,
            "SELECT 'stm' AS provider_id, "
            "TIMESTAMPTZ '2026-11-12 12:00:00+00' AS captured_at_utc WHERE false",
            provider="stm",
        )
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 0, result.output
    receipt = json.loads(result.stdout)
    assert any("core.providers" in r["key"] for r in receipt["receipts"])
    assert (root / "core.providers/all.parquet").is_file()
    assert closed == [True]


@pytest.mark.parametrize(
    "extra,reason",
    [
        (["--provider", "../stm"], "Invalid provider_id"),
        (["--date", "20261112"], "date must be YYYY-MM-DD"),
        (["--as-of", "2026-11-13T07:00:00"], "as_of_utc must be timezone-aware"),
        (["--timezone", "America/Toronto"], "explicit --as-of"),
    ],
)
def test_public_invalid_identity_refuses_before_storage(tmp_path, monkeypatch, extra, reason):
    _, _, args, closed = public_fetch(tmp_path, monkeypatch)
    result = CliRunner().invoke(app, args + extra)
    assert result.exit_code == 1
    assert reason in result.output
    assert closed == []


def test_public_valid_bootstrap_keeps_disposable_catalog_guard(tmp_path, monkeypatch):
    _, _, args, closed = public_fetch(
        tmp_path, monkeypatch, "SELECT 'stm' AS provider_id, 'America/Toronto' AS timezone"
    )
    monkeypatch.delenv("TRANSIT_REPLAY_DATABASE_URL", raising=False)
    result = CliRunner().invoke(app, args)
    assert result.exit_code == 1
    assert "TRANSIT_REPLAY_DATABASE_URL is required" in result.output
    assert closed == [True]
