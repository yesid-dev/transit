"""Shrinking architecture inventories; changes require the named successor's extraction."""

import ast
import re
from collections import Counter
from pathlib import Path

from pydantic import BaseModel

from transit_ops.snapshots import contract
from transit_ops.snapshots.contract import PAYLOAD_METHODOLOGY

ROOT = Path(__file__).parents[1] / "src/transit_ops"
MODELS = {
    name
    for name, model in vars(contract).items()
    if isinstance(model, type)
    and issubclass(model, BaseModel)
    and model.__module__ in {contract.__name__, "transit_ops.snapshots.contract_weekly_ranking"}
}
MAPS = {"PAYLOAD_METHODOLOGY", "TOP_LEVEL_MODELS", "_METHODOLOGY_BY_MODEL"}
TOKENS = set(PAYLOAD_METHODOLOGY.values())


def sources():
    paths = [
        *ROOT.joinpath("snapshots").rglob("*.py"),
        *ROOT.joinpath("validation").rglob("*.py"),
        ROOT / "daily_run.py",
        ROOT / "cli.py",
    ]
    return {
        str(path.relative_to(ROOT)).replace("\\", "/"): path.read_text(encoding="utf-8")
        for path in paths
    }


def qualified(node, aliases):
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        return qualified(node.value, aliases) + "." + node.attr
    return ""


def imported_names(source, path):
    aliases = {}
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            for item in node.names:
                module = node.module or ""
                if node.level:
                    package = path.removesuffix(".py").split("/")[: -node.level]
                    module = ".".join(["transit_ops", *package, module]).rstrip(".")
                aliases[item.asname or item.name] = f"{module}.{item.name}"
        elif isinstance(node, ast.Import):
            for item in node.names:
                aliases[item.asname or item.name] = (
                    item.name if item.asname else item.name.split(".")[0]
                )
    return aliases


def resolve_export(name, exports):
    seen = set()
    while name not in seen:
        seen.add(name)
        parts = name.split(".")
        for end in range(len(parts), 0, -1):
            prefix = ".".join(parts[:end])
            if prefix in exports:
                name = ".".join([exports[prefix], *parts[end:]])
                break
        else:
            return name
    return name


def exported_symbols(inputs):
    result = {}
    for path, source in inputs.items():
        module = path.removesuffix(".py").removesuffix("/__init__").replace("/", ".")
        for alias, name in imported_names(source, path).items():
            result[f"transit_ops.{module}.{alias}"] = name
    return result


def scan(source, path="snapshots/example.py", exports=None):
    tree = ast.parse(source)
    aliases = imported_names(source, path)
    counts, constructors, imports = Counter(), Counter(), set(aliases.values())
    counts["import"] = sum(name.startswith("transit_ops.snapshots.contract") for name in imports)

    def visit(node, scope="module"):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            scope = f"{scope}.{node.name}" if scope != "module" else node.name
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            value = node.value
            for kind, matches in {
                "root": bool(re.search(r"(?:^|/)v1(?:/|$)", value)),
                "path": "historic/" in value,
                "tier": value in {"historic", "historic_immutable", "publish_state_historic"}
                or "publish_state_historic" in value,
                "token": value in TOKENS,
            }.items():
                if matches:
                    counts[kind] += 1
        if isinstance(node, (ast.Name, ast.Attribute)):
            name = qualified(node, aliases).split(".")[-1]
            if name in MODELS | MAPS:
                counts["model" if name in MODELS else "map"] += 1
        if isinstance(node, ast.If) and qualified(node.test, aliases) in {
            "TYPE_CHECKING",
            "typing.TYPE_CHECKING",
        }:
            for child in node.orelse:
                visit(child, scope)
            return
        if isinstance(node, ast.Assign):
            value = qualified(node.value, aliases)
            if value.startswith("transit_ops."):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        aliases[target.id] = value
        if isinstance(node, ast.Call):
            name = resolve_export(qualified(node.func, aliases), exports or {})
            if name.startswith("transit_ops.snapshots.contract.") and name.split(".")[-1] in MODELS:
                constructors[f"{scope} -> {name}"] += 1
        for child in ast.iter_child_nodes(node):
            visit(child, scope)

    visit(tree)
    return counts, constructors, imports


# Counts are ceilings so deleting old knowledge needs no allowance expansion.
# Every listed file has a successor/reason; unknown files have a zero allowance.
OWNED = {
    "snapshots/builders/historic/weekly_ranking.py": (
        {"import": 4, "model": 3},
        "r2 weekly ranking builder (#1048)",
    ),
    "snapshots/contract_weekly_ranking.py": ({"model": 2}, "r2 ranking definitions (#1048)"),
    "cli.py": ({"tier": 3}, "current CLI; later activation"),
    "daily_run.py": ({"tier": 2}, "H1c"),
    "snapshots/builders/_helpers.py": (
        {"import": 2, "model": 4},
        "H1b1 shared historic model vocabulary",
    ),
    "snapshots/builders/historic/_spine.py": (
        {"import": 13, "model": 36},
        "H1b1 shared historic model vocabulary",
    ),
    "snapshots/builders/historic/alert_archive.py": (
        {"import": 8, "model": 22, "map": 2},
        "r2 builder",
    ),
    "snapshots/builders/historic/history_common.py": (
        {"import": 10, "model": 27, "token": 3},
        "H1b1",
    ),
    "snapshots/builders/historic/hotspots_history.py": (
        {"import": 5, "model": 8, "map": 1},
        "r2 builder",
    ),
    "snapshots/builders/historic/line_history.py": (
        {"import": 10, "model": 30, "token": 2},
        "r2 builder",
    ),
    "snapshots/builders/historic/network_history.py": (
        {"import": 8, "model": 25, "token": 2},
        "r2 builder",
    ),
    "snapshots/builders/historic/network_trend.py": ({"import": 2, "model": 4}, "r2 builder"),
    "snapshots/builders/historic/provenance.py": (
        {"import": 4, "model": 8, "path": 1},
        "r2 builder",
    ),
    "snapshots/builders/historic/ranking_kernel.py": (
        {"import": 3, "model": 16},
        "H1b1 shared historic model vocabulary",
    ),
    "snapshots/builders/historic/repeat_offenders_history.py": (
        {"import": 5, "model": 9, "map": 1},
        "r2 builder",
    ),
    "snapshots/builders/historic/route_reliability.py": ({"import": 10, "model": 24}, "r2 builder"),
    "snapshots/builders/historic/route_reliability_batch.py": (
        {"import": 1, "model": 1},
        "r2 builder",
    ),
    "snapshots/builders/historic/small_surfaces.py": (
        {"import": 18, "model": 32, "path": 1, "tier": 1},
        "r2 builder",
    ),
    "snapshots/builders/historic/stop_history.py": (
        {"import": 8, "model": 29, "token": 2},
        "r2 builder",
    ),
    "snapshots/builders/historic/stop_reliability.py": ({"import": 6, "model": 16}, "r2 builder"),
    "snapshots/builders/live.py": (
        {"import": 25, "model": 41, "tier": 2, "root": 1},
        "live/catalog",
    ),
    "snapshots/builders/static.py": ({"import": 13, "model": 23}, "static"),
    "snapshots/builders/static_headway_r3.py": (
        {"import": 2},
        "H1b1 shared historic model vocabulary",
    ),
    "snapshots/contract.py": (
        {"import": 6, "map": 3, "token": 34, "model": 197, "path": 12},
        "r2 definitions",
    ),
    "snapshots/contract_r3.py": ({"model": 2}, "H2a shared model annotations"),
    "snapshots/envelope.py": ({"import": 3, "map": 5, "model": 1}, "H1b1"),
    "snapshots/gate.py": ({"import": 9, "path": 13, "model": 13, "token": 2}, "H1b2"),
    "snapshots/historic_compatibility.py": (
        {"import": 4, "model": 5, "path": 14, "tier": 11},
        "H1f",
    ),
    "snapshots/historic_gc.py": ({"path": 1, "tier": 1}, "H1d; LS3.13a SQL unchanged"),
    "snapshots/historic_graph.py": ({"import": 8, "model": 22, "token": 1, "tier": 1}, "H1e"),
    "snapshots/historic_run.py": ({"tier": 1}, "H1c"),
    "snapshots/historic_streams.py": ({"import": 5, "model": 15, "tier": 3}, "H1e"),
    "snapshots/historic_tier.py": ({"import": 6, "model": 10, "path": 11, "tier": 10}, "H1e"),
    "snapshots/historic_tree.py": ({"import": 16, "model": 59, "path": 12, "tier": 2}, "H1b1/H1f"),
    "snapshots/paths.py": ({"root": 2}, "H1a root composition"),
    "snapshots/providers.py": (
        {"import": 5, "model": 5, "map": 1, "root": 2},
        "catalog validation",
    ),
    "snapshots/publication_target.py": (
        {"import": 2, "path": 11, "map": 5, "tier": 1},
        "H1a policy owner",
    ),
    "snapshots/publish.py": ({"import": 1, "model": 1, "tier": 11}, "H1c"),
    "snapshots/storage.py": ({"tier": 2}, "cache/fingerprint policy; fixed root removed"),
    "snapshots/uploads.py": ({"tier": 2}, "write modes"),
    "validation/historic_publish.py": ({"import": 16, "tier": 2, "model": 49, "root": 1}, "H1b3"),
}
CONSTRUCTORS = {
    "snapshots/builders/historic/history_common.py": (
        {
            (
                "history_entity_percentile_metrics -> "
                "transit_ops.snapshots.contract.HistoricDelayPercentiles"
            ): 1,
            (
                "history_entity_occupancy_metrics -> "
                "transit_ops.snapshots.contract.HistoricOccupancyMetric"
            ): 1,
            "history_delay_metric -> transit_ops.snapshots.contract.HistoricDelayMetric": 1,
            "history_gaps -> transit_ops.snapshots.contract.HistoricCoverageGap": 1,
            "history_metric_coverage -> transit_ops.snapshots.contract.HistoricMetricCoverage": 1,
            "_history_partition_ref -> transit_ops.snapshots.contract.HistoricPartitionRef": 1,
            "history_point_ref -> transit_ops.snapshots.contract.HistoricPartitionRef": 1,
            (
                "PointHistorySummary.build_index -> "
                "transit_ops.snapshots.contract.HistoricCollectionIndex"
            ): 1,
        },
        "H1b1",
    ),
    "snapshots/gate.py": (
        {"check_point_history_day -> transit_ops.snapshots.contract.HistoricPartitionRef": 1},
        "H1b2",
    ),
    "snapshots/historic_compatibility.py": (
        {
            "_build_items -> transit_ops.snapshots.contract.RouteReliabilityIndex": 1,
            "_build_items -> transit_ops.snapshots.contract.ReceiptAvailability": 1,
            "_build_items -> transit_ops.snapshots.contract.ReceiptsIndex": 1,
        },
        "H1f",
    ),
    "snapshots/historic_graph.py": (
        {
            (
                "_entity_family_availability -> "
                "transit_ops.snapshots.contract.HistoricFamilyAvailability"
            ): 1,
            (
                "HistoricGraph.build_root -> "
                "transit_ops.snapshots.contract.HistoricFamilyAvailability"
            ): 5,
            (
                "HistoricGraph.build_root -> "
                "transit_ops.snapshots.contract.HistoricAvailabilityIndex"
            ): 1,
        },
        "H1e",
    ),
    "validation/historic_publish.py": (
        {
            (
                "_verify_point_history_family -> "
                "transit_ops.snapshots.contract.HistoricFamilyAvailability"
            ): 1,
            (
                "_build_historic_publish_proof -> "
                "transit_ops.snapshots.contract.ManifestHistoricFiles"
            ): 1,
        },
        "H1b3",
    ),
}

# Only these existing implementations are revision-2-only. New helpers are never exempt.
R2_ONLY = {
    "snapshots/builders/live.py",
    "snapshots/builders/static.py",
    "snapshots/builders/historic/alert_archive.py",
    "snapshots/builders/historic/hotspots_history.py",
    "snapshots/builders/historic/line_history.py",
    "snapshots/builders/historic/network_history.py",
    "snapshots/builders/historic/network_trend.py",
    "snapshots/builders/historic/provenance.py",
    "snapshots/builders/historic/repeat_offenders_history.py",
    "snapshots/builders/historic/route_reliability.py",
    "snapshots/builders/historic/route_reliability_batch.py",
    "snapshots/builders/historic/small_surfaces.py",
    "snapshots/builders/historic/stop_history.py",
    "snapshots/builders/historic/stop_reliability.py",
}


def violations(inputs, *, constructors_only=False):
    failures = []
    exports = exported_symbols(inputs) if constructors_only else {}
    for path, source in inputs.items():
        counts, calls, _imports = scan(source, path, exports)
        actual = calls if constructors_only else counts
        owned = CONSTRUCTORS if constructors_only else OWNED
        expected, owner = owned.get(path, ({}, "unowned"))
        for symbol, count in actual.items():
            if count > expected.get(symbol, 0):
                failures.append(f"{path}: {symbol}: {count} > {expected.get(symbol, 0)} ({owner})")
    return failures


def test_root_tier_key_and_models_are_reached_only_through_the_target():
    assert not violations(sources()), "\n".join(violations(sources()))


def test_no_revision_2_model_is_constructed_on_a_path_the_revision_3_build_reaches():
    inputs = {
        str(path.relative_to(ROOT)).replace("\\", "/"): path.read_text(encoding="utf-8")
        for path in ROOT.rglob("*.py")
    }
    failures = violations(reachable(inputs), constructors_only=True)
    assert not failures, "\n".join(failures)


def reachable(inputs):
    pending = [
        f"snapshots/{name}.py"
        for name in ("historic_tier", "historic_graph", "historic_streams", "gate")
    ]
    pending += ["validation/historic_publish.py"]
    pending += [path for path in inputs if path.startswith("snapshots/builders/r3/")]
    result = {}
    while pending:
        path = pending.pop()
        if path in result or path in R2_ONLY:
            continue
        source = inputs.get(path)
        if source is None:
            continue
        result[path] = source
        for name in scan(source, path)[2]:
            if name.startswith("transit_ops."):
                parts = name.removeprefix("transit_ops.").split(".")
                while parts:
                    stem = "/".join(parts)
                    candidates = [stem + ".py", stem + "/__init__.py"]
                    found = next((item for item in candidates if item in inputs), None)
                    if found is not None:
                        pending.append(found)
                        break
                    parts.pop()
    return result


def test_publication_guards_detect_new_files_aliases_and_unowned_constructors():
    examples = {
        "snapshots/new.py": 'ROOT = "v1/new"\nPATH = "historic/new.json"\nTIER = "historic"',
        "snapshots/shared.py": (
            "from transit_ops.snapshots.contract import NetworkTrend as N\ndef build(): return N()"
        ),
        "snapshots/qualified.py": (
            "import transit_ops.snapshots.contract as c\ndef build(): return c.NetworkTrend()"
        ),
        "snapshots/map.py": (
            "from transit_ops.snapshots.contract import TOP_LEVEL_MODELS as M\nx = M"
        ),
    }
    failures = violations(examples)
    assert all(any(path in failure for failure in failures) for path in examples)
    calls = violations(examples, constructors_only=True)
    assert any(
        "build -> transit_ops.snapshots.contract.NetworkTrend" in failure for failure in calls
    )
    assert len(calls) == 2


def test_guards_follow_shared_imports_and_ignore_annotation_only_calls():
    inputs = {
        "snapshots/historic_graph.py": "from . import shared",
        "snapshots/shared.py": (
            "from transit_ops.snapshots.contract import HistoricMetricCoverage as M\n"
            "Alias = M\ndef construct(): return Alias()"
        ),
    }
    failures = violations(reachable(inputs), constructors_only=True)
    assert any("snapshots/shared.py: construct -> " in failure for failure in failures)
    source = (
        "from typing import TYPE_CHECKING\n"
        "from transit_ops.snapshots.contract import NetworkTrend\n"
        "if TYPE_CHECKING:\n    value = NetworkTrend()"
    )
    assert scan(source)[1] == {}
    assert violations({"snapshots/storage.py": 'ROOT = "v1/again"'})


def test_constructor_guard_follows_package_reexports():
    inputs = {
        "snapshots/historic_graph.py": (
            "from .shared import build, Model\ndef wrong(): return Model()\n"
        ),
        "snapshots/shared/__init__.py": (
            "from .helpers import build\n"
            "from transit_ops.snapshots.contract import NetworkTrend as Model\n"
        ),
        "snapshots/shared/helpers.py": (
            "from transit_ops.snapshots.contract import NetworkTrend as N\n"
            "def build(): return N()\n"
        ),
    }
    failures = violations(reachable(inputs), constructors_only=True)
    assert any("snapshots/shared/helpers.py: build -> " in failure for failure in failures)
    assert any("snapshots/historic_graph.py: wrong -> " in failure for failure in failures)


def test_constructor_guard_checks_runtime_type_checking_else_branch():
    source = (
        "from typing import TYPE_CHECKING\n"
        "from transit_ops.snapshots.contract import NetworkTrend\n"
        "if TYPE_CHECKING:\n    annotation_only = NetworkTrend()\n"
        "else:\n    runtime = NetworkTrend()\n"
    )
    assert scan(source)[1] == {"module -> transit_ops.snapshots.contract.NetworkTrend": 1}
