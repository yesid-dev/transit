"""Declare measures here. Use ask() for answers and methods() for their definitions."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import InitVar, dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from itertools import batched
from time import perf_counter
from typing import Any, Literal, NamedTuple

import duckdb

from transit_engine.capture import (
    MAX_POLL_AGE_SECONDS,
    MAX_POLL_SPACING_SECONDS,
    POLL_COVERAGE_SQL,
    set_poll_age_limits,
)
from transit_engine.cities import service_query
from transit_engine.clean_manifest import (
    ALERTS,
    FEED_POLLS,
    PREDICTION_SAMPLES,
    SCHEDULED_STOP_TIMES,
    SEGMENT_RUNS,
    STOP_ELIGIBILITY_VERSION,
    STOP_EVENTS,
    TRIP_DAYS,
    VEHICLE_POSITIONS,
)
from transit_engine.corridors import (
    CORRIDOR_RUNS_SQL,
    MAX_SEGMENT_RUN_MULTIPLE,
    MIN_SEGMENT_RUNS,
    SEGMENT_BIN_SECONDS,
    SEGMENT_RUNS_SQL,
)
from transit_engine.histogram import DELAY_BIN_SECONDS as DELAY_BIN_SECONDS
from transit_engine.histogram import percentile as _percentile
from transit_engine.schedule import (
    BUNCHING_FRACTION,
    FREQUENT_HEADWAY_SECONDS,
    LONG_GAP_MULTIPLE,
    MIN_OBSERVED_HEADWAYS,
    MIN_TRIPS_PER_HOUR,
    PERIODS,
    period_sql,
    periods_text,
)
from transit_engine.scorecard import (
    FEED_MEASURES,
    MIN_PREDICTION_SAMPLES,
    MIN_SCORECARD_SAMPLES,
    SCORECARD,
    VEHICLE_FIELDS,
    Result,
    coverage_counts,
    feed_results,
    prediction_result,
    vehicle_counts,
)
from transit_engine.series import (
    DAY_TYPES as _DAY_TYPES,
)
from transit_engine.series import (
    GROUP_COLUMNS,
    HOUR_GROUPS,
    LOCAL_HOUR_BUCKET,
    SeriesGroup,
    day_type_sql,
    local_epoch_us_sql,
    local_hour_sql,
    matches_date,
    series_sql,
)
from transit_engine.series import (
    LOCAL_HOUR as _LOCAL_HOUR,
)
from transit_engine.store import CITY, CheckedDay, Store
from transit_engine.vehicles import (
    MIN_STABLE_ID_READINGS,
    MIN_STABLE_READING_SHARE,
    MIN_VEHICLE_RANKING_HOURS,
    MIN_VEHICLE_TERMINUS_SHARE,
    TRACKED_VEHICLES_SQL,
    VEHICLE_COUNTS,
    VEHICLE_POLL_SECONDS,
    VEHICLE_REPORTING_GAP_SECONDS,
    VEHICLE_TAIL_CAP_SECONDS,
    vehicle_end_sql,
    vehicle_hour_weight_sql,
    vehicle_stats_query,
    vehicle_tail_sql,
)

Language = Literal["en", "fr"]
EntityKind = Literal["line", "stop", "departure", "vehicle", "segment"]
type EntityKey = tuple[str | int | None, ...]


class Text(NamedTuple):
    en: str
    fr: str


# Transit R5, "What on time counts" and "The math":
# https://app.notion.com/p/41e3e863069081e193eaeee433839958
# Each scheduled trip stop counts once. Lines without live data are outside every rate.
EARLY_LIMIT_SECONDS = -60
LATE_LIMIT_SECONDS = 300
# A display floor consistent with Transit's historical 30-observation floor.
# A few stop events can dominate a share or percentile. This is not a confidence interval.
MIN_CLASSIFIED_STOP_EVENTS = 30
# With at least 20 known-state trips, one trip moves an unweighted share by at most 5 points.
# Apply the same display floor to the duration sample and to each boundary departure.
MIN_SERVICE_DELIVERED_TRIPS = 20
# Bound trip join memory independently of the requested range. Counts and bins are additive.
DAYS_PER_QUERY_BATCH = 31
MAX_SERIES_DAYS = 400
MIN_CANCELLATION_NOTICES = 10
MIN_VEHICLE_REPORTING_HOURS = 2


@dataclass(frozen=True)
class Measure:
    id: str
    unit: str
    definition: Text
    band: str | None = None
    count_label: Text | None = None
    percentile: int | None = None
    counts: Text | None = None
    limits: Text | None = None
    ratio: tuple[str, str] | None = None
    extra_tables: tuple[str, ...] = ()
    worst_first_descending: bool = False
    ranking_kinds: tuple[EntityKind, ...] | None = None
    source: str | None = None
    ranking_minimum_sample: int | None = None
    exclusions: Text | None = None
    minimum_sample: int | None = None


class Departure(NamedTuple):
    measure: str
    service_date: str
    scheduled_departure: str
    scheduled: int
    eligible: int
    ran: int
    unconfirmed: int
    route_without_live_data: int
    capture_gap: int


class AlertSpan(NamedTuple):
    source: str
    alert_id: str
    version: str
    start: int
    end: int


class OfferedCounts(NamedTuple):
    route_id: str
    direction_id: int | None
    day_type: str
    period: str
    trips: int
    at_or_above_minimum: int
    service_dates: list[str]


@dataclass
class Batch:
    counts: Counter[str] = field(default_factory=Counter)
    histogram: Counter[int] = field(default_factory=Counter)
    departures: list[Departure] = field(default_factory=list)
    scheduled_routes: set[str] = field(default_factory=set)
    alert_spans: set[AlertSpan] = field(default_factory=set)
    offered: list[OfferedCounts] = field(default_factory=list)
    vehicle_routes: set[str] = field(default_factory=set)
    stop_accessibility: dict[str, tuple[date, int | None]] = field(default_factory=dict)
    trip_ids: set[str] = field(default_factory=set)
    alert_messages: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)
    waiting_weighted_excess: float = 0.0

    def update(self, other: Batch) -> None:
        self.counts.update(other.counts)
        self.histogram.update(other.histogram)
        self.departures.extend(other.departures)
        self.scheduled_routes.update(other.scheduled_routes)
        self.alert_spans.update(other.alert_spans)
        self.offered.extend(other.offered)
        self.vehicle_routes.update(other.vehicle_routes)
        self.waiting_weighted_excess += other.waiting_weighted_excess
        for stop, declaration in other.stop_accessibility.items():
            previous = self.stop_accessibility.get(stop)
            if previous is None or declaration[0] > previous[0]:
                self.stop_accessibility[stop] = declaration
        self.trip_ids.update(other.trip_ids)
        self.alert_messages.update(other.alert_messages)


@dataclass(frozen=True)
class Family:
    id: str
    label: Text
    method_version: str
    since: str
    tables: tuple[str, ...]
    minimum_sample: int
    counts: Text
    exclusions: Text
    limits: Text
    measures: tuple[Measure, ...]
    query: (
        Callable[
            [
                duckdb.DuckDBPyConnection,
                Family,
                dict[str, list[str]],
                Question,
                str,
                EntityKind | None,
            ],
            dict[EntityKey, Batch],
        ]
        | None
    )
    columns: dict[str, Text] = field(default_factory=dict)
    evidence_columns: dict[str, Text] = field(default_factory=dict)
    bin_seconds: int = DELAY_BIN_SECONDS
    minimum_cleaning_version: int | None = None
    coverage: tuple[float, float] | None = None
    ranking_floors: dict[EntityKind, dict[str, int]] = field(default_factory=dict)


def _histogram_text(seconds: int) -> Text:
    return Text(
        f"Bins are {seconds} seconds wide, starting at multiples of "
        f"{seconds} seconds with the lower edge included. Cumulative counts locate "
        "the two ranks for the percentile, then we interpolate between the midpoints of "
        "their bins. The error is at most half a bin.",
        f"Les classes ont une largeur de {seconds} secondes. Elles commencent aux "
        f"multiples de {seconds} secondes, borne inférieure incluse. Les effectifs "
        "cumulés situent les deux rangs du centile, puis on interpole entre les milieux des "
        "classes correspondantes. L’erreur est d’au plus une demi-classe.",
    )


_STATES = {
    "measured": Text("Measured", "Mesuré"),
    "no_live_data": Text("No live data", "Aucune donnée en direct"),
    "not_measured": Text("Not measured", "Non mesuré"),
    "not_tracked": Text("Not tracked", "Non suivi"),
    "not_published": Text("Not published", "Non publié"),
    "too_few_to_judge": Text("Too few to judge", "Trop peu de données pour conclure"),
    "unknown": Text("Unknown", "Inconnu"),
    "no_frequent_periods": Text(
        "No frequent periods in this selection", "Aucune période de service fréquent dans ce choix"
    ),
    "no_evening_or_weekend_periods": Text(
        "No evening or weekend periods in this selection",
        "Aucune période en soirée ou en fin de semaine dans ce choix",
    ),
}
_PARTIAL = Text("Only measured days are included.", "Seuls les jours mesurés sont inclus.")
# Reverse the cleaner's GTFS local-noon-minus-12-elapsed-hours anchor.
_DEPARTURE_SECONDS = """
    epoch(scheduled_start_utc)
    - epoch(timezone(getvariable('service_timezone'), service_date + INTERVAL '12 hours')) + 43200
"""
_SERVICE_DELIVERED_ID = "service_delivered"
_CROWDING_ID = "crowding"
_ALERT_COUNTS_ID = "alert_counts"
_ALERT_ENTITY_GROUPS = ("line", "stop_id", "effect", "cause")
_WAITING_ID = "waiting_and_gaps"
_SERVICE_OFFERED_ID = "service_offered"
_VEHICLES_ID = "vehicles"
_CORRIDORS_ID = "corridors"
CORRIDOR_RANKING_DEFAULT = "median_time_lost"
_ACCESSIBILITY_ID = "accessibility"
VEHICLE_RANKING_DEFAULT = "vehicle_reporting_gaps_per_100_hours"
_BOUNDARIES = ("first_trip", "last_trip")


@dataclass(frozen=True)
class Question:
    measure: str
    city: str
    start: date
    end: date
    line: str | None = None
    direction: int | None = None
    stop: str | None = None
    departure: str | None = None
    hour: int | None = None
    day_type: str | None = None
    ranking: InitVar[bool] = False
    effect: str | None = None
    cause: str | None = None
    vehicle: str | None = None
    group: SeriesGroup | None = None
    from_stop: str | None = None
    to_stop: str | None = None
    alert_details: bool = False
    map_view: bool = False

    def __post_init__(self, ranking: bool) -> None:
        if self.measure not in _SELECTIONS:
            raise ValueError("unknown measure")
        if not CITY.fullmatch(self.city) or self.start > self.end:
            raise ValueError("provide a city and an ordered service date range")
        family, _ = _SELECTIONS[self.measure]
        if self.map_view and not (
            (self.measure == "late" and self.group == "stop_id" and not self.cuts())
            or (
                self.measure == "mean_time_lost" and self.group == "segment"
                and self.line is not None and self.cuts().keys() <= {"line", "direction"}
            )
        ):
            raise ValueError("map view requires network late share or time lost on one line")
        if self.alert_details:
            if self.measure != _ALERT_COUNTS_ID or self.group or ranking:
                raise ValueError("alert_details requires ungrouped alert_counts")
            if (self.end - self.start).days >= 7:
                raise ValueError("alert_details supports at most 7 service dates")
        if family.id == _CORRIDORS_ID:
            if self.stop is not None or self.departure is not None:
                raise ValueError("corridors use from_stop, to_stop and scheduled departure hour")
            if (self.from_stop is None) != (self.to_stop is None):
                raise ValueError("provide both from_stop and to_stop")
        elif self.from_stop is not None or self.to_stop is not None:
            raise ValueError("from_stop and to_stop apply to corridors")
        if self.group is not None:
            if family.query is None:
                raise ValueError("scorecard measures do not support group")
            if self.group not in GROUP_COLUMNS or ranking:
                raise ValueError("group must be " + ", ".join(GROUP_COLUMNS))
            if (self.end - self.start).days >= MAX_SERIES_DAYS:
                raise ValueError(f"a series can cover at most {MAX_SERIES_DAYS} days")
            if self.group == "direction" and (
                self.line is None or family.id in {_ALERT_COUNTS_ID, _VEHICLES_ID}
            ):
                raise ValueError(
                    "group=direction requires a measure that supports line and direction"
                )
        if family.id == SCORECARD:
            allowed = {"day_type"}
            if self.measure not in (*FEED_MEASURES, SCORECARD):
                allowed.update(("line", "direction", "stop", "hour"))
            if self.cuts().keys() - allowed:
                raise ValueError(
                    f"{self.measure} supports only {', '.join(sorted(allowed))}"
                    + (
                        ". Select an individual scorecard measure for other cuts."
                        if self.measure == SCORECARD
                        else ""
                    )
                )
        if self.group == "stop" and (self.line is None or family.id != _PUNCTUALITY.id):
            raise ValueError("group=stop requires a line and a punctuality measure")
        if self.group == "stop_id" and family.id not in {_PUNCTUALITY.id, _ALERT_COUNTS_ID}:
            raise ValueError("group=stop_id requires punctuality or alert counts")
        if self.group == "segment" and not self.map_view:
            raise ValueError("group=segment requires map view")
        if self.group == "line" and not (
            family.id in {_PUNCTUALITY.id, _ALERT_COUNTS_ID}
            or self.measure == "trips_run"
            or (family.id == _WAITING_ID and self.stop is not None)
            or (self.vehicle is not None and self.measure == "vehicle_trips_run")
        ):
            raise ValueError(
                "group=line requires punctuality, alert counts, trips_run, "
                "waiting and gaps with a stop, or vehicle_trips_run with a vehicle"
            )
        if self.group in ("effect", "cause") and family.id != _ALERT_COUNTS_ID:
            raise ValueError("group=effect and group=cause require alert counts")
        if self.group == "vehicle" and self.measure != "vehicle_days_in_service":
            raise ValueError("group=vehicle requires vehicle_days_in_service")
        if self.group == "departure" and (
            self.line is None or family.id != _SERVICE_DELIVERED_ID or self.measure in _BOUNDARIES
        ):
            raise ValueError("group=departure requires a line and a service delivery measure")
        if family.id == _VEHICLES_ID:
            if any(name not in {"vehicle", "day_type"} for name in self.cuts()):
                raise ValueError("vehicle measures support vehicle and day_type")
        elif self.vehicle is not None:
            raise ValueError("vehicle applies to vehicle measures")
        if family.id == _ALERT_COUNTS_ID:
            if any(
                cut is not None
                for cut in (self.direction, self.departure, self.hour, self.day_type)
            ):
                raise ValueError("alert counts support line, stop, effect and cause")
        elif self.effect is not None or self.cause is not None:
            raise ValueError("effect and cause apply to alert counts")
        if family.id == _CROWDING_ID and self.departure is not None:
            raise ValueError("crowding does not apply to scheduled departures")
        if family.id == _ACCESSIBILITY_ID and self.departure is not None:
            raise ValueError("accessibility does not apply to scheduled departures")
        if family.id == _ACCESSIBILITY_ID and self.group is not None:
            raise ValueError("accessibility does not support series grouping")
        if family.id == _SERVICE_DELIVERED_ID and self.stop is not None:
            raise ValueError("stop does not apply to service delivered trip measures")
        if self.measure in _BOUNDARIES:
            if (self.line is None and not ranking) or (
                self.day_type is None and self.group is None
            ):
                raise ValueError("first and last trip require line and day_type")
            if self.hour is not None or self.departure is not None:
                raise ValueError("first and last trip use the full day, without hour or departure")
        if self.departure is not None and (self.line is None or self.direction is None):
            raise ValueError("departure requires line and direction")

    def cuts(self) -> dict[str, str | int]:
        cuts = {
            "line": self.line,
            "direction": self.direction,
            "stop": self.stop,
            "departure": self.departure,
            "hour": self.hour,
            "day_type": self.day_type,
            "effect": self.effect,
            "cause": self.cause,
            "vehicle": self.vehicle,
            "from_stop": self.from_stop,
            "to_stop": self.to_stop,
        }
        return {name: value for name, value in cuts.items() if value is not None}


_COUNTS = {
    "scheduled": ("count(*) FILTER (scheduled)", Text("Scheduled stops", "Arrêts prévus")),
    "classified": ("count(delay_seconds)", Text("Classified stops", "Arrêts classés")),
    "added": ("count(*) FILTER (added)", Text("Added stops", "Arrêts ajoutés")),
    "cancelled": ("count(*) FILTER (cancelled)", Text("Cancelled stops", "Arrêts annulés")),
    "route_without_live_data": (
        "count(*) FILTER (without_live_data)",
        Text("Stops without live data", "Arrêts sans données en direct"),
    ),
    "capture_gap": (
        "count(*) FILTER (scheduled AND capture_gap)",
        Text(
            "Stops affected by capture gaps", "Arrêts touchés par une interruption de la collecte"
        ),
    ),
    "unclassified": (
        "count(*) FILTER (scheduled AND NOT capture_gap AND delay_seconds IS NULL)",
        Text("Other unclassified stops", "Autres arrêts non classés"),
    ),
}
_PUNCTUALITY_BASES = {
    "vehicle_stopped": Text("Vehicle stopped", "Véhicule à l’arrêt"),
    "vehicle_nearby": Text("Vehicle GPS near stop", "GPS du véhicule près de l’arrêt"),
    "trip_update_reported": Text("Trip update reported", "Mise à jour du trajet déclarée"),
    "trip_update_passed": Text("Trip update passed", "Mise à jour du trajet au passage"),
}
_EVIDENCE_COLUMNS = {
    "city": Text("City", "Ville"),
    "start_date": Text("From", "Du"),
    "end_date": Text("To", "Au"),
    "cuts": Text("Filters", "Filtres"),
    "days_measured": Text("Measured days", "Jours mesurés"),
    "days_not_measured": Text("Days not measured", "Jours non mesurés"),
    "days_included": Text("Included days", "Jours inclus"),
    "share_observed": Text("Observed share", "Part observée"),
    "cleaning_versions": Text("Cleaning versions", "Versions du nettoyage"),
    "method_version": Text("Method version", "Version de la méthode"),
    "query_ms": Text("Query time (ms)", "Durée de la requête (ms)"),
}
_CSV_COLUMNS = {
    "measure": Text("Measure", "Mesure"),
    "value": Text("Value", "Valeur"),
    "unit": Text("Unit", "Unité"),
    "state": Text("State", "État"),
    "coverage_note": Text("Coverage note", "Note sur la couverture"),
    **_EVIDENCE_COLUMNS,
}
_GROUP_LABELS = {
    "day": Text("Service date", "Date de service"),
    "hour": Text("Local hour", "Heure locale"),
    "day_type": Text("Service day type", "Type de jour de service"),
    "weekday": Text("ISO weekday", "Jour de la semaine ISO"),
    "direction": Text("Direction", "Direction"),
    "stop_sequence": Text("Stop sequence", "Ordre de l’arrêt"),
    "stop": Text("Stop ID", "Identifiant de l’arrêt"),
    "line": Text("Line ID", "Identifiant de la ligne"),
    "vehicle": Text("Vehicle number", "Numéro de véhicule"),
    "departure": Text("Scheduled departure", "Départ prévu"),
    "effect": Text("Published effect", "Effet publié"),
    "cause": Text("Published cause", "Cause publiée"),
}
_UNIT_LABELS = {
    "share": Text("Share", "Part"),
    "seconds": Text("Seconds", "Secondes"),
    "count": Text("Count", "Nombre"),
    "hours": Text("Hours", "Heures"),
    "vehicle_minutes": Text("Vehicle-minutes", "Minutes-véhicules"),
    "trips": Text("Trips", "Trajets"),
    "trips_per_hour": Text("Trips per hour", "Trajets par heure"),
    "periods": Text("Periods", "Périodes"),
    "per_100_vehicle_hours": Text("Per 100 vehicle-hours", "Par 100 heures-véhicules"),
    "per_100_trips": Text("Per 100 trips", "Par 100 trajets"),
}


_RANKING_FLOOR_LABELS = {
    "classified": Text("observed stop events", "événements observés à l’arrêt"),
    "observed_trips": Text("observed trips", "trajets observés"),
    "observed_service_dates": Text("observed service dates", "dates de service observées"),
    "observed_trip_pairs": Text("distinct trip pairs", "paires de trajets distinctes"),
    "observed_headways": Text("observed headways", "intervalles observés"),
    "occupancy_vehicle_hours": Text(
        "vehicle-hours with occupancy", "heures-véhicules avec achalandage"
    ),
    "eligible": Text("eligible trips", "trajets admissibles"),
}
_RANKING_FLOOR_KINDS = {
    "line": Text("Line rankings", "Les classements par ligne"),
    "stop": Text("Stop rankings", "Les classements par arrêt"),
    "departure": Text("Departure rankings", "Les classements par départ"),
}

_ALERT_MESSAGE_COLUMN = {"alert_messages": Text("Agency messages", "Avis de l’agence")}
_DEPARTURE_STOP_COLUMN = {
    "observed_delay_seconds": Text("Observed delay (s)", "Retard observé (s)")
}


def _info(
    family: Family, measure: Measure, extra_columns: dict[str, Text] | None = None
) -> dict[str, Any]:
    columns = {**_csv_columns(family), **(extra_columns or {})}
    histogram = _histogram_text(family.bin_seconds) if measure.percentile else None
    limits = measure.limits or family.limits
    coverage = _PUNCTUALITY.coverage if measure.id in _VEHICLE_PUNCTUALITY_IDS else family.coverage
    if coverage:
        minimum, warning = coverage
        limits = Text(
            f"{limits.en} Below {minimum:.0%} coverage the result is not measured. "
            f"Below {warning:.0%} coverage the evidence flags low coverage.",
            f"{limits.fr} Sous {minimum:.0%} de couverture, le résultat est non mesuré. "
            f"Sous {warning:.0%}, les données signalent une faible couverture.",
        )
    if family.id == SCORECARD and measure.id != "prediction_error":
        limits = Text(
            f"{limits.en} At least {family.minimum_sample} samples are required.",
            f"{limits.fr} Il faut au moins {family.minimum_sample} observations.",
        )
    if family.id == _SERVICE_DELIVERED_ID:
        limits = Text(
            f"{limits.en} Median cancellation lead time requires "
            f"{MIN_CANCELLATION_NOTICES} notices.",
            f"{limits.fr} Le préavis médian exige au moins {MIN_CANCELLATION_NOTICES} avis.",
        )
    ranking_floors = {
        kind: floors for kind, floors in family.ranking_floors.items()
        if measure.ranking_kinds is None or kind in measure.ranking_kinds
    }
    for kind, floors in ranking_floors.items():
        en, fr = (
            ", ".join(f"{floor} {getattr(_RANKING_FLOOR_LABELS[key], lang)}"
                      for key, floor in floors.items())
            for lang in ("en", "fr")
        )
        label = _RANKING_FLOOR_KINDS[kind]
        limits = Text(
            f"{limits.en} {label.en} require at least {en}.",
            f"{limits.fr} {label.fr} exigent au moins {fr}.",
        )
    if measure.minimum_sample is not None:
        limits = Text(
            f"{limits.en} This rate requires at least {measure.minimum_sample} "
            f"{'vehicle-hours' if measure.unit == 'per_100_hours' else 'assessed trips'}.",
            f"{limits.fr} Ce taux exige au moins {measure.minimum_sample} "
            f"{'heures-véhicules' if measure.unit == 'per_100_hours' else 'trajets évalués'}.",
        )
    return {
        "id": measure.id,
        "family": family.id,
        "unit": measure.unit,
        "method_version": family.method_version,
        "since": family.since,
        "tables": (*family.tables, *measure.extra_tables),
        "minimum_sample": (
            MIN_CLASSIFIED_STOP_EVENTS
            if family.id == _VEHICLES_ID and measure.id in _VEHICLE_PUNCTUALITY_IDS
            else MIN_PREDICTION_SAMPLES
            if measure.id == "prediction_error"
            else measure.minimum_sample
            if measure.minimum_sample is not None
            else family.minimum_sample
        ),
        **(
            {"ranking_minimum_sample": measure.ranking_minimum_sample}
            if measure.ranking_minimum_sample is not None
            else {}
        ),
        **({"ranking_floors": ranking_floors} if ranking_floors else {}),
        **(
            {"minimum_coverage": coverage[0], "low_coverage_below": coverage[1]}
            if coverage else {}
        ),
        **({"source": measure.source} if measure.source else {}),
        "evidence_fields": [
            *(key for key in _EVIDENCE_COLUMNS if key in columns),
            "counts",
            "excluded",
            *(_DELIVERY_EVIDENCE if family.id == _SERVICE_DELIVERED_ID else ()),
            *(
                ("dimension_states", "capture_gap_days", "measure_days")
                if family.id == SCORECARD
                else ()
            ),
            *family.evidence_columns,
            *(key for key in _COVERAGE_COLUMNS if key in columns),
        ],
        "csv_columns": {
            lang: [getattr(label, lang) for label in columns.values()] for lang in ("en", "fr")
        },
        "text": {
            lang: {
                "definition": getattr(measure.definition, lang),
                "unit": getattr(_UNIT_LABELS[measure.unit], lang),
                "counts": getattr(measure.counts or family.counts, lang),
                "exclusions": getattr(measure.exclusions or family.exclusions, lang),
                "limits": getattr(limits, lang),
                **({"histogram": getattr(histogram, lang)} if histogram else {}),
            }
            for lang in ("en", "fr")
        },
    }


_COVERAGE_COLUMNS = {
    "low_coverage": Text("Low coverage", "Faible couverture"),
    "coverage_reason": Text("Coverage reason", "Motif lié à la couverture"),
}


def _csv_columns(family: Family) -> dict[str, Text]:
    coverage = _COVERAGE_COLUMNS if family.coverage or family.id == _VEHICLES_ID else {}
    if family.columns:
        common = {key: label for key, label in _CSV_COLUMNS.items() if key != "share_observed"}
        return {**common, **family.columns, **family.evidence_columns, **coverage}
    if family.id == _SERVICE_DELIVERED_ID:
        common = {key: label for key, label in _CSV_COLUMNS.items() if key != "share_observed"}
        return {**common, **_DELIVERY_COLUMNS, **_DELIVERY_EVIDENCE, **coverage}
    return {
        **_CSV_COLUMNS,
        **coverage,
        **{name: label for name, (_, label) in _COUNTS.items()},
        **_PUNCTUALITY_BASES,
        "observed_trips": Text("Observed trips", "Trajets observés"),
        "observed_service_dates": Text("Observed service dates", "Dates de service observées"),
        **{m.id: m.count_label for m in family.measures if m.count_label is not None},
    }


def methods() -> list[dict[str, Any]]:
    return [
        {**_info(family, measure), "family_text": {"en": family.label.en, "fr": family.label.fr}}
        for family in _FAMILIES
        for measure in family.measures
    ]


def _cuts(
    question: Question, hour_sql: str | None, *, departure_sql: str = _DEPARTURE_SECONDS
) -> tuple[str, list[object]]:
    filters = []
    parameters: list[object] = []
    for name, value in question.cuts().items():
        expression = {
            "line": "route_id",
            "direction": "direction_id",
            "stop": "stop_id",
            "departure": departure_sql,
            "hour": hour_sql,
            "from_stop": "from_stop",
            "to_stop": "to_stop",
        }.get(name)
        if expression is not None:
            filters.append(f"({expression}) = ?")
            if name == "departure":
                hour, minute, second = map(int, str(value).split(":"))
                parameters.append(hour * 3600 + minute * 60 + second)
            else:
                parameters.append(value)
    return " AND ".join(filters) or "true", parameters


def _entity_sql(
    group: EntityKind | None, series: SeriesGroup | None = None, hour: str = "NULL"
) -> str:
    if series == "departure":
        return f"row(direction_id, ({_DEPARTURE_SECONDS})::BIGINT)"
    if series:
        return series_sql(series, hour)
    return {
        None: "row(NULL::VARCHAR)",
        "line": "row(route_id)",
        "stop": "row(stop_id)",
        "departure": f"row(route_id, direction_id, ({_DEPARTURE_SECONDS})::BIGINT)",
        "segment": series_sql("segment", hour),
    }[group]


def _grouped_batches(
    rows: list[tuple[Any, ...]], counters: Iterable[str], sample: str, grouped: bool
) -> dict[EntityKey, Batch]:
    groups: dict[EntityKey, Batch] = {}
    for key, edge, routes, *values in rows:
        entity = tuple(key) if grouped else ()
        result = groups.get(entity)
        if result is None:
            result = groups[entity] = Batch()
        bucket = dict(zip(counters, values, strict=True))
        for name in ("observed_trips", "observed_service_dates"):
            if name in bucket:
                result.counts[name] = max(result.counts[name], bucket.pop(name))
        result.counts.update(bucket)
        if edge is not None:
            result.histogram[edge] = bucket[sample]
        if routes:
            result.scheduled_routes.update(routes)
    return groups


def _punctuality_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    by_exact_delay = (
        int(version) >= STOP_ELIGIBILITY_VERSION and group is None and not question.group
    )
    hour_sql = (
        local_hour_sql(conn, "scheduled_stop_utc", question.start, question.end)
        if int(version) < STOP_ELIGIBILITY_VERSION and question.group in HOUR_GROUPS
        else None
    )
    sql, parameters, counters = _punctuality_query(
        family, paths, question, version, group, hour_sql=hour_sql, by_exact_delay=by_exact_delay
    )
    try:
        rows = conn.execute(sql, parameters).fetchall()
    except duckdb.OutOfMemoryException:
        if not by_exact_delay:
            raise
        sql, parameters, counters = _punctuality_query(family, paths, question, version, group)
        rows = conn.execute(sql, parameters).fetchall()
    return _grouped_batches(rows, counters, "classified", bool(group or question.group))


def _punctuality_query(
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
    *,
    for_vehicles: bool = False,
    hour_sql: str | None = None,
    by_exact_delay: bool = False,
) -> tuple[str, list[object], dict[str, str]]:
    clean_events = int(version) >= STOP_ELIGIBILITY_VERSION
    hour = (
        "scheduled_local_hour"
        if clean_events
        else hour_sql or _LOCAL_HOUR.format("scheduled_stop_utc")
    )
    departure_sql = "scheduled_start_seconds" if clean_events else _DEPARTURE_SECONDS
    cut_sql, filters = _cuts(question, hour, departure_sql=departure_sql)
    scope = [question.city, version, question.start, question.end]
    trip_cut = "AND route_id = ?" if question.line is not None else ""
    parameters: list[object] = [paths[STOP_EVENTS], *scope, *filters]
    if not clean_events:
        parameters[:0] = [paths[TRIP_DAYS], *scope, *([question.line] if trip_cut else [])]
    counters = {name: sql for name, (sql, _) in _COUNTS.items()}
    counters.update({m.id: f"count(*) FILTER ({m.band})" for m in family.measures if m.band})
    if group:
        counters["live_candidates"] = "count(*) FILTER (NOT added AND route_has_live_data)"
    if question.group == "stop":
        cut_sql += " AND NOT added"
        counters["stop_occurrences"] = "count(*)"
        if _departure_stop_order(question):
            counters["observed_delay_seconds"] = "coalesce(sum(delay_seconds), 0)"
    elif question.group == "stop_id" or (question.group == "line" and question.stop is None):
        cut_sql += " AND NOT added"
    basis_counts = {
        name: f"count(*) FILTER (delay_seconds IS NOT NULL AND basis = '{name}')"
        for name in _PUNCTUALITY_BASES
    }
    counters.update(basis_counts)
    aggregates = ", ".join(counters.values())
    group_columns = {
        "line": "route_id",
        "stop": "stop_id",
        "departure": "route_id, direction_id, departure_seconds",
    }.get(group or "")
    routes = "NULL"
    if group_columns and group in {"line", "departure"}:
        routes = (
            "CASE WHEN count(*) FILTER (NOT added AND route_id IS NOT NULL) > 0 THEN [route_id] END"
        )
    elif group:
        routes = "list(DISTINCT route_id) FILTER (NOT added AND route_id IS NOT NULL)"
    edge = f"floor(delay_seconds::DOUBLE / {DELAY_BIN_SECONDS})::BIGINT * {DELAY_BIN_SECONDS}"
    with_histogram = (for_vehicles and question.group is None) or any(
        measure.percentile is not None for measure in _SELECTIONS[question.measure][1]
    )
    if not with_histogram:
        edge = "NULL::BIGINT"
    entity = (
        "row(route_id, direction_id, departure_seconds)"
        if group == "departure"
        else _entity_sql(group, question.group, hour)
    )
    if clean_events:
        if question.group == "weekday_hour":
            entity = f"row(service_weekday, {hour})"
        elif question.group == "day_type":
            entity = (
                "row(CASE service_weekday WHEN 6 THEN 'saturday' "
                "WHEN 7 THEN 'sunday' ELSE 'weekday' END)"
            )
    group_by = f"GROUP BY {group_columns or 'entity'}, lower_edge"
    if group is None and question.group is None:
        group_by = "GROUP BY lower_edge"
    # Trip flags and the GTFS service-time conversion are invariant across a trip's stops.
    departure = f", ({departure_sql})::BIGINT AS departure_seconds" if group == "departure" else ""
    by_trip = (
        not with_histogram
        and group in {"line", "departure"}
        and question.hour is None
        and question.stop is None
    )
    stop_scan = """
        FROM read_parquet(?, hive_partitioning = false) s
        WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
    """
    rank_by_band = not with_histogram and (
        group == "stop" or (clean_events and group in {"line", "departure"})
    )
    by_delay_bin = rank_by_band or (
        group is None and not for_vehicles and question.group != "stop"
    )
    stop_status = """
        CASE
            WHEN added THEN 1
            WHEN cancelled THEN 2
            WHEN without_live_data THEN 3
            WHEN scheduled AND capture_gap THEN 4
            WHEN scheduled THEN 5
            ELSE 6
        END AS unclassified_bucket
    """
    vehicle_filter = (
        "AND s.vehicle_id IN (SELECT vehicle_id FROM selected_vehicles)" if for_vehicles else ""
    )
    delay = (
        "s.delay_seconds"
        if by_delay_bin
        else "CASE WHEN scheduled AND NOT capture_gap THEN s.delay_seconds END"
    )
    ctes = f"""
        WITH trips AS MATERIALIZED (
            SELECT service_date, trip_id, route_id, direction_id, scheduled_start_utc,
                scheduled_start_utc IS NULL AS added,
                NOT added AND state = 'cancelled' AS cancelled,
                NOT added AND NOT cancelled AND NOT route_has_live_data AS without_live_data,
                NOT (added OR cancelled OR without_live_data) AS scheduled,
                route_has_live_data,
                state_reason IS NOT DISTINCT FROM 'capture_gap' AS capture_gap
                {departure}
                {f", {stop_status}" if by_delay_bin else ""}
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
                {trip_cut}
        )"""
    if clean_events:
        clean_status = """
            CASE
                WHEN trip_exclusion_reason IS NULL THEN 5
                WHEN trip_exclusion_reason = 'added' THEN 1
                WHEN trip_exclusion_reason = 'cancelled' THEN 2
                WHEN trip_exclusion_reason = 'route_without_live_data' THEN 3
                WHEN trip_exclusion_reason = 'capture_gap' THEN 4
                ELSE 6
            END
        """
        ctes = f"""
            WITH events AS (
                SELECT s.service_date, s.route_id, s.direction_id, s.stop_id, s.stop_sequence,
                    s.scheduled_local_hour, s.service_weekday, s.scheduled_start_seconds,
                    s.trip_exclusion_reason,
                    trip_exclusion_reason IS NOT DISTINCT FROM 'added' AS added,
                    trip_exclusion_reason IS NOT DISTINCT FROM 'cancelled' AS cancelled,
                    trip_exclusion_reason IS NOT DISTINCT FROM 'route_without_live_data'
                        AS without_live_data,
                    trip_exclusion_reason IS NOT DISTINCT FROM 'capture_gap' AS capture_gap,
                    (trip_exclusion_reason IS NULL OR capture_gap) AS scheduled,
                    route_has_live_data, s.trip_id, s.basis, {delay} AS delay_seconds
                    {departure}
                    {f", {clean_status} AS unclassified_bucket" if by_delay_bin else ""}
                {stop_scan} {vehicle_filter}
            )"""
    elif by_trip:
        # Line and departure keys come from the trip. Roll up its stop counts before
        # joining so the range-wide aggregates process one row per trip.
        bands = {m.id: counters[m.id] for m in family.measures if m.band}
        stop_bands = ", ".join(
            f"{sql} AS {name}" for name, sql in bands.items() if name != "on_time"
        )
        classified = "scheduled AND NOT capture_gap"
        sums = (
            ("n", "scheduled"),
            ("classified", classified),
            ("n", "added"),
            ("n", "cancelled"),
            ("n", "without_live_data"),
            ("n", "scheduled AND capture_gap"),
            ("n - classified", classified),
            *(
                ("classified - early - late" if name == "on_time" else name, classified)
                for name in bands
            ),
            ("n", "NOT added AND route_has_live_data"),
            *((name, classified) for name in _PUNCTUALITY_BASES),
        )
        aggregates = ", ".join(
            f"coalesce(sum({column}) FILTER ({condition}), 0)" for column, condition in sums
        )
        sample_key = "observed_trips" if group == "line" else "observed_service_dates"
        sample_expression = "count(*)" if group == "line" else "count(DISTINCT service_date)"
        counters[sample_key] = ""
        aggregates += f", {sample_expression} FILTER ({classified} AND classified > 0)"
        stop_bases = ", ".join(f"{sql} AS {key}" for key, sql in basis_counts.items())
        return (
            f"""
            {ctes}, stops AS (
                SELECT service_date, trip_id, count(*) AS n, count(delay_seconds) AS classified,
                    {stop_bands}, {stop_bases}
                {stop_scan}
                GROUP BY service_date, trip_id
            )
            SELECT {entity}, {edge} AS lower_edge, {routes}, {aggregates}
            FROM stops s JOIN trips t USING (service_date)
            WHERE s.trip_id IS NOT DISTINCT FROM t.trip_id AND {cut_sql}
            {group_by}
            """,
            parameters,
            counters,
        )
    else:
        ctes += f""", stops AS (SELECT * {stop_scan} {vehicle_filter}), events AS (
        SELECT service_date, t.route_id, t.direction_id, s.stop_id, s.stop_sequence,
            t.scheduled_start_utc,
            coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc) AS scheduled_stop_utc,
            added, cancelled, without_live_data, scheduled, route_has_live_data, capture_gap,
            s.trip_id, s.basis, {delay} AS delay_seconds
            {", departure_seconds" if departure else ""}
            {", unclassified_bucket" if by_delay_bin else ""}
        FROM stops s JOIN trips t USING (service_date)
        WHERE s.trip_id IS NOT DISTINCT FROM t.trip_id
    )"""
    ranking_join = ""
    ranking_projection = ""
    if group in {"line", "departure"}:
        sample_key = "observed_trips" if group == "line" else "observed_service_dates"
        distinct = "(service_date, trip_id)" if group == "line" else "service_date"
        counters[sample_key] = ""
        ctes += f""", ranking_samples AS (
            SELECT {entity} AS sample_entity, count(DISTINCT {distinct}) AS ranking_sample
            FROM events
            WHERE {cut_sql} AND scheduled AND NOT capture_gap AND delay_seconds IS NOT NULL
            GROUP BY sample_entity
        )"""
        parameters.extend(filters)
        ranking_join = f"LEFT JOIN ranking_samples ON ({entity}) = sample_entity"
        ranking_projection = ", coalesce(max(ranking_sample), 0)"
    if by_delay_bin:
        # Delay bins are multiples of 15. Reserve 1–6 for unclassified stops, and
        # separate exactly +300 from its late neighbors until the final rollup.
        delay_bucket = (
            f"WHEN delay_seconds = {LATE_LIMIT_SECONDS} THEN {LATE_LIMIT_SECONDS + 1} ELSE {edge}"
            if with_histogram
            else (
                f"WHEN delay_seconds < {EARLY_LIMIT_SECONDS} THEN {EARLY_LIMIT_SECONDS - 1} "
                f"WHEN delay_seconds > {LATE_LIMIT_SECONDS} THEN {LATE_LIMIT_SECONDS + 2} "
                "ELSE 0"
            )
        )
        normalized_edge = (
            f"CASE WHEN bucket = {LATE_LIMIT_SECONDS + 1} THEN {LATE_LIMIT_SECONDS} "
            "WHEN bucket NOT BETWEEN 1 AND 6 THEN bucket END"
            if with_histogram
            else edge
        )
        select_entity = f"{entity} AS entity, " if question.group else ""
        bin_group = final_group = "entity, " if question.group else ""
        result_entity = "entity" if question.group else entity
        bin_live = final_live = ""
        bin_routes = "NULL"
        bin_source = f"events WHERE {cut_sql}"
        bin_count = "count(*)"
        bin_bases = ", ".join(f"{sql} AS {name}" for name, sql in basis_counts.items())
        reason = "unclassified_bucket"
        excluded = "unclassified_bucket <> 5"
        if by_exact_delay:
            # The network has many stops at each exact delay. Compute the
            # histogram edges from those counts instead of from every stop.
            ctes += f""", delays AS (
                SELECT trip_exclusion_reason, delay_seconds, basis, count(*) AS n
                FROM events WHERE {cut_sql}
                GROUP BY trip_exclusion_reason, delay_seconds, basis
            )"""
            bin_source = "delays"
            bin_count = "sum(n)"
            bin_bases = ", ".join(
                f"sum(n) FILTER (delay_seconds IS NOT NULL AND basis = '{name}') AS {name}"
                for name in _PUNCTUALITY_BASES
            )
            reason = clean_status
            excluded = "trip_exclusion_reason IS NOT NULL"
        if clean_events and question.group in HOUR_GROUPS:
            keys = (
                f"service_weekday, {hour}" if question.group == "weekday_hour" else hour
            )
            select_entity = bin_group = final_group = f"{keys}, "
            result_entity = f"row({keys})"
        if rank_by_band:
            assert group_columns is not None
            final_group = f"{group_columns}, "
            result_entity = entity
            if group == "stop":
                # Resolve distinct route membership on the partial counts.
                select_entity = bin_group = "stop_id, route_id, "
                bin_routes = "list(DISTINCT route_id) FILTER (bucket <> 1 AND route_id IS NOT NULL)"
            else:
                select_entity = bin_group = final_group
                bin_routes = (
                    "CASE WHEN count(*) FILTER (bucket <> 1 AND route_id IS NOT NULL) > 0 "
                    "THEN [route_id] END"
                )
            bin_live = ", count(*) FILTER (NOT added AND route_has_live_data) AS live"
            final_live = ", sum(live)"
        final_bases = ", ".join(
            f"coalesce(sum({name}) FILTER (bucket NOT BETWEEN 1 AND 6), 0)"
            for name in _PUNCTUALITY_BASES
        )
        return (
            f"""
            {ctes}, bins AS (
                SELECT {select_entity}
                    CASE WHEN delay_seconds IS NULL OR {excluded}
                        THEN {reason} {delay_bucket} END AS bucket,
                    {bin_count} AS n {bin_live}, {bin_bases}
                FROM {bin_source}
                GROUP BY {bin_group}bucket
            )
            SELECT {result_entity} AS entity, {normalized_edge} AS lower_edge, {bin_routes},
                coalesce(sum(n) FILTER (bucket IN (4, 5) OR bucket NOT BETWEEN 1 AND 6), 0),
                coalesce(sum(n) FILTER (bucket NOT BETWEEN 1 AND 6), 0),
                coalesce(sum(n) FILTER (bucket = 1), 0),
                coalesce(sum(n) FILTER (bucket = 2), 0),
                coalesce(sum(n) FILTER (bucket = 3), 0),
                coalesce(sum(n) FILTER (bucket = 4), 0),
                coalesce(sum(n) FILTER (bucket = 5), 0),
                coalesce(sum(n) FILTER (bucket < {EARLY_LIMIT_SECONDS}), 0),
                coalesce(sum(n) FILTER (bucket NOT BETWEEN 1 AND 6
                    AND bucket BETWEEN {EARLY_LIMIT_SECONDS} AND {LATE_LIMIT_SECONDS - 1}
                    OR bucket = {LATE_LIMIT_SECONDS + 1}), 0),
                coalesce(sum(n) FILTER (bucket >= {LATE_LIMIT_SECONDS}
                    AND bucket <> {LATE_LIMIT_SECONDS + 1}), 0)
                {final_live}, {final_bases} {ranking_projection}
            FROM bins {ranking_join} GROUP BY {final_group}lower_edge
            """,
            parameters,
            counters,
        )
    return (
        f"""
        {ctes}
        SELECT {entity} AS entity,
            {edge} AS lower_edge, {routes}, {aggregates} {ranking_projection}
        FROM events {ranking_join} WHERE {cut_sql}
        {group_by}
        """,
        parameters,
        counters,
    )


_PUNCTUALITY = Family(
    id="punctuality",
    label=Text("Punctuality", "Ponctualité"),
    method_version="punctuality-v3",
    since="2026-11-22",
    tables=(STOP_EVENTS, TRIP_DAYS),
    query=_punctuality_rows,
    minimum_sample=MIN_CLASSIFIED_STOP_EVENTS,
    coverage=(0.25, 0.50),
    ranking_floors={
        "line": {"classified": 100, "observed_trips": 20},
        "stop": {"classified": 50},
        "departure": {"observed_service_dates": 5, "classified": 30},
    },
    counts=Text(
        "Each scheduled stop of each trip counts once. Shares divide the band count by the "
        "number of stops with a measured delay. Delay is signed seconds from the schedule. "
        "From cleaning v10, the archive calendar and trip timing resolve the service day, "
        "including trips that cross midnight. At the origin, the last nearby stopped report "
        "before the vehicle is seen past the stop measures departure. From v11, if a vehicle "
        "feed never reports a vehicle stopped in the service-day capture window, we estimate "
        "arrival as the vehicle enters the 50-metre radius between consecutive GPS fixes "
        "outside and inside the radius, at most 160 seconds apart. At the origin, we use "
        "the last fix "
        "within 50 metres before the same vehicle is seen at a later stop. Without a qualifying "
        "vehicle observation, we use an exact agency time or the last prediction before "
        "confirmed vehicle passage.",
        "Chaque arrêt prévu de chaque trajet compte une fois. Pour chaque catégorie, on "
        "divise son nombre d’arrêts par le nombre d’arrêts dont l’écart a été mesuré. "
        "L’écart à l’horaire est exprimé en secondes, en négatif pour l’avance. "
        "Depuis le nettoyage v10, le calendrier archivé et les heures du trajet déterminent "
        "le jour de service, même après minuit. Au premier arrêt, le départ correspond au "
        "dernier relevé du véhicule immobilisé à proximité avant qu’il soit vu plus loin. "
        "Depuis la version 11, si le flux ne signale aucun véhicule à l’arrêt pendant la "
        "période de collecte du jour de service, on estime l’arrivée à l’entrée dans le rayon "
        "de 50 mètres entre deux positions GPS successives, l’une à l’extérieur, l’autre à "
        "l’intérieur, espacées d’au plus 160 secondes. Au premier arrêt, on retient la "
        "dernière position dans "
        "ce rayon avant que le même véhicule soit vu à un arrêt suivant. Sans observation "
        "valide du véhicule, on utilise une heure exacte de l’agence ou la dernière "
        "prévision avant le passage confirmé.",
    ),
    exclusions=Text(
        "Added trips, cancelled trips and lines without live data are excluded. Stops without "
        "a measured delay stay in the scheduled count. From cleaning v10, an unobserved "
        "stop is marked as a capture gap if any required feed lacks continuous capture "
        "at its scheduled time.",
        "Les trajets ajoutés, les trajets annulés et les lignes sans données en direct sont "
        "exclus. Les arrêts sans écart mesuré restent dans le total prévu. Depuis le "
        "nettoyage v10, un arrêt non observé est marqué comme touché par une interruption "
        "si la collecte d’un flux requis n’est pas continue à l’heure prévue.",
    ),
    limits=Text(
        "The answer covers measured days only. It cannot tell how long riders waited or "
        "why a vehicle was early or late. A small sample can be dominated by a few stops.",
        "Le résultat porte seulement sur les jours mesurés. Il ne dit pas combien de temps "
        "les gens ont attendu ni pourquoi un véhicule était en avance ou en retard. "
        "Quelques arrêts peuvent peser lourd dans un petit échantillon.",
    ),
    measures=(
        Measure(
            "early",
            "share",
            Text(
                f"Share of stops more than {abs(EARLY_LIMIT_SECONDS)} seconds early.",
                f"Part des arrêts avec plus de {abs(EARLY_LIMIT_SECONDS)} secondes d’avance.",
            ),
            band=f"delay_seconds < {EARLY_LIMIT_SECONDS}",
            count_label=Text("Early stops", "Arrêts en avance"),
            worst_first_descending=True,
        ),
        Measure(
            "on_time",
            "share",
            Text(
                f"Share of stops from {abs(EARLY_LIMIT_SECONDS)} seconds early to "
                f"{LATE_LIMIT_SECONDS} seconds late, including both limits.",
                f"Part des arrêts entre {abs(EARLY_LIMIT_SECONDS)} secondes d’avance et "
                f"{LATE_LIMIT_SECONDS} secondes de retard, limites incluses.",
            ),
            band=f"delay_seconds BETWEEN {EARLY_LIMIT_SECONDS} AND {LATE_LIMIT_SECONDS}",
            count_label=Text("On-time stops", "Arrêts à l’heure"),
        ),
        Measure(
            "late",
            "share",
            Text(
                f"Share of stops more than {LATE_LIMIT_SECONDS} seconds late.",
                f"Part des arrêts avec plus de {LATE_LIMIT_SECONDS} secondes de retard.",
            ),
            band=f"delay_seconds > {LATE_LIMIT_SECONDS}",
            count_label=Text("Late stops", "Arrêts en retard"),
            worst_first_descending=True,
        ),
        Measure(
            "median_delay",
            "seconds",
            Text("Median delay across measured stops.", "Écart médian aux arrêts mesurés."),
            percentile=50,
            worst_first_descending=True,
        ),
        Measure(
            "p90_delay",
            "seconds",
            Text(
                "The delay at or below which about 90% of measured stops fall.",
                "L’écart à l’horaire que ne dépassent pas environ 90 % des arrêts mesurés.",
            ),
            percentile=90,
            worst_first_descending=True,
        ),
    ),
)

_DELIVERY_COLUMNS = {
    "scheduled": Text("Scheduled trips", "Trajets prévus"),
    "eligible": Text("Scheduled trips with known status", "Trajets prévus à l’état connu"),
    "ran": Text("Trips that ran", "Trajets effectués"),
    "cancelled": Text("Cancelled trips", "Trajets annulés"),
    "missing": Text("Missing trips", "Trajets manquants"),
    "unconfirmed": Text("Unconfirmed trips", "Trajets non confirmés"),
    "not_measured": Text("Trips not measured", "Trajets non mesurés"),
    "added": Text("Added trips", "Trajets ajoutés"),
    "route_without_live_data": Text("Trips without live data", "Trajets sans données en direct"),
    "capture_gap": Text(
        "Trips affected by capture gaps", "Trajets touchés par une interruption de la collecte"
    ),
    "cancellation_notices": Text("Cancellation notices", "Avis d’annulation"),
    "cancellations_announced_after_departure": Text(
        "Cancellations announced after scheduled start",
        "Annulations annoncées après le départ prévu",
    ),
    "trips_with_duration": Text(
        "Eligible trips with scheduled duration", "Trajets admissibles avec une durée prévue"
    ),
    "scheduled_hours": Text("Eligible scheduled hours", "Heures prévues admissibles"),
    "ran_hours": Text("Scheduled hours that ran", "Heures prévues effectuées"),
}
_DELIVERY_EXCLUDED = ("added", "route_without_live_data", "capture_gap")
_DELIVERY_EVIDENCE = {
    "share_eligible": Text("Eligible share", "Part admissible"),
    "share_unconfirmed": Text(
        "Unconfirmed share of scheduled trips", "Part des trajets non confirmés"
    ),
    "median_cancellation_lead_seconds": Text(
        "Median cancellation lead time (s)", "Préavis médian d’annulation (s)"
    ),
    "cancellation_lead_state": Text("Cancellation lead state", "État du préavis d’annulation"),
    "boundary_coverage": Text(
        "First and last departure coverage", "Couverture des départs limites"
    ),
    "boundary_departures": Text(
        "First and last departures by date", "Premiers et derniers départs par date"
    ),
}
_DELIVERY_AGGREGATES = {
    "scheduled": "count(*) FILTER (state <> 'added')",
    "eligible": "count(*) FILTER (eligible)",
    **{
        state: f"count(*) FILTER (state = '{state}')"
        for state in ("ran", "cancelled", "missing", "unconfirmed", "not_measured", "added")
    },
    "route_without_live_data": "count(*) FILTER (without_live_data)",
    "capture_gap": "count(*) FILTER (capture_gap)",
    "cancellation_notices": "count(lead_seconds)",
    "cancellations_announced_after_departure": "count(*) FILTER (lead_seconds < 0)",
    "trips_with_duration": "count(duration) FILTER (eligible)",
    "scheduled_seconds": "coalesce(sum(duration) FILTER (eligible), 0)",
    "ran_seconds": "coalesce(sum(duration) FILTER (state = 'ran'), 0)",
}


def _service_delivered_rows(
    conn: duckdb.DuckDBPyConnection,
    _family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    window = "provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?"
    hour_sql = _LOCAL_HOUR.format("scheduled_start_utc")
    cut_sql, filters = _cuts(question, hour_sql)
    scope = [question.city, version, question.start, question.end]
    trips_sql = f"""
        SELECT service_date, trip_id, route_id, direction_id, scheduled_start_utc, state,
            route_has_live_data,
            state_reason IS NOT DISTINCT FROM 'route_without_live_data' AS without_live_data,
            state_reason IS NOT DISTINCT FROM 'capture_gap' AS capture_gap,
            state IN ('ran', 'cancelled', 'missing') AS eligible,
            CASE WHEN state = 'cancelled'
                THEN epoch(scheduled_start_utc - cancellation_notice_utc) END AS lead_seconds
        FROM read_parquet(?, hive_partitioning = false)
        WHERE {window} AND {cut_sql}
    """
    parameters = [paths[TRIP_DAYS], *scope, *filters]
    counters = dict(_DELIVERY_AGGREGATES)
    if group:
        counters["live_candidates"] = "count(*) FILTER (state <> 'added' AND route_has_live_data)"
    if group and SCHEDULED_STOP_TIMES in paths:
        counters["squared_duration"] = (
            "coalesce(sum(duration::HUGEINT * duration) FILTER (eligible), 0)"
        )
    aggregates = ", ".join(counters.values())
    trip_ids = _single_day_departure(question)
    routes = (
        "list(DISTINCT route_id) FILTER (state <> 'added' AND route_id IS NOT NULL)"
        if group
        else "list(DISTINCT trip_id) FILTER (state <> 'added')"
        if trip_ids
        else "NULL"
    )
    duration_sql = "SELECT trips.*, NULL::BIGINT AS duration FROM trips"
    duration_params = []
    if SCHEDULED_STOP_TIMES in paths:
        duration_sql = f"""
            SELECT trips.*, CASE WHEN last_time >= first_time
                THEN last_time - first_time END AS duration
            FROM trips LEFT JOIN (
                SELECT service_date, trip_id,
                    arg_min(coalesce(scheduled_departure_seconds, scheduled_arrival_seconds),
                        stop_sequence) AS first_time,
                    arg_max(coalesce(scheduled_arrival_seconds, scheduled_departure_seconds),
                        stop_sequence) AS last_time
                FROM read_parquet(?, hive_partitioning = false)
                WHERE {window}
                GROUP BY service_date, trip_id
            ) times USING (service_date, trip_id)
        """
        duration_params = [paths[SCHEDULED_STOP_TIMES], *scope]
    entity = _entity_sql(group, question.group, hour_sql)
    boundaries = question.line is not None if group is None else question.measure in _BOUNDARIES
    boundary_sql = ""
    boundary_rows = ""
    if (
        boundaries
        and question.group != "departure"
        and (question.day_type or question.group)
        and question.hour is None
        and question.departure is None
    ):
        partition = ", route_id" if group == "line" else ""
        if question.group == "direction":
            partition = ", direction_id"
        boundary_sql = f"""
            , scheduled AS (
                SELECT *, {entity} AS entity, ({_DEPARTURE_SECONDS})::BIGINT AS departure_seconds
                FROM trips WHERE state <> 'added'
            ), bounds AS (
                SELECT *, min(departure_seconds) OVER day AS first_start,
                    max(departure_seconds) OVER day AS last_start
                FROM scheduled
                WINDOW day AS (PARTITION BY service_date{partition})
            )
        """
        boundary_rows = """
            UNION ALL
            SELECT entity, NULL, NULL, NULL, row(measure, service_date, departure_seconds,
                count(*),
                count(*) FILTER (eligible), count(*) FILTER (state = 'ran'),
                count(*) FILTER (state = 'unconfirmed'),
                count(*) FILTER (without_live_data), count(*) FILTER (capture_gap))
            FROM bounds, LATERAL (VALUES ('first_trip', first_start), ('last_trip', last_start))
                AS edge(measure, start_seconds)
            WHERE departure_seconds = start_seconds
            GROUP BY entity, measure, service_date, departure_seconds
        """
    rows = conn.execute(
        f"""
        WITH trips AS ({trips_sql}), durations AS ({duration_sql})
        {boundary_sql}
        SELECT {entity} AS entity,
            floor(lead_seconds / {DELAY_BIN_SECONDS})::BIGINT * {DELAY_BIN_SECONDS}
                AS lower_edge, {routes}, row({aggregates}), NULL
        FROM durations GROUP BY entity, lower_edge
        {boundary_rows}
        """,
        [*parameters, *duration_params],
    ).fetchall()
    grouped = bool(group or question.group)
    groups = _grouped_batches(
        [
            (key, edge, None if trip_ids else routes, *values)
            for key, edge, routes, values, _ in rows
            if values is not None
        ],
        counters,
        "cancellation_notices",
        grouped,
    )
    for key, _, identifiers, _, boundary in rows:
        if identifiers and trip_ids:
            groups[()].trip_ids.update(identifiers)
        if boundary is not None:
            measure, day, seconds, *counts = boundary
            hour, remainder = divmod(seconds, 3600)
            minute, second = divmod(remainder, 60)
            groups[tuple(key) if grouped else ()].departures.append(
                Departure(
                    measure, day.isoformat(), f"{hour:02d}:{minute:02d}:{second:02d}", *counts
                )
            )
    for batch in groups.values():
        batch.departures.sort(
            key=lambda row: (row.service_date, row.measure, row.scheduled_departure)
        )
    return groups


def _single_day_departure(question: Question) -> bool:
    return (
        question.departure is not None and question.group is None and question.start == question.end
    )


_BOUNDARY_COUNTS = Text(
    "Select a line and day type, with a direction if desired. Each trip tied at the "
    "first or last scheduled departure time counts. Evidence gives the GTFS departure "
    "time and run counts by date. "
    f"At least {MIN_SERVICE_DELIVERED_TRIPS} eligible trips are needed.",
    "Choisissez une ligne et un type de jour, avec un sens si désiré. Chaque trajet "
    "prévu à l’heure du premier ou du dernier départ compte. Les données indiquent "
    "l’heure GTFS et les trajets effectués par date. Il faut au moins "
    f"{MIN_SERVICE_DELIVERED_TRIPS} trajets admissibles.",
)
_BOUNDARY_LIMITS = Text(
    "A confirmed trip does not tell when it actually departed. Dates with no scheduled "
    "departure contribute no trip.",
    "Un trajet confirmé ne révèle pas l’heure réelle du départ. Les dates sans départ "
    "prévu ne contribuent aucun trajet.",
)
_SERVICE_DELIVERED = Family(
    id=_SERVICE_DELIVERED_ID,
    label=Text("Service delivered", "Service effectué"),
    method_version="service-delivered-v2",
    since="2026-11-22",
    tables=(TRIP_DAYS,),
    query=_service_delivered_rows,
    minimum_sample=MIN_SERVICE_DELIVERED_TRIPS,
    coverage=(0.50, 0.80),
    ranking_floors={"line": {"eligible": 30}},
    counts=Text(
        "Each scheduled trip counts once. Rates use scheduled trips with a known status: "
        "ran, cancelled or missing. "
        f"At least {MIN_SERVICE_DELIVERED_TRIPS} trips with a known status are needed so "
        "one trip cannot change the share by more than five percentage points.",
        "Chaque trajet prévu compte une fois. Les taux utilisent les trajets prévus dont "
        "l’état est connu : effectué, annulé ou manquant. Il faut au moins "
        f"{MIN_SERVICE_DELIVERED_TRIPS} trajets à l’état connu pour qu’un seul trajet "
        "ne change pas la part de plus de cinq points de pourcentage.",
    ),
    exclusions=Text(
        "Added trips, trips on lines without live data and trips affected by capture gaps "
        "are excluded from the rate and shown separately. Trips whose status could not "
        "be confirmed are also left out of the rate and shown separately.",
        "Les trajets ajoutés, les trajets sur les lignes sans données en direct et ceux "
        "touchés par une interruption de la collecte sont exclus du taux et présentés à part. "
        "Les trajets dont l’état n’a pu être confirmé sont aussi exclus du taux "
        "et présentés à part.",
    ),
    limits=Text(
        "A trip that ran had at least one confirmed stop. Unconfirmed trips were seen "
        "without a confirmed stop and count as neither run nor missing. The feed does "
        "not establish whether every stop was served or how many people rode.",
        "Un trajet effectué a au moins un arrêt confirmé. Les trajets non confirmés ont "
        "été vus sans arrêt confirmé et ne sont comptés ni comme effectués ni comme manquants. "
        "Les données ne disent pas si tous les arrêts ont été desservis ni combien de "
        "personnes sont montées.",
    ),
    measures=(
        Measure(
            "trips_run",
            "share",
            Text(
                "Share of eligible scheduled trips that ran.",
                "Part des trajets prévus admissibles qui ont été effectués.",
            ),
            ratio=("ran", "eligible"),
        ),
        Measure(
            "cancelled_trips",
            "share",
            Text(
                "Share of eligible scheduled trips whose latest status was cancelled.",
                "Part des trajets prévus admissibles dont le dernier état était annulé.",
            ),
            counts=Text(
                "Counts cancelled trips and estimates the median advance notice from the "
                "scheduled start minus the notice time. Notice 30 minutes in advance is "
                "+1,800 seconds. Negative offsets are counted as notices after scheduled start.",
                "Compte les trajets annulés et estime le préavis médian en soustrayant "
                "l’heure de l’avis de l’heure du départ prévu. Un avis donné 30 minutes "
                "à l’avance vaut +1 800 secondes. Un délai négatif correspond à un avis "
                "donné après le départ prévu, compté à part.",
            ),
            limits=Text(
                "The notice records when the feed announced the cancellation. It does not "
                "say when riders learned about it. Without a notice time there is no lead time.",
                "L’avis indique quand les données en direct ont annoncé l’annulation. "
                "Il ne dit pas quand les gens l’ont apprise. Sans heure d’avis, le délai "
                "ne peut pas être calculé.",
            ),
            percentile=50,
            ratio=("cancelled", "eligible"),
            worst_first_descending=True,
        ),
        Measure(
            "missing_trips",
            "share",
            Text(
                "Share of eligible scheduled trips never seen while capture was complete.",
                "Part des trajets prévus admissibles jamais vus malgré une collecte complète.",
            ),
            ratio=("missing", "eligible"),
            worst_first_descending=True,
        ),
        Measure(
            "service_hours",
            "share",
            Text(
                "Share of eligible scheduled service hours attributed to trips that ran.",
                "Part des heures de service prévues admissibles attribuée aux trajets effectués.",
            ),
            counts=Text(
                "Sum the scheduled time from the first timed stop's departure to the last "
                "timed stop's arrival, using the other time at either stop if needed. "
                "Compare the hours for trips that ran with all eligible scheduled hours. "
                f"At least {MIN_SERVICE_DELIVERED_TRIPS} eligible trips with a duration "
                "are needed.",
                "On additionne les durées prévues du départ du premier arrêt avec un horaire "
                "à l’arrivée au dernier, en prenant l’autre heure à l’un ou l’autre arrêt "
                "au besoin. On compare les heures des trajets effectués aux heures prévues "
                f"admissibles. Il faut au moins {MIN_SERVICE_DELIVERED_TRIPS} trajets admissibles "
                "dont la durée est connue.",
            ),
            limits=Text(
                "Trips without a usable scheduled duration contribute no hours. These "
                "hours use the schedule and cannot establish actual time in service.",
                "Les trajets sans durée prévue utilisable ne contribuent aucune heure. "
                "Ces heures proviennent de l’horaire et ne révèlent pas la durée réelle "
                "du service.",
            ),
            ratio=("ran_seconds", "scheduled_seconds"),
            extra_tables=(SCHEDULED_STOP_TIMES,),
        ),
        Measure(
            "first_trip",
            "share",
            Text(
                "How often the first scheduled departure of the day ran.",
                "Fréquence à laquelle le premier départ prévu de la journée a été effectué.",
            ),
            counts=_BOUNDARY_COUNTS,
            limits=_BOUNDARY_LIMITS,
            ratio=("ran", "eligible"),
        ),
        Measure(
            "last_trip",
            "share",
            Text(
                "How often the last scheduled departure of the day ran.",
                "Fréquence à laquelle le dernier départ prévu de la journée a été effectué.",
            ),
            counts=_BOUNDARY_COUNTS,
            limits=_BOUNDARY_LIMITS,
            ratio=("ran", "eligible"),
        ),
    ),
)

# The cleaner starts a fresh interval after a reporting gap of more than 60 seconds.
CROWDING_TAIL_CAP_SECONDS = VEHICLE_TAIL_CAP_SECONDS
# With no next reading in the clean day, assume one nominal vehicle-feed poll.
CROWDING_FINAL_TAIL_SECONDS = VEHICLE_POLL_SECONDS
MIN_CROWDING_VEHICLE_HOURS = 1
_US_PER_HOUR = 3_600_000_000
_OCCUPANCY_LEVELS = {
    0: ("crowding_empty", Text("Empty", "Vide")),
    1: ("crowding_many_seats", Text("Many seats available", "Beaucoup de places assises libres")),
    2: ("crowding_few_seats", Text("Few seats available", "Peu de places assises libres")),
    3: ("crowding_standing", Text("Standing room only", "Places debout seulement")),
    4: ("crowding_crushed", Text("Limited standing room", "Peu de places debout")),
    5: ("crowding_full", Text("Full", "Plein")),
}
_CROWDING_COLUMNS = {
    "intervals": Text("Vehicle state intervals", "Intervalles d’état des véhicules"),
    "readings": Text("Vehicle readings", "Relevés de véhicules"),
    "occupancy_readings": Text("Readings with occupancy", "Relevés avec achalandage"),
    "occupancy_vehicle_seconds": Text(
        "Vehicle-seconds with occupancy", "Véhicule-secondes mesurées"
    ),
    "readings_without_occupancy": Text("Readings without occupancy", "Relevés sans achalandage"),
    "capped_intervals": Text(
        "Intervals with a capped tail", "Intervalles avec prolongement plafonné"
    ),
    "level_vehicle_seconds": Text("Vehicle-seconds by level", "Véhicule-secondes par niveau"),
}


def _crowding_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    filters, arguments = _cuts(question, None)
    join = ""
    direction = "NULL::INTEGER"
    inputs: list[object] = [paths[VEHICLE_POSITIONS], question.city, version]
    if question.direction is not None or question.group == "direction":
        direction = "t.direction_id"
        join = """
            LEFT JOIN read_parquet(?, hive_partitioning = false) t
              ON (v.provider, v.cleaning_version, v.service_date, v.trip_id) =
                 (t.provider, t.cleaning_version, t.service_date, t.trip_id)
        """
        inputs.append(paths[TRIP_DAYS])
    weight = "epoch_us(ends_at) - epoch_us(captured_at_utc)"
    reading_cut = "matches"
    segments = ""
    entity_hour = "NULL"
    if question.group in HOUR_GROUPS:
        entity_hour = _LOCAL_HOUR.format("hour_start")
        bucket = LOCAL_HOUR_BUCKET.format("captured_at_utc")
        segments = f"""
            CROSS JOIN LATERAL generate_series({bucket},
                ends_at, INTERVAL '1 hour') AS hours(hour_start)
            WHERE hour_start < ends_at OR hour_start <= captured_at_utc
        """
        reading_cut = f"matches AND hour_start = {bucket}"
        weight = f"""
            least(epoch_us(ends_at), epoch_us(hour_start) + {_US_PER_HOUR})
                - greatest(epoch_us(captured_at_utc), epoch_us(hour_start))
        """
    elif question.hour is not None:
        start_hour = _LOCAL_HOUR.format("captured_at_utc")
        segment_hour = _LOCAL_HOUR.format("hour_start")
        weight = vehicle_hour_weight_sql(segment_hour)
        reading_cut = f"matches AND {start_hour} = ?"
        arguments.extend([question.hour] * 2)
    cap_us = CROWDING_TAIL_CAP_SECONDS * 1_000_000
    tail = vehicle_tail_sql("v.next_start", "v.last_seen_at_utc")
    rows = conn.execute(
        f"""
        WITH sequenced AS (
            SELECT provider, cleaning_version, service_date, trip_id, route_id, stop_id,
                captured_at_utc, last_seen_at_utc, readings, occupancy_status,
                occupancy_percentage, lead(captured_at_utc) OVER (
                    PARTITION BY vehicle_id ORDER BY captured_at_utc, filename
                ) AS next_start
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ?
        ), vehicles AS (
            SELECT v.route_id, v.stop_id, {direction} AS direction_id,
                v.captured_at_utc, v.readings,
                {tail} AS tail_us,
                {vehicle_end_sql("v.captured_at_utc", "v.last_seen_at_utc", "tail_us")} AS ends_at,
                CASE WHEN v.occupancy_status BETWEEN 0 AND 5 THEN v.occupancy_status END AS status,
                CASE WHEN status IS NULL AND v.occupancy_percentage >= 0
                     THEN v.occupancy_percentage END AS percentage
            FROM sequenced v
            {join}
            WHERE (?::VARCHAR IS NULL OR v.route_id = ?)
        ), cuts AS (
            SELECT *, {_entity_sql(group, question.group, entity_hour)} AS entity,
                {filters} AS matches,
                {weight} AS weight, {reading_cut} AS reading_cut
            FROM vehicles {segments}
        )
        SELECT entity, status, percentage,
            count(*) FILTER (reading_cut OR (matches AND weight > 0)) AS intervals,
            coalesce(sum(readings) FILTER (reading_cut), 0) AS readings,
            coalesce(sum(weight) FILTER (matches), 0) AS vehicle_us,
            coalesce(sum(weight::HUGEINT * weight) FILTER (matches), 0) AS squared_us,
            count(*) FILTER (tail_us > {cap_us} AND (reading_cut OR (matches AND weight > 0))),
            count(*)
        FROM cuts GROUP BY entity, status, percentage
        """,
        [
            *inputs,
            question.line,
            question.line,
            *arguments,
        ],
    ).fetchall()
    result: dict[EntityKey, Batch] = {}
    for key, status, percentage, intervals, readings, weight, squared, capped, baseline in rows:
        counts = result.setdefault(tuple(key) if group or question.group else (), Batch()).counts
        counts.update(
            intervals=intervals,
            readings=readings,
            capped_intervals=capped,
        )
        if status is None and percentage is None:
            continue
        counts.update(
            published_intervals=baseline,
            occupancy_readings=readings,
            occupancy_us=weight,
            squared_occupancy_us=squared,
        )
        if status is not None:
            counts[_OCCUPANCY_LEVELS[status][0]] += weight
        else:
            counts[f"percentage:{percentage}"] += weight
    return result


_CROWDING = Family(
    id=_CROWDING_ID,
    label=Text("Crowding", "Achalandage à bord"),
    method_version="crowding-v3",
    since="2026-11-22",
    tables=(VEHICLE_POSITIONS, TRIP_DAYS),
    minimum_sample=MIN_CROWDING_VEHICLE_HOURS,
    ranking_floors={"line": {"occupancy_vehicle_hours": 10}},
    query=_crowding_rows,
    columns=_CROWDING_COLUMNS,
    evidence_columns={
        "share_occupancy_readings": Text(
            "Share of readings with occupancy", "Part avec achalandage"
        ),
        "percentage_levels": Text("Percentage-only levels", "Niveaux publiés en pourcentage"),
    },
    counts=Text(
        "Shares divide time at each level by vehicle time with a usable occupancy value. "
        "Coverage divides readings with occupancy by all readings in the cut. Readings "
        "belong to the interval’s starting hour. Vehicle time is split at hour boundaries.",
        "Pour chaque niveau, on divise sa durée par le temps-véhicule avec une valeur "
        "d’achalandage utilisable. La couverture divise les relevés avec achalandage par "
        "tous les relevés du filtre. Les relevés sont attribués à l’heure de début de "
        "l’intervalle. Le temps-véhicule est réparti entre les heures qu’il chevauche.",
    ),
    exclusions=Text(
        "Reports without a usable occupancy level count toward coverage only. "
        "Boarding restrictions and unavailable status codes do not describe crowds. "
        "A direction needs a resolved trip and a stop cut uses the reported stop ID. "
        "The network or line is marked not tracked when no usable occupancy was published.",
        "Les relevés sans niveau utilisable entrent seulement dans la couverture. "
        "Les restrictions d’embarquement et les codes d’indisponibilité ne décrivent "
        "pas l’achalandage. "
        "La direction exige un trajet identifié et le filtre d’arrêt utilise l’arrêt "
        "déclaré. Le réseau ou la ligne est indiqué comme non suivi si aucune valeur "
        "d’achalandage utilisable n’a été publiée.",
    ),
    limits=Text(
        "We count the span from the first to the last capture of a state. We then "
        "carry the last reading forward to the next interval for that vehicle, up to "
        f"{CROWDING_TAIL_CAP_SECONDS} seconds, to limit the weight of stale readings. The "
        f"final interval for each vehicle gets {CROWDING_FINAL_TAIL_SECONDS} seconds, one "
        "scheduled feed poll. The one-vehicle-hour floor keeps a few minutes of reports "
        "from determining the share. "
        "We use the published status when usable and report exact percentages separately "
        "when only a percentage is usable. The full share also includes percentage-only "
        "values at or above 100%.",
        "On compte la durée entre la première et la dernière collecte d’un état. On "
        "prolonge ensuite le dernier relevé jusqu’au prochain intervalle du même véhicule, "
        f"avec un maximum de {CROWDING_TAIL_CAP_SECONDS} secondes pour limiter le poids des "
        f"relevés périmés. Le dernier intervalle de chaque véhicule reçoit "
        f"{CROWDING_FINAL_TAIL_SECONDS} secondes, soit la cadence de collecte prévue. "
        "Le seuil d’une heure-véhicule évite de juger l’achalandage à partir de quelques "
        "minutes de relevés. On utilise l’état publié s’il est utilisable. "
        "Les pourcentages seuls restent distincts et ceux d’au moins 100 % entrent aussi "
        "dans la part du temps où le véhicule est plein.",
    ),
    measures=tuple(
        Measure(
            key,
            "share",
            Text(
                f"Share of vehicle time at this occupancy level. {label.en}.",
                f"Part du temps-véhicule à ce niveau d’achalandage. {label.fr}.",
            ),
            worst_first_descending=True,
            ranking_kinds=("line",) if status == 5 else (),
        )
        for status, (key, label) in _OCCUPANCY_LEVELS.items()
    ),
)


def _alert_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    alert_paths = [path for path in paths[ALERTS] if path]
    if not alert_paths:
        return {(): Batch()} if group is None and question.group is None else {}
    filters = []
    arguments: list[object] = []
    for cut, value in question.cuts().items():
        filters.append(
            {
                "line": "list_contains(route_ids, ?)",
                "stop": "list_contains(stop_ids, ?)",
                "effect": "effect = ?",
                "cause": "cause = ?",
            }[cut]
        )
        arguments.append(value)
    group_sql = {
        None: "NULL::VARCHAR",
        "line": "unnest(route_ids)",
        "stop": "unnest(stop_ids)",
        "stop_id": "unnest(stop_ids)",
        "effect": "effect",
        "cause": "cause",
    }[question.group if question.group in _ALERT_ENTITY_GROUPS else group]
    projection = "entity, source, alert_id, version, epoch_us(starts), epoch_us(ends)"
    text_columns = (
        ", header_en, header_fr, description_en, description_fr" if question.alert_details else ""
    )
    message_columns = f", route_ids, stop_ids{text_columns}" if question.alert_details else ""
    projection += message_columns
    segments = ""
    temporal = question.group is not None and question.group not in _ALERT_ENTITY_GROUPS
    if temporal:
        local_day = "timezone(getvariable('service_timezone'), bucket)::DATE"
        if question.group in HOUR_GROUPS:
            bucket_start = "bucket"
            bucket_end = "bucket + INTERVAL '1 hour'"
            bucket = LOCAL_HOUR_BUCKET.format("starts")
            series = f"""
                generate_series({bucket}, ends, INTERVAL '1 hour')
            """
            key_sql = f"row({local_day}::VARCHAR, {_LOCAL_HOUR.format('bucket')})"
        else:
            bucket_start = "timezone(getvariable('service_timezone'), bucket)"
            bucket_end = "timezone(getvariable('service_timezone'), bucket + INTERVAL '1 day')"
            series = """
                generate_series(
                    date_trunc('day', timezone(getvariable('service_timezone'), starts)),
                    timezone(getvariable('service_timezone'), ends), INTERVAL '1 day')
            """
            key_sql = "row(bucket::DATE::VARCHAR)"
        projection = f"""
            {key_sql}, source, alert_id, version,
            epoch_us(greatest(starts, {bucket_start})),
            epoch_us(least(ends, {bucket_end}))
        """
        segments = f"""
            CROSS JOIN LATERAL {series} AS buckets(bucket)
            WHERE {bucket_start} < ends OR (starts = ends AND starts >= {bucket_start})
        """
    rows = conn.execute(
        f"""
        WITH bounds AS (
            SELECT timezone(getvariable('service_timezone'), ?::DATE::TIMESTAMP) AS window_start,
                timezone(getvariable('service_timezone'), (?::DATE + 1)::TIMESTAMP) AS window_end
        ), periods AS (
            SELECT source, alert_id, version, first_seen_at_utc, last_seen_at_utc,
                route_ids, stop_ids, effect, cause,
                unnest(CASE WHEN len(active_periods) = 0
                    THEN [{{'start_utc': NULL, 'end_utc': NULL}}]
                    ELSE active_periods END) AS period{text_columns}
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND ({" AND ".join(filters) or "true"})
        ), clipped AS (
            SELECT {group_sql} AS entity, source, alert_id, version,
                greatest(coalesce(period.start_utc, first_seen_at_utc), window_start) AS starts,
                least(coalesce(period.end_utc, last_seen_at_utc), window_end) AS ends,
                period.start_utc IS NULL AND period.end_utc IS NULL AS observed_only,
                first_seen_at_utc, last_seen_at_utc, window_end{message_columns}
            FROM periods CROSS JOIN bounds
        ), valid AS (
            SELECT DISTINCT entity, source, alert_id, version, starts, ends{message_columns}
            FROM clipped
            WHERE starts < ends OR (observed_only AND first_seen_at_utc = last_seen_at_utc
                AND starts = first_seen_at_utc AND starts < window_end AND starts = ends)
        )
        SELECT DISTINCT {projection} FROM valid {segments}
        """,
        [question.start, question.end, alert_paths, question.city, version, *arguments],
    ).fetchall()
    result: dict[EntityKey, Batch] = {}
    for entity, source, alert_id, revision, start, end, *message in rows:
        key = tuple(entity) if temporal else (entity,) if group or question.group else ()
        result.setdefault(key, Batch()).alert_spans.add(
            AlertSpan(source, alert_id, revision, start, end)
        )
        if message:
            routes, stops, header_en, header_fr, description_en, description_fr = message
            result[key].alert_messages[source, alert_id, revision] = {
                "source": source,
                "id": alert_id,
                "version": revision,
                "routes": routes,
                "stops": stops,
                "header": {"en": header_en, "fr": header_fr},
                "description": {"en": description_en, "fr": description_fr},
            }
    return result


_ALERT_COUNTS = Family(
    id=_ALERT_COUNTS_ID,
    label=Text("Service alerts", "Avis de service"),
    method_version="alert-counts-v1",
    since="2026-11-22",
    tables=(ALERTS,),
    minimum_sample=0,
    query=_alert_rows,
    columns={
        "alerts": Text("Distinct alerts", "Alertes distinctes"),
        "alert_versions": Text("Distinct alert versions", "Versions d’alertes distinctes"),
        "active_spans": Text("Distinct active spans", "Périodes actives distinctes"),
        "alert_seconds": Text("Alert-seconds", "Secondes d’alerte"),
    },
    evidence_columns={
        "days_not_tracked": Text("Days not tracked", "Jours sans suivi"),
        "days_alerts_tracked": Text("Days with alert tracking", "Jours avec suivi des alertes"),
    },
    counts=Text(
        "We count each alert ID and each version once per source. For each alert we "
        "merge overlapping periods across its versions, clip to the requested local dates, "
        "and sum its time with that of other alerts.",
        "On compte chaque identifiant d’alerte et chaque version une fois par source. "
        "Pour chaque alerte, on fusionne les périodes communes à ses versions, on se limite "
        "aux dates locales demandées et on additionne les durées de toutes les alertes.",
    ),
    exclusions=Text(
        "Line and stop filters use the IDs listed by the agency. Alerts without those "
        "IDs stay in the network total. Effect and cause use the published values. "
        "Zero alerts means no matching alert in the tracked history. An agency without "
        "alert tracking is marked not tracked.",
        "Les filtres de ligne et d’arrêt utilisent les identifiants déclarés par l’agence. "
        "Les alertes sans ces identifiants restent dans le total du réseau. L’effet et la "
        "cause reprennent les valeurs publiées. Zéro indique qu’aucune alerte ne correspond "
        "dans l’historique suivi. Une agence sans suivi des alertes est indiquée comme non suivie.",
    ),
    limits=Text(
        "The result describes published notices. Published bounds can extend outside the "
        "days when the notice was captured. Missing bounds use the first or last sighting "
        "of that version on its capture day. Gaps in the archive can omit other notices.",
        "Le résultat décrit les avis publiés. Les bornes publiées peuvent dépasser les "
        "jours de capture de l’avis. Une borne manquante est remplacée par la première "
        "ou la dernière observation de la version ce jour-là. Les lacunes des archives "
        "peuvent laisser d’autres avis de côté.",
    ),
    measures=(
        Measure(
            "alerts",
            "count",
            Text("Distinct alerts in effect.", "Alertes distinctes en vigueur."),
            ranking_kinds=(),
        ),
        Measure(
            "alert_versions",
            "count",
            Text("Distinct versions in effect.", "Versions distinctes en vigueur."),
            ranking_kinds=(),
        ),
        Measure(
            "alert_hours",
            "hours",
            Text("Hours of alerts in effect.", "Heures d’alerte en vigueur."),
            worst_first_descending=True,
            ranking_kinds=("line", "stop"),
        ),
    ),
)


_WAITING_EXCLUDED = {
    "unknown_direction": Text(
        "Scheduled stops with unknown direction", "Arrêts prévus de direction inconnue"
    ),
    "route_without_live_data": Text("Pairs without live data", "Paires sans données en direct"),
    "non_frequent": Text("Pairs outside frequent periods", "Paires hors des périodes fréquentes"),
    "missing_observation": Text(
        "Scheduled headways ending without an observation",
        "Intervalles prévus se terminant sans observation",
    ),
    "capture_gap": Text(
        "Observed headways without continuous capture",
        "Intervalles observés sans collecte continue",
    ),
    "unknown_passage": Text(
        "Covered intervals with an unobserved passage",
        "Intervalles couverts avec un passage non observé",
    ),
}
_WAITING_COLUMNS = {
    "scheduled_headways": Text("Scheduled headways", "Intervalles prévus"),
    "frequent_headways": Text(
        "Scheduled headways with live data in frequent periods",
        "Intervalles prévus avec données en direct en période fréquente",
    ),
    "covered_scheduled_headways": Text(
        "Scheduled headways in comparable windows",
        "Intervalles prévus dans les fenêtres comparables",
    ),
    "observed_headways": Text("Observed headways", "Intervalles observés"),
    "observed_trip_pairs": Text(
        "Distinct observed trip pairs", "Paires de trajets observés distinctes"
    ),
    "scheduled_seconds": Text("Covered scheduled seconds", "Secondes prévues couvertes"),
    "observed_seconds": Text("Covered observed seconds", "Secondes observées couvertes"),
    "wait_weight": Text(
        "Scheduled seconds used to weight excess wait",
        "Secondes prévues servant à pondérer l’attente excédentaire",
    ),
    "weighted_excess": Text(
        "Sum of period excess waits weighted by scheduled seconds",
        "Somme des attentes excédentaires par période, pondérées par les secondes prévues",
    ),
    "scheduled_squared_seconds": Text(
        "Sum of squared scheduled headways", "Somme des carrés des intervalles prévus"
    ),
    "observed_squared_seconds": Text(
        "Sum of squared observed headways", "Somme des carrés des intervalles observés"
    ),
    "bunching": Text("Bunched headways", "Intervalles avec regroupement"),
    "long_gaps": Text("Long headways", "Intervalles prolongés"),
    **_WAITING_EXCLUDED,
}


_WAITING_PERIOD_KEYS = "service_date, route_id, direction_id, stop_id, period"


def _waiting_schedule_summary(
    aggregates: str, entity: str, routes: str, counters: dict[str, str]
) -> tuple[str, str]:
    keys = _WAITING_PERIOD_KEYS
    # For distinct, whole-second passages, the positive gaps telescope to the
    # first-to-last span. Keep the ordered calculation for ties, fractional
    # times, or periods where a line's live status differs between trips.
    periods = f"""
        schedule_summary AS (
            SELECT {keys}, count(*) AS scheduled_stops,
                count(*) FILTER (route_has_live_data) AS live_candidates,
                count(*) FILTER (NOT has_observation)
                    - (NOT arg_min(has_observation, event_at))::INTEGER AS missing_after_first,
                (max(event_at) - min(event_at)) / 1000000 AS span_seconds,
                direction_id IS NULL OR (
                    count(DISTINCT event_at) = count(*)
                    AND bool_and(event_at % 1000000 = 0)
                    AND live_candidates IN (0, scheduled_stops)
                ) AS simple
            FROM scheduled_periods GROUP BY {keys}
        ), irregular_pairs AS (
            SELECT p.* EXCLUDE (local_at, trip_order),
                ((event_at - lag(event_at) OVER schedule) / 1000000)::BIGINT AS headway
            FROM scheduled_periods p SEMI JOIN (SELECT * FROM schedule_summary WHERE NOT simple) s
                USING ({keys})
            WINDOW schedule AS (PARTITION BY {keys} ORDER BY event_at, trip_order, stop_sequence)
        ), simple_frequency AS (
            SELECT {keys}, span_seconds / (scheduled_stops - 1) AS scheduled_mean
            FROM schedule_summary
            WHERE simple AND scheduled_stops > 1 AND direction_id IS NOT NULL
                AND live_candidates > 0 AND scheduled_mean <= {FREQUENT_HEADWAY_SECONDS}
        ), irregular_frequency AS (
            SELECT {keys}, avg(headway) AS scheduled_mean
            FROM irregular_pairs WHERE route_has_live_data AND headway > 0
            GROUP BY ALL HAVING scheduled_mean <= {FREQUENT_HEADWAY_SECONDS}
        ), frequent_periods AS (
            SELECT * FROM simple_frequency UNION ALL SELECT * FROM irregular_frequency
        )
    """
    totals = ", ".join(f"sum({name}) AS {name}" for name in counters)
    evidence = f"""
        simple_evidence AS (
            SELECT s.route_id, scheduled_stops, live_candidates,
                IF(s.direction_id IS NULL, 0, live_candidates) AS live_direction_stops,
                IF(s.direction_id IS NULL, scheduled_stops, 0) AS unknown_direction,
                IF(s.direction_id IS NULL, 0, scheduled_stops - 1) AS scheduled_headways,
                IF(scheduled_mean IS NULL, 0, scheduled_headways) AS frequent_headways,
                IF(live_candidates = 0, scheduled_headways, 0) AS route_without_live_data,
                scheduled_headways - frequent_headways - route_without_live_data AS non_frequent,
                IF(scheduled_mean IS NULL, 0, missing_after_first) AS missing_observation
            FROM schedule_summary s LEFT JOIN simple_frequency f USING ({keys})
            WHERE simple
        ), irregular_evidence AS (
            SELECT p.route_id, {aggregates}
            FROM (
                SELECT p.*, f.scheduled_mean IS NOT NULL AS frequent
                FROM irregular_pairs p LEFT JOIN irregular_frequency f USING ({keys})
            ) p
            GROUP BY p.route_id
        ), schedule_evidence AS (
            SELECT {entity} AS entity, {routes} AS routes, {totals}
            FROM (SELECT * FROM simple_evidence UNION ALL BY NAME SELECT * FROM irregular_evidence)
            GROUP BY entity
        )
    """
    return periods, evidence


def _waiting_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    scope, scope_params = _cuts(replace(question, hour=None, departure=None), None)
    cut, cut_params = _cuts(question, "local_hour")
    window = [question.city, version, question.start, question.end]
    entity = _entity_sql(group, question.group, "local_hour")

    scheduled_local = local_epoch_us_sql(conn, "scheduled_at", question.start, question.end)
    observed_local = local_epoch_us_sql(conn, "observed_at", question.start, question.end)
    scheduled_start = (
        "scheduled_start_utc"
        if question.departure is not None or question.group == "departure" or group == "departure"
        else "NULL::TIMESTAMPTZ"
    )
    routes = "list(DISTINCT route_id)" if group else "NULL"
    # Both sequences reset at period boundaries so that, for example, a planned
    # overnight break cannot contribute its wait to the morning period.
    schedule_counts = {
        "scheduled_stops": "count(*)",
        "live_candidates": "count(*) FILTER (route_has_live_data)",
        "live_direction_stops": "count(direction_id) FILTER (route_has_live_data)",
        "unknown_direction": "count(*) FILTER (direction_id IS NULL)",
        "scheduled_headways": "count(*) FILTER (headway > 0)",
        "frequent_headways": "count(*) FILTER (frequent AND headway > 0)",
        "route_without_live_data": "count(*) FILTER (headway > 0 AND NOT route_has_live_data)",
        "non_frequent": "count(*) FILTER (headway > 0 AND route_has_live_data AND NOT frequent)",
        "missing_observation": "count(*) FILTER (frequent AND headway > 0 AND NOT has_observation)",
    }
    observed_counts = {
        "observed_headways": "count(*) FILTER (eligible)",
        "observed_trip_pairs": (
            "count(DISTINCT (service_date, least(previous_trip, trip_id), "
            "greatest(previous_trip, trip_id))) FILTER (eligible AND previous_trip <> trip_id)"
        ),
        "observed_seconds": "sum(headway) FILTER (eligible)",
        "observed_squared_seconds": "sum(headway * headway) FILTER (eligible)",
        "capture_gap": "count(*) FILTER (NOT covered)",
        "unknown_passage": "count(*) FILTER (covered AND NOT eligible)",
    }
    observed_counts.update(
        {m.id: f"count(*) FILTER (eligible AND ({m.band}))" for m in family.measures if m.band}
    )
    wait_counts = ("covered_scheduled_headways", "scheduled_seconds", "scheduled_squared_seconds")
    counters = (*schedule_counts, *observed_counts, *wait_counts)
    schedule_aggregates = ", ".join(f"{sql} AS {name}" for name, sql in schedule_counts.items())
    observed_aggregates = ", ".join(f"{sql} AS {name}" for name, sql in observed_counts.items())
    period_start = "CASE " + " ".join(
        f"WHEN local_hour < {p.end_hour} THEN {p.start_hour}" for p in PERIODS
    ) + " END"
    period = f"date_diff('day', DATE '1970-01-01', local_at::DATE) * 24 + ({period_start})"
    keys = _WAITING_PERIOD_KEYS
    schedule_sql = f"""
        scheduled_pairs AS (
            SELECT * EXCLUDE (local_at, trip_order), lag(event_at) OVER schedule AS previous_at,
                CASE WHEN direction_id IS NOT NULL
                    THEN ((event_at - previous_at) / 1000000)::BIGINT END AS headway
            FROM scheduled_periods
            WINDOW schedule AS (PARTITION BY {keys} ORDER BY event_at, trip_order, stop_sequence)
        ), frequent_periods AS (
            SELECT {keys}, avg(headway) AS scheduled_mean
            FROM scheduled_pairs
            WHERE route_has_live_data AND headway > 0
            GROUP BY ALL HAVING scheduled_mean <= {FREQUENT_HEADWAY_SECONDS}
        )
    """
    schedule_evidence = f"""
        schedule_in_cut AS NOT MATERIALIZED (
            SELECT p.*, {entity} AS entity, f.scheduled_mean IS NOT NULL AS frequent
            FROM scheduled_pairs p LEFT JOIN frequent_periods f USING ({keys})
            WHERE {cut}
        ), schedule_evidence AS (
            SELECT entity, {routes} AS routes, {schedule_aggregates}
            FROM schedule_in_cut GROUP BY entity
        )
    """
    comparable_schedule = "SELECT * FROM schedule_in_cut WHERE frequent AND headway > 0"
    schedule_cut_params = cut_params
    if (
        group in (None, "line")
        and question.group is None
        and question.hour is None
        and question.departure is None
    ):
        schedule_sql, schedule_evidence = _waiting_schedule_summary(
            schedule_aggregates, entity, routes, schedule_counts
        )
        comparable_schedule = f"""
            SELECT {entity} AS entity, {keys}, event_at, previous_at,
                ((event_at - previous_at) / 1000000)::BIGINT AS headway
            FROM (
                SELECT {keys}, event_at,
                    lag(event_at) OVER (PARTITION BY {keys} ORDER BY event_at) AS previous_at
                FROM scheduled_periods SEMI JOIN observed_windows USING ({keys})
            )
            WHERE headway > 0
        """
        schedule_cut_params = []
    # Each batch holds one service day. Share the projected scan across the
    # scheduled, observed and unknown passages for that day.
    rows = conn.execute(
        f"""
        WITH events AS MATERIALIZED (
            SELECT service_date, trip_order, stop_id, stop_sequence, route_id, direction_id,
                scheduled_start_utc, route_has_live_data,
                state IN ('ran', 'unconfirmed') AS might_have_run,
                CASE WHEN state <> 'added' THEN
                    coalesce(scheduled_arrival_utc, scheduled_departure_utc)
                END AS scheduled_at,
                CASE WHEN route_has_live_data AND direction_id IS NOT NULL
                    THEN observed_at_utc END AS observed_at
            FROM (
                SELECT s.service_date, t.trip_order, s.stop_id, s.stop_sequence,
                    t.route_id, t.direction_id, t.route_has_live_data, t.scheduled_start_utc,
                    t.state, s.scheduled_arrival_utc, s.scheduled_departure_utc, s.observed_at_utc
                FROM read_parquet(?, hive_partitioning = false) s
                JOIN (
                    -- Preserve trip-id order at tied timestamps without carrying
                    -- trip strings through every stop sequence and distinct pair.
                    SELECT provider, cleaning_version, service_date, trip_id, route_id,
                        direction_id, route_has_live_data, {scheduled_start} AS scheduled_start_utc,
                        state,
                        row_number() OVER (PARTITION BY service_date ORDER BY trip_id)
                            AS trip_order
                    FROM read_parquet(?, hive_partitioning = false)
                    WHERE provider = ? AND cleaning_version = ?
                        AND service_date BETWEEN ? AND ? AND route_id IS NOT NULL
                ) t
                    USING (provider, cleaning_version, service_date, trip_id)
                WHERE s.provider = ? AND s.cleaning_version = ?
                    AND s.service_date BETWEEN ? AND ?
            )
            WHERE {scope}
        ), scheduled_periods AS NOT MATERIALIZED (
            SELECT service_date, trip_order, stop_id, stop_sequence, route_id, direction_id,
                scheduled_start_utc, route_has_live_data,
                observed_at IS NOT NULL AS has_observation,
                epoch_us(scheduled_at) AS event_at,
                make_timestamp({scheduled_local}) AS local_at,
                hour(local_at) AS local_hour,
                {period} AS period
            FROM events WHERE scheduled_at IS NOT NULL
        ), {schedule_sql},
        observed_periods AS (
            SELECT service_date, trip_order AS trip_id, stop_id, stop_sequence, route_id,
                direction_id, scheduled_start_utc, epoch_us(observed_at) AS event_at,
                make_timestamp({observed_local}) AS local_at,
                hour(local_at) AS local_hour,
                {period} AS period
            FROM events
            WHERE observed_at IS NOT NULL
        ), observed_pairs AS (
            SELECT p.* EXCLUDE (local_at), f.scheduled_mean,
                lag(event_at) OVER arrivals AS previous_at,
                lag(trip_id) OVER arrivals AS previous_trip,
                ((event_at - previous_at) / 1000000)::BIGINT AS headway
            FROM observed_periods p JOIN frequent_periods f
                USING (service_date, route_id, direction_id, stop_id, period)
            WINDOW arrivals AS (
                PARTITION BY service_date, route_id, direction_id, stop_id, period
                ORDER BY event_at, trip_id, stop_sequence
            )
        ),
        {POLL_COVERAGE_SQL},
        -- An intersection begins at the start of one feed run, and ends at the
        -- earliest end of the runs active at that moment.
        common_coverage AS (
            SELECT starts.service_date, epoch_us(starts.covered_from) AS covered_from,
                epoch_us(min(c.covered_to)) AS covered_to
            FROM (SELECT DISTINCT service_date, covered_from FROM coverage) starts
            JOIN coverage c ON c.service_date = starts.service_date
                AND c.covered_from <= starts.covered_from AND c.covered_to > starts.covered_from
            JOIN realtime_feed_counts f ON f.service_date = starts.service_date
            GROUP BY starts.service_date, starts.covered_from, f.required_feeds
            HAVING count(*) = f.required_feeds
        ), coverage_hours AS (
            -- A feed run ends before the next begins, so intersections are
            -- disjoint. Index them by UTC hour to limit the interval comparisons.
            SELECT service_date, covered_from, covered_to, coverage_hour
            FROM common_coverage,
                unnest(generate_series(
                    covered_from // 3600000000, covered_to // 3600000000
                )) hours(coverage_hour)
        ), {schedule_evidence},
        observed_in_cut AS (
            SELECT *, {entity} AS entity
            FROM observed_pairs WHERE previous_at IS NOT NULL AND {cut}
        ), unknown_passages AS (
            SELECT service_date, route_id, direction_id, stop_id,
                epoch_us(scheduled_at) AS unknown_at
            FROM events SEMI JOIN frequent_periods
                USING (service_date, route_id, direction_id, stop_id)
            WHERE scheduled_at IS NOT NULL AND observed_at IS NULL
                AND might_have_run
        ), checked_headways AS (
            SELECT p.service_date, p.route_id, p.direction_id, p.stop_id, p.period,
                p.entity, p.trip_id, p.previous_trip, p.headway,
                p.scheduled_mean, p.previous_at, p.event_at, c.covered_from, u.unknown_at,
                c.covered_from IS NOT NULL AS covered,
                covered AND (u.unknown_at IS NULL OR u.unknown_at <= p.previous_at) AS eligible
            FROM observed_in_cut p LEFT JOIN coverage_hours c
                ON p.service_date = c.service_date AND p.event_at // 3600000000 = c.coverage_hour
                AND p.previous_at >= c.covered_from AND p.event_at <= c.covered_to
            ASOF LEFT JOIN unknown_passages u
                ON p.service_date = u.service_date AND p.route_id = u.route_id
                AND p.direction_id = u.direction_id AND p.stop_id = u.stop_id
                AND p.event_at > u.unknown_at
        ), observed_evidence AS (
            SELECT entity, {observed_aggregates}
            FROM checked_headways GROUP BY entity
        ), observed_windows AS (
            -- Eligible intervals are contiguous within each coverage run and
            -- between unobserved passages. Only this time can inform the schedule.
            SELECT entity, service_date, route_id, direction_id, stop_id, period,
                min(previous_at) AS window_start, max(event_at) AS window_end,
                sum(headway) AS actual_elapsed, sum(headway * headway) AS actual_squared
            FROM checked_headways WHERE eligible
            GROUP BY entity, service_date, route_id, direction_id, stop_id, period,
                covered_from, unknown_at
        ), observed_wait_by_period AS (
            -- Every eligible observed headway counts toward the period's actual
            -- wait, even when its window contains no complete scheduled headway.
            SELECT entity, service_date, route_id, direction_id, stop_id, period,
                sum(actual_elapsed) AS actual_elapsed, sum(actual_squared) AS actual_squared
            FROM observed_windows GROUP BY ALL
        ), scheduled_wait_by_period AS (
            SELECT s.entity, s.service_date, s.route_id, s.direction_id, s.stop_id, s.period,
                count(*) AS scheduled_count, sum(s.headway) AS scheduled_elapsed,
                sum(s.headway * s.headway) AS scheduled_squared
            FROM ({comparable_schedule}) s
            ASOF JOIN observed_windows w
                ON s.entity = w.entity AND s.service_date = w.service_date
                AND s.route_id = w.route_id AND s.direction_id = w.direction_id
                AND s.stop_id = w.stop_id AND s.period = w.period
                AND s.previous_at >= w.window_start
            WHERE s.event_at <= w.window_end
            GROUP BY ALL
        ), waiting AS (
            SELECT entity, sum(scheduled_count) AS covered_scheduled_headways,
                sum(scheduled_elapsed) AS scheduled_seconds,
                sum(scheduled_squared) AS scheduled_squared_seconds,
                sum(scheduled_elapsed) FILTER (actual_elapsed > 0) AS wait_weight,
                sum(0.5 * (actual_squared * (scheduled_elapsed / nullif(actual_elapsed, 0))
                    - scheduled_squared)) AS weighted_excess
            FROM scheduled_wait_by_period JOIN observed_wait_by_period
                USING (entity, service_date, route_id, direction_id, stop_id, period)
            GROUP BY entity
        )
        SELECT entity, NULL, routes, {", ".join(f"coalesce({name}, 0)" for name in counters)},
            coalesce(wait_weight, 0), coalesce(weighted_excess, 0)
        FROM schedule_evidence FULL JOIN observed_evidence USING (entity)
        LEFT JOIN waiting USING (entity)
        """,
        [
            paths[STOP_EVENTS],
            paths[TRIP_DAYS],
            *window,
            *window,
            *scope_params,
            paths[FEED_POLLS],
            *window,
            *schedule_cut_params,
            *cut_params,
        ],
    ).fetchall()
    grouped = bool(group or question.group)
    results = _grouped_batches([row[:-2] for row in rows], counters, "observed_headways", grouped)
    for key, *_, wait_weight, weighted_excess in rows:
        batch = results[tuple(key) if grouped else ()]
        batch.counts["wait_weight"] = wait_weight
        batch.waiting_weighted_excess = weighted_excess
    return results


_WAITING = Family(
    id=_WAITING_ID,
    label=Text("Waiting and gaps", "Attente et intervalles"),
    method_version="3",
    since="2026-11-22",
    tables=(STOP_EVENTS, TRIP_DAYS, FEED_POLLS),
    minimum_sample=MIN_OBSERVED_HEADWAYS,
    coverage=(0.25, 0.50),
    ranking_floors={"line": {"observed_trip_pairs": 20, "observed_headways": 50}},
    counts=Text(
        "Evidence gives scheduled and observed headway counts, their sums and squared sums, "
        "and the counts of bunched and long intervals. Coverage compares the number of "
        "observed headways with the scheduled count in frequent periods, up to 100%.",
        "Les données indiquent le nombre d’intervalles prévus et observés, leur somme et "
        "la somme de leurs carrés, ainsi que le nombre d’intervalles courts et prolongés. "
        "La couverture rapporte le nombre d’intervalles observés au nombre prévu en période "
        "fréquente, jusqu’à 100 %.",
    ),
    exclusions=Text(
        "Observed headways are the intervals between successive observed passages for the "
        "same line, stop and direction. Every recorded observation time can contribute. "
        "A covered interval is unknown if a trip that ran or could not be confirmed "
        "was scheduled between the observations and has no observed time at that stop. "
        "Each recorded vehicle or trip updates feed must cover the entire interval, with "
        f"at most {MAX_POLL_SPACING_SECONDS} seconds between usable polls and publication "
        f"age of at most {MAX_POLL_AGE_SECONDS} seconds plus the declared source lag. "
        "The direction must be known and the line must have live data.",
        "Les intervalles observés séparent les passages observés successifs pour la même "
        "ligne, le même arrêt et la même direction. Toute heure de passage observée peut "
        "être utilisée. Un intervalle couvert est de durée inconnue si un trajet effectué "
        "ou non confirmé était prévu entre les observations et n’a pas d’heure observée "
        "à cet arrêt. Chaque flux de positions ou de mises à jour des trajets consigné "
        "doit couvrir tout l’intervalle, avec au plus "
        f"{MAX_POLL_SPACING_SECONDS} secondes entre les relevés utilisables et des "
        f"publications datant d’au plus {MAX_POLL_AGE_SECONDS} secondes plus le délai source "
        "déclaré. La direction doit être connue et la ligne doit fournir des données en direct.",
    ),
    limits=Text(
        f"A frequent period has at least two distinct scheduled times and a mean scheduled "
        f"interval of at most {FREQUENT_HEADWAY_SECONDS // 60} minutes for the line, stop "
        f"and direction on that service date. Local periods are {periods_text('en')}. "
        "Both passages must be in the same period. The ending passage determines the hour. "
        "A departure "
        "cut uses the ending trip’s scheduled departure. "
        f"At least {MIN_OBSERVED_HEADWAYS} observed headways are needed to report a value.",
        "Une période est fréquente si elle compte au moins deux heures de passage distinctes "
        f"et un intervalle prévu moyen d’au plus {FREQUENT_HEADWAY_SECONDS // 60} minutes "
        "pour la ligne, l’arrêt et la direction à cette date de service. "
        f"Les périodes locales sont {periods_text('fr')}. Les deux passages doivent être "
        "dans la même période. Le passage qui termine l’intervalle détermine l’heure. "
        "Un filtre par départ utilise "
        "l’heure de départ prévue du trajet qui termine l’intervalle. "
        f"Il faut au moins {MIN_OBSERVED_HEADWAYS} intervalles observés pour publier une valeur.",
    ),
    measures=(
        Measure(
            "observed_headway",
            "seconds",
            Text(
                "Mean time between successive observed passages at a stop.",
                "Intervalle moyen entre les passages observés successifs à un arrêt.",
            ),
            ratio=("observed_seconds", "observed_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "scheduled_headway",
            "seconds",
            Text(
                "Mean scheduled interval in capture windows with scheduled and observed headways.",
                "Intervalle prévu moyen dans les fenêtres de collecte qui contiennent des "
                "intervalles prévus et observés.",
            ),
            ratio=("scheduled_seconds", "covered_scheduled_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "bunching",
            "share",
            Text(
                f"Share of observed headways shorter than {BUNCHING_FRACTION:.0%} "
                "of the period’s mean scheduled headway.",
                f"Part des intervalles observés inférieurs à {BUNCHING_FRACTION:.0%} "
                "de l’intervalle prévu moyen de la période.",
            ),
            band=f"headway < {BUNCHING_FRACTION} * scheduled_mean",
            ratio=("bunching", "observed_headways"),
            worst_first_descending=True,
            ranking_kinds=("line",),
        ),
        Measure(
            "long_gaps",
            "share",
            Text(
                f"Share of observed headways longer than {LONG_GAP_MULTIPLE} times "
                "the period’s mean scheduled headway.",
                f"Part des intervalles observés supérieurs à {LONG_GAP_MULTIPLE} fois "
                "l’intervalle prévu moyen de la période.",
            ),
            band=f"headway > {LONG_GAP_MULTIPLE} * scheduled_mean",
            ratio=("long_gaps", "observed_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "excess_wait_time",
            "seconds",
            Text(
                "Excess wait is observed average wait minus scheduled average wait for "
                "riders arriving without consulting the timetable. Within each period, "
                "average wait is the sum of squared headways divided by twice their sum. "
                "The scheduled calculation uses complete scheduled headways inside the "
                "windows of known observed headways for each stop, line and direction. "
                "The result weights "
                "each period by the sum of its covered scheduled headways.",
                "L’attente excédentaire est l’attente moyenne observée moins l’attente "
                "moyenne prévue pour les personnes qui arrivent sans consulter l’horaire. "
                "Dans chaque période, l’attente moyenne est la somme des carrés des "
                "intervalles divisée par deux fois leur somme. Le calcul prévu utilise "
                "les intervalles prévus entièrement compris dans les fenêtres "
                "d’intervalles observés connus pour chaque arrêt, ligne et direction. "
                "Chaque période est "
                "pondérée selon la durée totale de ses intervalles prévus couverts.",
            ),
            worst_first_descending=True,
            ranking_kinds=("line",),
        ),
    ),
    query=_waiting_rows,
    columns={"share_observed": _EVIDENCE_COLUMNS["share_observed"], **_WAITING_COLUMNS},
)


_OFFERED_COLUMNS = {
    "scheduled_trips": Text("Scheduled trips", "Trajets prévus"),
    "scheduled_clock_hours": Text("Scheduled clock hours", "Heures de l’horaire"),
    "service_units": Text(
        "Line and direction combinations", "Combinaisons de ligne et de direction"
    ),
    "eligible_periods": Text(
        "Evening and weekend periods assessed", "Périodes évaluées en soirée et en fin de semaine"
    ),
    "below_minimum_service": Text(
        "Periods below the service threshold", "Périodes sous le seuil de service"
    ),
}
_OFFERED_EVIDENCE = {
    "periods": Text("Schedule by period and day type", "Horaire par période et type de jour")
}
_MIN_SCHEDULE_DAYS = 1


def _offered_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    cut, parameters = _cuts(replace(question, hour=None), None)
    bucket = period_sql("local_hour")
    period_hours = (
        "CASE period "
        + " ".join(f"WHEN '{p.id}' THEN {p.end_hour - p.start_hour}" for p in PERIODS)
        + " END"
    )
    count = "count(*)"
    hourly = question.group in HOUR_GROUPS
    hour_column = ", local_hour" if hourly else ""
    if hourly:
        period_hours = "1"
    elif question.hour is not None:
        count += " FILTER (local_hour = ?)"
        parameters.append(question.hour)
        period_hours = "1"
    entity = _entity_sql(None, question.group, "local_hour")
    rows = conn.execute(
        f"""
        WITH timetable AS (
            SELECT service_date, route_id, direction_id, stop_id, trip_id,
                coalesce(scheduled_departure_utc, scheduled_arrival_utc) AS stop_time,
                min(stop_time) OVER (PARTITION BY service_date, trip_id) AS scheduled_start_utc
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
                AND route_id IS NOT NULL
        ), departures AS (
            SELECT service_date, route_id, direction_id,
                {_LOCAL_HOUR.format("min(stop_time)")} AS local_hour
            FROM timetable WHERE stop_time IS NOT NULL AND {cut}
            GROUP BY service_date, route_id, direction_id, trip_id
        ), daily AS (
            SELECT service_date, route_id, direction_id, {bucket} AS period, {count} AS trips
                {hour_column}
            FROM departures GROUP BY service_date, route_id, direction_id, period{hour_column}
        )
        SELECT {entity} AS entity, route_id, direction_id,
            {day_type_sql("service_date")} AS day_type,
            period, sum(trips), count(*) FILTER (trips >= {MIN_TRIPS_PER_HOUR} * ({period_hours})),
            list(DISTINCT service_date::VARCHAR)
        FROM daily GROUP BY entity, route_id, direction_id, day_type, period
        """,
        [
            paths[family.tables[0]],
            question.city,
            version,
            question.start,
            question.end,
            *parameters,
        ],
    ).fetchall()
    results: dict[EntityKey, Batch] = {}
    for entity_key, *values in rows:
        key = tuple(entity_key) if question.group else ()
        results.setdefault(key, Batch()).offered.append(OfferedCounts(*values))
    return results


_SERVICE_OFFERED = Family(
    id=_SERVICE_OFFERED_ID,
    label=Text("Service offered", "Service offert"),
    method_version="2",
    since="2026-11-22",
    tables=(SCHEDULED_STOP_TIMES,),
    minimum_sample=_MIN_SCHEDULE_DAYS,
    counts=Text(
        "Evidence gives the number of scheduled trips, clock hours and evening or weekend "
        "periods assessed, with a breakdown by local period and service day type.",
        "Les données indiquent les nombres de trajets prévus, d’heures à l’horaire et de "
        "périodes évaluées, par période locale et type de jour de service.",
    ),
    exclusions=Text(
        "The schedule includes lines without live data. The count uses the first timed stop "
        "of each trip, or the first timed visit to the selected stop. Missing schedules are "
        "excluded. Minimum service is assessed for each line and direction on the dates "
        "when the published timetable includes it. A period on such a date may have zero trips.",
        "L’horaire inclut les lignes sans données en direct. Chaque trajet est compté au "
        "premier arrêt avec une heure prévue ou au premier passage avec une heure prévue "
        "à l’arrêt choisi. Les horaires manquants sont exclus. Une ligne et une direction "
        "sont évaluées aux dates où elles figurent dans l’horaire. Une période à cette date "
        "peut ne compter aucun trajet.",
    ),
    limits=Text(
        f"At least {_MIN_SCHEDULE_DAYS} service day with a validated schedule is required. "
        f"Local periods are {periods_text('en')}. Frequencies use clock-hour slots, including "
        "on clock-change days. Overnight trips keep the service date they belong to.",
        f"Il faut au moins {_MIN_SCHEDULE_DAYS} jour de service avec un horaire validé. "
        f"Périodes locales : {periods_text('fr')}. Les fréquences utilisent les heures "
        "de l’horloge, même les jours de changement d’heure. Les trajets de nuit "
        "conservent leur date de service.",
    ),
    measures=(
        Measure(
            "scheduled_trips",
            "trips",
            Text(
                "Number of trips in the selected timetable.",
                "Nombre de trajets dans l’horaire choisi.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "scheduled_frequency",
            "trips_per_hour",
            Text(
                "Scheduled trips divided by clock hours in the selected dates and periods.",
                "Trajets prévus divisés par le nombre d’heures aux dates et périodes choisies.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "below_minimum_service",
            "periods",
            Text(
                f"Number of evening and weekend periods with fewer than {MIN_TRIPS_PER_HOUR} "
                "scheduled trips per hour on average, assessed for each date, line and "
                "direction in scope. The threshold corresponds to a half-hour interval "
                "if service is evenly spaced.",
                "Nombre de périodes en soirée ou en fin de semaine comptant en moyenne "
                f"moins de {MIN_TRIPS_PER_HOUR} trajets prévus par heure, évaluées pour chaque "
                "date, ligne et direction choisies. Le seuil correspond à un intervalle "
                "d’une demi-heure si les passages sont réguliers.",
            ),
            ranking_kinds=(),
        ),
    ),
    query=_offered_rows,
    columns=_OFFERED_COLUMNS,
    evidence_columns=_OFFERED_EVIDENCE,
)


# Transit R5, "Owner decisions" and "What each screen answers":
# https://app.notion.com/p/41e3e863069081e193eaeee433839958
_VEHICLE_PUNCTUALITY_CAUTION = Text(
    "Lateness mostly reflects the lines and hours the vehicle is assigned to.",
    "Le retard reflète surtout les lignes et les heures auxquelles le véhicule est affecté.",
)
_VEHICLE_PUNCTUALITY = tuple(
    replace(
        measure,
        id=f"vehicle_{measure.id}",
        counts=_PUNCTUALITY.counts,
        exclusions=_PUNCTUALITY.exclusions,
        limits=Text(
            f"{_PUNCTUALITY.limits.en} {_VEHICLE_PUNCTUALITY_CAUTION.en}",
            f"{_PUNCTUALITY.limits.fr} {_VEHICLE_PUNCTUALITY_CAUTION.fr}",
        ),
        extra_tables=(STOP_EVENTS,),
        ranking_kinds=(),
    )
    for measure in _PUNCTUALITY.measures
)
_VEHICLE_PUNCTUALITY_IDS = {measure.id for measure in _VEHICLE_PUNCTUALITY}
_VEHICLE_REPORTING_IDS = {"vehicle_reporting_gaps", "vehicle_silent_hours", VEHICLE_RANKING_DEFAULT}
_VEHICLE_COMPLETION_IDS = {"vehicle_unfinished_trips", "vehicle_unfinished_trips_per_100_trips"}
_TRIP_END_NOT_OBSERVABLE = "trip_end_not_observable"
_VEHICLE_COLUMNS = {
    "days_in_service": Text("Days in service", "Jours en service"),
    "hours_in_service": Text("Vehicle-hours in service", "Heures-véhicules en service"),
    "lines_run": Text("Distinct lines", "Lignes distinctes"),
    "trips_run": Text("Trips run", "Trajets effectués"),
    "reporting_gaps": Text("Times reporting stopped", "Interruptions des signalements"),
    "silent_hours": Text("Hours without reports", "Heures sans signalement"),
    "reporting_gaps_capture_gap": Text(
        "Silences excluded for capture gaps", "Silences exclus pour interruption de la collecte"
    ),
    "reporting_gaps_capture_gap_hours": Text(
        "Hours excluded for capture gaps", "Heures exclues pour interruption de la collecte"
    ),
    "completion_confirmed_upstream_reassignments": Text(
        "Confirmed upstream reassignments", "Réaffectations confirmées avant le terminus"
    ),
    "completion_sample": Text("Trips assessed for completion", "Trajets évalués"),
    "completion_capture_gap": Text("Trips with capture gaps", "Trajets avec collecte interrompue"),
    "completion_unknown": Text("Trips with unknown status", "Trajets à l’état inconnu"),
    **{f"punctuality_{key}": label for key, (_, label) in _COUNTS.items()},
    **{f"punctuality_{key}": label for key, label in _PUNCTUALITY_BASES.items()},
    **{
        f"punctuality_{m.id}": m.count_label
        for m in _PUNCTUALITY.measures
        if m.count_label is not None
    },
}
_VEHICLE_LIMITS = Text(
    f"A day is not tracked if fewer than {MIN_STABLE_READING_SHARE:.0%} of clean vehicle "
    f"readings use an ID seen at least {MIN_STABLE_ID_READINGS} times, or fewer than that "
    "share of confirmed trips can be linked to those IDs. Repeated IDs are evidence "
    "of continuity within the day. Vehicle hours use capture times, and an interval "
    "never extends past the next capture. A gap describes silence in the captured feed.",
    f"Le suivi est indisponible un jour si moins de {MIN_STABLE_READING_SHARE:.0%} des "
    f"relevés de véhicules nettoyés ont un identifiant vu au moins {MIN_STABLE_ID_READINGS} "
    "fois, ou si une part inférieure des trajets confirmés est liée à ces identifiants. "
    "La répétition d’un identifiant témoigne de sa continuité dans la journée. "
    "Les heures-véhicules utilisent les heures de collecte. Un intervalle se termine "
    "au plus tard au relevé suivant. "
    "Une interruption indique un silence dans le flux capturé.",
)
_VEHICLE_REPORTING_EXCLUSIONS = Text(
    "The vehicle-position feed must have continuous capture across the silence. Usable polls "
    f"contain advancing, nonempty publications at most {MAX_POLL_AGE_SECONDS} seconds old "
    "plus the declared source lag, "
    f"and are at most {MAX_POLL_SPACING_SECONDS} seconds apart. Silences across capture gaps "
    "are excluded from the count and duration and shown in the evidence.",
    "La collecte du flux de positions doit être continue pendant le silence. Les relevés "
    "utilisables contiennent des publications non vides plus récentes que les précédentes, "
    f"vieilles d’au plus {MAX_POLL_AGE_SECONDS} secondes plus le délai source déclaré, "
    "et espacées d’au plus "
    f"{MAX_POLL_SPACING_SECONDS} secondes. Les silences pendant une interruption de la "
    "collecte sont exclus du nombre et de la durée et figurent dans les données justificatives.",
)
# Keep the upstream reassignment rule as diagnostic evidence. Revisit publication when a feed
# demonstrates confirmed reassignments on real service dates and terminus coverage is sufficient.
_VEHICLE_COMPLETION_METHOD = Text(
    "The live feeds do not show reliably when a trip ends early, "
    "so trips not finished are not tracked.",
    "Les flux en direct ne montrent pas de façon fiable quand un trajet se termine tôt, "
    "alors les trajets non terminés ne sont pas suivis.",
)


def _vehicle_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    stats, stats_params = vehicle_stats_query(
        paths,
        [question.city, version, question.start, question.end],
        group == "vehicle" or question.group == "vehicle",
        question.measure == family.id or question.measure in _VEHICLE_REPORTING_IDS,
        question.measure == family.id or question.measure in _VEHICLE_COMPLETION_IDS,
        by_hour=question.group == "hour",
        by_line=question.group == "line",
    )
    timing_cte = ""
    timing_rows = ""
    timing_params: list[object] = []
    timing_counters: dict[str, str] = {}
    if group is None and (
        question.measure == family.id or question.measure in _VEHICLE_PUNCTUALITY_IDS
    ):
        timing, timing_params, timing_counters = _punctuality_query(
            _PUNCTUALITY, paths, question, version, None, for_vehicles=True
        )
        timing_columns = ", ".join(("entity", "edge", "routes", *timing_counters))
        timing_cte = f", timing({timing_columns}) AS ({timing})"
        timing_rows = "UNION ALL SELECT NULL, timing, false FROM timing"

    stats_columns = ", ".join(("entity", "routes", *VEHICLE_COUNTS))
    rows = conn.execute(
        f"""
        WITH tracking AS ({TRACKED_VEHICLES_SQL}), selected_vehicles AS (
            SELECT vehicle_id FROM tracking, unnest(ids) AS stable(vehicle_id)
            WHERE (?::VARCHAR IS NULL OR vehicle_id = ?)
        ), stats({stats_columns}) AS ({stats})
        {timing_cte}
        SELECT stats, NULL, false FROM stats
        {timing_rows}
        UNION ALL SELECT NULL, NULL, true FROM tracking WHERE ids IS NULL
        """,
        [
            paths[VEHICLE_POSITIONS],
            question.city,
            version,
            paths[TRIP_DAYS],
            question.city,
            version,
            question.vehicle,
            question.vehicle,
            *stats_params,
            *timing_params,
        ],
    ).fetchall()
    results: dict[EntityKey, Batch] = {}
    timing_batches = []
    for stats_row, timing_row, untracked in rows:
        if untracked:
            return {(None,): Batch()}
        if stats_row is not None:
            key = (stats_row["entity"],) if group or question.group else ()
            results[key] = Batch(
                counts=Counter(
                    {
                        "tracked_vehicle_days": 1,
                        **{name: stats_row[name] for name in VEHICLE_COUNTS},
                    }
                ),
                vehicle_routes=set(stats_row["routes"] or ()),
            )
        elif timing_row is not None:
            timing_batches.append(
                (
                    timing_row["entity"],
                    timing_row["edge"],
                    timing_row["routes"],
                    *(timing_row[name] for name in timing_counters),
                )
            )
    for timing_key, punctuality in _grouped_batches(
        timing_batches, timing_counters, "classified", bool(question.group)
    ).items():
        if timing_key in results:
            results[timing_key].update(punctuality)
    return results


_VEHICLES = Family(
    id=_VEHICLES_ID,
    label=Text("Vehicles", "Véhicules"),
    method_version="vehicles-v3",
    since="2026-11-22",
    tables=(VEHICLE_POSITIONS, TRIP_DAYS),
    query=_vehicle_rows,
    minimum_sample=1,
    counts=Text(
        "City days count dates with any tracked vehicle in service. City hours add vehicle "
        "time, and routes and dated trips are distinct across vehicles.",
        "Les jours à l’échelle de la ville comptent les dates où au moins un véhicule suivi "
        "est en service. Les heures s’additionnent et les lignes et trajets datés sont distincts.",
    ),
    exclusions=Text(
        "Completion diagnostics distinguish observed termini, confirmed upstream reassignments, "
        "unknown outcomes and capture gaps.",
        "Les données sur l’achèvement distinguent les terminus observés, les réaffectations "
        "confirmées avant le terminus, les issues inconnues et les interruptions de collecte.",
    ),
    limits=_VEHICLE_LIMITS,
    columns=_VEHICLE_COLUMNS,
    evidence_columns={
        "share_observed": _EVIDENCE_COLUMNS["share_observed"],
        "days_not_tracked": Text("Days without vehicle tracking", "Jours sans suivi des véhicules"),
    },
    measures=(
        Measure(
            "vehicle_days_in_service",
            "count",
            Text(
                "Service dates with a vehicle position linked to a trip.",
                "Dates de service avec une position de véhicule liée à un trajet.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_hours_in_service",
            "hours",
            Text(
                f"Trip-linked observed time plus up to {VEHICLE_TAIL_CAP_SECONDS} seconds to the "
                f"next state, or {VEHICLE_POLL_SECONDS} seconds for the final reading.",
                f"Temps observé lié à un trajet, plus au plus {VEHICLE_TAIL_CAP_SECONDS} secondes "
                f"jusqu’à l’état suivant, ou {VEHICLE_POLL_SECONDS} secondes "
                "pour le dernier relevé.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_lines_run",
            "count",
            Text(
                "Distinct lines from confirmed trips and trip-linked positions.",
                "Lignes distinctes tirées des trajets confirmés et des positions "
                "liées à un trajet.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_trips_run",
            "count",
            Text(
                "Distinct dated trips confirmed or linked to a vehicle position.",
                "Trajets datés distincts confirmés ou liés à une position de véhicule.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_reporting_gaps",
            "count",
            Text(
                f"Silences longer than {VEHICLE_REPORTING_GAP_SECONDS} seconds between consecutive "
                "sightings on the same trip. The expected poll interval is "
                f"{VEHICLE_POLL_SECONDS} seconds.",
                f"Silences de plus de {VEHICLE_REPORTING_GAP_SECONDS} secondes entre deux relevés "
                f"successifs du même trajet. L’intervalle de collecte prévu est de "
                f"{VEHICLE_POLL_SECONDS} secondes.",
            ),
            extra_tables=(FEED_POLLS,),
            exclusions=_VEHICLE_REPORTING_EXCLUSIONS,
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_silent_hours",
            "hours",
            Text(
                "Total elapsed time in counted reporting gaps.",
                "Durée totale des interruptions de signalement comptées.",
            ),
            extra_tables=(FEED_POLLS,),
            exclusions=_VEHICLE_REPORTING_EXCLUSIONS,
            ranking_kinds=(),
        ),
        Measure(
            VEHICLE_RANKING_DEFAULT,
            "per_100_vehicle_hours",
            Text(
                "Times reporting stopped per 100 observed vehicle-hours in service. "
                f"Silence must exceed {VEHICLE_REPORTING_GAP_SECONDS} seconds between two "
                "consecutive sightings on the same trip.",
                "Interruptions de signalement par 100 heures-véhicules observées en service. "
                f"Le silence doit dépasser {VEHICLE_REPORTING_GAP_SECONDS} secondes entre deux "
                "relevés successifs du même trajet.",
            ),
            counts=Text(
                f"Rankings require {MIN_VEHICLE_RANKING_HOURS} hours in service. One gap then "
                "changes the rate by at most ten per 100 hours.",
                f"Le classement exige {MIN_VEHICLE_RANKING_HOURS} heures en service. Une "
                "interruption change alors le taux d’au plus dix par 100 heures.",
            ),
            extra_tables=(FEED_POLLS,),
            exclusions=_VEHICLE_REPORTING_EXCLUSIONS,
            worst_first_descending=True,
            ranking_kinds=("vehicle",),
            ranking_minimum_sample=MIN_VEHICLE_RANKING_HOURS,
            minimum_sample=MIN_VEHICLE_REPORTING_HOURS,
        ),
        Measure(
            "vehicle_unfinished_trips",
            "count",
            _VEHICLE_COMPLETION_METHOD,
            extra_tables=(STOP_EVENTS, FEED_POLLS),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_unfinished_trips_per_100_trips",
            "per_100_trips",
            _VEHICLE_COMPLETION_METHOD,
            extra_tables=(STOP_EVENTS, FEED_POLLS),
            ranking_kinds=(),
        ),
        *_VEHICLE_PUNCTUALITY,
    ),
)

_CORRIDOR_EXCLUSIONS = {
    "route_without_live_data": Text("Runs without live data", "Parcours sans données en direct"),
    "cancelled": Text("Cancelled runs", "Parcours annulés"),
    "missing_observation": Text("Missing endpoint observation", "Observation manquante à un arrêt"),
    "incomparable_basis": Text("Incomparable observations", "Observations non comparables"),
    "invalid_scheduled_run": Text("Invalid scheduled run time", "Durée prévue invalide"),
    "negative_observed_run": Text("Negative observed run time", "Durée observée négative"),
    "excessive_observed_run": Text("Excessive observed run time", "Durée observée excessive"),
    "capture_gap": Text("Runs across capture gaps", "Parcours touchés par une lacune de collecte"),
}
_CORRIDOR_BASES = {
    "vehicle_stopped": Text("Runs from stopped vehicles", "Parcours de véhicules vus à l’arrêt"),
    "vehicle_nearby": Text("Runs from vehicle GPS", "Parcours tirés du GPS des véhicules"),
    "trip_update_reported": Text("Runs from exact reports", "Parcours tirés de rapports exacts"),
    "trip_update_passed": Text("Runs from passed-stop estimates", "Parcours estimés après passage"),
}
_CORRIDOR_COUNTS = {
    "scheduled_runs": Text("Scheduled runs", "Parcours prévus"),
    "observed_runs": Text("Observed runs", "Parcours observés"),
    "scheduled_seconds": Text("Matched scheduled seconds", "Secondes prévues appariées"),
    "observed_seconds": Text("Matched observed seconds", "Secondes observées appariées"),
    **_CORRIDOR_BASES,
}


def _corridor_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    hour = _LOCAL_HOUR.format("departure_at")
    # Resolve the line and chosen direction on the trip scan before pairing stops.
    trip_parameters: list[object] = []
    trip_filter = ""
    if question.line is not None:
        trip_filter += " AND t.route_id = ?"
        trip_parameters.append(question.line)
    if question.direction is not None:
        trip_filter += " AND t.direction_id = ?"
        trip_parameters.append(question.direction)
    clean_events = int(version) >= STOP_ELIGIBILITY_VERSION
    stop_filter = trip_filter.replace("t.", "s.") if clean_events else ""
    stop_parameters = trip_parameters if clean_events else []
    cut, parameters = _cuts(question, hour)
    _, selected = _SELECTIONS[question.measure]
    edge = (
        f"(floor(lost_seconds / {family.bin_seconds}) * {family.bin_seconds})::BIGINT"
        if any(m.percentile for m in selected)
        else "NULL::BIGINT"
    )
    counters = {
        "scheduled_runs": "count(*)",
        "observed_runs": "count(*) FILTER (exclusion IS NULL)",
        "scheduled_seconds": "coalesce(sum(scheduled_seconds) FILTER (exclusion IS NULL), 0)",
        "observed_seconds": "coalesce(sum(observed_seconds) FILTER (exclusion IS NULL), 0)",
        **{
            basis: f"count(*) FILTER (exclusion IS NULL AND basis = '{basis}')"
            for basis in _CORRIDOR_BASES
        },
        **{key: f"count(*) FILTER (exclusion = '{key}')" for key in _CORRIDOR_EXCLUSIONS},
    }
    if question.map_view:
        # The compact map returns the mean, eligibility state and sample count.
        counters = {
            key: counters[key]
            for key in (
                "scheduled_runs", "observed_runs", "scheduled_seconds", "observed_seconds",
                "route_without_live_data", "cancelled", "capture_gap",
            )
        }
    entity_columns = (
        "route_id, direction_id, from_stop, to_stop"
        if group == "segment" or question.group == "segment"
        else "entity"
    )
    routes = "list(DISTINCT route_id)" if group else "NULL"
    window = [question.city, version, question.start, question.end]
    if SEGMENT_RUNS in paths:
        runs = SEGMENT_RUNS_SQL.format(cut=cut)
        args = [paths[FEED_POLLS], *window, paths[SEGMENT_RUNS], *window, *parameters]
    else:
        runs = CORRIDOR_RUNS_SQL.format(cut=cut, trip_filter=trip_filter, stop_filter=stop_filter)
        args = [
            paths[STOP_EVENTS], *window, *stop_parameters,
            paths[TRIP_DAYS], *window, *trip_parameters,
            paths[FEED_POLLS], *window, *parameters,
        ]
    rows = conn.execute(
        f"""
        WITH {runs}
        SELECT {_entity_sql(group, question.group, hour)} AS entity,
            CASE WHEN exclusion IS NULL THEN {edge} END AS edge,
            {routes}, {", ".join(counters.values())}
        FROM runs GROUP BY {entity_columns}, edge
        """,
        args,
    ).fetchall()
    return _grouped_batches(rows, counters, "observed_runs", bool(group or question.group))


_CORRIDORS = Family(
    id=_CORRIDORS_ID,
    label=Text("Corridors", "Corridors"),
    method_version="2",
    since="2026-11-22",
    tables=(STOP_EVENTS, TRIP_DAYS, FEED_POLLS),
    minimum_sample=MIN_SEGMENT_RUNS,
    coverage=(0.25, 0.50),
    bin_seconds=SEGMENT_BIN_SECONDS,
    counts=Text(
        "Each run pairs consecutive scheduled stops of the same trip. Time lost is the "
        "observed elapsed time minus the scheduled elapsed time between the corresponding "
        "events. An arrival at the first stop or a departure at the second includes that "
        "stop’s dwell in both durations. "
        "Hour uses the first stop’s scheduled departure, falling back to arrival. Day type "
        "uses the trip’s service date.",
        "Chaque parcours relie deux arrêts prévus consécutifs du même trajet. Le temps perdu "
        "est la durée observée moins la durée prévue entre les événements correspondants. "
        "Une arrivée au premier arrêt ou un départ du second inclut le temps d’arrêt "
        "correspondant dans les deux durées. "
        "L’heure est celle du départ prévu au premier arrêt, ou de son arrivée à défaut. "
        "Le type de jour suit la date de service du trajet.",
    ),
    exclusions=Text(
        "Both stops must have the same observation basis. Evidence distinguishes stopped "
        "vehicles, nearby GPS fixes, exact agency reports and estimates backed by vehicle "
        "progression. We "
        "exclude cancelled trips, missing observations or live data, nonpositive scheduled "
        f"durations, negative observed durations and runs over {MAX_SEGMENT_RUN_MULTIPLE} "
        "times their scheduled duration. Every recorded trip or vehicle feed must cover the "
        f"observed span with poll intervals of at most {MAX_POLL_SPACING_SECONDS} seconds and "
        f"publication age of at most {MAX_POLL_AGE_SECONDS} seconds plus the declared source lag.",
        "Les deux arrêts doivent avoir la même base d’observation. Les données distinguent "
        "les véhicules vus à l’arrêt, les positions GPS à proximité, les rapports exacts et "
        "les estimations confirmées par "
        "la progression du véhicule. Sont exclus les trajets annulés, les observations ou "
        "données en direct manquantes, les durées prévues non positives, les durées observées "
        f"négatives et celles dépassant {MAX_SEGMENT_RUN_MULTIPLE} fois la durée prévue. Chaque "
        "flux de trajets ou de véhicules enregistré doit couvrir l’intervalle observé, avec "
        f"au plus {MAX_POLL_SPACING_SECONDS} secondes entre relevés et "
        f"{MAX_POLL_AGE_SECONDS} secondes depuis la publication plus le délai source déclaré.",
    ),
    limits=Text(
        f"At least {MIN_SEGMENT_RUNS} observed runs per result, so the upper tenth represents "
        "at least two runs. Line totals pool matched runs across segments. Times are "
        "calculated from the observed sample.",
        f"Au moins {MIN_SEGMENT_RUNS} parcours observés par résultat, pour que le dixième "
        "supérieur représente au moins deux parcours. Les totaux d’une ligne regroupent "
        "les parcours appariés de ses segments. Les durées portent sur l’échantillon observé.",
    ),
    measures=(
        Measure(
            CORRIDOR_RANKING_DEFAULT,
            "seconds",
            Text("Median time lost per run.", "Temps perdu médian par parcours."),
            percentile=50,
            worst_first_descending=True,
            ranking_kinds=("segment",),
        ),
        Measure(
            "p90_time_lost",
            "seconds",
            Text(
                "90th percentile of time lost per run.", "90e centile du temps perdu par parcours."
            ),
            percentile=90,
            ranking_kinds=(),
        ),
        Measure(
            "mean_time_lost",
            "seconds",
            Text("Mean time lost per run.", "Temps perdu moyen par parcours."),
            ranking_kinds=(),
        ),
        Measure(
            "total_vehicle_minutes_lost",
            "vehicle_minutes",
            Text(
                "Net vehicle-minutes lost across observed runs, including time saved.",
                "Minutes-véhicules nettes perdues, en tenant compte du temps gagné.",
            ),
            worst_first_descending=True,
            ranking_kinds=("segment", "line"),
        ),
    ),
    query=_corridor_rows,
    columns={**_CORRIDOR_COUNTS, **_CORRIDOR_EXCLUSIONS},
    evidence_columns={"share_observed": _EVIDENCE_COLUMNS["share_observed"]},
)


_FEED_HISTOGRAM_LIMITS = Text(
    "Median and 90th percentile use one-second bins through 600 seconds. A percentile "
    "whose rank reaches the overflow bin is reported as over 10 minutes.",
    "La médiane et le 90e centile utilisent des classes d’une seconde jusqu’à 600 secondes. "
    "Un centile dont le rang atteint la classe de dépassement est indiqué comme supérieur à "
    "10 minutes.",
)
_VEHICLE_SCORECARD_LIMITS = Text(
    "Time follows each vehicle’s captured state, with at most 60 seconds after the last "
    "capture of a state and up to the next capture. The final interval adds 20 seconds. "
    "The hour cut includes only time in that local hour.",
    "La durée suit l’état du véhicule à la collecte. Elle se prolonge jusqu’à la collecte "
    "suivante, au plus 60 secondes après la dernière collecte de cet état. Le dernier "
    "intervalle ajoute 20 secondes. Le filtre "
    "horaire retient uniquement la durée comprise dans cette heure locale.",
)
_SCORECARD = Family(
    id=SCORECARD,
    label=Text("Open data scorecard", "Bilan des données ouvertes"),
    method_version="2",
    since="2026-11-22",
    tables=(),
    minimum_sample=MIN_SCORECARD_SAMPLES,
    counts=Text(
        "Counts are shown with each result.", "Les effectifs accompagnent chaque résultat."
    ),
    exclusions=Text(
        "Days without the needed clean tables are omitted.",
        "Les jours sans les tables nettoyées requises sont omis.",
    ),
    limits=Text(
        "The scorecard describes the open data the engine captured.",
        "La fiche décrit les données ouvertes recueillies par le moteur.",
    ),
    measures=(
        Measure(
            "poll_success",
            "share",
            Text(
                "Share of recorded capture attempts that returned a valid feed, including "
                "empty and unchanged feeds.",
                "Part des tentatives de collecte ayant renvoyé un flux valide, y compris "
                "les flux vides ou inchangés.",
            ),
            counts=Text(
                "Attempts, counts for each result, and share of attempts marked empty.",
                "Tentatives, effectifs par résultat et part des tentatives ayant renvoyé "
                "un flux marqué vide.",
            ),
            exclusions=Text(
                "Attempts duplicated across clean-day windows count once.",
                "Les tentatives communes à deux fenêtres ne comptent qu’une fois.",
            ),
            limits=Text(
                "Feeds without recorded attempts have no measured share.",
                "La part est non mesurée pour les flux sans tentative enregistrée.",
            ),
            extra_tables=(FEED_POLLS,),
        ),
        Measure(
            "feed_update_interval",
            "seconds",
            Text(
                "Time between consecutive changed publication timestamps, by feed.",
                "Temps entre deux changements successifs de l’horodatage de publication, par flux.",
            ),
            counts=Text(
                "Successful polls with timestamps, intervals and overflow counts.",
                "Collectes réussies horodatées, intervalles et dépassements.",
            ),
            exclusions=Text(
                "Updates use timestamped valid attempts. All attempts, including errors, "
                "count when checking for gaps of more than 120 seconds. Intervals crossing "
                "such a gap and backward timestamps are excluded.",
                "Les mises à jour utilisent les tentatives valides horodatées. Toutes les "
                "tentatives, y compris les erreurs, servent à repérer les interruptions de plus "
                "de 120 secondes. Les intervalles qui traversent une telle interruption et les "
                "horodatages qui reculent sont exclus.",
            ),
            limits=Text(
                _FEED_HISTOGRAM_LIMITS.en + " Capture spacing sets the shortest update cadence "
                "we can resolve. Faster feeds appear to update at the polling interval.",
                _FEED_HISTOGRAM_LIMITS.fr
                + " L’espacement des collectes fixe la fréquence maximale "
                "que l’on peut observer. Un flux plus rapide semble se mettre à jour à chaque "
                "collecte.",
            ),
            extra_tables=(FEED_POLLS,),
        ),
        Measure(
            "feed_age_at_capture",
            "seconds",
            Text(
                "Time from publication to capture on valid polls, including empty and unchanged "
                "feeds, by feed.",
                "Temps entre la publication et la collecte lors des tentatives valides, "
                "y compris pour les flux vides ou inchangés, par flux.",
            ),
            counts=Text(
                "Successful polls with timestamps, ages and overflow counts.",
                "Collectes réussies horodatées, âges et dépassements.",
            ),
            exclusions=Text(
                "Missing timestamps and negative ages are counted apart.",
                "Les horodatages manquants et les âges négatifs sont comptés à part.",
            ),
            limits=_FEED_HISTOGRAM_LIMITS,
            extra_tables=(FEED_POLLS,),
        ),
        Measure(
            "vehicle_field_completeness",
            "share",
            Text(
                "Share of vehicle reporting time with each field present: trip, route, stop, "
                "current status, occupancy status or percentage, and position.",
                "Part de la durée de signalement des véhicules où chaque champ est présent : "
                "trajet, ligne, arrêt, statut actuel, statut ou pourcentage d’occupation "
                "et position.",
            ),
            counts=Text(
                "Time with the field and total reporting time, in microseconds.",
                "Durée avec le champ et durée totale de signalement, en microsecondes.",
            ),
            exclusions=Text(
                "A declaration can indicate that a field is not published.",
                "Une déclaration peut indiquer qu’un champ est non publié.",
            ),
            limits=_VEHICLE_SCORECARD_LIMITS,
            extra_tables=(VEHICLE_POSITIONS,),
        ),
        Measure(
            "live_trip_coverage",
            "share",
            Text(
                "Share of scheduled trips on routes seen in realtime on any measured day "
                "that had a first capture.",
                "Part des trajets prévus sur les lignes vues en temps réel au moins un jour "
                "mesuré qui ont fait l’objet d’une première collecte.",
            ),
            counts=Text(
                "All scheduled trips, eligible trips, trips seen, and the count and share "
                "of scheduled trips on routes never seen in the selection.",
                "Tous les trajets prévus, les trajets admissibles, les trajets vus et le "
                "nombre et la part des trajets sur des lignes jamais vues dans la sélection.",
            ),
            exclusions=Text(
                "The coverage rate excludes added trips, days with a capture-gap trip state, "
                "and routes never seen in the selection.",
                "Le taux exclut les trajets ajoutés, les jours où un trajet présente une "
                "interruption de collecte et les lignes jamais vues dans la sélection.",
            ),
            limits=Text(
                "Verified trip days can establish route presence even when a capture gap "
                "excludes the day from the rate. The hour is the scheduled trip start. "
                "The stop cut selects scheduled trips that serve that stop.",
                "Les jours de trajets vérifiés peuvent établir la présence d’une ligne même "
                "si une interruption de collecte exclut le jour du taux. L’heure correspond "
                "au début prévu du trajet. Le filtre d’arrêt sélectionne les trajets prévus "
                "qui desservent cet arrêt.",
            ),
            extra_tables=(TRIP_DAYS,),
        ),
        Measure(
            "vehicles_without_trip",
            "share",
            Text(
                "Share of vehicle reporting time without a trip ID.",
                "Part de la durée de signalement des véhicules sans identifiant de trajet.",
            ),
            counts=Text(
                "Reporting time, time without a trip and distinct vehicles reporting without one.",
                "Durée de signalement, durée sans trajet et véhicules distincts signalés "
                "sans trajet.",
            ),
            exclusions=Text(
                "The line, direction and stop cuts require matching information in the "
                "clean vehicle observations.",
                "Les filtres de ligne, de direction et d’arrêt exigent une correspondance "
                "dans les observations nettoyées des véhicules.",
            ),
            limits=_VEHICLE_SCORECARD_LIMITS,
            extra_tables=(VEHICLE_POSITIONS,),
        ),
        Measure(
            "prediction_error",
            "seconds",
            Text(
                "By prediction horizon, sample count, median signed error (predicted minus "
                "observed), 90th percentile absolute error and share within ±60 seconds.",
                "Par horizon de prévision, effectif, médiane de l’erreur signée (prévu moins "
                "observé), 90e centile de l’erreur absolue et part à ±60 secondes.",
            ),
            counts=Text(
                "Counts by observation basis and exact inclusive ±60-second count.",
                "Effectifs par source d’observation et nombre exact à ±60 secondes incluses.",
            ),
            exclusions=Text(
                "Error statistics use reports of vehicles stopped at a stop. Nearby GPS fixes "
                "and exact agency times are counted separately. Passed stops are excluded "
                "because the observed time is itself a prediction.",
                "Les statistiques d’erreur utilisent les relevés de véhicules immobilisés à "
                "un arrêt. Les positions GPS à proximité et les heures exactes de l’agence "
                "sont comptées à part. Les arrêts dépassés sont exclus car l’heure observée "
                "est elle-même une prévision.",
            ),
            limits=Text(
                f"Percentiles use {DELAY_BIN_SECONDS}-second bins. The ±60-second band uses an "
                f"inclusive boundary. Each horizon requires {MIN_PREDICTION_SAMPLES} "
                "observed stop events. From "
                "cleaning v10, each bucket takes the latest forecast from its lower lead "
                "bound up to the next horizon, exclusive. The 30-minute bucket ends before "
                "40 minutes. Trip-update capture must cover the lead window continuously. "
                "The hour is the observed local hour. Requires cleaning v7 or later.",
                f"Les centiles utilisent des classes de {DELAY_BIN_SECONDS} secondes. La bande "
                "de ±60 secondes inclut ses bornes. "
                f"Chaque horizon exige {MIN_PREDICTION_SAMPLES} événements observés à l’arrêt. "
                "Depuis le nettoyage v10, on retient la prévision la plus récente entre "
                "l’horizon indiqué et le suivant, exclu. L’horizon de 30 minutes exclut les "
                "avances de 40 minutes ou plus. La collecte des mises à jour des trajets "
                "doit être continue pendant cette période. L’heure est l’heure locale "
                "observée. Nécessite le nettoyage v7 "
                "ou une version ultérieure.",
            ),
            extra_tables=(PREDICTION_SAMPLES,),
        ),
    ),
    query=None,
    columns={
        "counts": Text("Counts", "Effectifs"),
        "excluded": Text("Exclusions", "Exclusions"),
        "dimension_states": Text("States by dimension", "États par dimension"),
        "capture_gap_days": Text("Capture-gap days", "Jours de collecte interrompue"),
    },
)


_ACCESSIBILITY_COUNTS = {
    "trips_accessible": Text("Accessible trips", "Trajets accessibles"),
    "trips_not_accessible": Text("Not accessible trips", "Trajets non accessibles"),
    "trips_no_information": Text("Trips without information", "Trajets sans information"),
    "trips_not_published": Text("Trips without a published column", "Trajets sans colonne publiée"),
    "stops_accessible": Text("Accessible stops", "Arrêts accessibles"),
    "stops_not_accessible": Text("Not accessible stops", "Arrêts non accessibles"),
    "stops_no_information": Text("Stops without information", "Arrêts sans information"),
    "stops_not_published": Text("Stops without a published column", "Arrêts sans colonne publiée"),
}


def _accessibility_rows(
    conn: duckdb.DuckDBPyConnection,
    _family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    _group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    counts: Counter[str] = Counter()
    window = [question.city, version, question.start, question.end]
    if TRIP_DAYS in paths:
        filters: list[str] = []
        parameters: list[object] = []
        for name, value in question.cuts().items():
            if name == "line":
                filters.append("t.route_id = ?")
                parameters.append(value)
            elif name == "direction":
                filters.append("t.direction_id = ?")
                parameters.append(value)
            elif name == "hour":
                filters.append(f"({_LOCAL_HOUR.format('t.scheduled_start_utc')}) = ?")
                parameters.append(value)
            elif name == "stop":
                filters.append(
                    "EXISTS (SELECT 1 FROM read_parquet(?, hive_partitioning = false) s"
                    " WHERE s.provider = t.provider AND s.cleaning_version = t.cleaning_version"
                    " AND s.service_date = t.service_date AND s.trip_id = t.trip_id"
                    " AND s.stop_id = ?)"
                )
                parameters.extend([paths[SCHEDULED_STOP_TIMES], value])
        trips = conn.execute(
            f"""
            SELECT count(*),
                count(*) FILTER (WHERE wheelchair_accessible = 1),
                count(*) FILTER (WHERE wheelchair_accessible = 2),
                count(*) FILTER (WHERE wheelchair_accessible = 0)
            FROM read_parquet(?, hive_partitioning = false) t
            WHERE t.provider = ? AND t.cleaning_version = ?
                AND t.service_date BETWEEN ? AND ? AND t.state <> 'added'
                AND {" AND ".join(filters) or "true"}
            """,
            [paths[TRIP_DAYS], *window, *parameters],
        ).fetchone()
        assert trips is not None
        trips_total, trips_accessible, trips_not_accessible, trips_no_information = trips
        counts["trips_total"] = int(trips_total)
        counts["trips_accessible"] = int(trips_accessible)
        counts["trips_not_accessible"] = int(trips_not_accessible)
        counts["trips_no_information"] = int(trips_no_information)
        counts["trips_not_published"] = int(
            trips_total - trips_accessible - trips_not_accessible - trips_no_information
        )
    result = Batch(counts=counts)
    if SCHEDULED_STOP_TIMES in paths:
        hour = _LOCAL_HOUR.format("coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc)")
        cut, parameters = _cuts(question, hour)
        rows = conn.execute(
            f"""
            SELECT s.stop_id, max(s.service_date),
                arg_max_null(s.wheelchair_boarding, s.service_date)
            FROM read_parquet(?, hive_partitioning = false) s
            WHERE s.provider = ? AND s.cleaning_version = ?
                AND s.service_date BETWEEN ? AND ? AND s.stop_id IS NOT NULL AND {cut}
            GROUP BY s.stop_id
            """,
            [paths[SCHEDULED_STOP_TIMES], *window, *parameters],
        ).fetchall()
        result.stop_accessibility = {stop: (day, value) for stop, day, value in rows}
    return {(): result}


_ACCESSIBILITY = Family(
    id=_ACCESSIBILITY_ID,
    label=Text("Accessibility", "Accessibilité"),
    method_version="accessibility-v2",
    since="2026-11-22",
    tables=(TRIP_DAYS, SCHEDULED_STOP_TIMES),
    query=_accessibility_rows,
    minimum_sample=1,
    minimum_cleaning_version=8,
    columns=_ACCESSIBILITY_COUNTS,
    counts=Text(
        "Each scheduled trip or distinct served stop counts once. Each stop uses its "
        "declaration on its latest service date in the cut. The accessible share is the "
        "count declared accessible (1) divided by the number with a published value. "
        "A value of 0 means no information.",
        "Chaque trajet prévu ou arrêt distinct desservi compte une fois. Pour chaque arrêt, "
        "la déclaration retenue est celle de sa dernière date de service dans la sélection. "
        "La part accessible divise le nombre déclaré accessible (1) par le nombre avec une "
        "valeur publiée. La valeur 0 signifie aucune information.",
    ),
    exclusions=Text(
        "Trips added by the feed are excluded. Trips or stops whose edition does not declare "
        "the accessibility column are not published rather than counted as zero.",
        "Les trajets ajoutés par les données en direct sont exclus. Les trajets ou arrêts dont "
        "l’édition ne déclare pas la colonne d’accessibilité sont non publiés, jamais comptés "
        "comme zéro.",
    ),
    limits=Text(
        "The value is the agency's declaration, not an observed condition. A stop inherits its "
        "parent station's declaration when it publishes none of its own.",
        "La valeur est la déclaration de l’exploitant, pas une condition observée. Un arrêt "
        "hérite de la déclaration de sa station parente lorsqu’il n’en publie pas.",
    ),
    measures=(
        Measure(
            "accessible_trips",
            "share",
            Text(
                "Share of scheduled trips the agency declares wheelchair accessible.",
                "Part des trajets prévus que l’exploitant déclare accessibles en fauteuil roulant.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "accessible_stops",
            "share",
            Text(
                "Share of distinct served stops the agency declares wheelchair accessible.",
                "Part des arrêts distincts desservis que l’exploitant déclare accessibles en "
                "fauteuil roulant.",
            ),
            ranking_kinds=(),
        ),
    ),
)

_FAMILIES = (
    _PUNCTUALITY,
    _SERVICE_DELIVERED,
    _CROWDING,
    _ALERT_COUNTS,
    _WAITING,
    _SERVICE_OFFERED,
    _VEHICLES,
    _CORRIDORS,
    _SCORECARD,
    _ACCESSIBILITY,
)
_SELECTIONS = {
    key: (family, selected)
    for family in _FAMILIES
    for key, selected in (
        (family.id, family.measures),
        *((measure.id, (measure,)) for measure in family.measures),
    )
}


def _coverage_evidence(family: Family, sample: int, total: int) -> dict[str, Any]:
    assert family.coverage is not None
    minimum, warning = family.coverage
    share = sample / total if total > 0 else None
    key = "share_eligible" if family.id == _SERVICE_DELIVERED_ID else "share_observed"
    return {
        key: share,
        **({"low_coverage": True} if share is not None and share < warning else {}),
        **(
            {"coverage_reason": "insufficient_coverage"}
            if share is not None and share < minimum
            else {}
        ),
    }


def _state(
    family: Family,
    sample: int,
    scheduled_with_live: int,
    captures_missing: int,
    without_live: int,
    missing_days: bool,
    *,
    coverage_sample: int | None = None,
) -> str:
    if missing_days or (scheduled_with_live and captures_missing == scheduled_with_live):
        return "not_measured"
    if not scheduled_with_live and without_live:
        return "no_live_data"
    covered = sample if coverage_sample is None else coverage_sample
    if family.coverage and scheduled_with_live > 0:
        if covered / scheduled_with_live < family.coverage[0]:
            return "not_measured"
    if not sample:
        return "unknown"
    if sample < family.minimum_sample:
        return "too_few_to_judge"
    return "measured"


def _delivery_answer(
    family: Family,
    selected: tuple[Measure, ...],
    counts: Counter[str],
    histogram: Counter[int],
    departures: list[Departure],
    included: list[str],
    missing_days: bool,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    scheduled_with_live = counts["scheduled"] - counts["route_without_live_data"]

    def trip_state(sample: int) -> str:
        return _state(
            family,
            sample,
            scheduled_with_live,
            counts["capture_gap"],
            counts["route_without_live_data"],
            missing_days,
            coverage_sample=counts["eligible"],
        )

    state = trip_state(counts["eligible"])
    coverage = _coverage_evidence(family, counts["eligible"], scheduled_with_live)
    by_boundary: dict[str, dict[str, Any]] = {}
    values: dict[str, float | None] = {}
    states = {}
    samples = {}
    for measure in selected:
        assert measure.ratio is not None
        numerator, denominator = measure.ratio
        top, bottom = counts[numerator], counts[denominator]
        measure_state = state
        sample = bottom
        if measure.id == "service_hours":
            sample = counts["trips_with_duration"] if bottom else 0
            measure_state = trip_state(sample)
        elif measure.id in _BOUNDARIES:
            edge = [departure for departure in departures if departure.measure == measure.id]
            top, bottom = sum(row.ran for row in edge), sum(row.eligible for row in edge)
            sample = bottom
            without_live = sum(row.route_without_live_data for row in edge)
            boundary_total = sum(row.scheduled for row in edge) - without_live
            measure_state = _state(
                family, bottom, boundary_total, sum(row.capture_gap for row in edge),
                without_live, missing_days,
            )
            by_boundary[measure.id] = _coverage_evidence(family, bottom, boundary_total)
        if coverage.get("coverage_reason"):
            measure_state = state
        states[measure.id] = measure_state
        samples[measure.id] = sample
        values[measure.id] = top / bottom if measure_state == "measured" else None
    notices = counts["cancellation_notices"]
    states["median_cancellation_lead_seconds"] = (
        "not_measured" if missing_days
        else "too_few_to_judge" if notices < MIN_CANCELLATION_NOTICES
        else "measured"
    )
    delivery_counts: dict[str, int | float | None] = {
        key: counts[key] if included else None
        for key in _DELIVERY_COLUMNS
        if key not in (*_DELIVERY_EXCLUDED, "scheduled_hours", "ran_hours")
    }
    for label, key in (("scheduled_hours", "scheduled_seconds"), ("ran_hours", "ran_seconds")):
        delivery_counts[label] = counts[key] / 3600 if counts["trips_with_duration"] else None
    if not any(SCHEDULED_STOP_TIMES in measure.extra_tables for measure in selected):
        delivery_counts["trips_with_duration"] = None
    evidence = {
        "counts": delivery_counts,
        # Keep unconfirmed in the state reconciliation and show why it is outside the rate.
        "excluded": {
            key: counts[key] if included else None for key in (*_DELIVERY_EXCLUDED, "unconfirmed")
        },
        **(
            by_boundary[selected[0].id]
            if len(selected) == 1 and selected[0].id in by_boundary
            and not coverage.get("coverage_reason") else coverage
        ),
        **({"boundary_coverage": by_boundary} if by_boundary else {}),
        "share_unconfirmed": (
            counts["unconfirmed"] / scheduled_with_live if scheduled_with_live else None
        ),
        "median_cancellation_lead_seconds": (
            _percentile(sorted(histogram.items()), notices, 50, continuous=True)
            if states["median_cancellation_lead_seconds"] == "measured" else None
        ),
        "cancellation_lead_state": states["median_cancellation_lead_seconds"],
        "boundary_departures": [row._asdict() for row in departures] if departures else None,
        "measure_states": states,
    }
    return states[selected[0].id] if len(selected) == 1 else state, values, evidence, samples


@dataclass
class ReadWindow:
    paths: dict[str, list[str]]
    measured: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    unmeasured_reasons: dict[str, str] = field(default_factory=dict)
    included: list[str] = field(default_factory=list)
    missing_in_cut: bool = False
    not_tracked: list[str] = field(default_factory=list)
    not_tracked_reasons: dict[str, str] = field(default_factory=dict)
    batch_days: int | None = None
    versions: dict[str, int] = field(default_factory=dict)
    source_dates: dict[str, str] = field(default_factory=dict)

    @property
    def no_days_measured(self) -> bool:
        return not self.measured or (self.missing_in_cut and not self.included)

    @property
    def coverage_note(self) -> dict[str, str] | None:
        if (
            self.not_tracked
            and VEHICLE_POSITIONS in self.paths
            and (len(self.not_tracked) < len(self.included))
        ):
            return Text(
                "Days without vehicle tracking are excluded.",
                "Les jours sans suivi des véhicules sont exclus.",
            )._asdict()
        if ALERTS in self.paths and self.measured and (self.missing or self.not_tracked):
            return Text(
                "Some dates lack alert history. Published periods can still cover those dates.",
                "L’historique des alertes manque à certaines dates. Les périodes publiées "
                "peuvent quand même couvrir ces dates.",
            )._asdict()
        return _PARTIAL._asdict() if self.measured and self.missing else None

    def batches(self, *, days: int | None = None) -> Iterator[dict[str, list[str]]]:
        size = self.batch_days or days or DAYS_PER_QUERY_BATCH
        days_read = len(next(iter(self.paths.values())))
        for offset in range(0, days_read, size):
            yield {table: files[offset : offset + size] for table, files in self.paths.items()}

    def evidence(
        self, store: Store, question: Question, family: Family, started: float
    ) -> dict[str, Any]:
        untracked = set(self.not_tracked) if family.id == _VEHICLES_ID else set()
        included = self.measured if family.id == _ALERT_COUNTS_ID else [
            day for day in self.included if day not in untracked
        ]
        latest = max((self.source_dates.get(day, "") for day in included), default="")
        return {
            "city": question.city,
            "start_date": question.start.isoformat(),
            "end_date": question.end.isoformat(),
            "cuts": question.cuts(),
            "days_measured": [day for day in self.measured if day not in untracked],
            "days_not_measured": self.missing,
            "days_not_measured_reasons": self.unmeasured_reasons,
            "days_pending": self.pending,
            "days_included": included,
            **({"source_date": latest} if latest else {}),
            "cleaning_versions": [store.cleaning_version] if self.included else [],
            "method_version": family.method_version,
            "query_ms": (perf_counter() - started) * 1000,
            **(
                {"days_not_tracked": self.not_tracked, "days_alerts_tracked": self.measured}
                if family.id == _ALERT_COUNTS_ID
                else {}
            ),
            **({"days_not_tracked": self.not_tracked} if family.id == _VEHICLES_ID else {}),
            **(
                {"days_not_tracked_reasons": self.not_tracked_reasons}
                if question.measure in _VEHICLE_COMPLETION_IDS
                else {}
            ),
        }

    def record_vehicle_tracking(
        self, family: Family, offset: int, result: dict[EntityKey, Batch]
    ) -> None:
        if family.id == _VEHICLES_ID and (None,) in result:
            day = self.included[offset]
            if day not in self.not_tracked_reasons:
                self.not_tracked.append(day)


def read_window(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    group: EntityKind | None = None,
    *,
    extra_tables: tuple[str, ...] = (),
    receipts: dict[str, bytes] | None = None,
) -> ReadWindow:
    tables = tuple(
        dict.fromkeys(
            (*family.tables, *(table for m in selected for table in m.extra_tables), *extra_tables)
        )
    )
    preferred_tables: tuple[str, ...] = ()
    if family.id == _CORRIDORS_ID:
        preferred_tables = (SEGMENT_RUNS, FEED_POLLS)
        if group is not None:
            preferred_tables += (TRIP_DAYS,)
    if group and family.id == _ALERT_COUNTS_ID:
        tables += (TRIP_DAYS, STOP_EVENTS) if group == "stop" else (TRIP_DAYS,)
    # Bound window sorts over dense position records and stop sequences.
    batch_days = (
        1 if VEHICLE_POSITIONS in tables or family.id in {_CORRIDORS_ID, _WAITING_ID} else None
    )
    window = ReadWindow({table: [] for table in tables}, batch_days=batch_days)
    uses_poll_coverage = FEED_POLLS in tables and family.query is not None
    if uses_poll_coverage and receipts is None:
        receipts = {}
    if (
        family.minimum_cleaning_version is not None
        and store.cleaning_version < family.minimum_cleaning_version
    ):
        # The family's columns do not exist before its minimum cleaning version.
        for ordinal in range(question.start.toordinal(), question.end.toordinal() + 1):
            window.missing.append(date.fromordinal(ordinal).isoformat())
        window.missing_in_cut = True
        return window
    ordinals = range(question.start.toordinal(), question.end.toordinal() + 1)
    checked_days: dict[date, CheckedDay] = {}
    if family.id == _WAITING_ID and store.s3_endpoint and len(ordinals) > 1:
        assert receipts is not None
        # Overlap independent receipt requests. Separate cursors share this
        # query's HTTP metadata, including file sizes needed by the Parquet scan.
        conn.execute("SET enable_http_metadata_cache = true")

        def check(day: date) -> tuple[date, CheckedDay, dict[str, bytes]]:
            receipt: dict[str, bytes] = {}
            with conn.cursor() as cursor:
                checked = store.query_day(cursor, question.city, day, tables, receipts=receipt)
            return day, checked, receipt

        with ThreadPoolExecutor(max_workers=4) as executor:
            for days in batched(map(date.fromordinal, ordinals), 16):
                for day, checked, receipt in executor.map(check, days):
                    checked_days[day] = checked
                    receipts.update(receipt)

    for day in map(date.fromordinal, ordinals):
        day_key = day.isoformat()
        in_cut = question.day_type is None or question.day_type == _DAY_TYPES[day.weekday()]
        if in_cut and question.measure in _VEHICLE_COMPLETION_IDS:
            window.not_tracked.append(day_key)
            window.not_tracked_reasons[day_key] = _TRIP_END_NOT_OBSERVABLE
        configured = store.cleaning_version
        candidates = (
            range(configured, 2, -1)
            if family.id == SCORECARD and PREDICTION_SAMPLES not in tables and configured >= 3
            else (configured,)
        )
        files = None
        settled = True
        for version in candidates:
            source = store if version == configured else replace(store, cleaning_version=version)
            pending_check = checked_days.get(day)
            checked = (
                source.query_day(
                    conn,
                    question.city,
                    day,
                    tables,
                    preferred_tables=preferred_tables,
                    allow_untracked_alerts=family.id == _ALERT_COUNTS_ID,
                    receipts=receipts,
                )
                if pending_check is None
                else pending_check
            )
            # A preferred scorecard version can still arrive after a fallback answer.
            settled = settled and checked.settled
            if checked.unmeasured_reason is not None:
                window.unmeasured_reasons[day_key] = checked.unmeasured_reason
                break
            files = checked.files
            if files is not None:
                window.versions[day_key] = version
                if checked.source_date is not None:
                    window.source_dates[day_key] = checked.source_date
                break
        if not settled:
            window.pending.append(day_key)
        if files is None:
            window.missing.append(day_key)
            window.missing_in_cut |= in_cut
        else:
            dated = (
                window.not_tracked
                if family.id == _ALERT_COUNTS_ID and not files[0]
                else (window.measured)
            )
            dated.append(day_key)
            if in_cut:
                window.included.append(day_key)
            # A weekday schedule can establish that a line exists for a weekend zero.
            if in_cut or family.id == _SERVICE_OFFERED_ID:
                if SEGMENT_RUNS in checked.tables and SEGMENT_RUNS not in window.paths:
                    # Corridor windows use one cleaning version across all dates.
                    window.paths = {table: [] for table in checked.tables}
                    window.batch_days = None
                for table, path in zip(checked.tables, files, strict=True):
                    window.paths[table].append(path)
    if uses_poll_coverage and window.included:
        assert receipts is not None
        set_poll_age_limits(conn, question.city, receipts, window.included)
    if family.id == _WAITING_ID and store.s3_endpoint and not (question.line or question.stop):
        # Broad waiting queries read most of these small daily files. Fetch them
        # in one request each and leave larger objects on range reads.
        conn.execute("SET force_download_threshold = 8388608")
    return window


def _crowding_answer(
    selected: tuple[Measure, ...], counts: Counter[str], window: ReadWindow
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    weight = counts["occupancy_us"]
    state = "measured"
    if window.no_days_measured:
        state = "not_measured"
    elif not counts["published_intervals"]:
        state = "not_tracked"
    elif not weight and not counts["occupancy_readings"]:
        state = "unknown"
    elif weight < MIN_CROWDING_VEHICLE_HOURS * _US_PER_HOUR:
        state = "too_few_to_judge"
    levels = {name: counts[name] for name, _ in _OCCUPANCY_LEVELS.values()}
    percentages = {
        int(key.removeprefix("percentage:")): value
        for key, value in counts.items()
        if key.startswith("percentage:") and value
    }
    levels["crowding_full"] += sum(us for pct, us in percentages.items() if pct >= 100)
    values = {m.id: levels[m.id] / weight if state == "measured" else None for m in selected}
    seconds = {name: us / 1_000_000 for name, us in levels.items()}
    readings, occupied = counts["readings"], counts["occupancy_readings"]
    evidence = {
        "counts": {
            "intervals": counts["intervals"] if window.included else None,
            "readings": readings if window.included else None,
            "occupancy_readings": occupied if window.included else None,
            "occupancy_vehicle_seconds": weight / 1_000_000 if weight else None,
            "level_vehicle_seconds": seconds if weight else None,
        },
        "excluded": {
            "readings_without_occupancy": readings - occupied if window.included else None,
            "capped_intervals": counts["capped_intervals"] if window.included else None,
        },
        "share_occupancy_readings": occupied / readings if readings else None,
        "percentage_levels": [
            {
                "percentage": pct,
                "vehicle_seconds": us / 1_000_000,
                "share": us / weight if state == "measured" else None,
            }
            for pct, us in sorted(percentages.items())
        ],
    }
    return state, values, evidence, dict.fromkeys(values, weight)


def _alert_duration(spans: set[AlertSpan]) -> int:
    end = 0
    prior: tuple[str, str] | None = None
    total = 0
    for span in sorted(spans, key=lambda item: (item.source, item.alert_id, item.start)):
        key = (span.source, span.alert_id)
        if key != prior or span.start >= end:
            total += span.end - span.start
            end = span.end
        elif span.end > end:
            total += span.end - end
            end = span.end
        prior = key
    return total


def _alert_answer(
    selected: tuple[Measure, ...], totals: Batch, window: ReadWindow
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    spans = totals.alert_spans
    state = "measured"
    if (window.not_tracked and not window.measured) or (
        totals.counts["schedule_not_tracked"]
        and not totals.counts["schedule_tracked"]
        and not spans
    ):
        state = "not_tracked"
    elif not window.measured:
        state = "not_measured"
    alert_count = len({(span.source, span.alert_id) for span in spans})
    version_count = len({(span.source, span.alert_id, span.version) for span in spans})
    duration = _alert_duration(spans)
    counts = {
        "alerts": alert_count,
        "alert_versions": version_count,
        "active_spans": len(spans),
        "alert_seconds": duration / 1_000_000,
    }
    metrics = {**counts, "alert_hours": duration / _US_PER_HOUR}
    measured = state == "measured"
    values = {m.id: metrics[m.id] if measured else None for m in selected}
    return (
        state,
        values,
        {
            "counts": {key: value if measured else None for key, value in counts.items()},
            "excluded": {},
        },
        dict.fromkeys(values, alert_count),
    )


def evaluate(
    family: Family,
    selected: tuple[Measure, ...],
    totals: Batch,
    window: ReadWindow,
    *,
    hour: int | None = None,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    if family.id == _CORRIDORS_ID:
        return _corridor_answer(family, selected, totals, window)
    if family.id == _WAITING_ID:
        return _waiting_answer(family, selected, totals, window)
    if family.id == _SERVICE_OFFERED_ID:
        return _offered_answer(
            selected, totals.offered, window.included, window.no_days_measured, hour
        )
    if family.id == _CROWDING_ID:
        return _crowding_answer(selected, totals.counts, window)
    if family.id == _ALERT_COUNTS_ID:
        return _alert_answer(selected, totals, window)
    if family.id == _VEHICLES_ID:
        return _vehicle_answer(selected, totals, window)
    if family.id == _ACCESSIBILITY_ID:
        return _accessibility_answer(selected, totals, window)
    if family.id == _SERVICE_DELIVERED_ID:
        return _delivery_answer(
            family,
            selected,
            totals.counts,
            totals.histogram,
            totals.departures,
            window.included,
            window.no_days_measured,
        )
    return _punctuality_answer(
        family, selected, totals.counts, totals.histogram, window.included, window.no_days_measured
    )


def _corridor_answer(
    family: Family,
    selected: tuple[Measure, ...],
    totals: Batch,
    window: ReadWindow,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    counts = totals.counts
    sample = counts["observed_runs"]
    without_live = counts["route_without_live_data"]
    scheduled = counts["scheduled_runs"] - without_live - counts["cancelled"]
    state = _state(
        family,
        sample,
        scheduled,
        counts["capture_gap"],
        without_live,
        window.no_days_measured,
    )
    values: dict[str, float | None] = dict.fromkeys(m.id for m in selected)
    if state == "measured":
        lost = counts["observed_seconds"] - counts["scheduled_seconds"]
        histogram = sorted(totals.histogram.items())
        for measure in selected:
            if measure.percentile:
                values[measure.id] = _percentile(
                    histogram, sample, measure.percentile, width=family.bin_seconds
                )
            else:
                values[measure.id] = lost / (sample if measure.id == "mean_time_lost" else 60)
    evidence = {
        "counts": {key: counts[key] if window.included else None for key in _CORRIDOR_COUNTS},
        "excluded": {key: counts[key] if window.included else None for key in _CORRIDOR_EXCLUSIONS},
        **_coverage_evidence(family, sample, scheduled),
    }
    return state, values, evidence, dict.fromkeys(values, sample)


def _waiting_answer(
    family: Family,
    selected: tuple[Measure, ...],
    totals: Batch,
    window: ReadWindow,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    counts = totals.counts
    sample = counts["observed_headways"]
    frequent = counts["frequent_headways"]
    covered_sample = min(sample, frequent)
    state = _state(
        family,
        sample,
        frequent,
        0,
        0,
        window.no_days_measured,
        coverage_sample=covered_sample,
    )
    if not window.no_days_measured and not frequent and not sample:
        if counts["live_direction_stops"]:
            state = "no_frequent_periods"
        elif counts["scheduled_stops"] and not counts["live_candidates"]:
            state = "no_live_data"
    values: dict[str, float | None] = dict.fromkeys(m.id for m in selected)
    states = dict.fromkeys(values, state)
    if state == "measured":
        for measure in selected:
            if measure.ratio:
                numerator, denominator = measure.ratio
                if counts[denominator]:
                    values[measure.id] = counts[numerator] / counts[denominator]
                else:
                    states[measure.id] = "unknown"
            elif counts["wait_weight"]:
                values[measure.id] = totals.waiting_weighted_excess / counts["wait_weight"]
            else:
                states[measure.id] = "unknown"
    evidence = {
        "counts": {
            **{
                key: counts[key] if window.included else None
                for key in _WAITING_COLUMNS
                if key not in _WAITING_EXCLUDED and key != "weighted_excess"
            },
            "weighted_excess": totals.waiting_weighted_excess if counts["wait_weight"] else None,
        },
        "excluded": {key: counts[key] if window.included else None for key in _WAITING_EXCLUDED},
        **_coverage_evidence(family, covered_sample, frequent),
        "measure_states": states,
    }
    return (
        states[selected[0].id] if len(selected) == 1 else state,
        values,
        evidence,
        dict.fromkeys(values, sample),
    )


def _offered_units(offered: Iterable[OfferedCounts]) -> set[tuple[str, str, int | None]]:
    return {
        (day, row.route_id, row.direction_id) for row in offered for day in row.service_dates
    }


def _offered_answer(
    selected: tuple[Measure, ...],
    offered: list[OfferedCounts],
    included: list[str],
    missing_days: bool,
    hour: int | None,
    *,
    schedule_units: set[tuple[str, str, int | None]] | None = None,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    if schedule_units is None:
        schedule_units = _offered_units(offered)
    units = len({(route, direction) for _, route, direction in schedule_units})
    active = set(included)
    units_by_type = Counter(
        _DAY_TYPES[date.fromisoformat(day).weekday()]
        for day, _, _ in schedule_units if day in active
    )
    trips: Counter[tuple[str, str]] = Counter()
    at_or_above: Counter[tuple[str, str]] = Counter()
    for row in offered:
        key = (row.day_type, row.period)
        trips[key] += row.trips
        at_or_above[key] += row.at_or_above_minimum
    days_by_type = Counter(_DAY_TYPES[date.fromisoformat(day).weekday()] for day in included)
    periods: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    for p in PERIODS:
        if hour is not None and not p.start_hour <= hour < p.end_hour:
            continue
        hours = 1 if hour is not None else p.end_hour - p.start_hour
        for day_type, days in days_by_type.items():
            key = (day_type, p.id)
            assessed = (
                units_by_type[day_type] if p.id == "evening" or day_type != "weekday" else 0
            )
            below = assessed - at_or_above[key] if assessed else 0
            period_counts = {
                "scheduled_trips": trips[key],
                "scheduled_clock_hours": days * hours,
                "eligible_periods": assessed,
                "below_minimum_service": below,
            }
            counts.update(period_counts)
            periods.append(
                {
                    "period": p.id,
                    "period_text": {"en": p.en, "fr": p.fr},
                    "start_hour": p.start_hour if hour is None else hour,
                    "end_hour": p.end_hour if hour is None else hour + 1,
                    "day_type": day_type,
                    "days": days,
                    **period_counts,
                    "scheduled_frequency": trips[key] / (days * hours),
                }
            )
    counts["service_units"] = units
    has_schedule = bool(units and included)
    state = "not_measured" if missing_days else "measured" if has_schedule else "unknown"
    states = dict.fromkeys((m.id for m in selected), state)
    values: dict[str, float | None] = dict.fromkeys(states)
    if state == "measured":
        for measure in selected:
            if measure.id == "scheduled_frequency":
                values[measure.id] = counts["scheduled_trips"] / counts["scheduled_clock_hours"]
            elif measure.id == "below_minimum_service" and not counts["eligible_periods"]:
                states[measure.id] = "no_evening_or_weekend_periods" if units_by_type else "unknown"
            else:
                values[measure.id] = counts[measure.id]
    evidence = {
        "counts": {key: counts[key] if has_schedule else None for key in _OFFERED_COLUMNS},
        "excluded": {},
        "periods": periods if has_schedule else [],
        "measure_states": states,
    }
    return (
        states[selected[0].id] if len(selected) == 1 else state,
        values,
        evidence,
        dict.fromkeys(values, len(included)),
    )


def _scorecard_answer(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    started: float,
) -> dict[str, Any]:
    source_groups = (
        FEED_MEASURES,
        ("vehicle_field_completeness", "vehicles_without_trip"),
        ("live_trip_coverage",),
        ("prediction_error",),
    )
    results: dict[str, Result] = {}
    measure_days: dict[str, dict[str, Any]] = {}
    days_pending: set[str] = set()
    unmeasured_reasons: dict[str, str] = {}
    for group in source_groups:
        items = tuple(measure for measure in selected if measure.id in group)
        if not items:
            continue
        receipts: dict[str, bytes] = {}
        extra_tables: tuple[str, ...] = ()
        if group == source_groups[1] and question.direction is not None:
            extra_tables = (TRIP_DAYS,)
        if group == source_groups[2] and question.stop is not None:
            extra_tables = (STOP_EVENTS,)
        window = read_window(
            conn, store, question, family, items, extra_tables=extra_tables, receipts=receipts
        )
        days_pending.update(window.pending)
        unmeasured_reasons.update(window.unmeasured_reasons)
        included = [(day, json.loads(receipts[day])) for day in window.included]
        versions = sorted({str(window.versions[day]) for day in window.included})
        declarations = {
            day: declaration if isinstance(declaration, dict) else {}
            for day, receipt in included
            for declaration in (receipt.get("scorecard_declaration"),)
        }
        if group == FEED_MEASURES:
            feeds = {feed for entry in declarations.values() for feed in entry.get("feeds", [])}
            if any(
                window.versions[day] >= 5 and "alerts" not in receipt for day, receipt in included
            ):
                feeds.add("alerts")
            results.update(
                feed_results(
                    conn,
                    window.paths[FEED_POLLS],
                    question.city,
                    versions,
                    {item.id for item in items},
                    feeds,
                )
            )
        elif group == source_groups[1]:
            filters, arguments = _cuts(question, None)
            totals: Counter[str] = Counter()
            denominator: Counter[str] = Counter()
            unpublished: dict[str, list[str]] = {name: [] for name in VEHICLE_FIELDS}
            interval_denominator: Counter[str] = Counter()
            without_trip: set[str] = set()
            for day, paths in zip(window.included, window.batches(), strict=True):
                counts, ids = vehicle_counts(
                    conn,
                    paths[VEHICLE_POSITIONS],
                    paths.get(TRIP_DAYS),
                    question.city,
                    [str(window.versions[day])],
                    filters,
                    arguments,
                    question.hour,
                )
                without_trip.update(ids)
                totals.update(reporting_us=counts["reporting_us"], intervals=counts["intervals"])
                totals["without_trip_us"] += counts["reporting_us"] - counts["trip"]
                fields = declarations[day].get("unpublished_vehicle_fields", [])
                for name in VEHICLE_FIELDS:
                    if name in fields:
                        unpublished[name].append(day)
                    else:
                        totals[name] += counts[name]
                        denominator[name] += counts["reporting_us"]
                        interval_denominator[name] += counts["intervals"]
            declared = [entry["feeds"] for entry in declarations.values() if "feeds" in entry]
            empty = (
                "not_measured"
                if not window.included
                else "not_tracked"
                if len(declared) == len(window.included)
                and all("vehicle_positions" not in feeds for feeds in declared)
                else "unknown"
            )
            values = {}
            states = {}
            for name in VEHICLE_FIELDS:
                sample = interval_denominator[name]
                enough = sample >= family.minimum_sample and denominator[name]
                values[name] = totals[name] / denominator[name] if enough else None
                states[name] = (
                    "measured"
                    if enough
                    else "too_few_to_judge"
                    if sample and denominator[name]
                    else "not_published"
                    if unpublished[name] and len(unpublished[name]) == len(window.included)
                    else empty
                )
            results[group[0]] = Result(
                values,
                "measured"
                if "measured" in states.values()
                else "too_few_to_judge"
                if "too_few_to_judge" in states.values()
                else "not_published"
                if all(state == "not_published" for state in states.values())
                else empty,
                {
                    "intervals": totals["intervals"],
                    **{
                        name: {
                            "present_us": totals[name], "reporting_us": denominator[name],
                            "intervals": interval_denominator[name],
                        }
                        for name in VEHICLE_FIELDS
                    },
                },
                {"not_published_days": unpublished},
                states,
            )
            reporting = totals["reporting_us"]
            enough = totals["intervals"] >= family.minimum_sample and reporting
            results[group[1]] = Result(
                totals["without_trip_us"] / reporting if enough else None,
                "measured" if enough else "too_few_to_judge" if reporting else empty,
                {
                    "intervals": totals["intervals"],
                    "reporting_us": reporting,
                    "without_trip_us": totals["without_trip_us"],
                    "distinct_vehicles_without_trip": len(without_trip)
                    if totals["intervals"]
                    else None,
                },
            )
        elif group == source_groups[2]:
            filters, arguments = _cuts(
                replace(question, stop=None), _LOCAL_HOUR.format("scheduled_start_utc")
            )
            results[group[0]] = coverage_counts(
                conn,
                list(window.batches()),
                question.city,
                versions,
                filters,
                arguments,
                question.stop,
            )
        else:
            filters, arguments = _cuts(
                question,
                _LOCAL_HOUR.format("published_at_utc + actual_lead_seconds * INTERVAL '1 second'"),
            )
            results[group[0]] = prediction_result(
                conn,
                [batch[PREDICTION_SAMPLES] for batch in window.batches()],
                question.city,
                versions,
                filters,
                arguments,
            )
        for item in items:
            gap_days = set(results[item.id].gap_days)
            dates = window.evidence(store, question, family, started)
            for key in ("days_measured", "days_included"):
                dates[key] = [day for day in dates[key] if day not in gap_days]
            dates["days_not_measured"] = sorted(set(dates["days_not_measured"]) | gap_days)
            measure_days[item.id] = {
                key: dates[key] for key in ("days_measured", "days_included", "days_not_measured")
            }
            measure_days[item.id]["cleaning_versions"] = sorted(
                {window.versions[day] for day in window.included}
            )

    asked = {item.id: results[item.id] for item in selected}
    states_by_measure = {key: result.state for key, result in asked.items()}
    state = next(
        (
            value
            for value in (
                "measured",
                "too_few_to_judge",
                "unknown",
                "no_live_data",
                "not_published",
                "not_tracked",
                "not_measured",
            )
            if value in states_by_measure.values()
        ),
        "not_measured",
    )
    dates = {
        key: sorted({day for days in measure_days.values() for day in days[key]})
        for key in ("days_measured", "days_included", "days_not_measured", "cleaning_versions")
    }
    partial = dates["days_included"] and dates["days_not_measured"]
    dates["days_not_measured"] = sorted(
        set(dates["days_not_measured"]) - set(dates["days_measured"])
    )
    return {
        "measure": question.measure,
        "value": {key: result.value for key, result in asked.items()},
        "state": state,
        "state_text": _STATES[state]._asdict(),
        "coverage_note": _PARTIAL._asdict() if partial else None,
        "evidence": {
            "city": question.city,
            "start_date": str(question.start),
            "end_date": str(question.end),
            "cuts": question.cuts(),
            **dates,
            "days_pending": sorted(days_pending),
            "days_not_measured_reasons": {
                day: unmeasured_reasons[day]
                for day in dates["days_not_measured"]
                if day in unmeasured_reasons
            },
            "method_version": family.method_version,
            "query_ms": (perf_counter() - started) * 1000,
            "measure_states": states_by_measure,
            "measure_days": measure_days,
            "counts": {key: result.counts for key, result in asked.items()},
            "excluded": {key: result.excluded for key, result in asked.items()},
            "dimension_states": {key: result.states for key, result in asked.items()},
            "capture_gap_days": {key: result.gap_days for key, result in asked.items()},
        },
        "info": [_info(family, item) for item in selected],
    }


def _accessibility_answer(
    selected: tuple[Measure, ...], totals: Batch, window: ReadWindow
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    stops = Counter(value for _, value in totals.stop_accessibility.values())
    counts = totals.counts.copy()
    counts.update(
        stops_total=stops.total(), stops_accessible=stops[1], stops_not_accessible=stops[2],
        stops_no_information=stops[0], stops_not_published=stops[None],
    )
    values: dict[str, float | None] = {}
    states: dict[str, str] = {}
    samples: dict[str, int] = {}
    for measure in selected:
        prefix = "trips" if measure.id == "accessible_trips" else "stops"
        total = counts[f"{prefix}_total"]
        declared = total - counts[f"{prefix}_not_published"]
        if window.no_days_measured:
            measure_state = "not_measured"
        elif total == 0:
            measure_state = "unknown"
        elif declared == 0:
            measure_state = "not_published"
        else:
            measure_state = "measured"
        states[measure.id] = measure_state
        samples[measure.id] = declared
        values[measure.id] = (
            counts[f"{prefix}_accessible"] / declared if measure_state == "measured" else None
        )
    if len(selected) == 1:
        state = states[selected[0].id]
    elif "measured" in states.values():
        state = "measured"
    elif all(value == "not_published" for value in states.values()):
        state = "not_published"
    elif all(value == "not_measured" for value in states.values()):
        state = "not_measured"
    else:
        state = "unknown"
    evidence: dict[str, Any] = {
        "counts": {key: counts[key] if window.included else None for key in _ACCESSIBILITY_COUNTS},
        "excluded": {},
        "measure_states": states,
    }
    return state, values, evidence, samples


def ask(store: Store, question: Question) -> dict[str, Any]:
    """Read validated days and compute the selected measure or family with its evidence."""
    started = perf_counter()
    family, selected = _SELECTIONS[question.measure]
    if question.group:
        return _series_answer(store, question, family, selected, question.group, started)
    totals = Batch()
    with service_query(store, question.city) as conn:
        if family.query is None:
            return _scorecard_answer(conn, store, question, family, selected, started)
        window = read_window(conn, store, question, family, selected)
        for offset, batch in enumerate(window.batches()):
            result = family.query(conn, family, batch, question, str(store.cleaning_version), None)
            window.record_vehicle_tracking(family, offset, result)
            if () in result:
                totals.update(result[()])
    state, values, family_evidence, _ = evaluate(
        family, selected, totals, window, hour=question.hour
    )
    if family.id == _SERVICE_DELIVERED_ID and _single_day_departure(question):
        family_evidence["trip_ids"] = sorted(totals.trip_ids)
    if question.alert_details:
        messages = None
        if state == "measured":
            periods: dict[tuple[str, str, str], list[dict[str, str]]] = {}
            epoch = datetime(1970, 1, 1, tzinfo=UTC)
            for span in sorted(totals.alert_spans, key=lambda span: (span.start, span.end)):
                periods.setdefault((span.source, span.alert_id, span.version), []).append({
                    "start": (epoch + timedelta(microseconds=span.start)).isoformat(),
                    "end": (epoch + timedelta(microseconds=span.end)).isoformat(),
                })
            messages = [
                {**totals.alert_messages[key], "periods": periods[key]}
                for key in sorted(totals.alert_messages)
            ]
        family_evidence["alert_messages"] = messages
    return {
        "measure": question.measure,
        "value": values,
        "state": state,
        "state_text": _STATES[state]._asdict(),
        "coverage_note": window.coverage_note,
        "evidence": {**window.evidence(store, question, family, started), **family_evidence},
        "info": [
            _info(family, measure, _ALERT_MESSAGE_COLUMN if question.alert_details else None)
            for measure in selected
        ],
    }


def _date_key(group: SeriesGroup, day: str, hour_key: EntityKey = ()) -> EntityKey:
    if group == "day":
        return (day,)
    if group == "day_type":
        return (_DAY_TYPES[date.fromisoformat(day).weekday()],)
    if group == "weekday_hour":
        return (date.fromisoformat(day).isoweekday(), *hour_key)
    return hour_key


def _departure_stop_order(question: Question) -> bool:
    return (
        question.group == "stop"
        and question.departure is not None
        and question.start == question.end
    )


def _series_keys(
    question: Question,
    group: SeriesGroup,
    observed: set[EntityKey],
    stop_positions: dict[EntityKey, int],
) -> list[EntityKey]:
    if group == "day":
        return [
            (date.fromordinal(day).isoformat(),)
            for day in range(question.start.toordinal(), question.end.toordinal() + 1)
        ]
    if group == "day_type":
        return [(kind,) for kind in ("weekday", "saturday", "sunday")]
    if group == "hour":
        return [(hour,) for hour in range(24)]
    if group == "weekday_hour":
        return [(weekday, hour) for weekday in range(1, 8) for hour in range(24)]
    if group == "stop":
        if _departure_stop_order(question):
            return sorted(observed, key=lambda key: (key[1], key[2]))
        return sorted(
            observed,
            key=lambda key: (key[0] is None, key[0], stop_positions[key], key[1]),
        )
    if group == "departure":
        return sorted(
            (key for key in observed if key[1] is not None),
            key=lambda key: (key[0] is None, key),
        )
    if group in {"line", "stop_id", "vehicle"}:
        return sorted(key for key in observed if key[0] is not None)
    if group == "segment":
        return sorted(observed, key=lambda key: (key[0], key[1] is None, *key[1:]))
    if group in ("effect", "cause"):
        return sorted(observed, key=lambda key: (key[0] is None, key[0]))
    return [(0,), (1,), *([(None,)] if (None,) in observed else [])]


def _series_query_batches(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    family: Family,
    question: Question,
    window: ReadWindow,
) -> Iterator[dict[EntityKey, Batch]]:
    assert family.query is not None
    version = str(store.cleaning_version)
    if (
        family is _PUNCTUALITY
        and store.cleaning_version >= STOP_ELIGIBILITY_VERSION
        and store.memory_mib >= 2048
        and question.group in HOUR_GROUPS
        and len(window.included) > DAYS_PER_QUERY_BATCH
    ):
        # Merge each hour's bins in DuckDB before transferring them to Python.
        try:
            result = family.query(conn, family, window.paths, question, version, None)
        except duckdb.OutOfMemoryException:
            pass
        else:
            yield result
            return
    for batch in window.batches():
        yield family.query(conn, family, batch, question, version, None)


# No data (0) covers both insufficient coverage and an unknown observation.
_MAP_STATES = {"too_few_to_judge": 1, "no_live_data": 2, "measured": 3}


def _map_series(
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    group: SeriesGroup,
    started: float,
    window: ReadWindow,
    totals: dict[EntityKey, Batch],
) -> dict[str, Any]:
    """Encode parallel arrays for the map, using the same eligibility as the Record."""
    stops = group == "stop_id"
    columns = ("stop",) if stops else ("direction", "from_stop", "to_stop")
    keys: dict[str, list[str | int | None]] = {column: [] for column in columns}
    samples: list[int] = []
    states: list[int] = []
    values: list[float | int | None] = []
    for key in _series_keys(question, group, set(totals), {}):
        part = totals[key]
        if stops:
            state, metrics = _punctuality_values(
                family, selected, part.counts, part.histogram, window.no_days_measured
            )
            value = metrics["late"]
            value = round(value * 1000) if value is not None else None
            sample = part.counts["classified"]
        else:
            state, metrics, _, eligible = _corridor_answer(family, selected, part, window)
            value = metrics["mean_time_lost"]
            sample = eligible["mean_time_lost"]
        for column, item in zip(columns, key if stops else key[1:], strict=True):
            keys[column].append(item)
        samples.append(sample)
        states.append(_MAP_STATES.get(state, 0))
        values.append(value)
    return {
        "measure": question.measure,
        **keys,
        "value": values,
        "sample": samples,
        "state": states,
        "evidence": window.evidence(store, question, family, started),
    }


def _series_answer(
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    group: SeriesGroup,
    started: float,
) -> dict[str, Any]:
    totals: dict[EntityKey, Batch] = {}
    stop_sequences: dict[EntityKey, Counter[int]] = {}
    alerts = family.id == _ALERT_COUNTS_ID
    alert_entities = alerts and group in _ALERT_ENTITY_GROUPS
    vehicles = family.id == _VEHICLES_ID
    crowding = family.id == _CROWDING_ID
    offered = family.id == _SERVICE_OFFERED_ID
    hourly = group in HOUR_GROUPS
    # Position files are already queried one service day at a time. Their manifest
    # date also covers occupancy observations that have no trip or service date.
    position_series = (vehicles or crowding) and group != "direction"
    assert family.query is not None
    query = (
        replace(question, group="hour" if hourly else None)
        if position_series and group not in ("line", "vehicle")
        else question
    )
    occupancy_days: set[str] = set()
    with service_query(store, question.city) as conn:
        window = read_window(conn, store, question, family, selected)
        alert_days = set(window.measured) if alerts else set()
        for offset, result in enumerate(_series_query_batches(conn, store, family, query, window)):
            window.record_vehicle_tracking(family, offset, result)
            if crowding and any(part.counts["published_intervals"] for part in result.values()):
                occupancy_days.add(window.included[offset])
            for key, part in result.items():
                if alerts and not alert_entities:
                    day, *hours = key
                    if not isinstance(day, str) or day not in alert_days:
                        continue
                    key = _date_key(group, day, tuple(hours))
                elif position_series:
                    if vehicles and key == (None,):
                        continue
                    if group not in ("line", "vehicle"):
                        key = _date_key(group, window.included[offset], key)
                elif group == "stop" and not _departure_stop_order(question):
                    direction, sequence, stop = key
                    assert isinstance(sequence, int)
                    key = (direction, stop)
                    # Choose the position across the whole cut while pooling each stop's sample.
                    stop_sequences.setdefault(key, Counter())[sequence] += part.counts.pop(
                        "stop_occurrences"
                    )
                totals.setdefault(key, Batch()).update(part)

    if question.map_view:
        return _map_series(store, question, family, selected, group, started, window, totals)

    stop_positions = {
        key: min(sequences, key=lambda sequence: (-sequences[sequence], sequence))
        for key, sequences in stop_sequences.items()
    }
    # A line's published timetable establishes that an empty hour can have zero service.
    schedule_units = _offered_units(row for part in totals.values() for row in part.offered)
    cells = []
    columns = GROUP_COLUMNS[group]
    untracked = set(window.not_tracked)
    for key in _series_keys(question, group, set(totals), stop_positions):
        cell_hour = key[-1] if hourly else question.hour
        assert cell_hour is None or isinstance(cell_hour, int)
        in_cut = (not hourly or question.hour is None or cell_hour == question.hour) and (
            group != "direction" or question.direction is None or key[0] == question.direction
        )
        included = (
            window.included
            if group == "stop_id"
            else [day for day in window.included if in_cut and matches_date(group, key, day)]
        )
        cell_window = ReadWindow(
            {},
            measured=[day for day in included if not alerts or day not in untracked],
            included=included,
            not_tracked=[day for day in included if day in untracked],
        )
        part = totals.get(key, Batch()) if included else Batch()
        if offered:
            units = (
                {unit for unit in schedule_units if unit[2] == key[0]}
                if group == "direction" else schedule_units
            )
            state, values, evidence, _ = _offered_answer(
                selected, part.offered, included, not included, cell_hour, schedule_units=units
            )
        else:
            if hourly and occupancy_days.intersection(included):
                part.counts["published_intervals"] = 1
            state, values, evidence, _ = evaluate(
                family, selected, part, cell_window, hour=cell_hour
            )
        if _departure_stop_order(question):
            evidence["observed_delay_seconds"] = (
                part.counts["observed_delay_seconds"] if part.counts["classified"] == 1 else None
            )
        display_key = key
        if group == "stop" and not _departure_stop_order(question):
            display_key = (key[0], stop_positions[key], key[1])
        elif group == "departure":
            direction, seconds = key
            assert isinstance(seconds, int)
            departure_hour, remainder = divmod(seconds, 3600)
            minute, second = divmod(remainder, 60)
            display_key = (direction, f"{departure_hour:02d}:{minute:02d}:{second:02d}")
        cells.append(
            {
                "key": dict(zip(columns, display_key, strict=True)),
                "value": values,
                "state": state,
                "state_text": _STATES[state]._asdict(),
                "evidence": {
                    **evidence,
                    # Every stop has the same date window. Keep it once in the envelope.
                    **(
                        {}
                        if group == "stop_id" and not alerts
                        else {"days_included": [day for day in included if day not in untracked]}
                    ),
                },
            }
        )
    headings = {
        **{key: _GROUP_LABELS[key] for key in columns},
        **_csv_columns(family),
    }
    if _departure_stop_order(question):
        headings.update(_DEPARTURE_STOP_COLUMN)
    series_state = {}
    if alert_entities:
        state = _alert_answer(selected, Batch(), window)[0]
        series_state = {"state": state, "state_text": _STATES[state]._asdict()}
    elif question.measure in _VEHICLE_COMPLETION_IDS:
        series_state = {"state": "not_tracked", "state_text": _STATES["not_tracked"]._asdict()}
    elif vehicles and group in ("vehicle", "line"):
        state = "measured" if cells else _vehicle_answer(selected, Batch(), window)[0]
        series_state = {"state": state, "state_text": _STATES[state]._asdict()}
    return {
        "measure": question.measure,
        "group": group,
        "cells": cells,
        **series_state,
        "coverage_note": window.coverage_note,
        "evidence": window.evidence(store, question, family, started),
        "info": [
            {
                **_info(family, measure),
                "csv_columns": {
                    lang: [getattr(label, lang) for label in headings.values()]
                    for lang in ("en", "fr")
                },
            }
            for measure in selected
        ],
    }


def _punctuality_values(
    family: Family,
    selected: tuple[Measure, ...],
    counts: Counter[str],
    histogram: Counter[int],
    missing_days: bool,
) -> tuple[str, dict[str, float | None]]:
    classified, scheduled = counts["classified"], counts["scheduled"]
    state = _state(
        family,
        classified,
        scheduled,
        counts["capture_gap"],
        counts["route_without_live_data"],
        missing_days,
    )
    values: dict[str, float | None] = dict.fromkeys(m.id for m in selected)
    if state == "measured":
        bins = sorted(histogram.items()) if histogram else []
        for measure in selected:
            values[measure.id] = (
                counts[measure.id] / classified
                if measure.percentile is None
                else _percentile(bins, classified, measure.percentile)
            )
    return state, values


def _punctuality_evidence(
    family: Family, counts: Counter[str], included: list[str]
) -> dict[str, Any]:
    scheduled = counts["scheduled"]
    return {
        "counts": {
            key: counts[key] if included else None
            for key in (
                "scheduled", "classified", *(m.id for m in family.measures if m.band),
                *_PUNCTUALITY_BASES,
                *(key for key in ("observed_trips", "observed_service_dates") if key in counts),
            )
        },
        "excluded": {
            key: counts[key] if included else None
            for key in _COUNTS
            if key not in ("scheduled", "classified")
        },
        **_coverage_evidence(family, counts["classified"], scheduled),
    }


def _punctuality_answer(
    family: Family,
    selected: tuple[Measure, ...],
    counts: Counter[str],
    histogram: Counter[int],
    included: list[str],
    missing_days: bool,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    state, values = _punctuality_values(family, selected, counts, histogram, missing_days)
    return (
        state,
        values,
        _punctuality_evidence(family, counts, included),
        dict.fromkeys(values, counts["classified"]),
    )


def _vehicle_answer(
    selected: tuple[Measure, ...], totals: Batch, window: ReadWindow
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    counts = totals.counts
    tracked = counts["tracked_vehicle_days"] > 0
    if window.no_days_measured:
        state = "not_measured"
    elif window.not_tracked and len(window.not_tracked) == len(window.included):
        state = "not_tracked"
    else:
        state = "measured" if tracked else "unknown"

    hours = counts["service_us"] / _US_PER_HOUR
    completion_sample = counts["completion_sample"]
    days_below_threshold = counts["completion_days_below_threshold"]
    ran_trips = counts["completion_ran_trips"]
    observed_termini = counts["completion_observed_termini"]
    vehicle_counts = {
        "days_in_service": counts["days_in_service"],
        "hours_in_service": hours,
        "lines_run": len(totals.vehicle_routes),
        "trips_run": counts["trips_run"],
        "reporting_gaps": counts["reporting_gaps"],
        "silent_hours": counts["silent_us"] / _US_PER_HOUR,
        "completion_sample": completion_sample,
    }
    excluded = {key: counts[key] for key in ("completion_capture_gap", "completion_unknown")}
    states = dict.fromkeys((m.id for m in selected), state)
    completion_ids = states.keys() & _VEHICLE_COMPLETION_IDS
    states.update(dict.fromkeys(completion_ids, "not_tracked"))
    values: dict[str, float | None] = dict.fromkeys(states)
    samples = dict.fromkeys(states, 0)
    punctuality_selected = tuple(
        measure for measure in _PUNCTUALITY.measures if f"vehicle_{measure.id}" in states
    )
    timing_evidence: dict[str, int | None] = {}
    timing_coverage: dict[str, Any] = {}
    if punctuality_selected:
        timing_state, timing_values, timing, timing_samples = _punctuality_answer(
            _PUNCTUALITY,
            punctuality_selected,
            counts,
            totals.histogram,
            window.included if tracked else [],
            window.no_days_measured,
        )
        timing_evidence = {**timing["counts"], **timing["excluded"]}
        timing_coverage = {
            key: timing[key] for key in ("share_observed", *_COVERAGE_COLUMNS) if key in timing
        }
        for key, value in timing_values.items():
            name = f"vehicle_{key}"
            states[name] = timing_state if tracked else state
            values[name] = value if tracked else None
            samples[name] = timing_samples[key]
    if tracked:
        for name in states.keys() - _VEHICLE_PUNCTUALITY_IDS - completion_ids:
            if name == VEHICLE_RANKING_DEFAULT:
                samples[name] = counts["service_us"]
                if hours >= MIN_VEHICLE_REPORTING_HOURS:
                    values[name] = 100 * counts["reporting_gaps"] / hours
                else:
                    states[name] = "too_few_to_judge"
            else:
                values[name] = vehicle_counts[name.removeprefix("vehicle_")]

    if not any(value is not None for value in values.values()):
        state = next(iter(states.values()))
    reporting_measured = tracked and any(m.id in _VEHICLE_REPORTING_IDS for m in selected)
    completion_diagnostics = tracked and bool(completion_ids)
    return (
        state,
        values,
        {
            "counts": {
                **{
                    key: value if tracked else None
                    for key, value in vehicle_counts.items()
                    if key
                    not in {
                        "completion_sample",
                        "reporting_gaps",
                        "silent_hours",
                    }
                },
                "completion_confirmed_upstream_reassignments": (
                    counts["unfinished_trips"] if completion_diagnostics else None
                ),
                "completion_sample": completion_sample if completion_diagnostics else None,
                "reporting_gaps": counts["reporting_gaps"] if reporting_measured else None,
                "silent_hours": vehicle_counts["silent_hours"] if reporting_measured else None,
                **{
                    key: timing_evidence.get(key.removeprefix("punctuality_"))
                    for key in _VEHICLE_COLUMNS
                    if key.startswith("punctuality_")
                },
            },
            "excluded": {
                **{
                    key: value if completion_diagnostics else None
                    for key, value in excluded.items()
                },
                "reporting_gaps_capture_gap": (
                    counts["reporting_gaps_capture_gap"] if reporting_measured else None
                ),
                "reporting_gaps_capture_gap_hours": (
                    counts["reporting_gaps_capture_gap_us"] / _US_PER_HOUR
                    if reporting_measured
                    else None
                ),
            },
            "measure_states": states,
            **(
                {
                    "completion_coverage": {
                        "ran_trips": ran_trips if completion_diagnostics else None,
                        "observed_termini": observed_termini if completion_diagnostics else None,
                        "observed_terminus_share": (
                            observed_termini / ran_trips if ran_trips else None
                        ),
                        "minimum_share": MIN_VEHICLE_TERMINUS_SHARE,
                        "days_below_threshold": days_below_threshold,
                        "reason": _TRIP_END_NOT_OBSERVABLE,
                    },
                }
                if completion_ids
                else {}
            ),
            **timing_coverage,
        },
        samples,
    )


def answer_csv(answer: dict[str, Any], language: Language) -> str:
    family, _ = _SELECTIONS[answer["measure"]]
    columns = _csv_columns(family)
    group = answer.get("group")
    if group:
        columns = {**{key: _GROUP_LABELS[key] for key in GROUP_COLUMNS[group]}, **columns}
    cut = answer["evidence"]
    if "alert_messages" in cut:
        columns.update(_ALERT_MESSAGE_COLUMN)
    if group == "stop" and "departure" in cut["cuts"] and cut["start_date"] == cut["end_date"]:
        columns.update(_DEPARTURE_STOP_COLUMN)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(getattr(label, language) for label in columns.values())
    info = answer["info"]
    entries = [(cell, info) for cell in answer["cells"]] if group else [(answer, [m]) for m in info]
    for cell, measures in entries:
        evidence = {**answer["evidence"], **cell["evidence"]}
        states = evidence.get("measure_states", {})
        values = {
            measure["id"]: (
                cell["value"][measure["id"]],
                measure["text"][language]["unit"],
                getattr(_STATES[states.get(measure["id"], cell["state"])], language),
            )
            for measure in measures
        }
        if len(values) == 1:
            key, (value, unit, state) = next(iter(values.items()))
        else:
            key = answer["measure"]
            value = {name: fields[0] for name, fields in values.items()}
            unit = {name: fields[1] for name, fields in values.items()}
            state = {name: fields[2] for name, fields in values.items()}
        row = {
            **evidence,
            **evidence["counts"],
            **evidence["excluded"],
            **cell.get("key", {}),
            "coverage_note": (answer["coverage_note"] or {}).get(language),
            "state": state,
            "measure": key,
            "unit": unit,
            "value": value,
        }
        if family.id == SCORECARD:
            row.update(evidence["measure_days"][key])
            for column in ("counts", "excluded", "dimension_states", "capture_gap_days"):
                row[column] = evidence[column][key]
        writer.writerow(
            json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value
            for value in (row.get(name) for name in columns)
        )
    return output.getvalue()
