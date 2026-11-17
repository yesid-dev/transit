from typing import Literal

from pydantic import BaseModel, ConfigDict

type FactPruneMode = Literal["legacy", "hold"]


class FactPruningHeld(ValueError):
    """The transition policy protects the provider's Gold fact history."""


def require_fact_pruning_allowed(mode: FactPruneMode, *, dry_run: bool = False) -> None:
    if mode not in ("legacy", "hold"):
        raise ValueError("invalid_fact_prune_mode")
    if mode == "hold" and not dry_run:
        raise FactPruningHeld("fact_pruning_held")


class LaneSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    switch_backend: Literal["postgres", "r2"] = "postgres"
    gc_marks_backend: Literal["postgres", "r2"] = "postgres"
    fact_prune_mode: FactPruneMode = "legacy"
