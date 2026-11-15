"""Edition names never depend on which registrations survived retention.

New versions use digest.vID, even when only one registration remains. Legacy
bare digest names require a durable assignment proved by archived bytes.
checksum_sha256 is authoritative; content_hash is the declared NULL fallback.
"""

import json
import re
from collections.abc import Iterable, Mapping
from typing import Any


class EditionIdentityRefused(ValueError):
    reason = "edition_identity"


def assignment_json(assignments: Mapping[int, str]) -> str:
    return json.dumps({str(k): v for k, v in sorted(assignments.items())}, sort_keys=True)


def parse_assignments(payload: str) -> dict[int, str]:
    try:
        values = json.loads(payload)
        if not isinstance(values, dict):
            raise ValueError("expected object")
        result = {int(k): v for k, v in values.items()}
        if any(str(k) not in values or k <= 0 for k in result):
            raise ValueError("invalid ID")
        owners: dict[str, int] = {}
        for ident, window in result.items():
            if not isinstance(window, str) or not re.fullmatch(
                rf"[0-9a-f]{{64}}(?:\.v{ident})?", window
            ):
                raise ValueError("invalid window")
            if window in owners and owners[window] != ident:
                raise ValueError("conflicting owner")
            owners[window] = ident
        return result
    except (ValueError, TypeError) as exc:
        raise EditionIdentityRefused("edition_identity: invalid assignments") from exc


def merge_assignments(*mappings: Mapping[int, str]) -> dict[int, str]:
    result: dict[int, str] = {}
    for mapping in mappings:
        for ident, window in mapping.items():
            if ident in result and result[ident] != window:
                raise EditionIdentityRefused(f"edition_identity: conflicting assignment: {ident}")
            result[ident] = window
    return parse_assignments(assignment_json(result))


def edition_keys(
    rows: Iterable[tuple[int, str | None, str | None]],
    *,
    assignments: Mapping[int, str] | None = None,
) -> dict[int, str]:
    assigned = merge_assignments(assignments or {})
    result: dict[int, str] = {}
    digests: dict[int, str] = {}
    for ident, checksum, content_hash in rows:
        digest = checksum if checksum is not None else content_hash
        if type(ident) is not int or ident <= 0 or not isinstance(digest, str):
            raise EditionIdentityRefused(f"edition_identity: invalid edition mapping: {ident}")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise EditionIdentityRefused(f"edition_identity: invalid digest: {ident}")
        if ident in digests and digests[ident] != digest:
            raise EditionIdentityRefused(f"edition_identity: ambiguous edition id: {ident}")
        digests[ident] = digest
        window = assigned.get(ident, f"{digest}.v{ident}")
        if window.split(".")[0] != digest:
            raise EditionIdentityRefused(f"edition_identity: digest differs: {ident}")
        if ident in result and result[ident] != window:
            raise EditionIdentityRefused(f"edition_identity: ambiguous edition id: {ident}")
        result[ident] = window
    return result


def registration_rows(connection: Any, provider: str) -> list[tuple[int, str | None, str | None]]:
    rows = connection.execute(
        "SELECT dataset_version_id, checksum_sha256, content_hash "
        "FROM core.dataset_versions WHERE provider_id=%s ORDER BY dataset_version_id",
        (provider,),
    ).fetchall()
    return [(ident, checksum, content_hash) for ident, checksum, content_hash in rows]


def registered_keys(
    connection: Any,
    provider: str,
    *,
    assignments: Mapping[int, str] | None = None,
) -> dict[int, str]:
    return edition_keys(registration_rows(connection, provider), assignments=assignments)


def resolve_edition(connection: Any, provider: str, window: str, assignments: str = "{}") -> int:
    mapping = registered_keys(connection, provider, assignments=parse_assignments(assignments))
    matches = [ident for ident, key in mapping.items() if key == window]
    if len(matches) != 1:
        raise EditionIdentityRefused(f"edition_identity: unresolved edition: {provider} {window}")
    return matches[0]
