"""Private immutable proposals; only the capture runner mutates messages."""

from dataclasses import dataclass


@dataclass(frozen=True)
class FieldWrite:
    field: str
    value: str
    stop_time_update_index: int | None = None


@dataclass(frozen=True)
class RuleProposal:
    writes: tuple[FieldWrite, ...] = ()
    seen: int = 0
    unresolved: int = 0
    reasons: tuple[tuple[str, int], ...] = ()
