from __future__ import annotations

import re
from urllib.parse import unquote, urlsplit

_PERCENT_ESCAPE = re.compile(r"%([0-9a-fA-F]{2})")
_ENCODED_UNSAFE_BYTES = {ord(character) for character in "./\\?#:@"}


def safe_public_path(path: str) -> str:

    canonical = path
    while True:
        if any(
            int(match.group(1), 16) in _ENCODED_UNSAFE_BYTES
            for match in _PERCENT_ESCAPE.finditer(canonical)
        ):
            raise ValueError("unsafe_public_path")
        decoded = unquote(canonical, errors="strict")
        if decoded == canonical:
            break
        canonical = decoded

    parsed = urlsplit(canonical)
    segments = canonical.split("/")
    if (
        not canonical
        or parsed.scheme
        or parsed.netloc
        or canonical.startswith("/")
        or "\\" in canonical
        or "%" in canonical
        or parsed.query
        or parsed.fragment
        or any(segment in {"", ".", ".."} for segment in segments)
        or any(
            character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F
            for character in canonical
        )
    ):
        raise ValueError("unsafe_public_path")
    return canonical


def publication_prefix(provider_id: str | None, root_suffix: str) -> str:
    prefix = f"v1/{provider_id}" if provider_id is not None else "v1"
    if not root_suffix:
        return prefix
    if provider_id is None:
        raise ValueError("publication_target_requires_provider")
    if (
        safe_public_path(root_suffix) != root_suffix
        or "/" in root_suffix
        or any(character in root_suffix for character in "%?#")
    ):
        raise ValueError("unsafe_publication_target_suffix")
    return f"{prefix}/{root_suffix}"


__all__ = ["safe_public_path", "publication_prefix"]
