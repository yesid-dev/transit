"""The worker writes the admission gate's restart and window CPU evidence as by-products."""

import importlib.util
import json
import logging
from contextlib import closing
from datetime import timedelta
from functools import partial
from hashlib import sha256
from pathlib import Path

import pytest
from test_live_admission import START, arguments, files, worker_log
from test_live_admission_restart import run_until_death
from test_live_local_file import SETTINGS
from test_live_recording import MANIFEST, configured
from test_sample_transit_containers import fake_run
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.live import admission
from transit_ops.live.admission import (
    WORKER_REOPEN_POINT,
    EvidenceInvalid,
    WindowCpu,
    classify_restart,
    committed_rows,
    observe_restart,
    read_restart_records,
    recorded_reopen,
    restart_evidence_path,
    window_cpu_from_samples,
)
from transit_ops.live.local_file import LocalFileMismatch, LocalFileUnreadable
from transit_ops.live.recovery import open_worker_file
from transit_ops.live.watermark import write_committed_watermark
from transit_ops.live.worker_state import worker_state_scope

SAMPLER = Path(__file__).parents[1] / "scripts" / "sample_transit_containers.py"


def records(path):
    return read_restart_records(path.read_text(encoding="utf-8").splitlines())


def test_a_killed_workers_reopen_writes_records_the_gate_reads_and_classifies(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    committed = run_until_death(path, "committed")
    evidence = restart_evidence_path(path)
    clean = observe_restart(
        path,
        provider_id="network",
        settings=SETTINGS,
        committed=committed,
        point="committed",
        evidence=evidence,
    )
    # A simulated ruling 12 trigger: the dead process claims a row the file never had.
    ghost = {**committed, "fact_vehicle_snapshot": [*committed["fact_vehicle_snapshot"], '["x"]']}
    lost = observe_restart(
        path,
        provider_id="network",
        settings=SETTINGS,
        committed=ghost,
        point="ghost",
        evidence=evidence,
    )

    assert records(evidence) == (clean, lost)
    assert clean.wal_present and clean.observed_at.utcoffset() == timedelta(0)
    assert [classify_restart(r, 20) for r in records(evidence)] == [
        "recovered",
        "lost_committed_row",
    ]


def test_the_worker_reopen_records_itself_and_never_claims_an_unmeasured_loss(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    run_until_death(path, "committed")
    evidence = restart_evidence_path(path)
    with closing(
        open_worker_file(path, provider_id="network", settings=SETTINGS, restart_evidence=evidence)
    ) as local:
        assert committed_rows(local)["fact_vehicle_snapshot"]

    (record,) = records(evidence)
    assert (record.provider_id, record.point, record.reopened, record.wal_present) == (
        "network",
        WORKER_REOPEN_POINT,
        True,
        True,
    )
    assert record.reopen_seconds is not None and record.refusal is None
    # Nothing outside the file witnessed what the dead worker committed (#1142).
    assert record.committed_rows_lost is None
    assert classify_restart(record, 20) == "measurement_unavailable"


def test_a_failed_wal_replay_is_recorded_and_the_refusal_still_raised(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    path.write_bytes(b"not a duckdb file")
    Path(str(path) + ".wal").write_bytes(b"not a wal")
    evidence = restart_evidence_path(path)
    with pytest.raises(LocalFileUnreadable):
        open_worker_file(path, provider_id="network", settings=SETTINGS, restart_evidence=evidence)

    (record,) = records(evidence)
    assert (record.reopened, record.wal_present, record.refusal) == (
        False,
        True,
        "failed_wal_replay",
    )
    assert classify_restart(record, 20) == "failed_wal_replay"


def test_a_record_that_cannot_be_written_never_fails_the_reopen(tmp_path, caplog):
    path = tmp_path / "provider-network.duckdb"
    open_worker_file(path, provider_id="network", settings=SETTINGS).close()
    blocked = tmp_path / "blocked"
    blocked.mkdir()  # A directory cannot take an appended line.

    with caplog.at_level(logging.ERROR, logger="transit_ops.live.admission"):
        with closing(
            open_worker_file(
                path, provider_id="network", settings=SETTINGS, restart_evidence=blocked
            )
        ) as local:
            local.verify_shape()
    assert "live_restart_record_unwritable:" in caplog.text


def test_only_the_worker_loop_records_its_reopens_and_never_the_first_creation(tmp_path):
    settings = configured(tmp_path)
    evidence = restart_evidence_path(tmp_path / "provider-network.duckdb")
    scope = dict(settings=settings, engine=None, manifest=MANIFEST, resolver=None)
    with worker_state_scope(**scope, record_restart=True):
        pass
    assert not evidence.exists()
    with worker_state_scope(**scope):  # A one-shot cycle is not a worker restart.
        pass
    assert not evidence.exists()

    with worker_state_scope(**scope, record_restart=True):
        pass
    (record,) = records(evidence)
    assert (record.provider_id, record.point, record.reopened, record.refusal) == (
        "network",
        WORKER_REOPEN_POINT,
        True,
        None,
    )


def test_a_torn_last_line_is_closed_so_only_it_is_refused(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    open_worker_file(path, provider_id="network", settings=SETTINGS).close()
    evidence = restart_evidence_path(path)
    evidence.write_bytes(b'{"provider_id":"network","obs')  # A write cut short by a full disk.
    with closing(
        open_worker_file(path, provider_id="network", settings=SETTINGS, restart_evidence=evidence)
    ):
        pass

    lines = evidence.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    with pytest.raises(EvidenceInvalid, match="restart_record_json_invalid:line 1"):
        read_restart_records(lines)
    (record,) = read_restart_records(lines[1:])
    assert (record.point, record.reopened) == (WORKER_REOPEN_POINT, True)


def test_a_full_restart_file_stops_growing_and_says_so(tmp_path, monkeypatch, caplog):
    path = tmp_path / "provider-network.duckdb"
    open_worker_file(path, provider_id="network", settings=SETTINGS).close()
    evidence = restart_evidence_path(path)
    monkeypatch.setattr(admission, "RESTART_EVIDENCE_MAX_BYTES", 1)
    evidence.write_bytes(b"\n")
    with caplog.at_level(logging.ERROR, logger="transit_ops.live.admission"):
        open_worker_file(
            path, provider_id="network", settings=SETTINGS, restart_evidence=evidence
        ).close()
    assert evidence.read_bytes() == b"\n"
    assert "live_restart_record_file_full:1" in caplog.text


def test_a_refused_open_while_adoption_is_pending_is_recorded_by_name(tmp_path):
    path = tmp_path / "provider-network.duckdb"
    Path(str(path) + ".recovery-pending").write_bytes(b"{}")
    evidence = restart_evidence_path(path)
    with pytest.raises(LocalFileMismatch, match="recovery_adoption_pending"):
        open_worker_file(path, provider_id="network", settings=SETTINGS, restart_evidence=evidence)
    (record,) = records(evidence)
    assert (record.reopened, record.refusal) == (False, "recovery_adoption_pending")
    assert classify_restart(record, 20) == "recovery_adoption_pending"


# Window CPU from the merged #854 sampler's own output.


def sampler_rows(percents, *, service="worker", start=START - timedelta(minutes=1), **summary):
    """A small run in the sampler's JSONL shape: one row per minute, then its summary."""
    measured = [p for p in percents if isinstance(p, int | float)]
    rows = []
    for n, percent in enumerate(percents):
        at = (start + timedelta(minutes=n)).isoformat()
        for name, value in ((service, percent), ("postgres", 300.0)):
            rows.append(
                {
                    "kind": "sample",
                    "service": name,
                    "container": {"id": "a" * 64, "service": name},
                    "metrics": {"cpu_percent": value, "memory_bytes": 1.0},
                    "source": "docker stats MemUsage",
                    "utc": at,
                    "monotonic": 60.0 * n,
                }
            )
    rows.append(
        {
            "kind": "summary",
            "elapsed_seconds": 60.0 * len(percents),
            "interrupted": False,
            "outcome": 0,
            "services": {
                service: {
                    "samples": len(percents),
                    "errors": 0,
                    "restarts": 0,
                    "metrics": {"cpu_percent": {"max": max(measured, default=None)}},
                }
            },
        }
        | summary
    )
    return [json.dumps(row) for row in rows]


def test_the_merged_sampler_output_becomes_the_window_cpu_the_gate_parses():
    spec = importlib.util.spec_from_file_location("sampler", SAMPLER)
    sampler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sampler)
    run, _ = fake_run(sampler)
    rows, elapsed = [], [0.0]
    sampler.sample(
        "transit",
        180,
        60,
        rows.append,
        run,
        lambda: elapsed[0],
        lambda s: elapsed.__setitem__(0, elapsed[0] + s),
    )
    lines = [json.dumps(row) for row in rows]
    digest = sha256("".join(line + "\n" for line in lines).encode()).hexdigest()

    cpu = window_cpu_from_samples(lines, service="worker", measurement_sha=digest)
    assert cpu.cpu_cores == 1.25  # The fake Docker reports 125%.
    assert WindowCpu.from_dict(json.loads(json.dumps(cpu.display_dict()))) == cpu


@pytest.mark.parametrize(
    ("lines", "name"),
    [
        (sampler_rows([10.0, 20.0])[:-1], "summary_missing"),
        (sampler_rows([10.0, 20.0], outcome=130, interrupted=True), "incomplete:130"),
        (sampler_rows([10.0, 20.0], truncated=True), "truncated"),
        (sampler_rows([10.0, 20.0], service="health"), "service_unmeasured"),
        (sampler_rows([10.0, None]), "cpu_unmeasured"),
        (
            [*sampler_rows([10.0])[:-1], json.dumps({"kind": "gap", "missed": 2})]
            + sampler_rows([10.0])[-1:],
            "gap",
        ),
        (["{not json"], "json_invalid:line 1"),
        # Two runs joined with cat, 20 h apart: the time between them was never measured.
        (
            sampler_rows([10.0, 20.0])
            + sampler_rows([10.0, 20.0], start=START + timedelta(hours=20)),
            "multiple_runs",
        ),
        # A dropped sample row (the run's own peak was higher) disagrees with its summary.
        (
            sampler_rows([10.0, 90.0, 20.0])[:2] + sampler_rows([10.0, 90.0, 20.0])[4:],
            "summary_mismatch",
        ),
        (sampler_rows([10.0, "abc"]), "cpu_unmeasured"),
        (sampler_rows([10.0, True]), "cpu_unmeasured"),
        (
            [json.dumps({"kind": "error", "service": "worker", "reason": "missing stats row"})]
            + sampler_rows([10.0]),
            "reading_failed",
        ),
        (
            [json.dumps({"kind": "error", "reason": "Docker observation failed"})]
            + sampler_rows([10.0]),
            "reading_failed",
        ),
    ],
)
def test_a_sampler_run_that_did_not_measure_the_whole_window_is_refused_by_name(lines, name):
    with pytest.raises(EvidenceInvalid, match="window_cpu_samples_" + name):
        window_cpu_from_samples(lines, service="worker", measurement_sha="a" * 64)


def test_window_cpu_cli_writes_the_file_and_refuses_malformed_samples_by_name(tmp_path):
    samples = tmp_path / "samples.jsonl"
    samples.write_text("\n".join(sampler_rows([10.0, 45.0, 30.0])) + "\n", encoding="utf-8")
    output = tmp_path / "cpu.json"
    command = ["live-engine", "window-cpu", "--samples", str(samples), "--service", "worker"]

    result = CliRunner().invoke(app, [*command, "--output", str(output)])
    assert result.exit_code == 0, result.output
    cpu = WindowCpu.from_dict(json.loads(output.read_text(encoding="utf-8")))
    assert (cpu.service, cpu.cpu_cores) == ("worker", 0.45)
    assert (cpu.start, cpu.end) == (START - timedelta(minutes=1), START + timedelta(minutes=1))
    assert cpu.measurement_sha == sha256(samples.read_bytes()).hexdigest()
    again = CliRunner().invoke(app, [*command, "--output", str(output)])
    assert again.exit_code == 2 and "exists" in again.output

    samples.write_text("\n".join(sampler_rows([10.0], truncated=True)) + "\n", encoding="utf-8")
    refused = CliRunner().invoke(app, [*command, "--output", str(tmp_path / "other.json")])
    assert refused.exit_code == 2
    assert "evidence_malformed:window_cpu_samples_truncated" in refused.output
    assert not (tmp_path / "other.json").exists()

    samples.write_text("\n".join(sampler_rows([10.0, "abc"])) + "\n", encoding="utf-8")
    forged = CliRunner().invoke(app, [*command, "--output", str(tmp_path / "other.json")])
    assert forged.exit_code == 2
    assert "evidence_malformed:window_cpu_samples_cpu_unmeasured" in forged.output


# End to end: a generated log plus the two written files through the gate CLI.


def written_evidence(tmp_path, *, percents, lost_row=False, watermark=None):
    """Restart record from a real reopen; window CPU from sampler rows spanning the window.

    With ``watermark`` (True or False), the record is the worker's own reopen, with or
    without the committed watermark its last cycle wrote; otherwise a probe's handshake.
    """
    database = tmp_path / "provider-stm.duckdb"
    with closing(open_worker_file(database, provider_id="stm", settings=SETTINGS)) as local:
        committed = committed_rows(local)
        if watermark:
            assert write_committed_watermark(database, local, provider_id="stm", cycle_at=START)
    if lost_row:
        committed["meta"] = [*committed["meta"], '["x"]']
    evidence = restart_evidence_path(database)
    if watermark is not None:
        reopened = recorded_reopen(
            partial(open_worker_file, database, provider_id="stm", settings=SETTINGS),
            database,
            provider_id="stm",
            evidence=evidence,
            clock=lambda: START + timedelta(minutes=5),
        )
        reopened.close()
    else:
        observe_restart(
            database,
            provider_id="stm",
            settings=SETTINGS,
            committed=committed,
            point="worker_kill",
            evidence=evidence,
            clock=lambda: START + timedelta(minutes=5),
        )
    samples = tmp_path / "samples.jsonl"
    rows = sampler_rows(percents, service="worker-stm")
    samples.write_text("\n".join(rows) + "\n", encoding="utf-8")
    cpu = tmp_path / "written-cpu.json"
    result = CliRunner().invoke(
        app,
        [
            "live-engine",
            "window-cpu",
            "--samples",
            str(samples),
            "--service",
            "worker-stm",
            "--output",
            str(cpu),
        ],
    )
    assert result.exit_code == 0, result.output
    return evidence, cpu


def gate_with_written_evidence(tmp_path, **written):
    restarts, cpu = written_evidence(tmp_path, **written)
    paths = files(tmp_path, log_lines=worker_log(60)) | {"restarts": restarts, "cpu": cpu}
    output = tmp_path / "verdict.json"
    result = CliRunner().invoke(app, arguments(paths, output))
    return result, json.loads(output.read_text(encoding="utf-8"))


def test_the_gate_admits_a_window_from_written_restart_and_cpu_evidence(tmp_path):
    result, verdict = gate_with_written_evidence(tmp_path, percents=[20.0] * 13)
    assert result.exit_code == 0, result.output
    assert verdict["outcome"] == "eligible"
    assert verdict["gates"]["recovery"]["details"]["restarts"][0]["category"] == "recovered"
    assert verdict["gates"]["resources"]["details"]["window_cpu_cores"] == 0.2


def test_the_gate_admits_a_window_whose_worker_restart_its_watermark_verified(tmp_path):
    result, verdict = gate_with_written_evidence(tmp_path, percents=[20.0] * 13, watermark=True)
    assert result.exit_code == 0, result.output
    assert verdict["outcome"] == "eligible"
    (restart,) = verdict["gates"]["recovery"]["details"]["restarts"]
    assert (restart["point"], restart["verified_by"], restart["category"]) == (
        WORKER_REOPEN_POINT,
        "durable_watermark",
        "recovered",
    )


def test_a_worker_restart_without_its_watermark_keeps_the_window_ineligible(tmp_path):
    result, verdict = gate_with_written_evidence(tmp_path, percents=[20.0] * 13, watermark=False)
    assert result.exit_code == 1
    recovery = verdict["gates"]["recovery"]
    assert (recovery["outcome"], recovery["reasons"]) == (
        "unavailable",
        ["measurement_unavailable"],
    )


def test_the_gate_names_the_failure_in_written_evidence(tmp_path):
    result, verdict = gate_with_written_evidence(tmp_path, percents=[20.0] * 13, lost_row=True)
    assert result.exit_code == 1
    assert verdict["gates"]["recovery"]["reasons"] == ["ruling_12:lost_committed_row"]
    assert verdict["ruling_12_triggers"] == ["lost_committed_row"]


def test_the_gate_refuses_a_window_cpu_above_the_worker_limit(tmp_path):
    result, verdict = gate_with_written_evidence(tmp_path, percents=[20.0] * 12 + [400.0])
    assert result.exit_code == 1
    assert "window_cpu_above_worker_limit" in verdict["gates"]["resources"]["reasons"]


def test_a_cpu_measurement_that_ends_before_the_window_is_unavailable(tmp_path):
    result, verdict = gate_with_written_evidence(tmp_path, percents=[20.0] * 5)
    assert result.exit_code == 1
    resources = verdict["gates"]["resources"]
    assert (resources["outcome"], resources["reasons"]) == (
        "unavailable",
        ["window_cpu_outside_window"],
    )
