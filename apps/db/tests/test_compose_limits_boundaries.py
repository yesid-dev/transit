"""Regression cases from the LS3.15b boundary review."""

import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from test_compose_limits import (
    WORKERS,
    base_compose,
    cli_args,
    compose_limits,
    evidence_payload,
    render,
)

from transit_ops.operations.compose_limits import ComposeLimitsRefused, parse_compose_yaml


def console(tmp_path, args, **environment):
    env = os.environ.copy()
    env.update(environment)
    executable = Path(sys.executable).with_name(
        "transit-ops.exe" if os.name == "nt" else "transit-ops"
    )
    return subprocess.run(
        [str(executable), *args],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize("source", ["process", "dotenv"])
def test_fresh_console_ignores_unrelated_runtime_settings(tmp_path, source):
    args = cli_args(tmp_path, evidence_payload())
    env = {}
    if source == "process":
        env["REALTIME_POLL_SECONDS"] = "invalid-boundary-value"
    else:
        (tmp_path / ".env").write_text("REALTIME_POLL_SECONDS=invalid-boundary-value\n")
    result = console(tmp_path, args, **env)
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
    assert set(json.loads(result.stdout)["services"]) == set(base_compose()["services"])


@pytest.mark.parametrize("location", ["direct", "inherited", "child"])
def test_null_storage_reference_refuses(location):
    compose = base_compose()
    if location != "child":
        compose["services"]["worker"]["environment"]["LIGHTER_STORAGE"] = None
    if location == "child":
        compose["services"]["octranspo-worker"]["environment"]["LIGHTER_STORAGE"] = None
    bindings = WORKERS if location != "inherited" else {"octranspo-worker": "octranspo"}
    evidence = evidence_payload()
    if location == "inherited":
        next(p for p in evidence["peaks"] if p["service"] == "worker")["worker"] = False
    with pytest.raises(ComposeLimitsRefused, match="host reference"):
        render(compose, evidence=evidence, bindings=bindings)


@pytest.mark.parametrize("changes", [{"memory_bytes": 0, "memswap_bytes": 0}, {"pids_limit": 0}])
def test_nonworker_zero_limits_refuse(monkeypatch, changes):
    real = compose_limits.plan_resources

    def changed(*args, **kwargs):
        plan = real(*args, **kwargs)
        return replace(
            plan,
            services={**plan.services, "postgres": replace(plan.services["postgres"], **changes)},
        )

    monkeypatch.setattr(compose_limits, "plan_resources", changed)
    with pytest.raises(ComposeLimitsRefused, match="postgres"):
        render()


@pytest.mark.parametrize("service", sorted(base_compose()["services"]))
@pytest.mark.parametrize("peak,accepted", [(4_194_303, False), (4_194_304, True)])
def test_linux_memory_minimum_for_every_service(service, peak, accepted):
    evidence = evidence_payload()
    next(p for p in evidence["peaks"] if p["service"] == service)["container_memory_bytes"] = peak
    if accepted:
        assert render(evidence=evidence)["services"][service]["mem_limit"] == 6_291_456
    else:
        with pytest.raises(ComposeLimitsRefused, match="memory_bytes.*6291456"):
            render(evidence=evidence)


@pytest.mark.parametrize("value", [True, False, 1.0, "9000000", "wrong", [], {}, None])
def test_console_reservation_types_refuse_without_traceback(tmp_path, value):
    evidence = evidence_payload()
    evidence["disk"]["reservations"]["postgres"] = value
    result = console(tmp_path, cli_args(tmp_path, evidence))
    assert result.returncode == 1
    assert result.stdout == ""
    assert "refused:" in result.stderr
    assert "reservations.postgres" in result.stderr
    assert "Traceback" not in result.stderr


@pytest.mark.parametrize(
    "parent,match",
    [
        ({"file": "external.yml", "service": "base"}, "external Compose"),
        ("missing", "unknown service"),
        ("octranspo-pruner", "inheritance cycle"),
    ],
)
def test_nonworker_inheritance_refuses(parent, match):
    compose = base_compose()
    compose["services"]["pruner"]["extends"] = parent
    with pytest.raises(ComposeLimitsRefused, match=match):
        render(compose)


def test_valid_nonworker_inheritance_accepts():
    compose = base_compose()
    compose["services"]["health"]["extends"] = "pruner"
    assert "environment" not in render(compose)["services"]["health"]


@pytest.mark.parametrize(
    "text",
    [
        "services: {worker: {}}\nservices: {worker: {}}\n",
        "services:\n  worker: {}\n  worker: {}\n",
        (
            "services:\n  worker:\n    environment:\n"
            "      LIGHTER_STORAGE: '{}'\n      LIGHTER_STORAGE: '{}'\n"
        ),
        '{"services":{"worker":{}},"services":{"worker":{}}}',
        '{"services":{"worker":{},"worker":{}}}',
        '{"services":{"worker":{"environment":{"LIGHTER_STORAGE":"{}","LIGHTER_STORAGE":"{}"}}}}',
        "services: {worker: !!python/object:builtins.object {}}",
    ],
)
def test_console_ambiguous_or_unsafe_compose_refuses(tmp_path, text):
    args = cli_args(tmp_path, evidence_payload(["worker"]), {"worker": "stm"})
    Path(args[args.index("--compose") + 1]).write_text(text, encoding="utf-8")
    result = console(tmp_path, args)
    assert result.returncode == 1
    assert result.stdout == ""
    assert "refused:" in result.stderr
    assert "compose:" in result.stderr
    assert "Traceback" not in result.stderr


def test_yaml_merges_allow_explicit_override_and_sequence_precedence():
    document = parse_compose_yaml("""
x-first: &first {image: first, restart: always}
x-second: &second {image: second}
services:
  worker:
    <<: [*first, *second]
    image: explicit
  other:
    <<: [*first, *second]
""")
    assert document["services"]["worker"] == {"image": "explicit", "restart": "always"}
    assert document["services"]["other"]["image"] == "first"


def test_nested_merge_anchor_keeps_explicit_overrides():
    document = parse_compose_yaml("""
x-base: &base {image: original}
x-child: &child {<<: *base, image: child}
services:
  worker: {<<: *child}
""")
    assert document["services"]["worker"]["image"] == "child"


@pytest.mark.parametrize("reference", [None, ["LIGHTER_STORAGE"]])
def test_child_storage_key_replaces_unresolved_parent(reference):
    compose = base_compose()
    compose["services"]["worker"]["environment"] = (
        {"LIGHTER_STORAGE": None} if reference is None else reference
    )
    compose["services"]["octranspo-worker"]["environment"]["LIGHTER_STORAGE"] = (
        '{"other_lane":{"keep":true}}'
    )
    evidence = evidence_payload()
    next(p for p in evidence["peaks"] if p["service"] == "worker")["worker"] = False
    override = render(compose, evidence=evidence, bindings={"octranspo-worker": "octranspo"})
    storage = json.loads(override["services"]["octranspo-worker"]["environment"]["LIGHTER_STORAGE"])
    assert storage["other_lane"] == {"keep": True}
