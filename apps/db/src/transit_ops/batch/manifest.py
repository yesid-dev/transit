"""Host-independent identity of a family build and its declared input bytes."""

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime

import duckdb


@dataclass(frozen=True, order=True)
class ManifestInput:
    relation: str
    window: str
    sha256: str
    byte_size: int


@dataclass(frozen=True)
class BuildManifest:
    family_id: str
    provider_id: str
    code_commit: str
    as_of_utc: datetime
    local_dates: tuple[date, ...]
    timezone: str
    inputs: tuple[ManifestInput, ...]
    revision: int = field(default=2, init=False)
    engine: str = field(default="duckdb", init=False)
    engine_version: str = field(default=duckdb.__version__, init=False)

    def __post_init__(self) -> None:
        if self.as_of_utc.utcoffset() is None:
            raise ValueError("as_of_utc must be timezone-aware")
        object.__setattr__(self, "as_of_utc", self.as_of_utc.astimezone(UTC))
        object.__setattr__(self, "inputs", tuple(sorted(self.inputs)))

    def canonical_json(self) -> bytes:
        payload = asdict(self)
        payload["as_of_utc"] = self.as_of_utc.isoformat(timespec="microseconds").replace(
            "+00:00", "Z"
        )
        payload["local_dates"] = [day.isoformat() for day in self.local_dates]
        return json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")

    @property
    def build_id(self) -> str:
        return hashlib.sha256(self.canonical_json()).hexdigest()
