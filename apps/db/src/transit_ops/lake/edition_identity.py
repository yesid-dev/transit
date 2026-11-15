"""Stable edition identities, shared by archive planning, export and replay.

checksum_sha256 is authoritative when present; content_hash is the declared
fallback. Replay reads these declarations only from its digest-verified registry
copy. The first registration retains the legacy digest key forever; subsequent
registrations of that digest qualify it by version, since table rows include IDs.
"""

import re
from collections.abc import Iterable
from typing import Any


def edition_keys(rows: Iterable[tuple[int, str | None, str | None]]) -> dict[int, str]:
    digests: dict[int, str] = {}
    for ident, checksum, content_hash in rows:
        digest = checksum if checksum is not None else content_hash
        if type(ident) is not int or ident <= 0 or not isinstance(digest, str):
            raise ValueError(f"edition_identity: invalid edition mapping: {ident}")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"edition_identity: invalid digest: {ident}")
        if ident in digests and digests[ident] != digest:
            raise ValueError(f"edition_identity: ambiguous edition id: {ident}")
        digests[ident] = digest
    seen: set[str] = set()
    result = {}
    for ident, digest in sorted(digests.items()):
        result[ident] = f"{digest}.v{ident}" if digest in seen else digest
        seen.add(digest)
    return result


def registered_keys(connection: Any, provider: str) -> dict[int, str]:
    rows = connection.execute(
        "SELECT dataset_version_id, checksum_sha256, content_hash "
        "FROM core.dataset_versions WHERE provider_id=%s ORDER BY dataset_version_id",
        (provider,),
    ).fetchall()
    return edition_keys(rows)


def resolve_edition(connection: Any, provider: str, window: str) -> int:
    matches = [
        ident for ident, key in registered_keys(connection, provider).items() if key == window
    ]
    if len(matches) != 1:
        raise ValueError(f"edition_identity: unresolved edition: {provider} {window}")
    return matches[0]
