"""Publication namespace and policy, independent of storage transport."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

from pydantic import BaseModel

from transit_ops.snapshots import historic_tree as tree
from transit_ops.snapshots.contract import PAYLOAD_METHODOLOGY, TOP_LEVEL_MODELS


@dataclass(frozen=True)
class PublicationTarget:
    revision: int
    root_suffix: str
    token_by_model: Mapping[type[BaseModel], str]
    model_by_path: Callable[[str], type[BaseModel]]
    history_metrics: Mapping[str, tuple[str, ...]]
    publish_state_key: str
    inventory_roots: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "token_by_model", MappingProxyType(dict(self.token_by_model)))
        object.__setattr__(
            self,
            "history_metrics",
            MappingProxyType(
                {name: tuple(metrics) for name, metrics in self.history_metrics.items()}
            ),
        )
        object.__setattr__(self, "inventory_roots", tuple(self.inventory_roots))

    def token_for_model(self, model: type[BaseModel]) -> str:
        try:
            return self.token_by_model[model]
        except KeyError:
            reason = "publication_target_not_ready" if not self.token_by_model else "unknown_model"
            raise ValueError(reason) from None


_FLAT_MODELS = {
    "historic/network_trend.json": "historic_network_trend",
    "historic/hotspots.json": "historic_hotspots",
    "historic/repeat_offenders.json": "historic_repeat_offenders",
    "historic/alert_history.json": "historic_alert_history",
    "historic/route_reliability/index.json": "historic_route_reliability_index",
    "historic/history/index.json": "historic_availability_index",
    "provenance.json": "provenance",
}
_COMPATIBILITY_MODELS = {
    "historic/route_reliability/": "historic_route_reliability",
    "historic/stop_reliability/": "historic_stop_reliability",
    "historic/receipts/": "historic_receipt",
}


def _revision_2_model(path: str) -> type[BaseModel]:
    if path in _FLAT_MODELS:
        return TOP_LEVEL_MODELS[_FLAT_MODELS[path]]
    for family in tree.FAMILIES.values():
        if path == family.index_path:
            return family.index_model
    route = tree.family_path_role(path, strict=True)
    if route is not None:
        family, role = route
        if role == "entity":
            return TOP_LEVEL_MODELS["historic_collection_index"]
        model = family.index_model if role == "index" else family.leaf_model
        if model is not None:
            return model
    for prefix, name in _COMPATIBILITY_MODELS.items():
        child = path.removeprefix(prefix)
        if path.startswith(prefix) and child.endswith(".json") and "/" not in child:
            return TOP_LEVEL_MODELS[name]
    raise ValueError("unknown_publication_path")


def _not_ready(path: str) -> type[BaseModel]:
    raise ValueError("publication_target_not_ready")


REVISION_2_TARGET = PublicationTarget(
    revision=2,
    root_suffix="",
    token_by_model={model: PAYLOAD_METHODOLOGY[name] for name, model in TOP_LEVEL_MODELS.items()},
    model_by_path=_revision_2_model,
    history_metrics={
        name: tuple(metric for metric, _ in spec.metrics)
        for name, spec in tree._HISTORY_FAMILY_SPECS.items()
    },
    publish_state_key="historic",
    inventory_roots=("historic/",),
)
REVISION_3_TARGET = PublicationTarget(
    revision=3,
    root_suffix="r3",
    token_by_model={},
    model_by_path=_not_ready,
    history_metrics={},
    publish_state_key="historic_r3",
    inventory_roots=("r3/historic/",),
)
