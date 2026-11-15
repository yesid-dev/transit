"""Host-independent identity of a family build and its declared input bytes."""

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field

import duckdb

from transit_ops.batch.build import BuildRequest


@dataclass(frozen=True, order=True)
class ManifestInput:
    relation: str
    window: str
    sha256: str
    byte_size: int


@dataclass(frozen=True)
class BuildManifest(BuildRequest):
    family_id: str
    code_commit: str
    inputs: tuple[ManifestInput, ...]
    revision: int = field(default=2, init=False)
    engine: str = field(default="duckdb", init=False)
    engine_version: str = field(default=duckdb.__version__, init=False)

    def __post_init__(self) -> None:
        super().__post_init__()
        if not isinstance(self.code_commit, str) or not re.fullmatch(
            r"[0-9a-f]{40}", self.code_commit
        ):
            raise ValueError("code_commit must be exactly 40 lowercase hex characters")
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
