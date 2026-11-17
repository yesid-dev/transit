from typing import Literal

from pydantic import BaseModel, ConfigDict

type FactPruneMode = Literal["legacy", "hold"]


class LaneSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    switch_backend: Literal["postgres", "r2"] = "postgres"
    gc_marks_backend: Literal["postgres", "r2"] = "postgres"
    fact_prune_mode: FactPruneMode = "legacy"
