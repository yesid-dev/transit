"""Identify translations of a published notice within a read window."""

import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from unicodedata import normalize

type NoticeKey = tuple[str, str, str]
type NoticeText = tuple[str, str]
type NoticeScope = tuple[tuple[str, ...], tuple[str, ...], str, str | None, str | None]
type TranslationKey = tuple[str, str | None, NoticeScope, str, NoticeText]
# English header and description, then French header and description, as published.
type NoticeWording = tuple[str | None, str | None, str | None, str | None]


def notice_text(header: str | None, body: str | None) -> NoticeText:
    return (
        " ".join(normalize("NFC", header or "").split()),
        " ".join(normalize("NFC", body or "").split()),
    )


@dataclass(frozen=True)
class NoticeVariant:
    scope: NoticeScope
    en: NoticeText
    fr: NoticeText

    def translation_key(self, key: NoticeKey, language: str, text: NoticeText) -> TranslationKey:
        source, alert_id, _ = key
        upstream_id = None if alert_id.startswith("anonymous:") else alert_id
        return source, upstream_id, self.scope, language, text


def translation_reissues(variants: dict[NoticeKey, NoticeVariant]) -> dict[NoticeKey, NoticeKey]:
    bilingual: dict[TranslationKey, NoticeKey | None] = {}
    for key, variant in variants.items():
        if any(variant.en) and any(variant.fr):
            for language, text in (("en", variant.en), ("fr", variant.fr)):
                # A generic headline alone gives too little evidence for a match.
                if text[1]:
                    match = variant.translation_key(key, language, text)
                    bilingual[match] = None if match in bilingual else key

    aliases = {}
    for key, variant in variants.items():
        if any(variant.en) == any(variant.fr):
            continue
        language, text = ("en", variant.en) if any(variant.en) else ("fr", variant.fr)
        target = bilingual.get(variant.translation_key(key, language, text))
        if target is not None:
            aliases[key] = target
    return aliases


# The same headings the web treats as generic (apps/web/src/lib/v1/alertDisplay.ts).
_GENERIC_HEADINGS = frozenset(
    ("your stop", "your line", "votre arrêt", "votre arret", "votre ligne")
)


def _generic(text: str) -> bool:
    return re.sub(r"[\s.!:…]+$", "", text.strip().lower()) in _GENERIC_HEADINGS


def _wording(text: str | None) -> str | None:
    if not text:
        return None
    return " ".join(normalize("NFC", text).replace("'", "’").split()).removesuffix(".")


def distinct_notices(
    spans: Iterable[tuple[NoticeKey, int, int]], wording: dict[NoticeKey, NoticeWording]
) -> int:
    """How many notices a reader would call different.

    Two publications are one notice when they share an alert ID (later versions revise a
    notice) or when they say the same thing: the same wording in both languages, in
    effect over the same periods. So an agency that publishes one notice under several
    IDs, one per line or stop it affects, publishes one notice, and the count is never
    above the number of IDs. A publication without readable wording (empty, or only a
    generic "Your line" heading) gives no evidence that it repeats another ID. Translation
    reissues are folded into their original before this count.
    """
    periods: dict[NoticeKey, set[tuple[int, int]]] = defaultdict(set)
    for publication, start, end in spans:
        periods[publication].add((start, end))
    parent: dict[object, object] = {}

    def root(node: object) -> object:
        while (up := parent.setdefault(node, node)) != node:
            parent[node] = parent.setdefault(up, up)
            node = up
        return node

    for publication, intervals in periods.items():
        notice = root(publication[:2])
        words = wording.get(publication, (None, None, None, None))
        if any(text and text.strip() and not _generic(text) for text in words):
            said = (tuple(_wording(text) for text in words), tuple(sorted(intervals)))
            parent[root(said)] = notice
    return len({root(publication[:2]) for publication in periods})
