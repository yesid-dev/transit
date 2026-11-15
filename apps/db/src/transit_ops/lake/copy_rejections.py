"""Immutable copy rejections backed by the LS1.9 run evidence (R33b)."""

from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class RejectedCopy:
    dataset_id: str
    provider_id: str
    window_key: str
    object_sha256: str
    content_sha256: str
    derived_key: str
    rows: int


REJECTED_COPIES = (
    RejectedCopy(
        "gold.fact_trip_delay_snapshot",
        "octranspo",
        "2026-11-01",
        "8d6b9a92e21ac850eb94d9b3b44c0774701d32b40954cd9c19938164c818e128",
        "1e67bd67bb7544c30a151e3ca4f4575089c45a6377a5553ac69db9a512b48d89",
        "archive/v1/tables/gold.fact_trip_delay_snapshot/octranspo/r0/2026/2026-11-01.c1.s1.parquet",
        234241,
    ),
)


class KnownIncomplete(ValueError):
    reason = "known_incomplete"


def require_usable_copy(receipt: Mapping[str, object], key: str | None = None) -> None:
    from transit_ops.lake.archive_keys import parse_copy_key

    path = key if key is not None else receipt.get("key")
    parts = parse_copy_key(path) if isinstance(path, str) else None
    names = ("dataset_id", "provider_id", "window_key", "object_sha256", "content_sha256")
    identity = tuple(getattr(parts, n, receipt.get(n)) for n in names)
    for copy in REJECTED_COPIES:
        if identity == tuple(getattr(copy, n) for n in names):
            raise KnownIncomplete(
                f"known_incomplete: {copy.derived_key} rows={copy.rows} selected={path}"
            )
