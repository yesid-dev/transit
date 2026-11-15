from transit_ops.gold.reader.bands import EARLY_BELOW_SECONDS, LATE_ABOVE_SECONDS
from transit_ops.gold.reader.delay_hist import DELAY_HIST_LAYOUTS
from transit_ops.gold.reader.rates import TRIP_FLOOR
from transit_ops.ranking.rules import RULES

from ..model import AbsenceKey, Arithmetic, Bilingual, Floor, Metric, Series, Source


def _word(en: str, fr: str) -> Bilingual:
    return Bilingual(en=en, fr=fr)


IDS = ("on_time_rate", "late_rate", "early_rate", "late_share", "trips_counted")
RATE_FLOOR = Floor(trips=TRIP_FLOOR, trips_of="trips", service_days=True)
SERVICE_DAY_RULE = {
    "service_day_base": dict(RULES.service_day_base),
    "service_day_range": RULES.service_day_range,
    "service_day_never_below": RULES.service_day_never_below,
}
_FLOORS = {"TRIP_FLOOR": TRIP_FLOOR, "service_day_rule": SERVICE_DAY_RULE}
METRIC_CONSTANTS: dict[tuple[str, int], dict[str, object]] = {
    ("on_time_rate", 3): {
        "EARLY_BELOW_SECONDS": EARLY_BELOW_SECONDS,
        "LATE_ABOVE_SECONDS": LATE_ABOVE_SECONDS,
        **_FLOORS,
    },
    ("late_rate", 3): {"LATE_ABOVE_SECONDS": LATE_ABOVE_SECONDS, **_FLOORS},
    ("early_rate", 3): {"EARLY_BELOW_SECONDS": EARLY_BELOW_SECONDS, **_FLOORS},
    ("late_share", 3): {"LATE_ABOVE_SECONDS": LATE_ABOVE_SECONDS, **_FLOORS},
    ("trips_counted", 3): {},
}
HISTOGRAM_LAYOUTS = {2: DELAY_HIST_LAYOUTS[2].edges_s}
# Primary count metadata only; day histograms are composed from hour cells later.
SOURCES = tuple(
    Source.model_validate(
        {
            "dimension": dimension,
            "time_of_day": cut,
            "day_type": day_type,
            "summary": "counts_and_histogram" if histogram else "counts",
            "histogram_layout": 2 if histogram else None,
            "read_from": "cells",
            "cell_table": f"gold.{table}",
            "metrics": IDS,
            "gate": "stop_on_time_rate" if dimension.startswith("stop") else "on_time_rate",
        }
    )
    for dimensions, cut, table, histogram in (
        (("network", "line", "line_direction"), "all", "route_reading_day", True),
        (("network", "line", "line_direction"), "hour", "route_reading_hour", True),
        (("network", "line", "line_direction"), "shift", "route_reading_shift_day", False),
        (("stop", "stop_line"), "all", "stop_reading_day", False),
        (("stop", "stop_line"), "shift", "stop_reading_shift_day", False),
    )
    for dimension in dimensions
    for day_type in (False, True)
)


def _arithmetic(id: str) -> Arithmetic:
    count = id == "trips_counted"
    kind, numerator, denominator, worse = {
        "on_time_rate": ("rate", "on_time", "n", "lower"),
        "late_rate": ("rate", "late", "n", "higher"),
        "early_rate": ("rate", "early", "n", "higher"),
        "late_share": ("share", "late", "late", "higher"),
        "trips_counted": ("count", "trips", None, None),
    }[id]
    return Arithmetic.model_validate(
        {
            "revision": 3,
            "kind": kind,
            "numerator": numerator,
            "denominator": denominator,
            "scale": (1, 1) if count else (100, 1),
            "precision": 0 if count else 1,
            "worse": worse,
            "floor": Floor() if count else RATE_FLOOR,
        }
    )


def _metric(
    id: str,
    name: Bilingual,
    plain: Bilingual,
    exact: Bilingual,
    *,
    limits: tuple[Bilingual, ...] = (),
) -> Metric:
    return Metric(
        id=id,
        series="reliability",
        unit="trips" if id == "trips_counted" else "percent",
        name=name,
        plain=plain,
        exact=exact,
        limits=limits,
        pair_with=("late_rate",) if id == "late_share" else (),
        absence_overrides={
            AbsenceKey("not_defined", None): _word(
                "No late reading in the network in this window",
                "Aucun relevé en retard sur le réseau dans cette fenêtre",
            )
        }
        if id == "late_share"
        else {},
        arithmetic=(_arithmetic(id),),
    )


SERIES = Series(
    id="reliability",
    revision=3,
    unit="readings",
    population_key="counted_readings",
    windows=("day", "trailing_7", "trailing_30", "calendar_month", "range"),
    sources=SOURCES,
    population=_word(
        "A unit here is a reading: one trip in one minute, by the agency's prediction. It is "
        "the newest prediction the agency published for a trip under way, captured during that "
        "minute. Its delay is the one predicted for the trip's next stop. Only lines with live "
        "data that day give units, and a minute with no usable capture gives none.",
        "Ici, une unité est un relevé : une minute d'un trajet, selon la prévision de la "
        "société de transport. C'est la prévision la plus récente publiée par la société de "
        "transport pour un trajet en cours, captée pendant cette minute. Son écart par rapport "
        "à l'horaire est celui prévu pour le prochain arrêt du trajet. Seules les lignes qui "
        "ont des données en direct ce jour-là donnent des unités, et une minute sans capture "
        "utilisable n'en donne aucune.",
    ),
    limits=(
        _word(
            "A unit is a prediction, not an observed arrival or departure, and it does not prove "
            "that a vehicle moved.",
            "Une unité est une prévision, pas une arrivée ni un départ observés, et elle ne prouve "
            "pas qu'un véhicule s'est déplacé.",
        ),
        _word(
            "A unit is one minute of a trip, not a whole trip: a trip under way for 40 minutes "
            "gives up to 40 units, so a long trip weighs more than a short one.",
            "Une unité est une minute d'un trajet, pas un trajet entier : un trajet en cours "
            "pendant 40 minutes donne jusqu'à 40 unités, donc un long trajet pèse plus qu'un "
            "trajet "
            "court.",
        ),
        _word(
            "Units are not weighted by the number of riders: a minute of a crowded trip counts the "
            "same as a minute of an empty one.",
            "Les unités ne sont pas pondérées selon le nombre d'usagers : une minute d'un trajet "
            "bondé compte autant qu'une minute d'un trajet vide.",
        ),
        _word(
            "Two networks compare only when both feeds update at least once a minute and count "
            "units the same way.",
            "Deux réseaux ne se comparent que si leurs flux se mettent à jour au moins une fois "
            "par "
            "minute et comptent les unités de la même façon.",
        ),
    ),
)
ON_TIME_RATE = _metric(
    "on_time_rate",
    _word("On-time rate", "Taux de ponctualité"),
    _word(
        "The share of counted units that were on time, between 1 minute early and 5 minutes late.",
        "La part des unités comptées qui étaient à l'heure, soit entre 1 minute d'avance et 5 "
        "minutes de retard.",
    ),
    _word(
        "On-time units divided by all counted units in the window, as a percentage. A unit is "
        "on time when its delay against the schedule is between 1 minute early and 5 minutes "
        "late, both limits included.",
        "Les unités à l'heure divisées par l'ensemble des unités comptées dans la fenêtre, en "
        "pourcentage. Une unité est à l'heure quand son écart par rapport à l'horaire se situe "
        "entre 1 minute d'avance et 5 minutes de retard, bornes comprises.",
    ),
    limits=(
        _word(
            "It does not say how late the late units were.",
            "Il n'indique pas à quel point les unités en retard l'étaient.",
        ),
        _word(
            "It is not the agency's own published figure, which may be calculated another way.",
            "Ce n'est pas le taux publié par la société de transport, qui peut être calculé "
            "autrement.",
        ),
    ),
)
LATE_RATE = _metric(
    "late_rate",
    _word("Late rate", "Taux de retard"),
    _word(
        "The share of counted units that were late, more than 5 minutes behind the schedule.",
        "La part des unités comptées qui étaient en retard de plus de 5 minutes sur l'horaire.",
    ),
    _word(
        "Late units divided by all counted units in the window, as a percentage. A unit is late "
        "when it is more than 5 minutes behind the schedule.",
        "Les unités en retard divisées par l'ensemble des unités comptées dans la fenêtre, en "
        "pourcentage. Une unité est en retard quand elle a plus de 5 minutes de retard sur "
        "l'horaire.",
    ),
    limits=(
        _word(
            "It says how often units were late, not how late they were.",
            "Il indique à quelle fréquence les unités étaient en retard, pas à quel point.",
        ),
    ),
)
EARLY_RATE = _metric(
    "early_rate",
    _word("Early rate", "Taux d'avance"),
    _word(
        "The share of counted units that were early, more than 1 minute ahead of the schedule.",
        "La part des unités comptées qui étaient en avance de plus d'une minute sur l'horaire.",
    ),
    _word(
        "Early units divided by all counted units in the window, as a percentage. A unit is "
        "early when it is more than 1 minute ahead of the schedule.",
        "Les unités en avance divisées par l'ensemble des unités comptées dans la fenêtre, en "
        "pourcentage. Une unité est en avance quand elle a plus d'une minute d'avance sur "
        "l'horaire.",
    ),
)
LATE_SHARE = _metric(
    "late_share",
    _word("Share of the network's late units", "Part des unités en retard du réseau"),
    _word(
        "Of all late units in the network in this window, the share counted here.",
        "Sur toutes les unités en retard du réseau dans cette fenêtre, la part comptée ici.",
    ),
    _word(
        "Late units counted here, divided by all late units of the network in the same window, "
        "as a percentage. The network total includes every line with live data, ranked or not. "
        "With no late unit in the network, the share is not defined.",
        "Les unités en retard comptées ici, divisées par toutes les unités en retard du réseau "
        "dans la même fenêtre, en pourcentage. Le total du réseau inclut toutes les lignes qui "
        "ont des données en direct, classées ou non. Sans aucune unité en retard sur le réseau, "
        "la part n'est pas définie.",
    ),
    limits=(
        _word(
            "It grows with the number of units counted here, not only with how often they are "
            "late. "
            "The late rate says how often.",
            "Elle augmente avec le nombre d'unités comptées ici, pas seulement avec leur fréquence "
            "de retard. Le taux de retard indique à quelle fréquence.",
        ),
        _word(
            "It counts late units, not how late they were or how many riders they affected.",
            "Elle compte des unités en retard, pas l'ampleur des retards ni le nombre d'usagers "
            "touchés.",
        ),
    ),
)
TRIPS_COUNTED = _metric(
    "trips_counted",
    _word("Trips counted", "Trajets comptés"),
    _word(
        "The number of trips with at least one counted unit in this window.",
        "Le nombre de trajets ayant au moins une unité comptée dans cette fenêtre.",
    ),
    _word(
        "The number of trips with at least one counted unit in the window. A trip counts once, "
        "however many units it gave: this is a count of trips, not of units.",
        "Le nombre de trajets ayant au moins une unité comptée dans la fenêtre. Un trajet "
        "compte une seule fois, quel que soit son nombre d'unités : c'est un compte de trajets, "
        "pas d'unités.",
    ),
    limits=(
        _word(
            "It is not the number of trips scheduled or run: a trip with no counted unit is left "
            "out.",
            "Ce n'est pas le nombre de trajets prévus ni effectués : un trajet sans unité comptée "
            "n'y figure pas.",
        ),
    ),
)
METRICS = (ON_TIME_RATE, LATE_RATE, EARLY_RATE, LATE_SHARE, TRIPS_COUNTED)
