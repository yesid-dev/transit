"""LS3.15b: render admitted limits into an opt-in Compose override."""

from __future__ import annotations

import hashlib
import json
import math
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

import transit_ops.operations.compose_limits as compose_limits
from transit_ops.cli import app
from transit_ops.operations.compose_limits import (
    ComposeLimitsRefused,
    parse_evidence,
    parse_json_document,
    parse_worker_bindings,
    render_compose_limits,
    render_json,
)
from transit_ops.operations.resource_plan import (
    DISK_CATEGORIES,
    ResourceEvidenceMissing,
    plan_resources,
)

DB_ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = DB_ROOT / "docker-compose.yml"
WORKERS = {"octranspo-worker": "octranspo", "worker": "stm"}
DISK_BYTES = {
    "database": 1_000_000,
    "wal_checkpoints": 200_000,
    "edition_overlap": 100_000,
    "pending_segments": 100_000,
    "capture_spool": 100_000,
    "duckdb_temp": 4_000_000,
    "status": 2_000,
    "ingress_data": 1_000,
    "rotated_logs": 1_000,
}
RESERVATION = 9_000_000
runner = CliRunner()


def base_compose() -> dict:
    return yaml.safe_load(COMPOSE_FILE.read_text(encoding="utf-8"))


def services() -> list[str]:
    return sorted(base_compose()["services"])


def sha(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8")).hexdigest()


def peak(service: str, *, worker: bool = False, **changes) -> dict:
    sample = {
        "service": service,
        "measurement_sha": sha(service),
        "interval": "transition pilot interval",
        "workload": "busy-hour replay",
        "complete": True,
        "gaps": [],
        "cpu_cores": 0.1,
        "container_memory_bytes": 4_000_000,
        "process_rss_bytes": 2_000_000 if worker else None,
        "pid_peak": 8,
        "worker": worker,
    }
    sample.update(changes)
    return sample


def evidence_payload(names: list[str] | None = None, **changes) -> dict:
    measured = services() if names is None else names
    payload = {
        "peaks": [peak(name, worker=name in WORKERS) for name in measured],
        "disk": {
            "items": [
                {
                    "service": name,
                    "category": category,
                    "occupied_bytes": DISK_BYTES[category],
                    "measurement_sha": sha(f"{name}.{category}"),
                    "basis": f"du -sb {name}/{category}",
                    "measurement_kind": "occupied_bytes",
                }
                for name in measured
                for category in DISK_CATEGORIES
            ],
            "reservations": {name: RESERVATION for name in measured},
        },
    }
    payload.update(changes)
    return payload


def render(compose=None, evidence=None, bindings=None) -> dict:
    peaks, disk = parse_evidence(evidence if evidence is not None else evidence_payload())
    return render_compose_limits(
        base_compose() if compose is None else compose,
        peaks=peaks,
        disk=disk,
        worker_bindings=WORKERS if bindings is None else bindings,
    )


def merge_volumes(compose: dict, override: dict, service: str) -> dict[str, str]:
    """Model Compose's service merge: volumes are keyed by container target."""

    merged: dict[str, str] = {}
    chain = []
    current = service
    while current is not None:
        definition = compose["services"][current]
        chain.append(definition)
        extends = definition.get("extends")
        current = extends if isinstance(extends, str) else None
    for definition in reversed(chain):
        for item in definition.get("volumes") or []:
            source, target = item.split(":")
            merged[target] = source
    for item in (override["services"].get(service) or {}).get("volumes") or []:
        source, target = item.split(":")
        merged[target] = source
    return merged


def test_transition_services_admit_then_render_exact_limits():
    compose = base_compose()
    transition = services()
    assert len(transition) == 7
    peaks, disk = parse_evidence(evidence_payload())
    plan = plan_resources(peaks, disk=disk, concurrent_services=tuple(transition))

    rendered = render(compose)
    # Only measured workers are configured; every base service took part in admission.
    assert sorted(rendered["services"]) == sorted(WORKERS)
    worker = rendered["services"]["worker"]
    assert worker["cpus"] == 0.15
    assert worker["mem_limit"] == 6_000_000
    assert worker["memswap_limit"] == 6_000_000
    assert worker["pids_limit"] == 12
    storage = json.loads(worker["environment"]["LIGHTER_STORAGE"])
    assert storage == {
        "live": {
            "local_dir": "/app/data/live",
            "duckdb_memory_limit_mb": 3,
            "duckdb_threads": 1,
            "temp_dir_max_mb": 6,
        }
    }
    proof = rendered["x-transit-resource-plan"]
    assert proof["concurrent_services"] == transition
    assert proof["total"] == {
        "cpus": 1.05,
        "memory_bytes": 42_000_000,
        "disk_budget_bytes": 63_000_000,
    }
    assert proof["headroom"] == {
        "cpus": 1.45,
        "memory_bytes": 8_547_934_592,
        "disk_budget_bytes": 31_937_000_000,
    }
    assert proof["total"] == {
        "cpus": plan.total.cpus,
        "memory_bytes": plan.total.memory_bytes,
        "disk_budget_bytes": plan.total.disk_budget_bytes,
    }
    assert proof["source_proof_hashes"] == sorted(plan.source_proof_hashes)
    assert proof["limits"]["postgres"] == {
        "cpus": 0.15,
        "memory_bytes": 6_000_000,
        "memswap_bytes": 6_000_000,
        "pids_limit": 12,
    }
    assert proof["reservations"]["worker"]["disk_budget_bytes"] == RESERVATION
    assert proof["reservations"]["worker"]["duckdb_memory_mb"] == 3
    assert proof["reservations"]["worker"]["temp_dir_max_mb"] == 6


def test_admission_receives_original_evidence_and_every_base_service(monkeypatch):
    peaks, disk = parse_evidence(evidence_payload())
    seen = {}
    real = compose_limits.plan_resources

    def spy(passed_peaks, *, disk, concurrent_services):  # type: ignore[no-untyped-def]
        seen["peaks"] = passed_peaks
        seen["disk"] = disk
        seen["names"] = concurrent_services
        return real(passed_peaks, disk=disk, concurrent_services=concurrent_services)

    monkeypatch.setattr(compose_limits, "plan_resources", spy)
    render_compose_limits(base_compose(), peaks=peaks, disk=disk, worker_bindings=WORKERS)
    assert tuple(seen["peaks"]) == tuple(peaks)
    assert seen["disk"] is disk
    assert tuple(seen["names"]) == tuple(services())


@pytest.mark.parametrize(
    "evidence",
    [
        evidence_payload(services()[:2]),
        evidence_payload(services() + ["shadow"]),
    ],
)
def test_missing_or_extra_measurement_refuses(evidence):
    with pytest.raises(ResourceEvidenceMissing, match="concurrent_services"):
        render(evidence=evidence)


@pytest.mark.parametrize(
    "changes,error,match",
    [
        ({"measurement_sha": "short"}, ResourceEvidenceMissing, "measurement_sha"),
        ({"complete": False}, ResourceEvidenceMissing, "coverage"),
        ({"gaps": ["missed sample"]}, ResourceEvidenceMissing, "coverage"),
        ({"cpu_cores": 0}, ResourceEvidenceMissing, "cpu_cores"),
        ({"pid_peak": 1.5}, ResourceEvidenceMissing, "pid_peak"),
    ],
)
def test_incomplete_or_unmeasured_evidence_refuses(changes, error, match):
    evidence = evidence_payload()
    evidence["peaks"][0].update(changes)
    with pytest.raises(error, match=match):
        render(evidence=evidence)


def test_missing_disk_measurement_or_reservation_refuses():
    missing = evidence_payload()
    missing["disk"]["items"].pop()
    with pytest.raises(ResourceEvidenceMissing):
        render(evidence=missing)
    unclaimed = evidence_payload()
    unclaimed["disk"]["reservations"].pop(next(iter(unclaimed["disk"]["reservations"])))
    with pytest.raises(ResourceEvidenceMissing, match="reservations"):
        render(evidence=unclaimed)


def test_pilot_unresolved_refuses_the_render():
    evidence = evidence_payload()
    for sample in evidence["peaks"]:
        if sample["worker"]:
            sample["process_rss_bytes"] = None
    with pytest.raises(ComposeLimitsRefused, match="pilot unresolved.*process_rss_bytes"):
        render(evidence=evidence)


@pytest.mark.parametrize(
    "bindings,match",
    [
        ({"worker": "stm"}, "missing measured workers"),
        ({**WORKERS, "pruner": "pruner"}, "unexpected"),
        ({"worker": "stm", "octranspo-worker": "stm"}, "also binds"),
        ({"worker": "STM", "octranspo-worker": "octranspo"}, "unsafe provider id"),
        ({"worker": "../etc", "octranspo-worker": "octranspo"}, "unsafe provider id"),
        ({"worker": "", "octranspo-worker": "octranspo"}, "unsafe provider id"),
    ],
)
def test_worker_bindings_must_be_measured_unique_and_safe(bindings, match):
    with pytest.raises(ComposeLimitsRefused, match=match):
        render(bindings=bindings)


def test_provider_bindings_must_be_strings():
    with pytest.raises(ComposeLimitsRefused, match="provider id string required"):
        parse_worker_bindings({"worker": 1})


def test_two_workers_get_distinct_volumes_at_the_same_target_and_keep_bronze():
    compose = base_compose()
    override = render(compose)
    assert override["volumes"] == {"transit_live_octranspo": None, "transit_live_stm": None}
    targets = set()
    for name in WORKERS:
        mounts = override["services"][name]["volumes"]
        assert len(mounts) == 1
        source, target = mounts[0].split(":")
        assert target == "/app/data/live"
        targets.add(target)
    assert targets == {"/app/data/live"}
    stm = merge_volumes(compose, override, "worker")
    octranspo = merge_volumes(compose, override, "octranspo-worker")
    # Compose keys volumes by target; the child's live target replaces the parent's.
    assert stm["/app/data/bronze"] == "bronze_data"
    assert stm["/app/data/live"] == "transit_live_stm"
    assert octranspo["/app/data/bronze"] == "bronze_data"
    assert octranspo["/app/data/live"] == "transit_live_octranspo"
    assert "transit_live_stm" not in octranspo.values()


def test_common_target_replaces_inherited_local_state_and_a_differing_target_leaks():
    compose = {
        "services": {
            "worker": {
                "volumes": ["bronze_data:/app/data/bronze", "transit_live_stm:/app/data/live"]
            },
            "octranspo-worker": {"extends": "worker"},
        }
    }
    override = render(compose, evidence=evidence_payload(["octranspo-worker", "worker"]))
    merged = merge_volumes(compose, override, "octranspo-worker")
    assert merged["/app/data/bronze"] == "bronze_data"
    assert merged["/app/data/live"] == "transit_live_octranspo"
    # A differing target would keep the parent's STM volume beside the child's.
    leaky = deepcopy(override)
    leaky["services"]["octranspo-worker"]["volumes"] = ["transit_live_octranspo:/app/data/live-own"]
    leaked = merge_volumes(compose, leaky, "octranspo-worker")
    assert leaked["/app/data/live"] == "transit_live_stm"
    assert leaked["/app/data/live-own"] == "transit_live_octranspo"


def test_compatible_and_incompatible_volume_declarations():
    compose = base_compose()
    compose["volumes"] = {"transit_live_stm": None}
    assert render(compose)["volumes"]["transit_live_stm"] is None
    compose["volumes"] = {"transit_live_stm": {"external": True}}
    with pytest.raises(ComposeLimitsRefused, match="incompatible existing definition"):
        render(compose)
    compose["volumes"] = {"transit_live_octranspo": {"driver": "local"}}
    with pytest.raises(ComposeLimitsRefused, match="incompatible existing definition"):
        render(compose)


def test_only_lighter_storage_is_added_and_unrelated_settings_survive():
    compose = {
        "services": {
            "worker": {
                "environment": {
                    "PGAPPNAME": "transit-worker",
                    "PGPASSWORD": "${POSTGRES_PASSWORD:?required}",
                    "LIGHTER_STORAGE": json.dumps(
                        {
                            "copy_out": {"batch_rows": 5000},
                            "live": {"duckdb_threads": 8, "recording_mode": "opaque"},
                        }
                    ),
                }
            },
            "octranspo-worker": {
                "extends": "worker",
                "environment": {
                    "OCTRANSPO_API_KEY": "${OCTRANSPO_API_KEY:-}",
                    "LIGHTER_STORAGE": json.dumps(
                        {"copy_out": {"batch_rows": 7000}, "live": {"duckdb_threads": 2}}
                    ),
                },
            },
        }
    }
    evidence = evidence_payload(["octranspo-worker", "worker"])
    override = render(compose, evidence=evidence)
    for name in WORKERS:
        assert set(override["services"][name]["environment"]) == {"LIGHTER_STORAGE"}
    stm_lanes = json.loads(override["services"]["worker"]["environment"]["LIGHTER_STORAGE"])
    assert stm_lanes["copy_out"] == {"batch_rows": 5000}
    assert stm_lanes["live"] == {
        "local_dir": "/app/data/live",
        "duckdb_memory_limit_mb": 3,
        "duckdb_threads": 1,
        "temp_dir_max_mb": 6,
        "recording_mode": "opaque",
    }
    # Environment merging is per KEY: the child's own JSON replaces the parent's.
    octranspo_lanes = json.loads(
        override["services"]["octranspo-worker"]["environment"]["LIGHTER_STORAGE"]
    )
    assert octranspo_lanes == {
        "copy_out": {"batch_rows": 7000},
        "live": {
            "local_dir": "/app/data/live",
            "duckdb_memory_limit_mb": 3,
            "duckdb_threads": 1,
            "temp_dir_max_mb": 6,
        },
    }
    emitted = render_json(override)
    for secret in (
        "${POSTGRES_PASSWORD",
        "PGPASSWORD",
        "PGAPPNAME",
        "OCTRANSPO_API_KEY",
        "transit-worker",
    ):
        assert secret not in emitted


def test_environment_list_form_and_key_level_child_override():
    compose = {
        "services": {
            "parent": {"environment": ["LIGHTER_STORAGE={\"live\":{\"duckdb_threads\":4}}"]},
            "worker": {"extends": {"service": "parent"}, "environment": ["PGAPPNAME=child"]},
        }
    }
    evidence = evidence_payload(["parent", "worker"])
    rendered = render(compose, evidence=evidence, bindings={"worker": "stm"})
    lanes = json.loads(rendered["services"]["worker"]["environment"]["LIGHTER_STORAGE"])
    assert lanes["live"]["duckdb_threads"] == 1
    assert rendered["services"]["worker"]["environment"].keys() == {"LIGHTER_STORAGE"}


@pytest.mark.parametrize(
    "compose,match",
    [
        (
            {
                "services": {
                    "worker": {"extends": "loop"},
                    "loop": {"extends": "worker"},
                }
            },
            "inheritance cycle",
        ),
        ({"services": {"worker": {"extends": {"file": "other.yml", "service": "base"}}}},
         "external Compose files"),
        ({"services": {"worker": {"extends": "missing"}}}, "unknown service"),
        (
            {"services": {"worker": {"environment": {"LIGHTER_STORAGE": "${LIVE_JSON}"}}}},
            "unresolved placeholder",
        ),
        (
            {
                "services": {
                    "worker": {
                        "environment": {
                            "LIGHTER_STORAGE": json.dumps({"live": {"local_dir": "$LIVE"}})
                        }
                    }
                }
            },
            "unresolved placeholder",
        ),
        (
            {"services": {"worker": {"environment": ["LIGHTER_STORAGE"]}}},
            "host reference is unresolvable",
        ),
    ],
)
def test_unresolvable_extends_and_placeholders_refuse(compose, match):
    names = sorted(compose["services"])
    with pytest.raises(ComposeLimitsRefused, match=match):
        render(compose, evidence=evidence_payload(names), bindings={"worker": "stm"})


def test_decimal_mb_floor_and_admitted_threads():
    compose = {"services": {"worker": {}}}
    evidence = evidence_payload(["worker"])
    evidence["peaks"][0].update(cpu_cores=1.0, container_memory_bytes=4_000_000)
    rendered = render(compose, evidence=evidence, bindings={"worker": "stm"})
    storage = json.loads(rendered["services"]["worker"]["environment"]["LIGHTER_STORAGE"])
    assert rendered["services"]["worker"]["cpus"] == 1.5
    assert rendered["services"]["worker"]["mem_limit"] == 6_000_000
    # 3.6 decimal MB floors to 3, never 4 MiB-ish rounding up.
    assert storage["live"]["duckdb_memory_limit_mb"] == 3
    assert storage["live"]["duckdb_threads"] == 2
    assert storage["live"]["temp_dir_max_mb"] == 6
    assert rendered["x-transit-resource-plan"]["reservations"]["worker"]["threads"] == 2


def test_below_one_decimal_mb_refuses():
    compose = {"services": {"worker": {}}}
    evidence = evidence_payload(["worker"])
    evidence["peaks"][0]["container_memory_bytes"] = 1_000_000
    with pytest.raises(ComposeLimitsRefused, match="duckdb_memory_limit_mb.*below one decimal MB"):
        render(compose, evidence=evidence, bindings={"worker": "stm"})
    tiny_temp = evidence_payload(["worker"])
    for item in tiny_temp["disk"]["items"]:
        item["occupied_bytes"] = 1
    with pytest.raises(ComposeLimitsRefused, match="temp_dir_max_mb.*below one decimal MB"):
        render(compose, evidence=tiny_temp, bindings={"worker": "stm"})


@pytest.mark.parametrize(
    "changes,match",
    [
        ({"cpus": 0.0}, "cpus"),
        ({"cpus": math.nan}, "cpus"),
        ({"cpus": 1}, "cpus"),
        ({"memory_bytes": 0, "memswap_bytes": 0}, "memory_bytes"),
        ({"memswap_bytes": 1}, "memswap_bytes"),
        ({"pids_limit": 0}, "pids_limit"),
        ({"threads": 0}, "threads"),
    ],
)
def test_zero_or_unrepresentable_admitted_limits_refuse(monkeypatch, changes, match):
    real = compose_limits.plan_resources

    def fake(*args, **kwargs):  # type: ignore[no-untyped-def]
        plan = real(*args, **kwargs)
        limit = replace(plan.services["worker"], **changes)
        return replace(plan, services={**plan.services, "worker": limit})

    monkeypatch.setattr(compose_limits, "plan_resources", fake)
    with pytest.raises(ComposeLimitsRefused, match=match):
        render({"services": {"worker": {}}}, evidence=evidence_payload(["worker"]),
               bindings={"worker": "stm"})


def test_evidence_json_types_are_not_coerced():
    for changes, match in (
        ({"complete": 1}, "complete: boolean required"),
        ({"complete": "true"}, "complete: boolean required"),
        ({"worker": "yes"}, "worker: boolean required"),
        ({"cpu_cores": "0.2"}, "cpu_cores: JSON number required"),
        ({"pid_peak": "8"}, "pid_peak: JSON number required"),
        ({"cpu_cores": True}, "cpu_cores: JSON number required"),
    ):
        evidence = evidence_payload(["worker"])
        evidence["peaks"][0].update(changes)
        with pytest.raises(ComposeLimitsRefused, match=match):
            render({"services": {"worker": {}}}, evidence=evidence, bindings={"worker": "stm"})


def test_unknown_and_missing_evidence_fields_refuse():
    unknown = evidence_payload(["worker"])
    unknown["peaks"][0]["limits"] = {"cpus": 2}
    with pytest.raises(ComposeLimitsRefused, match="unknown fields \\['limits'\\]"):
        parse_evidence(unknown)
    missing = evidence_payload(["worker"])
    missing["peaks"][0].pop("pid_peak")
    with pytest.raises(ComposeLimitsRefused, match="missing fields \\['pid_peak'\\]"):
        parse_evidence(missing)
    extra = evidence_payload(["worker"])
    extra["budget"] = {}
    with pytest.raises(ComposeLimitsRefused, match="unknown fields \\['budget'\\]"):
        parse_evidence(extra)
    with pytest.raises(ComposeLimitsRefused, match="duplicate JSON key 'peaks'"):
        parse_json_document('{"peaks": [], "peaks": []}', "evidence")
    with pytest.raises(ComposeLimitsRefused, match="malformed JSON"):
        parse_json_document("{", "evidence")


def test_output_is_deterministic_and_round_trips_through_json_and_yaml():
    compose = base_compose()
    evidence = evidence_payload()
    first = render(compose, evidence=evidence)
    second = render(compose, evidence=evidence)
    assert render_json(first) == render_json(second)
    text = render_json(first)
    assert text.endswith("\n")
    assert json.loads(text) == first
    assert yaml.safe_load(text) == first
    assert (
        text.index('"services"') < text.index('"volumes"') < text.index('"x-transit-resource-plan"')
    )


def test_inputs_are_not_mutated():
    compose = base_compose()
    compose_before = deepcopy(compose)
    evidence = evidence_payload()
    evidence_before = deepcopy(evidence)
    peaks, disk = parse_evidence(evidence)
    assert evidence == evidence_before
    peaks_before = tuple(peaks)
    disk_before = deepcopy(disk)
    render_compose_limits(compose, peaks=peaks, disk=disk, worker_bindings=WORKERS)
    assert compose == compose_before
    assert evidence == evidence_before
    assert tuple(peaks) == peaks_before
    assert disk == disk_before


def cli_args(tmp_path: Path, evidence: object, bindings: object | None = None) -> list[str]:
    compose_path = tmp_path / "compose.yml"
    compose_path.write_text(COMPOSE_FILE.read_text(encoding="utf-8"), encoding="utf-8")
    evidence_path = tmp_path / "evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    bindings_path = tmp_path / "bindings.json"
    bindings_path.write_text(
        json.dumps(WORKERS if bindings is None else bindings), encoding="utf-8"
    )
    return [
        "lake-ops",
        "render-compose-limits",
        "--compose",
        str(compose_path),
        "--evidence",
        str(evidence_path),
        "--worker-bindings",
        str(bindings_path),
    ]


def test_public_command_prints_one_json_artifact(tmp_path):
    result = runner.invoke(app, cli_args(tmp_path, evidence_payload()))
    assert result.exit_code == 0, result.output
    document = json.loads(result.stdout)
    assert document == render(evidence=evidence_payload())
    assert "Usage:" not in result.stdout
    assert result.stdout.count('"x-transit-resource-plan"') == 1


def test_public_command_refuses_truthfully(tmp_path):
    failure = evidence_payload()
    failure["peaks"] = failure["peaks"][:1]
    result = runner.invoke(app, cli_args(tmp_path, failure))
    assert result.exit_code == 1
    assert result.stdout == ""
    assert "refused:" in result.stderr
    assert "concurrent_services" in result.stderr
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    args = cli_args(tmp_path, evidence_payload())
    args[args.index("--evidence") + 1] = str(bad)
    refused = runner.invoke(app, args)
    assert refused.exit_code == 1
    assert refused.stdout == ""
    assert "malformed JSON" in refused.stderr


def test_bare_lane_still_prints_help():
    result = runner.invoke(app, ["lake-ops"])
    assert result.exit_code == 0
    assert "Usage:" in result.stdout
    help_result = runner.invoke(app, ["lake-ops", "--help"])
    assert help_result.exit_code == 0
    assert "render-compose-limits" in help_result.stdout
