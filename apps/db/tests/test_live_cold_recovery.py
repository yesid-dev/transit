from contextlib import closing
from dataclasses import replace

import pytest
from cold_recovery_fixture import generate, seal
from test_live_local_file import SETTINGS

from transit_ops.history.poll_record import ProcessingEntry
from transit_ops.live.recovery import (
    CHECKPOINT_TABLES,
    RecoveryRefused,
    _read_frame,
    _state,
    frames_sha256,
    reconstruct,
    reopen,
)
from transit_ops.live.segments import export_segment


def build(tmp_path, inputs, storage, payloads, name="candidate.duckdb"):
    return reconstruct(
        tmp_path / name,
        owned_directory=tmp_path,
        inputs=inputs,
        storage=storage,
        resolver=lambda c: payloads[(c.index_family, c.capture_row_id)],
        settings=SETTINGS,
    )


def test_complete_generated_inputs_rebuild_both_fact_families_and_alert_continuity(tmp_path):
    inputs, storage, payloads, expected = generate(tmp_path)
    result = build(tmp_path, inputs, storage, payloads)
    with closing(reopen(result.path, provider_id="network", settings=SETTINGS)) as local:
        assert frames_sha256(_state(local)) == frames_sha256(expected)
        assert local.connection.execute(
            "SELECT delay_seconds FROM fact_trip_delay_snapshot"
        ).fetchall() == [(180,)]
        assert local.connection.execute(
            "SELECT i3_alert_snapshot_id, message_snapshot_id FROM silver.i3_alerts "
            "WHERE alert_id='avis'"
        ).fetchall() == [(101, 102)]
        assert local.connection.execute(
            "SELECT ingestion_run_id FROM recording_coverage WHERE NOT terminal_recorded"
        ).fetchall() == [(99,)]
    with pytest.raises(FileExistsError):
        build(tmp_path, inputs, storage, payloads)


def test_original_application_order_and_historical_editions_are_required_and_replayed(tmp_path):
    inputs, storage, payloads, expected = generate(tmp_path, historical=True)
    result = build(tmp_path, inputs, storage, payloads)
    with closing(reopen(result.path, provider_id="network", settings=SETTINGS)) as local:
        assert frames_sha256(_state(local)) == frames_sha256(expected)
        assert local.connection.execute(
            "SELECT delay_seconds FROM fact_trip_delay_snapshot ORDER BY realtime_snapshot_id"
        ).fetchall() == [(180,), (3780,)]
    missing = replace(
        inputs, applications=tuple(replace(s, edition=None) for s in inputs.applications)
    )
    missing = seal(missing, frames_sha256(expected))
    with pytest.raises(RecoveryRefused, match="application_edition_missing"):
        build(tmp_path, missing, storage, payloads, "incomplete.duckdb")


def test_cold_restore_keeps_failed_source_attribution_without_claiming_capture_identity(tmp_path):
    inputs, storage, payloads, _ = generate(tmp_path)
    from test_live_captures import AT

    failure = ProcessingEntry(
        "silver_load",
        "realtime_snapshot",
        None,
        "by_time",
        "failed",
        AT,
        AT,
        "fixture source load failed",
        None,
        88,
    )
    with closing(
        reopen(tmp_path / "source.duckdb", provider_id="network", settings=SETTINGS)
    ) as source:
        with source.transaction() as conn:
            source.record_processing((failure,), endpoint_key="trip_updates")
            conn.execute("INSERT INTO recording_coverage VALUES (88, true)")
        segment = export_segment(source, storage)
        inputs = replace(
            inputs,
            inventory=(*inputs.inventory, segment),
            checkpoint=tuple(_read_frame(source, n) for n in CHECKPOINT_TABLES),
        )
        inputs = seal(inputs, frames_sha256(_state(source)))
    candidate = build(tmp_path, inputs, storage, payloads)
    with closing(reopen(candidate.path, provider_id="network", settings=SETTINGS)) as restored:
        assert restored.connection.execute(
            "SELECT capture_row_id,attribution,status,error_message FROM processing"
        ).fetchall() == [(None, "by_time", "failed", "fixture source load failed")]


@pytest.mark.parametrize(
    "missing",
    [
        "edition_source",
        "alert_seed",
        "alert_history",
        "checkpoint",
        "inventory",
        "cut",
        "applications",
    ],
)
def test_incomplete_sources_refuse_instead_of_building_empty_state(tmp_path, missing):
    inputs, storage, payloads, _ = generate(tmp_path)
    inputs = replace(inputs, **{missing: b"" if missing in ("alert_seed", "cut") else ()})
    with pytest.raises(RecoveryRefused):
        build(tmp_path, inputs, storage, payloads)


def test_bad_retained_bytes_refuse_and_preserve_source_and_candidate_evidence(tmp_path):
    inputs, storage, payloads, _ = generate(tmp_path)
    original = (tmp_path / "source.duckdb").read_bytes()
    payloads[("alert_snapshot", 101)] = b"wrong"
    with pytest.raises(RecoveryRefused, match="retained_bytes_mismatch"):
        build(tmp_path, inputs, storage, payloads)
    assert (tmp_path / "source.duckdb").read_bytes() == original
    assert (tmp_path / "candidate.duckdb").is_file()


@pytest.mark.parametrize(
    "failure",
    [
        "inventory",
        "history",
        "coverage",
        "provider",
        "version",
        "state",
        "window",
        "context",
        "serving",
        "membership",
        "cursor",
        "exports",
    ],
)
def test_even_digest_verified_cut_must_prove_complete_consistent_inputs(tmp_path, failure):
    inputs, storage, payloads, expected = generate(tmp_path)
    overrides = {}
    if failure == "inventory":
        inputs = replace(inputs, inventory=inputs.inventory[1:])
    elif failure == "history":
        inputs = replace(inputs, alert_history=inputs.alert_history[:1])
    elif failure == "coverage":
        inputs = replace(
            inputs,
            checkpoint=tuple(
                replace(f, rows=()) if f.table == "recording_coverage" else f
                for f in inputs.checkpoint
            ),
        )
    elif failure == "provider":
        inputs = replace(inputs, provider_id="other")
    elif failure == "version":
        overrides["schema_version"] = 0
    elif failure == "window":
        overrides["window_start"] = "2027-01-01T00:00:00+00:00"
    elif failure == "context":
        inputs = replace(inputs, timezone="UTC")
    elif failure in ("serving", "membership", "cursor", "exports"):
        table = {
            "serving": "local_serving",
            "membership": "segment_fact_members",
            "cursor": "recording_cursor",
            "exports": "segment_exports",
        }[failure]
        inputs = replace(
            inputs,
            checkpoint=tuple(
                replace(f, rows=()) if f.table == table else f for f in inputs.checkpoint
            ),
        )
    else:
        overrides["state_sha256"] = "0" * 64
    inputs = seal(inputs, frames_sha256(expected), **overrides)
    with pytest.raises(RecoveryRefused):
        build(tmp_path, inputs, storage, payloads)
