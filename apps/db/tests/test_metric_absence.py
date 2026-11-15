from itertools import batched
from typing import get_args

import pytest

from transit_ops.metrics import Arithmetic, Bilingual, Metric, Registry, Series, Source
from transit_ops.metrics.absence import (
    ABSENCE,
    AbsenceKey,
    absence_key,
    absence_sentence,
    available_metrics,
    available_sources,
)
from transit_ops.ranking.engine import RankState

WORD = Bilingual(en="Synthetic", fr="Synthétique")
ALERT = Bilingual(
    en="Not tracked: {operator} has no alert feed",
    fr="Non suivi : {operator} n'a pas de flux d'alertes",
)
LATE = Bilingual(
    en="No late reading in the network in this window",
    fr="Aucun relevé en retard sur le réseau dans cette fenêtre",
)


def metric(id, series, revisions=(3,), overrides=None):
    arithmetic = tuple(Arithmetic(revision=r, kind="count", precision=0) for r in revisions)
    words = {"name": WORD, "plain": WORD, "exact": WORD, "absence_overrides": overrides or {}}
    return Metric(id=id, series=series, unit="count", arithmetic=arithmetic, **words)


def source(dimension, gate, metrics, time_of_day="all", day_type=False):
    cut = {"dimension": dimension, "time_of_day": time_of_day, "day_type": day_type}
    cells = {"summary": "counts", "read_from": "cells", "cell_table": f"{dimension}_cells"}
    return Source(**cut, **cells, metrics=metrics, gate=gate)


def series(id, revision, *sources, live=False):
    listed = {"windows": ("live",) if live else ("day",), "in_availability_list": not live}
    words = {"unit": "readings", "population_key": "counted", "population": WORD, "limits": ()}
    return Series(id=id, revision=revision, sources=sources, **listed, **words)


LINE = source("line", "on_time_rate", ("on_time", "late_share"))
LINE_DAY_TYPE = source("line", "on_time_rate", ("on_time",), day_type=True)
LINE_SHIFT = source("line", "on_time_rate", ("on_time",), time_of_day="shift")
STOP = source("stop", "stop_on_time_rate", ("on_time",))
STOP_DAY_TYPE = source("stop", "stop_on_time_rate", ("on_time",), day_type=True)
ALERTS = source("network", "alerts", ("alerts_distinct",))
LIVE = source("line_direction", "vehicle_positions", ("vehicles_seen",))
PUNCTUALITY = (LINE, LINE_DAY_TYPE, LINE_SHIFT, STOP, STOP_DAY_TYPE)
SERIES = (
    series("alerts", 3, ALERTS),
    series("punctuality", 3, *PUNCTUALITY),
    series("punctuality", 4, source("line", "on_time_rate", ("on_time",))),
    series("vehicles", 3, LIVE, live=True),
)
METRICS = (
    metric("alerts_distinct", "alerts", overrides={AbsenceKey("not_tracked", None): ALERT}),
    metric("late_share", "punctuality", overrides={AbsenceKey("not_defined", None): LATE}),
    metric("on_time", "punctuality", revisions=(3, 4)),
    metric("vehicles_seen", "vehicles"),
)
REGISTRY = Registry(SERIES, METRICS)
GATES = ("on_time_rate", "stop_on_time_rate")

# S0.5 A4, quoted independently of absence.py: "state [reasons] owner", English, French.
# French "de {operator}" became "publiés/exploité par {operator}" (owner-approved, 2026-11-14).
A4 = """
not_measured schedule_not_kept S0.1
Schedule not kept that day
Horaire non conservé ce jour-là
not_measured captures_not_available no_capture_record capture_gap S0.1
Not measured that day
Non mesuré ce jour-là
not_measured window_too_short schedule_mismatch S0.1
Not measured that day
Non mesuré ce jour-là
not_measured applicability_unresolved S0.1
Not measured: it is not known yet whether this line has live data
Non mesuré : on ne sait pas encore si cette ligne a des données en direct
not_measured S0.1
Not measured
Non mesuré
not_tracked S0.1
Not tracked: {operator} has no such feed
Non suivi : {operator} n'a pas de flux de ce type
not_published S0.1
Not published by {operator}
Non publié par {operator}
no_live_data S0.1
No live data: {operator} publishes none for this service
Aucune donnée en direct : {operator} n'en publie pas pour ce service
unsupported S0.2
Not available: {operator}'s feeds do not carry what this figure needs
Non disponible : les flux publiés par {operator} ne fournissent pas ce que ce chiffre exige
not_applicable S0.2
Does not apply to {operator}'s network
Ne s'applique pas au réseau exploité par {operator}
missing S0.2
No data yet: it is not known whether {operator}'s feeds can provide this figure
Pas encore de données : on ne sait pas si les flux publiés par {operator} permettent ce chiffre
stale S0.2
No recent data: the last check of {operator}'s feeds is out of date
Pas de données récentes : la dernière vérification des flux publiés par {operator} n'est plus à jour
below_floor too_few_trips S0.5
Too few trips to judge
Trop peu de trajets pour juger
below_floor too_few_service_days S0.5
Too few service days to judge
Trop peu de jours de service pour juger
below_floor too_few_units S0.5
Too few late readings to judge
Trop peu de relevés en retard pour juger
not_defined S0.5
Not defined in this window: there is nothing to divide by
Non défini sur cette fenêtre : le dénominateur est nul
"""
TABLE = {
    (state, reason): (owner, en, fr)
    for head, en, fr in batched(A4.strip().splitlines(), 3)
    for state, *reasons, owner in [head.split()]
    for reason in reasons or [None]
}


def both(metric_id, key):
    key = AbsenceKey(*key)
    return tuple(absence_sentence(metric_id, key, x, registry=REGISTRY) for x in ("en", "fr"))


def test_every_state_and_reason_has_one_sentence_in_both_languages():
    assert {k: (e.owner, e.sentence.en, e.sentence.fr) for k, e in ABSENCE.items()} == TABLE
    assert len(TABLE) == 19 and len({e.sentence for e in ABSENCE.values()}) == 15
    for key, (_, en, fr) in TABLE.items():
        assert both("on_time", key) == (en, fr)
    with pytest.raises(TypeError):
        ABSENCE[AbsenceKey("missing", None)] = ABSENCE[AbsenceKey("stale", None)]


def test_the_seven_reasons_of_not_measured_are_all_present():
    reasons = [r for s, r in TABLE if s == "not_measured" and r is not None]
    keys = [absence_key("not_measured", r) for r in reasons]
    assert len(set(keys)) == 7 and keys == [("not_measured", r) for r in reasons]
    with pytest.raises(ValueError):
        absence_key("not_measured", "schedule_not_keep")


def test_not_measured_with_no_reason_takes_the_generic_sentence():
    key = absence_key("not_measured")
    assert key == AbsenceKey("not_measured", None) == absence_key("not_measured", None)
    assert both("on_time", key) == ("Not measured", "Non mesuré")


def test_every_state_the_engine_or_a_file_can_say_has_a_key():
    floors = ("too_few_trips", "too_few_service_days", "too_few_units")
    words = ("not_defined", "no_live_data", "not_tracked", "not_published", "unsupported")
    said = {"ranked": None, "not_measured": ("not_measured", None)}
    said |= {s: ("below_floor", s) for s in floors}
    said |= {s: (s, None) for s in (*words, "not_applicable", "missing", "stale")}
    assert set(get_args(RankState)) <= said.keys()
    assert absence_key("not_measured", "capture_gap") == ("not_measured", "capture_gap")
    for state, key in said.items():
        assert absence_key(state) == key


def test_a_supported_or_partial_capability_is_no_absence():
    assert absence_key("supported") is None
    assert absence_key("partial") is None
    assert absence_key("partial", "some_trips_only") is None


def test_an_unsupported_reason_without_a_row_takes_the_generic_sentence():
    reasoned = ("unsupported", "no_stop_time_updates")
    assert absence_key(*reasoned) == ("unsupported", None)
    assert both("on_time", reasoned) == TABLE["unsupported", None][1:]
    with pytest.raises(ValueError):
        absence_key("unsuported", "no_stop_time_updates")


def test_an_unknown_state_raises():
    # below_floor is a row of the table, never a word the engine, a file or a record says.
    for said in (("rankd",), ("Missing",), ("",), ("below_floor", "too_few_units")):
        with pytest.raises(ValueError):
            absence_key(*said)


def test_an_override_replaces_the_row_for_one_metric():
    tracked, undefined = ("not_tracked", None), ("not_defined", None)
    assert both("alerts_distinct", tracked) == (ALERT.en, ALERT.fr)
    assert both("late_share", undefined) == (LATE.en, LATE.fr)
    assert both("on_time", tracked) == both("late_share", tracked) == TABLE[tracked][1:]
    assert both("on_time", undefined) == both("alerts_distinct", undefined) == TABLE[undefined][1:]


def test_unknown_metric_key_and_locale_are_refused():
    missing = AbsenceKey("missing", None)
    with pytest.raises(KeyError):
        absence_sentence("no_such_metric", missing, "en", registry=REGISTRY)
    for key in (("rankd", None), ("not_measured", "typo"), ("below_floor", None)):
        with pytest.raises(ValueError):
            both("on_time", key)
    for locale in ("de", "EN", "fr-CA", ""):
        with pytest.raises(ValueError):
            absence_sentence("on_time", missing, locale, registry=REGISTRY)
    assert all("{operator}" in text for text in both("on_time", missing))


def metrics_for(revision, capabilities, dimension, time_of_day="all", day_type=False):
    cut = {"dimension": dimension, "time_of_day": time_of_day, "day_type": day_type}
    return available_metrics(revision, capabilities, **cut, registry=REGISTRY)


def test_availability_is_per_dimension_and_cut():
    both = {"on_time_rate": "supported", "stop_on_time_rate": "supported"}
    assert metrics_for(3, both, "line") == {"on_time", "late_share"}
    assert metrics_for(3, both, "line", "shift") == {"on_time"}
    assert metrics_for(3, both, "line", day_type=True) == {"on_time"}
    assert metrics_for(3, both, "stop") == {"on_time"}
    assert metrics_for(3, both, "stop", day_type=True) == {"on_time"}
    assert metrics_for(3, both, "stop", "shift") == frozenset()
    assert metrics_for(3, both, "stop_line") == frozenset()
    assert metrics_for(4, both, "line") == {"on_time"}
    assert metrics_for(4, both, "stop") == frozenset()
    assert metrics_for(5, both, "line") == frozenset()


def test_stop_punctuality_unsupported_keeps_the_lines_table_and_drops_the_stops_table():
    lines_only = {"on_time_rate": "supported", "stop_on_time_rate": "unsupported"}
    assert metrics_for(3, lines_only, "line") == {"on_time", "late_share"}
    assert metrics_for(3, lines_only, "stop") == frozenset()
    stops_only = {"on_time_rate": "unsupported", "stop_on_time_rate": "supported"}
    assert metrics_for(3, stops_only, "line") == frozenset()
    assert metrics_for(3, stops_only, "stop") == {"on_time"}


def test_missing_and_stale_drop_no_source():
    for evidence in ("supported", "partial", "missing", "stale", None):
        capabilities = {} if evidence is None else dict.fromkeys(GATES, evidence)
        assert metrics_for(3, capabilities, "line") == {"on_time", "late_share"}
        assert metrics_for(3, capabilities, "stop") == {"on_time"}
    for removed in ("unsupported", "not_applicable"):
        assert metrics_for(3, dict.fromkeys(GATES, removed), "line") == frozenset()
        assert metrics_for(3, dict.fromkeys(GATES, removed), "stop") == frozenset()
    for invalid in ("Supported", "unknown", ""):
        with pytest.raises(ValueError):
            metrics_for(3, {"on_time_rate": "supported", "alerts": invalid}, "line")


def test_availability_does_not_apply_the_publication_list_filter():
    live = {"vehicle_positions": "supported"}
    assert metrics_for(3, live, "line_direction") == {"vehicles_seen"}
    assert (SERIES[3], LIVE) in available_sources(3, live, registry=REGISTRY)


def test_availability_keeps_source_identity_and_order():
    expected = [(SERIES[0], ALERTS), *[(SERIES[1], x) for x in PUNCTUALITY], (SERIES[3], LIVE)]
    assert available_sources(3, {}, registry=REGISTRY) == expected  # cell_table included
    flipped = [s.model_copy(update={"sources": s.sources[::-1]}) for s in SERIES[::-1]]
    reversed_registry = Registry(flipped, METRICS[::-1])
    pairs = available_sources(3, {}, registry=reversed_registry)
    assert [(s.id, x) for s, x in pairs] == [(s.id, x) for s, x in expected]
    ids = [s.id for s in reversed_registry.series_for_revision(3)]
    assert ids == ["alerts", "punctuality", "vehicles"]
    assert reversed_registry.series_for_revision(9) == ()
