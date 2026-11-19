from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, PositiveFloat, PositiveInt


class LaneSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    local_dir: Path | None = None
    duckdb_memory_limit_mb: PositiveInt | None = None
    duckdb_threads: PositiveInt | None = None
    temp_dir_max_mb: PositiveInt | None = None
    recording: bool = False
    trip_updates_fallback: Literal["postgres", "local"] = "postgres"
    initial_cut_path: Path | None = None
    initial_cut_sha256: str | None = None
    alert_seed_path: Path | None = None
    alert_seed_sha256: str | None = None
    segment_storage_backend: Literal["local", "s3"] | None = None
    catchup_page_size: PositiveInt = 64
    # Paired shadow role; "off" is today's worker. Admission lives in live/shadow.py.
    shadow: Literal["off", "postgres_authoritative", "local_authoritative"] = "off"
    shadow_budget_seconds: PositiveFloat | None = None
    shadow_rss_limit_mb: PositiveInt | None = None
