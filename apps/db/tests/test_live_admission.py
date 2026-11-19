"""Admission gate: every gate passes and fails by name; unavailable is never a pass."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.live.admission import (
    RULING_12_TRIGGERS,
    Adjudication,
    CycleRecord,
    EvidenceBundle,
    EvidenceInvalid,
    ResourceEvidence,
    RestartObservation,
    ShadowRecord,
    Thresholds,
    classify_restart,
    evaluate,
    read_worker_log,
    reopen_refusal,
)
from transit_ops.live.local_file import LocalFileLocked, LocalFileMismatch, LocalFileUnreadable
from transit_ops.live.recovery import RecoveryRefused
from transit_ops.operations.resource_plan import DISK_CATEGORIES, DiskItem, DiskPeak, ServicePeak

START = datetime(2026, 11, 20, 0, 0, tzinfo=UTC)
GIB = 2**30
SHA = "a" * 64
UNADJUDICATED = "publication:live/trips.json:unadjudicated"


def shadow(seconds, *, status="compared", reason=None, counts=None, rss=900 * 2**20):
    return ShadowRecord(
        START + timedelta(seconds=seconds),
        status,
        reason,
        counts or {},
        {"edition": 7, "context_sha256": "c" * 64},
        1.0,
        0.2,
        rss,
        rss,
    )


def cycle(seconds, record=..., *, status="succeeded", duration=4.0):
    record = shadow(seconds) if record is ... else record
    return CycleRecord(START + timedelta(seconds=seconds), status, duration, record)


def resources(rss=800 * 2**20):
    peak = ServicePeak("worker-stm", SHA, "24h", "shadow", True, (), 0.5, GIB, rss, 50, True)
    items = tuple(
        DiskItem("worker-stm", category, 1_000, SHA, "du", "occupied_bytes")
        for category in DISK_CATEGORIES
    )
    return ResourceEvidence((peak,), DiskPeak(items, {"worker-stm": 100_000}), "worker-stm")


def bundle(**changes):
    base = EvidenceBundle(
        provider_id="stm",
        window_start=START,
        window_end=START + timedelta(hours=1),
        cycles=tuple(cycle(20 * n) for n in range(60)),
        restarts=(RestartObservation("committed", True, 0.4, True, None, 0),),
        cadence_seconds=20,
        resources=resources(),
    )
    return replace(base, **changes)


def gate(verdict, name):
    return next(g for g in verdict.gates if g.gate == name)


def test_clean_evidence_passes_every_gate_and_names_the_owner_approval():
    verdict = evaluate(bundle())
    assert [g.outcome for g in verdict.gates] == ["pass"] * 4
    shown = verdict.display_dict()
    assert shown["outcome"] == "eligible"
    assert "owner's separate approval" in shown["approval"]
    assert shown["thresholds"]["max_uncompared_cycle_share"]["value"] == 0.05
    assert "live ruling 24.1" in shown["thresholds"]["max_uncompared_cycle_share"]["owner"]


# Recovery: live ruling 12 by name, #1142's refusals are not DuckDB failures.


@pytest.mark.parametrize(
    ("observation", "category"),
    [
        (RestartObservation("p", True, 0.4, True, None, 3), "lost_committed_row"),
        (
            RestartObservation("p", False, None, True, "failed_wal_replay", None),
            "failed_wal_replay",
        ),
        (RestartObservation("p", True, 21.0, True, None, 0), "missed_restart_gate"),
    ],
)
def test_each_ruling_12_trigger_fails_recovery_by_name(observation, category):
    verdict = evaluate(bundle(restarts=(observation,)))
    recovery = gate(verdict, "recovery")
    assert recovery.outcome == "fail"
    assert recovery.reasons == (f"ruling_12:{category}",)
    assert verdict.display_dict()["ruling_12_triggers"] == [category]
    assert category in RULING_12_TRIGGERS


def test_a_named_schema_refusal_fails_eligibility_without_a_fallback_trigger():
    refused = RestartObservation("p", False, None, True, "schema_mismatch", None)
    verdict = evaluate(bundle(restarts=(refused,)))
    assert gate(verdict, "recovery").reasons == ("refused:schema_mismatch",)
    assert verdict.display_dict()["ruling_12_triggers"] == []


@pytest.mark.parametrize(
    ("error", "wal", "name"),
    [
        (LocalFileUnreadable("x"), True, "failed_wal_replay"),
        (LocalFileUnreadable("x"), False, "local_file_unreadable_without_wal"),
        (LocalFileMismatch("meta schema version differs"), True, "schema_mismatch"),
        (LocalFileMismatch("recovery_adoption_pending"), True, "recovery_adoption_pending"),
        (LocalFileLocked("x"), True, "local_file_locked"),
        (
            FileNotFoundError("recovery_database_missing_with_wal: x"),
            True,
            "database_missing_with_wal",
        ),
        (RecoveryRefused("recovery_cut_digest_mismatch"), False, "recovery_cut_digest_mismatch"),
    ],
)
def test_reopen_failures_are_classified_at_the_1142_boundary(error, wal, name):
    assert reopen_refusal(error, wal_present=wal) == name
    triggers = name in RULING_12_TRIGGERS
    assert triggers == (name == "failed_wal_replay")


def test_unmeasured_restarts_are_unavailable_never_a_pass():
    assert gate(evaluate(bundle(restarts=())), "recovery").reasons == (
        "restart_evidence_unavailable",
    )
    unmeasured = RestartObservation("p", True, 0.4, True, None, None)
    result = gate(evaluate(bundle(restarts=(unmeasured,))), "recovery")
    assert (result.outcome, result.reasons) == ("unavailable", ("measurement_unavailable",))
    assert classify_restart(RestartObservation("p", True, 0.4, True, None, 0), None) == (
        "cadence_undeclared"
    )


# Publication equivalence: live ruling 24.1-24.2.


def test_shadow_attributable_share_fails_and_public_failures_are_excluded():
    cycles = [cycle(20 * n) for n in range(19)]
    refused = shadow(400, status="refused", reason="shadow_admission_refused:rss_limit")
    public = [
        cycle(20 * n, shadow(20 * n, status="invalid", reason="public_publication_failed"))
        for n in range(30, 60)
    ]
    nightly = [cycle(20 * n, None, status="failed") for n in range(60, 90)]
    passing = gate(evaluate(bundle(cycles=(*cycles, *public, *nightly))), "publication")
    assert passing.outcome == "pass"
    assert passing.details["public_side_failures"] == {
        "public_cycle_failed": 30,
        "public_publication_failed": 30,
    }
    over = (*cycles, cycle(400, refused), cycle(420, None), *public)
    failing = gate(evaluate(bundle(cycles=over)), "publication")
    assert failing.reasons == ("uncompared_cycle_share_exceeded",)
    assert failing.details["shadow_attributable"] == {
        "shadow_admission_refused:rss_limit": 1,
        "shadow_evidence_missing": 1,
    }
    assert failing.details["uncompared_cycle_share"] == pytest.approx(2 / 21)


def test_unadjudicated_key_fails_only_when_it_persists_to_the_end_of_the_window():
    def run(first, last):
        return tuple(
            cycle(20 * n, shadow(20 * n, counts={UNADJUDICATED: 2} if first <= n <= last else {}))
            for n in range(60)
        )

    persistent = gate(evaluate(bundle(cycles=run(29, 59))), "publication")
    assert persistent.reasons == (f"persistent_unadjudicated:{UNADJUDICATED}",)
    assert persistent.details["persistent_unadjudicated"][0]["span_seconds"] == 600.0
    short = gate(evaluate(bundle(cycles=run(31, 59))), "publication")
    assert short.outcome == "pass"
    assert short.details["transient_unadjudicated"][0]["count"] == 58
    healed = gate(evaluate(bundle(cycles=run(0, 58))), "publication")
    assert healed.outcome == "pass"
    assert healed.details["differences_by_class"] == {"unadjudicated": 118}


def test_class_b_corrections_are_methodology_items_and_class_a_is_an_engine_error():
    persistent = tuple(cycle(20 * n, shadow(20 * n, counts={UNADJUDICATED: 1})) for n in range(60))
    note = "PG counts departures from its later now(); cycle + 60 min is the definition"
    corrected = evaluate(
        bundle(cycles=persistent, adjudications={UNADJUDICATED: Adjudication("b", note)})
    )
    assert gate(corrected, "publication").outcome == "pass"
    assert corrected.display_dict()["methodology_items"] == [
        {"key": UNADJUDICATED, "count": 60, "cycles": 60, "class": "b", "math": note}
    ]
    engine = evaluate(
        bundle(cycles=persistent, adjudications={UNADJUDICATED: Adjudication("a", "wrong")})
    )
    assert gate(engine, "publication").reasons == (f"engine_error:{UNADJUDICATED}",)


def test_representation_and_clock_skew_differences_never_fail_by_themselves():
    counts = {
        "publication:live/network.json:representation": 3,
        "publication:live/trips.json:clock_skew": 2,
        "facts:fact_vehicle_snapshot:missing": 1,
        "publication:live/vehicles.json:unpaired": 1,
    }
    cycles = tuple(cycle(20 * n, shadow(20 * n, counts=counts)) for n in range(60))
    result = gate(evaluate(bundle(cycles=cycles)), "publication")
    assert result.outcome == "pass"
    assert result.details["differences_by_class"] == {
        "clock_skew": 120,
        "missing": 60,
        "representation": 180,
        "unpaired": 60,
    }


def test_unset_threshold_is_threshold_unowned_and_no_cycles_is_unavailable():
    unset = Thresholds(max_uncompared_cycle_share=None)
    result = gate(evaluate(bundle(), unset), "publication")
    assert (result.outcome, result.reasons) == (
        "threshold_unowned",
        ("max_uncompared_cycle_share",),
    )
    empty = gate(evaluate(bundle(cycles=())), "publication")
    assert (empty.outcome, empty.reasons) == ("unavailable", ("shadow_cycles_unavailable",))


# Performance: the provider's declared cadence.


def test_shadow_that_pushes_the_public_cycle_past_its_cadence_fails_by_name():
    slow = tuple(
        cycle(20 * n, replace(shadow(20 * n), shadow_seconds=9.0), duration=22.0) for n in range(60)
    )
    result = gate(evaluate(bundle(cycles=slow)), "performance")
    assert result.reasons == ("shadow_delays_public_cycle",)
    assert result.details["public_cycle_p95_seconds_without_shadow"] == 13.0
    assert result.details["public_cycle_p95_seconds_with_shadow"] == 22.0
    assert result.details["shadow_p95_seconds"] == 9.0
    baseline = tuple(cycle(20 * n, duration=30.0) for n in range(60))
    assert gate(evaluate(bundle(cycles=baseline)), "performance").reasons == (
        "public_cycle_over_cadence",
    )


def test_performance_without_cadence_or_timing_is_unavailable():
    assert gate(evaluate(bundle(cadence_seconds=None)), "performance").reasons == (
        "cadence_undeclared",
    )
    untimed = tuple(cycle(20 * n, duration=None) for n in range(60))
    result = gate(evaluate(bundle(cycles=untimed)), "performance")
    assert (result.outcome, result.reasons) == ("unavailable", ("public_cycle_timing_unavailable",))


# Resources: #901's plan_resources, never redefined here.


def test_observed_peak_is_replanned_through_the_901_ceilings():
    passing = gate(evaluate(bundle()), "resources")
    assert passing.outcome == "pass"
    assert passing.details["worker_memory_limit_bytes"] == GIB * 3 // 2
    heavy = tuple(cycle(20 * n, shadow(20 * n, rss=3 * GIB)) for n in range(60))
    failing = gate(evaluate(bundle(cycles=heavy)), "resources")
    assert failing.reasons == (
        "observed_peak_exceeds_plan:worker-stm.pilot: RSS plus headroom exceeds 3.5 GiB",
        "peak_rss_above_worker_memory_limit",
        "current_rss_above_worker_memory_limit",
    )


def test_unmeasured_resources_are_unavailable_never_a_pass():
    no_plan = gate(evaluate(bundle(resources=None)), "resources")
    assert (no_plan.outcome, no_plan.reasons) == ("unavailable", ("resource_plan_unavailable",))
    blind = tuple(cycle(20 * n, shadow(20 * n, rss=None)) for n in range(60))
    result = gate(evaluate(bundle(cycles=blind)), "resources")
    assert result.reasons == ("peak_rss_unavailable", "current_rss_unavailable")
    incomplete = replace(resources(), peaks=(replace(resources().peaks[0], complete=False),))
    missing = gate(evaluate(bundle(resources=incomplete)), "resources")
    assert missing.reasons == ("resource_plan_evidence:worker-stm.coverage",)


# Reading the worker's own log lines, and the CLI.


def log_lines(provider="stm"):
    lines = []
    for n in range(3):
        at = START + timedelta(seconds=20 * n)
        stamp = "2026-11-20 00:00:00,000 INFO"
        record = {
            "cycle": at.isoformat(),
            "role": "postgres_authoritative",
            "status": "compared",
            "reason": None,
            "identity": {"cycle": at.isoformat(), "edition": 7},
            "counts": {UNADJUDICATED: 1} if n == 2 else {},
            "difference_total": 0,
            "samples": [],
            "shadow_seconds": 1.5,
            "capture_seconds": 0.25,
            "p95_seconds": 1.5,
            "rss_bytes": 700 * 2**20,
            "process_peak_rss_bytes": 750 * 2**20,
        }
        lines += [
            f"{stamp} [transit_ops.orchestration] Starting realtime worker cycle {n + 1} "
            f"for provider '{provider}'.",
            f"{stamp} [transit_ops.live.shadow] paired_shadow {json.dumps(record)}",
            f"{stamp} [transit_ops.orchestration] Realtime worker cycle {n + 1} completed "
            "successfully: "
            + json.dumps(
                {"provider_id": provider, "status": "succeeded", "started_at_utc": at.isoformat()}
            ),
            f"{stamp} [transit_ops.orchestration] Realtime worker cycle {n + 1} timing: "
            + json.dumps({"cycle_start_utc": at.isoformat(), "cycle_duration_seconds": 5.0}),
        ]
    lines += [
        "2026-11-20 00:01:00,000 INFO [transit_ops.orchestration] Starting realtime worker "
        f"cycle 4 for provider '{provider}'.",
        "2026-11-20 00:01:00,000 ERROR [transit_ops.orchestration] Realtime worker cycle 4 "
        f"for provider '{provider}' raised an unexpected exception and will be skipped",
        "Traceback (most recent call last):",
    ]
    return lines


def test_worker_log_becomes_cycles_inside_the_window_only():
    cycles = read_worker_log(
        log_lines(),
        provider_id="stm",
        start=START + timedelta(seconds=10),
        end=START + timedelta(hours=1),
    )
    assert [c.status for c in cycles] == ["succeeded", "succeeded", "raised"]
    assert cycles[0].shadow.capture_seconds == 0.25 and cycles[0].duration_seconds == 5.0
    assert cycles[2].public_failed and cycles[2].shadow is None
    assert (
        read_worker_log(
            log_lines("sto"), provider_id="stm", start=START, end=START + timedelta(hours=1)
        )
        == ()
    )


def test_corrupt_shadow_evidence_is_refused_by_name_not_skipped():
    lines = log_lines()
    lines[1] = lines[1].replace('"status": "compared"', '"status": "maybe"')
    with pytest.raises(EvidenceInvalid, match="shadow_status_unknown"):
        read_worker_log(lines, provider_id="stm", start=START, end=START + timedelta(hours=1))


def test_cli_reads_shadow_logs_and_writes_the_verdict(tmp_path):
    log = tmp_path / "worker.log"
    log.write_text("\n".join(log_lines()) + "\n", encoding="utf-8")
    restarts = tmp_path / "restarts.jsonl"
    restarts.write_text(
        json.dumps(
            {
                "point": "committed",
                "reopened": True,
                "reopen_seconds": 0.3,
                "wal_present": True,
                "refusal": None,
                "committed_rows_lost": 0,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    output = tmp_path / "verdict.json"
    arguments = [
        "live-engine",
        "admission",
        "--provider",
        "stm",
        "--log",
        str(log),
        "--start",
        START.isoformat(),
        "--end",
        (START + timedelta(hours=1)).isoformat(),
        "--restarts",
        str(restarts),
        "--output",
        str(output),
    ]
    result = CliRunner().invoke(app, arguments)
    assert result.exit_code == 1, result.output  # Not eligible: no resource plan supplied.
    verdict = json.loads(output.read_text(encoding="utf-8"))
    assert json.loads(result.stdout) == verdict
    assert verdict["outcome"] == "not_eligible"
    assert verdict["thresholds"]["cadence_seconds"]["value"] == 20
    outcomes = {name: g["outcome"] for name, g in verdict["gates"].items()}
    assert outcomes == {
        "recovery": "pass",
        "publication": "pass",
        "performance": "pass",
        "resources": "unavailable",
    }
    assert verdict["gates"]["publication"]["details"]["public_side_failures"] == {
        "public_cycle_raised": 1
    }
    assert verdict["gates"]["resources"]["reasons"] == ["resource_plan_unavailable"]
    again = CliRunner().invoke(app, arguments)
    assert again.exit_code == 2 and "exists" in again.output
