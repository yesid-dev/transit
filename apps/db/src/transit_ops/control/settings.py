from typing import Literal

from pydantic import BaseModel, ConfigDict


class LaneSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    switch_backend: Literal["postgres", "r2"] = "postgres"
