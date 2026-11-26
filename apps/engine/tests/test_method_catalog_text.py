"""Regression guards for public method registry text in English and Québec French."""

from __future__ import annotations

import re

from transit_engine import measures, ranking, schedule


def _all_catalog_prose(lang: str) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for entry in measures.methods():
        label = entry["id"]
        items.append((f"{label}.family_text", entry["family_text"][lang]))
        for field, value in entry["text"][lang].items():
            if field != "unit":
                items.append((f"{label}.{field}", value))
    return items


def test_catalog_has_no_internal_versions_or_jargon_in_en_and_fr() -> None:
    banned = (
        re.compile(r"\b(?:cleaning|nettoyage)\s+v\d+\b", re.IGNORECASE),
        re.compile(r"\bfrom\s+v\d+\b|\bversion\s+v?\d+\b", re.IGNORECASE),
        re.compile(r"\b(?:engine|moteur)\b", re.IGNORECASE),
        re.compile(r"\b(?:snapshot|instantané)s?\b", re.IGNORECASE),
        re.compile(r"/v1\b"),
        re.compile(r"\b(?:spine|silver)\b", re.IGNORECASE),
        re.compile(r"\bNULL\b"),
        re.compile(r"\bslice-[\w.-]+", re.IGNORECASE),
        re.compile(r"\bclean tables\b|\btables nettoyées\b", re.IGNORECASE),
        re.compile(r"\b(?:seconds|secondes)\b", re.IGNORECASE),
    )
    for lang in ("en", "fr"):
        for location, text in _all_catalog_prose(lang):
            for pattern in banned:
                assert not pattern.search(text), (
                    f"{lang} {location} matched {pattern.pattern}: {text}"
                )


def test_catalog_definitions_are_full_sentences_and_limits_match_their_label() -> None:
    for entry in measures.methods():
        for lang in ("en", "fr"):
            definition = entry["text"][lang]["definition"]
            sentences = [
                part.strip() for part in re.split(r"(?<=[.!?])\s+", definition) if part.strip()
            ]
            assert sentences, f"{entry['id']} missing {lang} definition"
            for sentence in sentences:
                assert len(sentence.split()) >= 4, (
                    f"{entry['id']} {lang} has stub sentence: {sentence!r}"
                )
            limits = entry["text"][lang]["limits"]
            assert not limits.startswith("The answer covers measured days only.")
            assert not limits.startswith("A trip that ran had at least one confirmed stop.")
            assert not limits.startswith("Le résultat porte seulement sur les jours mesurés.")
            assert not limits.startswith("Un trajet effectué a au moins un arrêt confirmé.")


def test_catalog_quebec_french_meaning_terminology_and_typography() -> None:
    by_id = {entry["id"]: entry for entry in measures.methods()}
    assert "qui se chevauchent" in by_id["alerts"]["text"]["fr"]["counts"]
    assert "périodes communes" not in by_id["alerts"]["text"]["fr"]["counts"]
    pred = by_id["prediction_error"]["text"]["fr"]
    assert "faites 40 minutes ou plus à l’avance" in pred["limits"]
    assert "prévision moins observation" in pred["definition"]
    assert "30 passages observés aux arrêts" in pred["limits"]
    gaps_rate = by_id["vehicle_reporting_gaps_per_100_hours"]["text"]
    assert "2 vehicle-hours" in gaps_rate["en"]["limits"]
    assert "2 heures-véhicules" in gaps_rate["fr"]["limits"]
    assert by_id["crowding_empty"]["family_text"]["fr"] == "Occupation des véhicules"
    assert "Retard minimal (s)" in by_id["delay_distribution"]["csv_columns"]["fr"]
    assert "Retard maximal (s)" in by_id["delay_distribution"]["csv_columns"]["fr"]
    assert "passages aux arrêts" in ranking._RANGE_NOTES["wilson_95"].fr
    assert "95\u00a0%" in ranking._RANGE_NOTES["wilson_95"].fr
    assert "historique des avis" in ranking._RANGE_NOTES["recorded_alert_hours"].fr
    assert schedule.periods_text("fr").startswith("nuit (0\u00a0h à 5\u00a0h)")

    banned_fr = (
        re.compile(r"\b(?:alerte|alertes)\b", re.IGNORECASE),
        re.compile(r"\bachalandage\b", re.IGNORECASE),
        re.compile(r"\bpercentiles?\b", re.IGNORECASE),
        re.compile(r"\bexploitant\b", re.IGNORECASE),
        re.compile(r"\bagence\b", re.IGNORECASE),
        re.compile(r"ne contribuent aucune", re.IGNORECASE),
        re.compile(r"plus au plus", re.IGNORECASE),
        re.compile(r"délai source", re.IGNORECASE),
        re.compile(r"Véhicule-secondes", re.IGNORECASE),
        re.compile(r"événements observés à l’arrêt", re.IGNORECASE),
        re.compile(r"jours de capture", re.IGNORECASE),
        re.compile(r"\d%"),
        re.compile(r"\d %"),
        re.compile(r" :"),
    )
    for location, text in _all_catalog_prose("fr"):
        for pattern in banned_fr:
            assert not pattern.search(text), f"fr {location} matched {pattern.pattern}: {text}"
    for entry in measures.methods():
        for column in entry["csv_columns"]["fr"]:
            assert not re.search(r"\b(?:alerte|alertes|achalandage)\b", column, re.IGNORECASE), (
                f"fr csv column in {entry['id']}: {column}"
            )
            assert "Véhicule-secondes" not in column
