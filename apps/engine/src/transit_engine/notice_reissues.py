"""Identify translations of a published notice within a read window."""

from dataclasses import dataclass
from unicodedata import normalize

type NoticeKey = tuple[str, str, str]
type NoticeText = tuple[str, str]
type NoticeScope = tuple[tuple[str, ...], tuple[str, ...], str, str | None, str | None]
type TranslationKey = tuple[str, str | None, NoticeScope, str, NoticeText]


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
