"""Render admitted container limits into an opt-in Compose override.

Admission mathematics belongs to ``operations.resource_plan``. This renderer only
parses explicit measured evidence, forwards it uncoerced to ``plan_resources``,
and maps the admitted ``ServiceLimit`` values onto Compose configuration. It
starts nothing, creates no host path and claims no cgroup or host enforcement:
disk reservations are reservations, not a hard host quota.

Every worker gets its own named volume at the SAME container target so Compose's
target-keyed volume merge replaces the parent local-state volume for a child
service instead of sharing the parent's provider state. Only each worker's
``environment.LIGHTER_STORAGE`` is patched; other environment keys, other lanes
and unknown live fields are preserved verbatim and never copied between keys.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any, Final, NoReturn

import yaml  # type: ignore[import-untyped]

from transit_ops.operations.resource_plan import (
    DiskItem,
    DiskPeak,
    ResourcePlan,
    ResourceTotal,
    ServiceLimit,
    ServicePeak,
    plan_resources,
)

LIVE_CONTAINER_DIR: Final = "/app/data/live"
BYTES_PER_MB: Final = 1_000_000
_PROVIDER_ID: Final = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")

_EVIDENCE_FIELDS: Final = frozenset({"peaks", "disk"})
_PEAK_FIELDS: Final = frozenset(
    {
        "service",
        "measurement_sha",
        "interval",
        "workload",
        "complete",
        "gaps",
        "cpu_cores",
        "container_memory_bytes",
        "process_rss_bytes",
        "pid_peak",
        "worker",
    }
)
_DISK_FIELDS: Final = frozenset({"items", "reservations"})
_DISK_ITEM_FIELDS: Final = frozenset(
    {"service", "category", "occupied_bytes", "measurement_sha", "basis", "measurement_kind"}
)
_EXTENDS_FIELDS: Final = frozenset({"service", "file"})


class ComposeLimitsRefused(ValueError):
    """The renderer refused: inputs are not a complete, renderable admitted plan."""


def _refuse(message: str) -> NoReturn:
    raise ComposeLimitsRefused(message)


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        _refuse(f"{name}: object required")
    fields: dict[str, Any] = {}
    for key, field in value.items():
        if not isinstance(key, str) or not key:
            _refuse(f"{name}: string keys required")
        fields[key] = field
    return fields


def _exact_fields(fields: Mapping[str, Any], expected: frozenset[str], name: str) -> None:
    missing = sorted(expected - fields.keys())
    unknown = sorted(fields.keys() - expected)
    if missing:
        _refuse(f"{name}: missing fields {missing}")
    if unknown:
        _refuse(f"{name}: unknown fields {unknown}")


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str):
        _refuse(f"{name}: string required")
    return value


def _numeric(value: Any, name: str) -> Any:
    """Refuse JSON strings and booleans where a measured number is required."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _refuse(f"{name}: JSON number required")
    return value


def _boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        _refuse(f"{name}: boolean required")
    return value


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    document: dict[str, Any] = {}
    for key, value in pairs:
        if key in document:
            _refuse(f"duplicate JSON key {key!r}")
        document[key] = value
    return document


def parse_json_document(text: str, name: str) -> Any:
    """Parse strict JSON, refusing malformed text and duplicate keys."""
    try:
        return json.loads(text, object_pairs_hook=_object_pairs)
    except json.JSONDecodeError as exc:
        _refuse(f"{name}: malformed JSON ({exc.msg})")


def parse_compose_yaml(text: str) -> dict[str, Any]:
    """Safe-load a base Compose document; YAML aliases never become Python objects."""
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        _refuse(f"compose: malformed YAML ({type(exc).__name__})")
    return _object(document, "compose")


def _peak(value: Any, index: int) -> ServicePeak:
    name = f"evidence.peaks[{index}]"
    fields = _object(value, name)
    _exact_fields(fields, _PEAK_FIELDS, name)
    gaps = fields["gaps"]
    if not isinstance(gaps, (list, tuple)) or any(not isinstance(gap, str) for gap in gaps):
        _refuse(f"{name}.gaps: string list required")
    return ServicePeak(
        _text(fields["service"], f"{name}.service"),
        _text(fields["measurement_sha"], f"{name}.measurement_sha"),
        _text(fields["interval"], f"{name}.interval"),
        _text(fields["workload"], f"{name}.workload"),
        # Evidence keeps its measured JSON types: plan_resources still refuses
        # incomplete coverage, bools, non-integral counts and NaN/inf itself.
        _boolean(fields["complete"], f"{name}.complete"),
        tuple(gaps),
        _numeric(fields["cpu_cores"], f"{name}.cpu_cores"),
        _numeric(fields["container_memory_bytes"], f"{name}.container_memory_bytes"),
        _numeric(fields["process_rss_bytes"], f"{name}.process_rss_bytes"),
        _numeric(fields["pid_peak"], f"{name}.pid_peak"),
        _boolean(fields["worker"], f"{name}.worker"),
    )


def _disk_item(value: Any, index: int) -> DiskItem:
    name = f"evidence.disk.items[{index}]"
    fields = _object(value, name)
    _exact_fields(fields, _DISK_ITEM_FIELDS, name)
    return DiskItem(
        _text(fields["service"], f"{name}.service"),
        _text(fields["category"], f"{name}.category"),
        _numeric(fields["occupied_bytes"], f"{name}.occupied_bytes"),
        _text(fields["measurement_sha"], f"{name}.measurement_sha"),
        _text(fields["basis"], f"{name}.basis"),
        _text(fields["measurement_kind"], f"{name}.measurement_kind"),
    )


def parse_evidence(payload: Any) -> tuple[tuple[ServicePeak, ...], DiskPeak]:
    """Build the owner's evidence dataclasses from the documented JSON shape."""
    document = _object(payload, "evidence")
    _exact_fields(document, _EVIDENCE_FIELDS, "evidence")
    peaks = document["peaks"]
    if not isinstance(peaks, list):
        _refuse("evidence.peaks: list required")
    disk = _object(document["disk"], "evidence.disk")
    _exact_fields(disk, _DISK_FIELDS, "evidence.disk")
    items = disk["items"]
    if not isinstance(items, list):
        _refuse("evidence.disk.items: list required")
    reservations = _object(disk["reservations"], "evidence.disk.reservations")
    return (
        tuple(_peak(value, index) for index, value in enumerate(peaks)),
        DiskPeak(
            tuple(_disk_item(value, index) for index, value in enumerate(items)), reservations
        ),
    )


def parse_worker_bindings(payload: Any) -> dict[str, str]:
    """Read the explicit worker-service to provider-id map; values stay unvalidated here."""
    document = _object(payload, "worker bindings")
    bindings: dict[str, str] = {}
    for service, provider in document.items():
        if not service.strip():
            _refuse("worker bindings: nonempty service name required")
        if not isinstance(provider, str):
            _refuse(f"worker bindings.{service}: provider id string required")
        bindings[service] = provider
    return bindings


def _services(base_compose: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    document = _object(base_compose, "compose")
    raw = document.get("services")
    if raw is None:
        _refuse("compose.services: required")
    services: dict[str, dict[str, Any]] = {}
    for name, definition in _object(raw, "compose.services").items():
        if not name.strip():
            _refuse("compose.services: nonempty service name required")
        services[name] = _object(
            {} if definition is None else definition, f"compose.services.{name}"
        )
    if not services:
        _refuse("compose.services: at least one concurrent service required")
    return services


def _extends_parent(definition: Mapping[str, Any], name: str) -> str | None:
    parent = definition.get("extends")
    if parent is None:
        return None
    if isinstance(parent, str):
        if not parent.strip():
            _refuse(f"{name}.extends: service name required")
        return parent
    fields = _object(parent, f"{name}.extends")
    unknown = sorted(fields.keys() - _EXTENDS_FIELDS)
    if unknown:
        _refuse(f"{name}.extends: unknown fields {unknown}")
    if "file" in fields:
        _refuse(f"{name}.extends.file: external Compose files are not supported")
    target = fields.get("service")
    if not isinstance(target, str) or not target.strip():
        _refuse(f"{name}.extends: service name required")
    return target


def _service_environment(definition: Mapping[str, Any], name: str) -> dict[str, Any]:
    raw = definition.get("environment")
    if raw is None:
        return {}
    if isinstance(raw, Mapping):
        return _object(raw, f"{name}.environment")
    if not isinstance(raw, list):
        _refuse(f"{name}.environment: mapping or list required")
    environment: dict[str, Any] = {}
    for index, entry in enumerate(raw):
        if not isinstance(entry, str) or not entry.strip():
            _refuse(f"{name}.environment[{index}]: string entry required")
        key, separator, value = entry.partition("=")
        if key in environment:
            _refuse(f"{name}.environment: duplicate {key}")
        if not separator:
            # A bare entry imports the host environment. It is never copied, and a
            # LIGHTER_STORAGE host reference cannot be resolved without reading it.
            if key == "LIGHTER_STORAGE":
                _refuse(f"{name}.environment.LIGHTER_STORAGE: host reference is unresolvable")
            environment[key] = None
            continue
        environment[key] = value
    return environment


def _effective_environment(
    services: Mapping[str, Mapping[str, Any]], name: str
) -> dict[str, Any]:
    """Merge same-file extends at the environment-KEY level, child last."""
    chain: list[Mapping[str, Any]] = []
    visited: list[str] = []
    current: str | None = name
    while current is not None:
        if current in visited:
            _refuse(f"{name}.extends: inheritance cycle at {current!r}")
        definition = services.get(current)
        if definition is None:
            _refuse(f"{name}.extends: unknown service {current!r}")
        visited.append(current)
        chain.append(definition)
        current = _extends_parent(definition, name)
    environment: dict[str, Any] = {}
    for definition in reversed(chain):
        environment.update(_service_environment(definition, name))
    return environment


def _refuse_placeholders(value: Any, name: str) -> None:
    if isinstance(value, str):
        if "$" in value:
            _refuse(f"{name}: unresolved placeholder {value!r}")
    elif isinstance(value, Mapping):
        for item in value.values():
            _refuse_placeholders(item, name)
    elif isinstance(value, list):
        for item in value:
            _refuse_placeholders(item, name)


def _patched_storage(
    service: str, environment: Mapping[str, Any], limit: ServiceLimit, memory_mb: int, temp_mb: int
) -> str:
    """Return the worker's LIGHTER_STORAGE JSON with only owned live fields changed."""
    name = f"{service}.environment.LIGHTER_STORAGE"
    existing = environment.get("LIGHTER_STORAGE")
    if existing is None:
        document: dict[str, Any] = {}
    else:
        if not isinstance(existing, str):
            _refuse(f"{name}: JSON object string required")
        if "$" in existing:
            _refuse(f"{name}: unresolved placeholder")
        try:
            decoded = json.loads(existing, object_pairs_hook=_object_pairs)
        except json.JSONDecodeError as exc:
            _refuse(f"{name}: malformed JSON ({exc.msg})")
        if not isinstance(decoded, Mapping):
            _refuse(f"{name}: JSON object required")
        _refuse_placeholders(decoded, name)
        document = dict(decoded)
    live = document.get("live")
    if live is None:
        lanes: dict[str, Any] = {}
    elif isinstance(live, Mapping):
        lanes = dict(live)
    else:
        _refuse(f"{name}.live: object required")
    lanes["local_dir"] = LIVE_CONTAINER_DIR
    lanes["duckdb_memory_limit_mb"] = memory_mb
    lanes["duckdb_threads"] = limit.threads
    lanes["temp_dir_max_mb"] = temp_mb
    document["live"] = lanes
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def _validated_bindings(
    peaks: Sequence[ServicePeak], worker_bindings: Mapping[str, str]
) -> dict[str, str]:
    measured = {peak.service for peak in peaks if peak.worker}
    missing = sorted(measured - set(worker_bindings))
    extra = sorted(set(worker_bindings) - measured)
    if missing or extra:
        _refuse(f"worker bindings: missing measured workers {missing}, unexpected {extra}")
    validated: dict[str, str] = {}
    owners: dict[str, str] = {}
    for service in sorted(worker_bindings):
        provider = worker_bindings[service]
        if not _PROVIDER_ID.fullmatch(provider):
            _refuse(f"worker bindings.{service}: unsafe provider id {provider!r}")
        if provider in owners:
            _refuse(
                f"worker bindings.{service}: provider id {provider!r}"
                f" also binds {owners[provider]}"
            )
        owners[provider] = service
        validated[service] = provider
    return validated


def _owned_volumes(
    base_compose: Mapping[str, Any], bindings: Mapping[str, str]
) -> dict[str, str]:
    raw = base_compose.get("volumes")
    declared = {} if raw is None else _object(raw, "compose.volumes")
    owned: dict[str, str] = {}
    for service in sorted(bindings):
        name = f"transit_live_{bindings[service]}"
        if name in declared and declared[name] not in (None, {}):
            _refuse(f"compose.volumes.{name}: incompatible existing definition")
        owned[service] = name
    return owned


def _representable(service: str, limit: ServiceLimit) -> tuple[int, int]:
    """Return the decimal-MB memory and temp values, refusing unrepresentable ones."""
    if type(limit.cpus) is not float or not math.isfinite(limit.cpus) or limit.cpus <= 0:
        _refuse(f"{service}.cpus: positive finite admitted value required")
    for field in (
        "memory_bytes",
        "memswap_bytes",
        "pids_limit",
        "threads",
        "duckdb_memory_bytes",
        "temp_max_bytes",
    ):
        value = getattr(limit, field)
        if type(value) is not int or value <= 0:
            _refuse(f"{service}.{field}: positive integer admitted value required")
    if limit.memswap_bytes != limit.memory_bytes:
        _refuse(f"{service}.memswap_bytes: must equal admitted memory_bytes")
    memory_mb = limit.duckdb_memory_bytes // BYTES_PER_MB
    temp_mb = limit.temp_max_bytes // BYTES_PER_MB
    if memory_mb < 1:
        _refuse(
            f"{service}.duckdb_memory_limit_mb: admitted {limit.duckdb_memory_bytes} bytes"
            " is below one decimal MB"
        )
    if temp_mb < 1:
        _refuse(
            f"{service}.temp_dir_max_mb: admitted {limit.temp_max_bytes} bytes"
            " is below one decimal MB"
        )
    return memory_mb, temp_mb


def _total(total: ResourceTotal) -> dict[str, Any]:
    return {
        "cpus": total.cpus,
        "disk_budget_bytes": total.disk_budget_bytes,
        "memory_bytes": total.memory_bytes,
    }


def _proof(
    plan: ResourcePlan,
    bindings: Mapping[str, str],
    owned: Mapping[str, str],
    concurrent: Sequence[str],
    rendered_mb: Mapping[str, tuple[int, int]],
) -> dict[str, Any]:
    limits = {}
    reservations = {}
    for name in sorted(plan.services):
        limit = plan.services[name]
        limits[name] = {
            "cpus": limit.cpus,
            "memory_bytes": limit.memory_bytes,
            "memswap_bytes": limit.memswap_bytes,
            "pids_limit": limit.pids_limit,
        }
        reservation: dict[str, Any] = {
            "disk_budget_bytes": limit.disk_budget_bytes,
            "duckdb_memory_bytes": limit.duckdb_memory_bytes,
            "temp_max_bytes": limit.temp_max_bytes,
            "threads": limit.threads,
        }
        if name in rendered_mb:
            memory_mb, temp_mb = rendered_mb[name]
            reservation["duckdb_memory_mb"] = memory_mb
            reservation["temp_dir_max_mb"] = temp_mb
        reservations[name] = reservation
    return {
        "admission": "operations.resource_plan.plan_resources",
        "concurrent_services": list(concurrent),
        "limits": limits,
        "notes": [
            "disk reservations are reservations, not a hard host disk quota",
            "no cgroup or host enforcement is claimed by this artifact",
        ],
        "owned_volumes": sorted(owned.values()),
        "reservations": reservations,
        "source_proof_hashes": list(plan.source_proof_hashes),
        "total": _total(plan.total),
        "headroom": _total(plan.headroom),
        "worker_bindings": dict(sorted(bindings.items())),
    }


def render_compose_limits(
    base_compose: Mapping[str, Any],
    *,
    peaks: Sequence[ServicePeak],
    disk: DiskPeak,
    worker_bindings: Mapping[str, str],
) -> dict[str, Any]:
    """Render the override mapping for an admitted plan; inputs are never mutated."""
    services = _services(base_compose)
    concurrent = tuple(sorted(services))
    plan = plan_resources(peaks, disk=disk, concurrent_services=concurrent)
    if plan.pilot_unresolved:
        _refuse("pilot unresolved: " + ", ".join(plan.pilot_unresolved))
    bindings = _validated_bindings(peaks, worker_bindings)
    owned = _owned_volumes(base_compose, bindings)
    rendered_services: dict[str, Any] = {}
    rendered_mb: dict[str, tuple[int, int]] = {}
    for service in sorted(bindings):
        limit = plan.services[service]
        memory_mb, temp_mb = _representable(service, limit)
        rendered_mb[service] = (memory_mb, temp_mb)
        environment = _effective_environment(services, service)
        rendered_services[service] = {
            "cpus": limit.cpus,
            "environment": {
                "LIGHTER_STORAGE": _patched_storage(service, environment, limit, memory_mb, temp_mb)
            },
            "mem_limit": limit.memory_bytes,
            "memswap_limit": limit.memswap_bytes,
            "pids_limit": limit.pids_limit,
            "volumes": [f"{owned[service]}:{LIVE_CONTAINER_DIR}"],
        }
    return {
        "services": rendered_services,
        "volumes": {owned[service]: None for service in sorted(owned)},
        "x-transit-resource-plan": _proof(plan, bindings, owned, concurrent, rendered_mb),
    }


def render_json(document: Mapping[str, Any]) -> str:
    """Serialize the override as sorted, deterministic JSON (also valid YAML)."""
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
