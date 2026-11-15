import json
from copy import deepcopy
from hashlib import sha256

import pytest

from transit_ops import metrics as real
from transit_ops.gold.reader.rates import min_service_days
from transit_ops.metrics import Arithmetic, Bilingual, Floor, Metric, Registry, Series, Source
from transit_ops.metrics.definitions import reliability as r
from transit_ops.ranking.rules import MeasureSpec


def sample_metrics(word):
    rate = Arithmetic(
        revision=3,
        kind="rate",
        numerator="ok",
        denominator="n",
        scale=(100, 1),
        precision=1,
        worse="lower",
        floor=Floor(trips=30, trips_of="reported", units=5, units_of="ok", service_days=True),
    )
    return tuple(
        Metric(
            id=id,
            series="sample",
            name=word,
            plain=Bilingual(en="Plain", fr="Simple"),
            exact=Bilingual(en="Exact", fr="Exacte"),
            limits=(Bilingual(en="Metric limit", fr="Limite de métrique"),),
            unit="percent",
            arithmetic=(arithmetic,),
            pair_with=pair,
        )
        for id, arithmetic, pair in (
            ("rate", rate, ("quantile", "average")),
            ("average", rate.model_copy(update={"kind": "average"}), ()),
            ("share", rate.model_copy(update={"kind": "share"}), ()),
            (
                "quantile",
                Arithmetic(revision=3, kind="quantile_bin", quantile="0.9", precision=0),
                (),
            ),
        )
    )


def entries():
    word = Bilingual(en="Units", fr="Unités")
    source = Source(
        dimension="line",
        time_of_day="all",
        day_type=False,
        summary="counts_and_histogram",
        histogram_layout=2,
        read_from="cells",
        cell_table="logical_cells",
        metrics=("rate", "average", "share", "quantile"),
        gate="sample",
    )
    stop = source.model_copy(
        update={
            "dimension": "stop",
            "summary": "counts",
            "histogram_layout": None,
            "metrics": ("rate",),
        }
    )
    series = Series(
        id="sample",
        revision=3,
        unit="readings",
        population_key="counted",
        population=Bilingual(en="Population", fr="Population"),
        limits=(Bilingual(en="Series limit", fr="Limite de série"),),
        windows=("day",),
        sources=(stop, source),
    )
    return (series,), sample_metrics(word)


def test_a_series_is_keyed_by_id_and_revision():
    series, metrics = entries()
    registry = Registry(series, metrics)
    assert registry.series("sample", 3) == series[0]
    assert registry.metric("rate") == metrics[0]
    with pytest.raises(KeyError):
        registry.series("sample", 4)


@pytest.mark.parametrize("locale", ["en", "fr"])
def test_every_lookup_but_metric_takes_the_revision(locale):
    registry = Registry(*entries())
    assert registry.arithmetic("rate", 3).numerator == "ok"
    assert tuple(s.dimension for s in registry.sources_for("quantile", 3)) == ("line",)
    descriptions = {
        "en": "Plain\nExact\nPopulation\nSeries limit\nMetric limit",
        "fr": "Simple\nExacte\nPopulation\nLimite de série\nLimite de métrique",
    }
    assert registry.describe("rate", 3, locale) == descriptions[locale]
    for lookup in (registry.arithmetic, registry.sources_for, registry.describe):
        for id, revision in (("rate", 4), ("unknown", 3)):
            with pytest.raises(KeyError):
                lookup(id, revision)
    with pytest.raises(ValueError):
        registry.describe("rate", 3, "es")


@pytest.mark.parametrize(
    "change", ["series", "metric", "arithmetic", "reference", "pair", "source"]
)
def test_duplicate_or_broken_definitions_are_refused(change):
    series, metrics = entries()
    s, m = series[0], metrics[0]
    if change == "series":
        series += series
    elif change == "metric":
        metrics += (m,)
    elif change == "arithmetic":
        metrics = (m.model_copy(update={"arithmetic": m.arithmetic * 2}), *metrics[1:])
    elif change == "reference":
        series = (s.model_copy(update={"revision": 4}),)
    elif change == "pair":
        metrics = (m.model_copy(update={"pair_with": ("missing",)}), *metrics[1:])
    else:
        source = s.sources[0].model_copy(update={"metrics": ("missing",)})
        series = (s.model_copy(update={"sources": (source,)}),)
    with pytest.raises(ValueError):
        Registry(series, metrics)


@pytest.mark.parametrize(
    "en", ["", " ", "{other}", "{operator!r}", "{operator:>5}", "{operator.x}"]
)
def test_texts_use_only_the_two_placeholders(en):
    with pytest.raises(ValueError):
        Bilingual(en=en, fr="Unités")


def test_every_text_has_both_languages():
    assert Bilingual(en="{operator}", fr="{no_live_data_lines}").en == "{operator}"
    for values in (
        {"en": "Units"},
        {"en": "Units", "fr": " "},
        {"en": "Units", "fr": "Unités", "typo": "bad"},
    ):
        with pytest.raises(ValueError):
            Bilingual(**values)


@pytest.mark.parametrize(
    "change",
    [
        {"cell_table": ""},
        {"read_from": "archive"},
        {"histogram_layout": None},
        {"summary": "counts"},
    ],
)
def test_source_metadata_matches_its_storage_and_summary(change):
    source = entries()[0][0].sources[1]
    with pytest.raises(ValueError):
        Source.model_validate(source.model_dump() | change)


@pytest.mark.parametrize("kind,quantile", [("rate", "0.9"), ("quantile_bin", None)])
def test_a_quantile_metric_carries_its_quantile_and_no_other_does(kind, quantile):
    with pytest.raises(ValueError):
        Arithmetic(revision=3, kind=kind, quantile=quantile, precision=0)


def with_future_arithmetic(metric, keep_earlier=True):
    future = metric.arithmetic[0].model_copy(update={"revision": 4, "numerator": "future_operand"})
    arithmetic = (*metric.arithmetic, future) if keep_earlier else (future,)
    return metric.model_copy(update={"arithmetic": arithmetic})


def expected_spec(id, pair=None, numerator="ok"):
    return MeasureSpec(
        id,
        numerator,
        "n",
        "entity",
        (100, 1),
        1,
        "lower",
        "sample",
        30,
        "reported",
        5,
        "ok",
        True,
        pair,
    )


def test_a_nested_pair_is_the_specification_of_that_measure():
    series, metrics = entries()
    future = series[0].model_copy(update={"revision": 4, "sources": ()})
    later = tuple(with_future_arithmetic(m) if m.id in ("rate", "average") else m for m in metrics)
    registry = Registry((*series, future), later)
    assert registry.measure_spec("rate", 3) == expected_spec("rate", expected_spec("average"))
    assert registry.measure_spec("rate", 4) == expected_spec(
        "rate", expected_spec("average", numerator="future_operand"), numerator="future_operand"
    )
    assert registry.series("sample", 3) == series[0]
    assert tuple(registry.arithmetic(m.id, 3) for m in metrics) == tuple(
        m.arithmetic[0] for m in metrics
    )
    assert registry.measure_spec("share", 3).denominator_from == "network"
    with pytest.raises(ValueError):
        registry.measure_spec("quantile", 3)
    with pytest.raises(KeyError):
        registry.measure_spec("rate", 5)


def test_a_pair_never_borrows_another_revision():
    series, metrics = entries()
    s = series[0]
    sources = tuple(x.model_copy(update={"metrics": ("rate",)}) for x in s.sources)
    future = s.model_copy(update={"revision": 4, "sources": ()})
    metrics = tuple(with_future_arithmetic(m, False) if m.id == "average" else m for m in metrics)
    registry = Registry((s.model_copy(update={"sources": sources}), future), metrics)
    assert registry.measure_spec("rate", 3).pair is None
    bad = metrics[0].model_copy(
        update={"arithmetic": (metrics[0].arithmetic[0].model_copy(update={"numerator": None}),)}
    )
    with pytest.raises(ValueError):
        Registry(
            (s.model_copy(update={"sources": sources}), future), (bad, *metrics[1:])
        ).measure_spec("rate", 3)


def test_reliability_entries_resolve_through_package_bindings():
    from transit_ops import metrics

    ids = {"on_time_rate", "late_rate", "early_rate", "late_share", "trips_counted"}
    assert {m["id"] for m in metrics.export_registry(3)["metrics"]} == ids
    assert metrics.series("reliability", 3).population_key == "counted_readings"
    assert metrics.series("reliability", 3).unit == "readings"
    assert metrics.series("reliability", 3).in_availability_list is True
    assert metrics.series("reliability", 3).what_differed is None
    for id in ids:
        assert metrics.metric(id).series == "reliability"
        assert metrics.arithmetic(id, 3).revision == 3
        assert metrics.sources_for(id, 3)
        assert metrics.describe(id, 3)
        with pytest.raises(KeyError):
            metrics.arithmetic(id, 4)
    with pytest.raises(KeyError):
        metrics.series("reliability", 4)


def assembled(constants=None, layouts=None, metrics=r.METRICS, series=r.SERIES):
    return Registry(
        (series,),
        metrics,
        metric_constants=constants or r.METRIC_CONSTANTS,
        histogram_layouts=layouts or r.HISTOGRAM_LAYOUTS,
    )


def test_reliability_sources_match_the_approved_dimension_cut_matrix():
    expected = set()
    for dimensions, cut, table, hist, gate in (
        (("network", "line", "line_direction"), "all", "route_reading_day", 2, "on_time_rate"),
        (("network", "line", "line_direction"), "hour", "route_reading_hour", 2, "on_time_rate"),
        (
            ("network", "line", "line_direction"),
            "shift",
            "route_reading_shift_day",
            None,
            "on_time_rate",
        ),
        (("stop", "stop_line"), "all", "stop_reading_day", None, "stop_on_time_rate"),
        (("stop", "stop_line"), "shift", "stop_reading_shift_day", None, "stop_on_time_rate"),
    ):
        expected.update(
            (d, cut, dt, "gold." + table, hist, gate) for d in dimensions for dt in (False, True)
        )
    sources = real.series("reliability", 3).sources
    assert {
        (s.dimension, s.time_of_day, s.day_type, s.cell_table, s.histogram_layout, s.gate)
        for s in sources
    } == expected
    assert all(s.read_from == "cells" and set(s.metrics) == set(r.IDS) for s in sources)
    assert set(r.SERIES.windows) == {"day", "trailing_7", "trailing_30", "calendar_month", "range"}


def test_no_stop_source_lists_a_percentile():
    for s in real.series("reliability", 3).sources:
        assert s.summary == ("counts_and_histogram" if s.histogram_layout else "counts")
        if s.dimension in ("stop", "stop_line"):
            assert s.summary == "counts" and not any(id.startswith("delay_p") for id in s.metrics)


@pytest.mark.parametrize(
    "id,kind,num,den,worse",
    [
        ("on_time_rate", "rate", "on_time", "n", "lower"),
        ("late_rate", "rate", "late", "n", "higher"),
        ("early_rate", "rate", "early", "n", "higher"),
        ("late_share", "share", "late", "late", "higher"),
        ("trips_counted", "count", "trips", None, None),
    ],
)
def test_reliability_arithmetic_names_the_real_operands(id, kind, num, den, worse):
    a = real.arithmetic(id, 3)
    assert (a.kind, a.numerator, a.denominator, a.worse, a.quantile) == (
        kind,
        num,
        den,
        worse,
        None,
    )
    count = id == "trips_counted"
    assert real.metric(id).unit == ("trips" if count else "percent")
    expected = ((1, 1), 0, Floor()) if count else ((100, 1), 1, Floor(trips=30, service_days=True))
    assert (a.scale, a.precision, a.floor) == expected
    if count:
        with pytest.raises(ValueError):
            real.measure_spec(id, 3)
    else:
        assert real.measure_spec(id, 3).denominator_from == (
            "network" if kind == "share" else "entity"
        )


def test_rate_pairs_are_deferred_only_until_delay_entries():
    # MR1d replaces this transitional assertion when late_avg is registered.
    for id in ("on_time_rate", "late_rate", "early_rate"):
        assert real.metric(id).pair_with == () and real.measure_spec(id, 3).pair is None
    assert real.measure_spec("late_share", 3).pair == real.measure_spec("late_rate", 3)


def test_bands_floors_and_histogram_edges_are_their_owners_constants():
    from transit_ops.gold.reader import bands, delay_hist, rates

    assert r.HISTOGRAM_LAYOUTS == {2: delay_hist.DELAY_HIST_LAYOUTS[2].edges_s}
    floors = {"TRIP_FLOOR": rates.TRIP_FLOOR, "service_day_rule": r.SERVICE_DAY_RULE}
    edges = {
        "EARLY_BELOW_SECONDS": bands.EARLY_BELOW_SECONDS,
        "LATE_ABOVE_SECONDS": bands.LATE_ABOVE_SECONDS,
    }
    for id, names in (
        ("on_time_rate", tuple(edges)),
        ("late_rate", ("LATE_ABOVE_SECONDS",)),
        ("late_share", ("LATE_ABOVE_SECONDS",)),
        ("early_rate", ("EARLY_BELOW_SECONDS",)),
        ("trips_counted", ()),
    ):
        constants = {k: edges[k] for k in names} | (floors if names else {})
        assert r.METRIC_CONSTANTS[id, 3] == constants
        preimage = real.arithmetic(id, 3).model_dump() | {
            "constants": constants,
            "series": "reliability",
            "unit": real.metric(id).unit,
        }
        assert (
            real.metric_pin(id, 3)
            == sha256(
                json.dumps(
                    preimage, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                ).encode()
            ).hexdigest()
        )
    preimage = (
        '{"constants":{},"denominator":null,"floor":{"service_days":false,"trips":null,'
        '"trips_of":"trips","units":null,"units_of":null},"kind":"count","numerator":"trips",'
        '"precision":0,"quantile":null,"revision":3,"scale":[1,1],"series":"reliability",'
        '"unit":"trips","worse":null}'
    )
    assert real.metric_pin("trips_counted", 3) == sha256(preimage.encode()).hexdigest()


def test_pinned_service_day_rule_matches_its_computational_owner():
    rule = r.SERVICE_DAY_RULE
    minimum, (num, den) = rule["service_day_range"]
    for width in range(1, 367):
        base = rule["service_day_base"].get(
            {1: "day", 7: "trailing_7", 30: "trailing_30"}.get(width)
        )
        if base is None:
            base = min(width, max(minimum, (width * num + den - 1) // den))
        for scheduled in range(width + 1):
            assert min(base, max(rule["service_day_never_below"], scheduled)) == min_service_days(
                width, scheduled
            )
    assert [min_service_days(w, s) for w, s in ((1, 1), (3, 2), (7, 2), (30, 8), (30, 30))] == [
        1,
        3,
        4,
        8,
        15,
    ]


@pytest.mark.parametrize(
    "key,affected",
    [
        ("LATE_ABOVE_SECONDS", {"on_time_rate", "late_rate", "late_share"}),
        ("EARLY_BELOW_SECONDS", {"on_time_rate", "early_rate"}),
        ("service_day_rule", {"on_time_rate", "late_rate", "early_rate", "late_share"}),
    ],
)
def test_real_pin_dependencies_move_only_the_definitions_that_use_them(key, affected):
    constants = deepcopy(r.METRIC_CONSTANTS)
    for values in constants.values():
        if key in values:
            values[key] = {"changed": 1} if key == "service_day_rule" else values[key] + 1
    changed = assembled(constants)
    assert {id for id in r.IDS if changed.metric_pin(id, 3) != real.metric_pin(id, 3)} == affected
    assert changed.series_pin("reliability", 3) == real.series_pin("reliability", 3)


def test_layout_two_changes_only_the_reliability_series_pin_here():
    changed = assembled(layouts={2: (-60, 301), 3: (123,)})
    assert changed.series_pin("reliability", 3) != real.series_pin("reliability", 3)
    assert all(changed.metric_pin(id, 3) == real.metric_pin(id, 3) for id in r.IDS)
    assert assembled(layouts=r.HISTOGRAM_LAYOUTS | {3: (123,)}).series_pin(
        "reliability", 3
    ) == real.series_pin("reliability", 3)


def test_reliability_words_are_complete_and_do_not_change_definition_pins():
    # Frozen from the approved W1-W3 table, independently of the definitions.
    assert (
        real.wording_sha256() == "e7b8748ed16edf94853c4c4969ec4c07420c8dff1bfe05ae78ae10ed23496e1f"
    )
    assert real.metric("on_time_rate").name == Bilingual(
        en="On-time rate", fr="Taux de ponctualité"
    )
    assert real.metric("late_share").name == Bilingual(
        en="Share of the network's late units", fr="Part des unités en retard du réseau"
    )
    for id in r.IDS:
        m = real.metric(id)
        assert m.aliases == () and m.reference is None
        for locale in ("en", "fr"):
            words = (m.name, m.plain, m.exact, r.SERIES.population, *r.SERIES.limits, *m.limits)
            assert all(getattr(w, locale).strip() and "{" not in getattr(w, locale) for w in words)
            assert real.describe(id, 3, locale).splitlines() == [
                getattr(w, locale)
                for w in (m.plain, m.exact, r.SERIES.population, *r.SERIES.limits, *m.limits)
            ]
    changed = assembled(
        metrics=(
            r.METRICS[0].model_copy(update={"name": Bilingual(en="Correction", fr="Correction")}),
            *r.METRICS[1:],
        )
    )
    assert changed.wording_sha256() != real.wording_sha256()
    assert changed.export_registry(3)["pins"] == real.export_registry(3)["pins"]


def test_late_share_uses_its_quoted_not_defined_override():
    from transit_ops.metrics import AbsenceKey
    from transit_ops.metrics.absence import absence_sentence

    for locale, text in (
        ("en", "No late reading in the network in this window"),
        ("fr", "Aucun relevé en retard sur le réseau dans cette fenêtre"),
    ):
        key = AbsenceKey("not_defined", None)
        assert getattr(real.metric("late_share").absence_overrides[key], locale) == text
        assert absence_sentence("late_share", key, locale) == text


def test_real_export_keeps_cell_tables_private():
    assert "cell_table" not in json.dumps(real.export_registry(3))
    assert all(s.cell_table for s in real.series("reliability", 3).sources)
    source = r.SERIES.sources[0].model_copy(update={"cell_table": "other_counts"})
    series = r.SERIES.model_copy(update={"sources": (source, *r.SERIES.sources[1:])})
    assert assembled(series=series).series_pin("reliability", 3) != real.series_pin(
        "reliability", 3
    )
