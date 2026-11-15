"""One table from what the engine, a file or the capabilities record says to a sentence."""

from collections.abc import Mapping
from operator import attrgetter
from types import MappingProxyType
from typing import NamedTuple

import transit_ops.metrics as package

from .model import AbsenceKey as AbsenceKey
from .model import Bilingual, Series, Source
from .registry import Registry


class AbsenceEntry(NamedTuple):
    owner: str
    sentence: Bilingual


def _row(owner: str, en: str, fr: str) -> AbsenceEntry:
    return AbsenceEntry(owner, Bilingual(en=en, fr=fr))


_SAME_DAY = _row("S0.1", "Not measured that day", "Non mesuré ce jour-là")
# Sentences keep their {operator} placeholder: the page that shows one fills it in.
ABSENCE: Mapping[AbsenceKey, AbsenceEntry] = MappingProxyType(
    {
        AbsenceKey("not_measured", "schedule_not_kept"): _row(
            "S0.1", "Schedule not kept that day", "Horaire non conservé ce jour-là"
        ),
        AbsenceKey("not_measured", "captures_not_available"): _SAME_DAY,
        AbsenceKey("not_measured", "no_capture_record"): _SAME_DAY,
        AbsenceKey("not_measured", "capture_gap"): _SAME_DAY,
        AbsenceKey("not_measured", "window_too_short"): _SAME_DAY,
        AbsenceKey("not_measured", "schedule_mismatch"): _SAME_DAY,
        AbsenceKey("not_measured", "applicability_unresolved"): _row(
            "S0.1",
            "Not measured: it is not known yet whether this line has live data",
            "Non mesuré : on ne sait pas encore si cette ligne a des données en direct",
        ),
        AbsenceKey("not_measured", None): _row("S0.1", "Not measured", "Non mesuré"),
        AbsenceKey("not_tracked", None): _row(
            "S0.1",
            "Not tracked: {operator} has no such feed",
            "Non suivi : {operator} n'a pas de flux de ce type",
        ),
        AbsenceKey("not_published", None): _row(
            "S0.1", "Not published by {operator}", "Non publié par {operator}"
        ),
        AbsenceKey("no_live_data", None): _row(
            "S0.1",
            "No live data: {operator} publishes none for this service",
            "Aucune donnée en direct : {operator} n'en publie pas pour ce service",
        ),
        AbsenceKey("unsupported", None): _row(
            "S0.2",
            "Not available: {operator}'s feeds do not carry what this figure needs",
            "Non disponible : les flux publiés par {operator} "
            "ne fournissent pas ce que ce chiffre exige",
        ),
        AbsenceKey("not_applicable", None): _row(
            "S0.2",
            "Does not apply to {operator}'s network",
            "Ne s'applique pas au réseau exploité par {operator}",
        ),
        AbsenceKey("missing", None): _row(
            "S0.2",
            "No data yet: it is not known whether {operator}'s feeds can provide this figure",
            "Pas encore de données : on ne sait pas si les flux publiés par {operator} "
            "permettent ce chiffre",
        ),
        AbsenceKey("stale", None): _row(
            "S0.2",
            "No recent data: the last check of {operator}'s feeds is out of date",
            "Pas de données récentes : la dernière vérification des flux publiés par "
            "{operator} n'est plus à jour",
        ),
        AbsenceKey("below_floor", "too_few_trips"): _row(
            "S0.5", "Too few trips to judge", "Trop peu de trajets pour juger"
        ),
        AbsenceKey("below_floor", "too_few_service_days"): _row(
            "S0.5", "Too few service days to judge", "Trop peu de jours de service pour juger"
        ),
        AbsenceKey("below_floor", "too_few_units"): _row(
            "S0.5", "Too few late readings to judge", "Trop peu de relevés en retard pour juger"
        ),
        AbsenceKey("not_defined", None): _row(
            "S0.5",
            "Not defined in this window: there is nothing to divide by",
            "Non défini sur cette fenêtre : le dénominateur est nul",
        ),
    }
)


def _registry(registry: Registry | None) -> Registry:
    # Resolved at call time: the entries packet owns the package REGISTRY.
    return package.REGISTRY if registry is None else registry


_NOTHING_ABSENT = frozenset({"ranked", "supported", "partial"})
_CAPABILITY_STATES = frozenset(
    {"supported", "partial", "unsupported", "not_applicable", "missing", "stale"}
)
_BELOW_FLOOR = frozenset(k.reason for k in ABSENCE if k.state == "below_floor")
_REASONED = frozenset({"not_measured", "unsupported"})
_STATE_ONLY = frozenset(k.state for k in ABSENCE if k.reason is None) - _REASONED


def _known(key: AbsenceKey) -> AbsenceKey:
    if key in ABSENCE:
        return key
    if key.state == "unsupported":
        return AbsenceKey("unsupported", None)
    raise ValueError(f"no absence row for {key}")


def absence_key(state: str, reason: str | None = None) -> AbsenceKey | None:
    if state in _NOTHING_ABSENT:
        return None
    if state in _BELOW_FLOOR:
        return AbsenceKey("below_floor", state)
    if state in _STATE_ONLY:
        return AbsenceKey(state, None)
    if state in _REASONED:
        return _known(AbsenceKey(state, reason))
    raise ValueError(f"no source says {state!r}")


def absence_sentence(
    metric_id: str, key: AbsenceKey, locale: str, *, registry: Registry | None = None
) -> str:
    if locale not in ("en", "fr"):
        raise ValueError("unsupported locale")
    overrides = _registry(registry).metric(metric_id).absence_overrides
    key = _known(key)
    text = overrides.get(key) or ABSENCE[key].sentence
    return text.en if locale == "en" else text.fr


def available_sources(
    revision: int, capabilities: Mapping[str, str], *, registry: Registry | None = None
) -> list[tuple[Series, Source]]:
    # An absent gate is missing evidence: the source stays, which proves no support.
    if not set(capabilities.values()) <= _CAPABILITY_STATES:
        raise ValueError("unknown capability state")
    return [
        (s, source)
        for s in _registry(registry).series_for_revision(revision)
        for source in sorted(s.sources, key=attrgetter("dimension", "time_of_day", "day_type"))
        if capabilities.get(source.gate) not in ("unsupported", "not_applicable")
    ]


def available_metrics(
    revision: int,
    capabilities: Mapping[str, str],
    *,
    dimension: str,
    time_of_day: str = "all",
    day_type: bool = False,
    registry: Registry | None = None,
) -> frozenset[str]:
    cut = (dimension, time_of_day, day_type)
    return frozenset(
        id
        for _, source in available_sources(revision, capabilities, registry=registry)
        if (source.dimension, source.time_of_day, source.day_type) == cut
        for id in source.metrics
    )
