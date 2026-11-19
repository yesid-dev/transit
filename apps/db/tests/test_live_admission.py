"""Admission gate: every gate passes and fails by name; unavailable is never a pass."""

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

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
    WindowCpu,
    classify_restart,
    evaluate,
    read_restart_records,
    read_worker_log,
    reopen_refusal,
)
from transit_ops.live.local_file import LocalFileLocked, LocalFileMismatch, LocalFileUnreadable
from transit_ops.live.recovery import RecoveryRefused
from transit_ops.operations.resource_plan import DISK_CATEGORIES, DiskItem, DiskPeak, ServicePeak
from transit_ops.providers.registry import load_provider_manifest
from transit_ops.realtime_schedule import worker_tick_seconds

START = datetime(2026, 11, 20, 0, 0, tzinfo=UTC)
WINDOW = timedelta(minutes=20)  # 60 ticks of 20 s.
GIB = 2**30
SHA = "a" * 64
UNADJUDICATED = "publication:live/trips.json:unadjudicated"
STM = Path(__file__).parents[1] / "config" / "providers" / "stm.yaml"


def shadow(seconds, *, status="compared", reason=None, counts=None, rss=900 * 2**20):
    return ShadowRecord(
        START + timedelta(seconds=seconds),
        status,
        reason,
        counts or {},
        {"edition": 7, "context_sha256": "c" * 64, "public_keys_written": ["manifest.json"]},
        1.0,
        0.2,
        rss,
        rss,
    )


def cycle(seconds, record=..., *, status="succeeded", duration=4.0, attempted=2, tick=20.0):
    record = shadow(seconds) if record is ... else record
    return CycleRecord(
        START + timedelta(seconds=seconds), status, duration, record, attempted, tick
    )


def restart(*, provider="stm", at=START + timedelta(minutes=5), **changes):
    return replace(
        RestartObservation(
            provider, at, "committed", True, 0.4, True, None, 0, "durable_watermark"
        ),
        **changes,
    )


def resources(rss=800 * 2**20):
    peak = ServicePeak("worker-stm", SHA, "24h", "shadow", True, (), 0.5, GIB, rss, 50, True)
    items = tuple(
        DiskItem("worker-stm", category, 1_000, SHA, "du", "occupied_bytes")
        for category in DISK_CATEGORIES
    )
    return ResourceEvidence((peak,), DiskPeak(items, {"worker-stm": 100_000}), "worker-stm")


def window_cpu(cores=0.4, *, start=START, end=START + WINDOW):
    return WindowCpu("worker-stm", cores, start, end, SHA)


def bundle(**changes):
    base = EvidenceBundle(
        provider_id="stm",
        window_start=START,
        window_end=START + WINDOW,
        cycles=tuple(cycle(20 * n) for n in range(60)),
        restarts=(restart(),),
        cadence_seconds=20,
        tick_seconds=20,
        resources=resources(),
        window_cpu=window_cpu(),
    )
    return replace(base, **changes)


def gate(verdict, name):
    return next(g for g in verdict.gates if g.gate == name)


def every_cycle(counts, n=60):
    return tuple(cycle(20 * i, shadow(20 * i, counts=counts)) for i in range(n))


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
    ("changes", "category"),
    [
        ({"committed_rows_lost": 3}, "lost_committed_row"),
        (
            {"reopened": False, "reopen_seconds": None, "refusal": "failed_wal_replay"},
            "failed_wal_replay",
        ),
        ({"reopen_seconds": 21.0}, "missed_restart_gate"),
    ],
)
def test_each_ruling_12_trigger_fails_recovery_by_name(changes, category):
    verdict = evaluate(bundle(restarts=(restart(), restart(**changes))))
    recovery = gate(verdict, "recovery")
    assert recovery.outcome == "fail"
    assert recovery.reasons == (f"ruling_12:{category}",)
    assert verdict.display_dict()["ruling_12_triggers"] == [category]
    assert category in RULING_12_TRIGGERS


def test_a_named_schema_refusal_fails_eligibility_without_a_fallback_trigger():
    refused = restart(reopened=False, reopen_seconds=None, refusal="schema_mismatch")
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
    unmeasured = restart(committed_rows_lost=None)
    result = gate(evaluate(bundle(restarts=(unmeasured,))), "recovery")
    assert (result.outcome, result.reasons) == ("unavailable", ("measurement_unavailable",))
    assert classify_restart(restart(), None) == "cadence_undeclared"


def test_a_restart_record_without_a_witness_never_verified_its_rows():
    # Records written before the committed watermark carry a count but no verifier.
    legacy = {**restart().display_dict(), "committed_rows_lost": 0}
    del legacy["verified_by"]
    (record,) = read_restart_records([json.dumps(legacy)])
    assert record.verified_by is None
    assert classify_restart(record, 20) == "measurement_unavailable"
    result = gate(evaluate(bundle(restarts=(record,))), "recovery")
    assert (result.outcome, result.reasons) == ("unavailable", ("measurement_unavailable",))


@pytest.mark.parametrize(
    "changes",
    [
        {"verified_by": "reopened_file"},
        {"verified_by": "durable_watermark", "committed_rows_lost": None},
    ],
)
def test_a_restart_record_with_an_unknown_or_empty_verification_is_malformed(changes):
    with pytest.raises(EvidenceInvalid, match="restart_record_verified_by_invalid"):
        RestartObservation.from_dict({**restart().display_dict(), **changes})


def test_restart_records_bind_to_their_provider_and_the_window():
    elsewhere = (restart(provider="sto"), restart(at=START - timedelta(hours=1)))
    result = gate(evaluate(bundle(restarts=elsewhere)), "recovery")
    assert (result.outcome, result.reasons) == ("unavailable", ("restart_evidence_unavailable",))
    assert result.details["ignored_restarts"] == {"other_provider": 1, "outside_window": 1}
    # Every in-window record must pass; one slow restart among good ones fails.
    mixed = (*elsewhere, restart(), restart(reopen_seconds=25.0))
    assert gate(evaluate(bundle(restarts=mixed)), "recovery").reasons == (
        "ruling_12:missed_restart_gate",
    )


# Publication equivalence: live rulings 24.1-24.2 and 25.


@pytest.mark.parametrize(
    ("key", "count"),
    [
        ("publication:live/vehicles.json:missing", 1),  # vehicles.json never written.
        ("facts:fact_vehicle_snapshot:missing", 500),  # Fact rows lost every cycle.
        ("facts:fact_vehicle_snapshot:extra", 3),
        ("publication:live/vehicles.json:unpaired", 1),
        (UNADJUDICATED, 2),
    ],
)
def test_every_judged_class_fails_when_it_persists(key, count):
    result = gate(evaluate(bundle(cycles=every_cycle({key: count}))), "publication")
    klass = key.rsplit(":", 1)[-1]
    assert result.outcome == "fail"
    assert result.reasons == (f"persistent_{klass}:{key}", f"frequent_{klass}:{key}")


def once(key, at=59):
    return tuple(
        cycle(20 * n, shadow(20 * n, counts={key: 1} if n == at else {})) for n in range(60)
    )


def test_an_unlisted_class_is_threshold_unowned_and_still_fails_when_persistent():
    novel = "facts:fact_vehicle_snapshot:novel"
    result = gate(evaluate(bundle(cycles=once(novel))), "publication")
    assert (result.outcome, result.reasons) == ("threshold_unowned", ("unowned_class:novel",))
    persistent = gate(evaluate(bundle(cycles=every_cycle({novel: 1}))), "publication")
    assert persistent.reasons == (f"persistent_novel:{novel}", f"frequent_novel:{novel}")


def test_a_restart_window_with_transient_unobserved_files_passes():
    # Live ruling 25a: after a restart the owner has not yet seen what the other reused.
    restarted = tuple(
        cycle(20 * n, shadow(20 * n, counts={"publication:unobserved": 3} if n < 3 else {}))
        for n in range(60)
    )
    result = gate(evaluate(bundle(cycles=restarted)), "publication")
    assert result.outcome == "pass", result.reasons
    assert result.details["transient"][0]["class"] == "unobserved"
    persistent = gate(
        evaluate(bundle(cycles=every_cycle({"publication:unobserved": 1}))), "publication"
    )
    assert persistent.reasons == (
        "persistent_unobserved:publication:unobserved",
        "frequent_unobserved:publication:unobserved",
    )


def test_a_single_columns_difference_fails_as_a_schema_difference():
    result = gate(
        evaluate(bundle(cycles=once("facts:fact_vehicle_snapshot:columns", at=10))), "publication"
    )
    assert (result.outcome, result.reasons) == (
        "fail",
        ("schema_columns:facts:fact_vehicle_snapshot",),
    )


def test_truncated_comparisons_are_uncompared_shadow_attributable_cycles():
    truncated = {"publication:truncated": 1, "publication:live/trips.json:representation": 9}
    cycles = tuple(
        cycle(20 * n, shadow(20 * n, counts=truncated if n % 15 == 0 else {})) for n in range(60)
    )
    result = gate(evaluate(bundle(cycles=cycles)), "publication")
    assert result.reasons == ("uncompared_cycle_share_exceeded",)
    assert result.details["shadow_attributable"] == {"comparison_truncated": 4}
    assert result.details["compared_cycles"] == 56
    assert result.details["uncompared_cycle_share"] == pytest.approx(4 / 60)


def test_ten_minutes_of_logs_cannot_admit_a_day():
    day = bundle(window_end=START + timedelta(hours=24), cycles=every_cycle({}, n=30))
    result = gate(evaluate(day), "publication")
    assert result.reasons == ("uncompared_cycle_share_exceeded",)
    assert result.details["coverage"]["expected_cycles"] == 4320
    assert result.details["shadow_attributable"] == {"shadow_evidence_missing": 4290}
    assert result.details["coverage"]["max_gap_seconds"] == pytest.approx(86400 - 580)
    nothing = gate(evaluate(bundle(cycles=())), "publication")
    assert (nothing.outcome, nothing.reasons) == ("unavailable", ("no_cycles_observed",))


def test_stm_ticks_with_nothing_due_are_excluded_from_the_share():
    def tick(n):
        if n % 6 in (2, 4):  # :20 and :40 — nothing due on STM's 10 s tick.
            return cycle(10 * n, None, attempted=0, tick=10.0)
        if n % 30 == 5:  # Every endpoint attempted, every one failed: public side.
            return cycle(10 * n, None, status="failed", attempted=2, tick=10.0)
        return cycle(10 * n, tick=10.0)

    stm = bundle(cycles=tuple(tick(n) for n in range(120)), tick_seconds=10)
    result = gate(evaluate(stm), "publication")
    assert result.outcome == "pass", result.reasons
    assert result.details["no_publication_due"] == 40
    assert result.details["public_side_failures"] == {"public_cycle_failed": 4}
    assert result.details["uncompared_cycle_share"] == 0.0


def test_shadow_attributable_share_fails_and_public_failures_are_excluded():
    mixed = [cycle(20 * n) for n in range(54)]
    public = [
        cycle(20 * n, shadow(20 * n, status="invalid", reason="public_publication_failed"))
        for n in range(54, 59)
    ]
    passing = gate(evaluate(bundle(cycles=(*mixed, *public, cycle(1180)))), "publication")
    assert passing.outcome == "pass"
    assert passing.details["public_side_failures"] == {"public_publication_failed": 5}
    refused = shadow(1160, status="refused", reason="shadow_admission_refused:rss_limit")
    worse = (*mixed[:-2], cycle(1040, refused), cycle(1060, None), *public[:-2], cycle(1180))
    failing = gate(evaluate(bundle(cycles=worse)), "publication")
    assert failing.reasons == ("uncompared_cycle_share_exceeded",)
    assert failing.details["shadow_attributable"] == {
        "shadow_admission_refused:rss_limit": 1,
        "shadow_evidence_missing": 3,
    }


def test_unadjudicated_key_fails_only_when_it_persists_to_the_end_of_the_window():
    def run(first, last):
        return tuple(
            cycle(20 * n, shadow(20 * n, counts={UNADJUDICATED: 2} if first <= n <= last else {}))
            for n in range(60)
        )

    # Persistence alone: the frequency rule (25b.1) is lifted out of the way here.
    only = Thresholds(intermittent_difference_share=1.0)
    persistent = gate(evaluate(bundle(cycles=run(29, 59)), only), "publication")
    assert persistent.reasons == (f"persistent_unadjudicated:{UNADJUDICATED}",)
    assert persistent.details["persistent"][0]["span_seconds"] == 600.0
    short = gate(evaluate(bundle(cycles=run(31, 59)), only), "publication")
    assert short.outcome == "pass"
    assert short.details["transient"][0]["count"] == 58
    healed = gate(evaluate(bundle(cycles=run(0, 58)), only), "publication")
    assert healed.outcome == "pass"
    assert healed.details["differences_by_class"] == {"unadjudicated": 118}


def adjudication(klass, *, start=START, end=START + WINDOW, math="cycle + 60 min"):
    return Adjudication(klass, math, start, end)


def test_class_b_corrections_are_methodology_items_and_class_a_is_an_engine_error():
    persistent = every_cycle({UNADJUDICATED: 1})
    corrected = evaluate(
        bundle(cycles=persistent, adjudications={UNADJUDICATED: adjudication("b")})
    )
    assert gate(corrected, "publication").outcome == "pass"
    [item] = corrected.display_dict()["methodology_items"]
    assert (item["key"], item["count"], item["cycles"], item["class"]) == (
        UNADJUDICATED,
        60,
        60,
        "b",
    )
    engine = evaluate(bundle(cycles=persistent, adjudications={UNADJUDICATED: adjudication("a")}))
    assert gate(engine, "publication").reasons == (f"engine_error:{UNADJUDICATED}",)


def test_an_adjudication_outside_its_validity_interval_reverts_to_unadjudicated():
    expired = adjudication("b", end=START + timedelta(minutes=5))
    result = gate(
        evaluate(
            bundle(cycles=every_cycle({UNADJUDICATED: 1}), adjudications={UNADJUDICATED: expired})
        ),
        "publication",
    )
    assert result.reasons == (
        f"persistent_unadjudicated:{UNADJUDICATED}",
        f"frequent_unadjudicated:{UNADJUDICATED}",
    )
    assert result.details["methodology_items"][0]["cycles"] == 15
    other_key = {"publication:live/network.json:unadjudicated": adjudication("b")}
    assert gate(
        evaluate(bundle(cycles=every_cycle({UNADJUDICATED: 1}), adjudications=other_key)),
        "publication",
    ).reasons == (
        f"persistent_unadjudicated:{UNADJUDICATED}",
        f"frequent_unadjudicated:{UNADJUDICATED}",
    )


def test_a_key_missing_every_other_cycle_fails_as_frequent_without_persisting():
    lost = "facts:fact_vehicle_snapshot:missing"
    alternating = tuple(
        cycle(20 * n, shadow(20 * n, counts={lost: 500} if n % 2 else {})) for n in range(60)
    )
    result = gate(evaluate(bundle(cycles=alternating)), "publication")
    assert result.reasons == (f"frequent_missing:{lost}",)
    assert result.details["persistent"] == []
    rare = tuple(
        cycle(20 * n, shadow(20 * n, counts={lost: 1} if n in (3, 17, 30, 44, 50) else {}))
        for n in range(60)
    )
    assert gate(evaluate(bundle(cycles=rare)), "publication").outcome == "pass"
    excused = {lost: adjudication("b")}
    assert gate(
        evaluate(bundle(cycles=alternating, adjudications=excused)), "publication"
    ).outcome == ("pass")


def test_an_adjudication_never_excuses_a_columns_difference():
    columns = "facts:fact_vehicle_snapshot:columns"
    result = gate(
        evaluate(bundle(cycles=once(columns, at=10), adjudications={columns: adjudication("b")})),
        "publication",
    )
    assert result.reasons == ("schema_columns:facts:fact_vehicle_snapshot",)
    assert result.details["methodology_items"] == []


def test_representation_and_clock_skew_differences_never_fail_by_themselves():
    counts = {
        "publication:live/network.json:representation": 3,
        "publication:live/trips.json:clock_skew": 2,
    }
    result = gate(evaluate(bundle(cycles=every_cycle(counts))), "publication")
    assert result.outcome == "pass"
    assert result.details["differences_by_class"] == {"clock_skew": 120, "representation": 180}


def test_unset_threshold_is_threshold_unowned():
    unset = Thresholds(max_uncompared_cycle_share=None)
    result = gate(evaluate(bundle(), unset), "publication")
    assert (result.outcome, result.reasons) == (
        "threshold_unowned",
        ("max_uncompared_cycle_share",),
    )


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
    assert (result.outcome, result.reasons) == (
        "unavailable",
        ("public_cycle_timing_unavailable",),
    )


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


def test_window_cpu_must_be_measured_over_the_window_and_fit_the_plan():
    absent = gate(evaluate(bundle(window_cpu=None)), "resources")
    assert (absent.outcome, absent.reasons) == ("unavailable", ("window_cpu_unavailable",))
    partial = window_cpu(start=START + timedelta(minutes=1))
    assert gate(evaluate(bundle(window_cpu=partial)), "resources").reasons == (
        "window_cpu_outside_window",
    )
    busy = gate(evaluate(bundle(window_cpu=window_cpu(2.0))), "resources")
    assert busy.reasons == (
        "observed_cpu_exceeds_plan:tenant.cpus: requires 3.0, ceiling 2.5",
        "window_cpu_above_worker_limit",
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

STAMP = "2026-11-20 00:00:00,000 INFO"


def worker_log(ticks, *, provider="stm", tick=10, idle=lambda n: n % 6 in (2, 4)):
    """A real-format worker log on STM's 10 s tick, idle at :20 and :40."""
    lines = []
    for n in range(ticks):
        at = START + timedelta(seconds=tick * n)
        lines.append(
            f"{STAMP} [transit_ops.orchestration] Starting realtime worker cycle {n + 1} "
            f"for provider '{provider}'."
        )
        if not idle(n):
            record = {
                "cycle": at.isoformat(),
                "role": "postgres_authoritative",
                "status": "compared",
                "reason": None,
                "identity": {"cycle": at.isoformat(), "edition": 7},
                "counts": {},
                "difference_total": 0,
                "samples": [],
                "shadow_seconds": 1.5,
                "capture_seconds": 0.25,
                "p95_seconds": 1.5,
                "rss_bytes": 700 * 2**20,
                "process_peak_rss_bytes": 750 * 2**20,
            }
            lines.append(f"{STAMP} [transit_ops.live.shadow] paired_shadow {json.dumps(record)}")
        result = {
            "provider_id": provider,
            "status": "succeeded",
            "started_at_utc": at.isoformat(),
            "successful_endpoint_count": 0 if idle(n) else 2,
            "failed_endpoint_count": 0,
        }
        timing = {
            "cycle_start_utc": at.isoformat(),
            "cycle_duration_seconds": 0.1 if idle(n) else 5.0,
            "requested_poll_seconds": float(tick),
        }
        lines += [
            f"{STAMP} [transit_ops.orchestration] Realtime worker cycle {n + 1} completed "
            f"successfully: {json.dumps(result)}",
            f"{STAMP} [transit_ops.orchestration] Realtime worker cycle {n + 1} timing: "
            f"{json.dumps(timing)}",
        ]
    return lines


def test_worker_log_becomes_cycles_inside_the_window_only():
    lines = worker_log(4) + [
        f"{STAMP} [transit_ops.orchestration] Starting realtime worker cycle 5 for provider 'stm'.",
        f"{STAMP} [transit_ops.orchestration] Realtime worker cycle 5 for provider 'stm' raised "
        "an unexpected exception and will be skipped",
        "Traceback (most recent call last):",
    ]
    end = START + timedelta(hours=1)
    cycles = read_worker_log(lines, provider_id="stm", start=START + timedelta(seconds=5), end=end)
    assert [(c.status, c.attempted_endpoints) for c in cycles] == [
        ("succeeded", 2),
        ("succeeded", 0),
        ("succeeded", 2),
        ("raised", None),
    ]
    assert cycles[0].shadow.capture_seconds == 0.25 and cycles[0].duration_seconds == 5.0
    assert cycles[0].requested_poll_seconds == 10.0
    assert cycles[1].shadow is None and not cycles[1].public_failed
    assert cycles[3].public_failed and cycles[3].shadow is None
    assert (
        read_worker_log(worker_log(4, provider="sto"), provider_id="stm", start=START, end=end)
        == ()
    )


def test_corrupt_shadow_evidence_is_refused_by_name_not_skipped():
    lines = worker_log(1)
    lines[1] = lines[1].replace('"status": "compared"', '"status": "maybe"')
    with pytest.raises(EvidenceInvalid, match="shadow_status_unknown"):
        read_worker_log(lines, provider_id="stm", start=START, end=START + timedelta(hours=1))


def files(tmp_path, *, log_lines, restarts=None, adjudications=None, cpu=None):
    log = tmp_path / "worker.log"
    log.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    restart_lines = restarts or [
        {
            "provider_id": "stm",
            "observed_at": (START + timedelta(seconds=30)).isoformat(),
            "point": "committed",
            "reopened": True,
            "reopen_seconds": 0.3,
            "wal_present": True,
            "refusal": None,
            "committed_rows_lost": 0,
            "verified_by": "durable_watermark",
        }
    ]
    paths = {"log": log}
    paths["restarts"] = tmp_path / "restarts.jsonl"
    paths["restarts"].write_text(
        "".join(json.dumps(line) + "\n" for line in restart_lines), encoding="utf-8"
    )
    peak = {
        "service": "worker-stm",
        "measurement_sha": SHA,
        "interval": "24h",
        "workload": "shadow",
        "complete": True,
        "gaps": [],
        "cpu_cores": 0.5,
        "container_memory_bytes": GIB,
        "process_rss_bytes": 800 * 2**20,
        "pid_peak": 50,
        "worker": True,
    }
    disk = {
        "items": [
            {
                "service": "worker-stm",
                "category": category,
                "occupied_bytes": 1000,
                "measurement_sha": SHA,
                "basis": "du",
                "measurement_kind": "occupied_bytes",
            }
            for category in DISK_CATEGORIES
        ],
        "reservations": {"worker-stm": 100_000},
    }
    paths["resources"] = tmp_path / "resources.json"
    paths["resources"].write_text(json.dumps({"peaks": [peak], "disk": disk}), encoding="utf-8")
    paths["cpu"] = tmp_path / "cpu.json"
    paths["cpu"].write_text(
        json.dumps(
            cpu
            or {
                "service": "worker-stm",
                "cpu_cores": 0.4,
                "start": START.isoformat(),
                "end": (START + timedelta(minutes=10)).isoformat(),
                "measurement_sha": SHA,
            }
        ),
        encoding="utf-8",
    )
    paths["adjudications"] = tmp_path / "adjudications.json"
    paths["adjudications"].write_text(json.dumps(adjudications or {}), encoding="utf-8")
    return paths


def arguments(paths, output, *, end=START + timedelta(minutes=10)):
    return [
        "live-engine",
        "admission",
        "--provider",
        "stm",
        "--log",
        str(paths["log"]),
        "--start",
        START.isoformat(),
        "--end",
        end.isoformat(),
        "--restarts",
        str(paths["restarts"]),
        "--resources",
        str(paths["resources"]),
        "--worker-service",
        "worker-stm",
        "--window-cpu",
        str(paths["cpu"]),
        "--adjudications",
        str(paths["adjudications"]),
        "--output",
        str(output),
    ]


def test_cli_admits_a_clean_stm_window_on_its_real_tick(tmp_path):
    assert worker_tick_seconds(load_provider_manifest(STM), 30) == 10
    paths = files(tmp_path, log_lines=worker_log(60))
    output = tmp_path / "verdict.json"
    result = CliRunner().invoke(app, arguments(paths, output))
    assert result.exit_code == 0, result.output
    verdict = json.loads(output.read_text(encoding="utf-8"))
    assert json.loads(result.stdout) == verdict
    assert verdict["outcome"] == "eligible"
    publication = verdict["gates"]["publication"]["details"]
    assert publication["no_publication_due"] == 20
    assert publication["coverage"]["expected_cycles"] == 60
    again = CliRunner().invoke(app, arguments(paths, output))
    assert again.exit_code == 2 and "exists" in again.output


def test_cli_without_restart_evidence_in_the_window_is_not_eligible(tmp_path):
    late = {
        "provider_id": "stm",
        "observed_at": (START + timedelta(hours=2)).isoformat(),
        "point": "committed",
        "reopened": True,
        "reopen_seconds": 0.3,
        "wal_present": True,
        "refusal": None,
        "committed_rows_lost": 0,
        "verified_by": "durable_watermark",
    }
    paths = files(tmp_path, log_lines=worker_log(60), restarts=[late])
    output = tmp_path / "verdict.json"
    result = CliRunner().invoke(app, arguments(paths, output))
    assert result.exit_code == 1, result.output
    verdict = json.loads(output.read_text(encoding="utf-8"))
    assert verdict["gates"]["recovery"]["reasons"] == ["restart_evidence_unavailable"]


def _without_duration(lines):
    return [
        line.replace('"cycle_duration_seconds": 5.0, ', "") if " timing: " in line else line
        for line in lines
    ]


def _reason_number(lines):
    return [line.replace('"reason": null', '"reason": 7') for line in lines]


@pytest.mark.parametrize(
    ("change", "what"),
    [
        ({"log_lines": _without_duration(worker_log(60))}, "cycle_timing"),
        ({"log_lines": _reason_number(worker_log(60))}, "shadow_reason"),
        ({"adjudications": {UNADJUDICATED: "b"}}, "adjudication"),
        ({"restarts": [7]}, "restart_record"),
    ],
)
def test_cli_malformed_evidence_exits_2_by_name(tmp_path, change, what):
    options = {"log_lines": worker_log(60), **change}
    paths = files(tmp_path, **options)
    output = tmp_path / "verdict.json"
    result = CliRunner().invoke(app, arguments(paths, output))
    assert result.exit_code == 2, result.output
    assert "evidence_malformed:" in result.output and what in result.output
    assert not output.exists()


def test_cli_refuses_the_same_cycles_from_two_files(tmp_path):
    paths = files(tmp_path, log_lines=worker_log(60))
    copy = tmp_path / "worker-copy.log"
    copy.write_bytes(paths["log"].read_bytes())
    output = tmp_path / "verdict.json"
    command = arguments(paths, output, end=START + timedelta(minutes=20))
    command[command.index("--log") + 1 : command.index("--log") + 1] = [str(copy), "--log"]
    result = CliRunner().invoke(app, command)
    assert result.exit_code == 2, result.output
    assert "evidence_malformed:duplicate_cycle" in result.output
    assert not output.exists()


@pytest.mark.parametrize("target", ["log", "restarts"])
def test_cli_text_that_is_not_utf8_exits_2_by_name(tmp_path, target):
    paths = files(tmp_path, log_lines=worker_log(60))
    paths[target].write_bytes(b"\xff\xfe not text\n")
    output = tmp_path / "verdict.json"
    result = CliRunner().invoke(app, arguments(paths, output))
    assert result.exit_code == 2, result.output
    assert f"evidence_malformed:not_utf8:{paths[target].name}" in result.output
    assert not output.exists()


def test_cli_configuration_errors_exit_2_by_name(tmp_path):
    paths = files(tmp_path, log_lines=worker_log(60))
    missing = tmp_path / "absent" / "verdict.json"
    result = CliRunner().invoke(app, arguments(paths, missing))
    assert result.exit_code == 2 and "output_directory_missing" in result.output
    providers = tmp_path / "providers"
    providers.mkdir()
    (providers / "stm.yaml").write_text("declaration: 2\nid: stm\n", encoding="utf-8")
    output = tmp_path / "verdict.json"
    result = CliRunner().invoke(app, [*arguments(paths, output), "--providers", str(providers)])
    assert result.exit_code == 2 and "provider_declaration_invalid" in result.output
    assert not output.exists()
