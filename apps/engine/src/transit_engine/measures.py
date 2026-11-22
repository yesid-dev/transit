"""Declare measures here. Use ask() for answers and methods() for their definitions."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import InitVar, dataclass, field, replace
from datetime import date
from time import perf_counter
from typing import Any, Literal, NamedTuple

import duckdb

from transit_engine.capture import MAX_POLL_AGE_SECONDS, MAX_POLL_SPACING_SECONDS, POLL_COVERAGE_SQL
from transit_engine.clean_manifest import (
    ALERTS,
    FEED_POLLS,
    SCHEDULED_STOP_TIMES,
    STOP_EVENTS,
    TRIP_DAYS,
    VEHICLE_POSITIONS,
)
from transit_engine.corridors import (
    CORRIDOR_RUNS_SQL,
    MAX_SEGMENT_RUN_MULTIPLE,
    MIN_SEGMENT_RUNS,
    SEGMENT_BIN_SECONDS,
)
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
from transit_engine.series import (
    DAY_TYPES as _DAY_TYPES,
)
from transit_engine.series import (
    GROUP_COLUMNS,
    HOUR_GROUPS,
    SeriesGroup,
    day_type_sql,
    matches_date,
    series_sql,
)
from transit_engine.series import (
    LOCAL_HOUR as _LOCAL_HOUR,
)
from transit_engine.store import CITY, Store
from transit_engine.vehicles import (
    MIN_STABLE_ID_READINGS,
    MIN_STABLE_READING_SHARE,
    MIN_VEHICLE_RANKING_HOURS,
    MIN_VEHICLE_RANKING_TRIPS,
    TRACKED_VEHICLES_SQL,
    TRIP_CAPTURE_LEAD_SECONDS,
    VEHICLE_COUNTS,
    VEHICLE_POLL_SECONDS,
    VEHICLE_REPORTING_GAP_SECONDS,
    VEHICLE_TAIL_CAP_SECONDS,
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
DELAY_BIN_SECONDS = 15
# A display floor consistent with Transit's historical 30-observation floor.
# A few stop events can dominate a share or percentile. This is not a confidence interval.
MIN_CLASSIFIED_STOP_EVENTS = 30
# With at least 20 known-state trips, one trip moves an unweighted share by at most 5 points.
# Apply the same display floor to the duration sample and to each boundary departure.
MIN_SERVICE_DELIVERED_TRIPS = 20
# Bound trip join memory independently of the requested range. Counts and bins are additive.
DAYS_PER_QUERY_BATCH = 31
MAX_SERIES_DAYS = 400


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


@dataclass
class Batch:
    counts: Counter[str] = field(default_factory=Counter)
    histogram: Counter[int] = field(default_factory=Counter)
    departures: list[Departure] = field(default_factory=list)
    scheduled_routes: set[str] = field(default_factory=set)
    alert_spans: set[AlertSpan] = field(default_factory=set)
    offered: list[OfferedCounts] = field(default_factory=list)
    vehicle_routes: set[str] = field(default_factory=set)

    def update(self, other: Batch) -> None:
        self.counts.update(other.counts)
        self.histogram.update(other.histogram)
        self.departures.extend(other.departures)
        self.scheduled_routes.update(other.scheduled_routes)
        self.alert_spans.update(other.alert_spans)
        self.offered.extend(other.offered)
        self.vehicle_routes.update(other.vehicle_routes)


@dataclass(frozen=True)
class Family:
    id: str
    method_version: str
    since: str
    tables: tuple[str, ...]
    minimum_sample: int
    counts: Text
    exclusions: Text
    limits: Text
    measures: tuple[Measure, ...]
    query: Callable[
        [duckdb.DuckDBPyConnection, Family, dict[str, list[str]], Question, str, EntityKind | None],
        dict[EntityKey, Batch],
    ]
    columns: dict[str, Text] = field(default_factory=dict)
    evidence_columns: dict[str, Text] = field(default_factory=dict)
    bin_seconds: int = DELAY_BIN_SECONDS


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
# Both supported cities use the same service timezone. Departures reverse the
# GTFS local-noon-minus-12-elapsed-hours anchor used by the cleaner, even on DST days.
_DEPARTURE_SECONDS = """
    epoch(scheduled_start_utc)
    - epoch(timezone('America/Toronto', service_date + INTERVAL '12 hours')) + 43200
"""
_SERVICE_DELIVERED_ID = "service_delivered"
_CROWDING_ID = "crowding"
_ALERT_COUNTS_ID = "alert_counts"
_WAITING_ID = "waiting_and_gaps"
_SERVICE_OFFERED_ID = "service_offered"
_VEHICLES_ID = "vehicles"
_CORRIDORS_ID = "corridors"
CORRIDOR_RANKING_DEFAULT = "median_time_lost"
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

    def __post_init__(self, ranking: bool) -> None:
        if self.measure not in _SELECTIONS:
            raise ValueError("unknown measure")
        if not CITY.fullmatch(self.city) or self.start > self.end:
            raise ValueError("provide a city and an ordered service date range")
        family, _ = _SELECTIONS[self.measure]
        if family.id == _CORRIDORS_ID:
            if self.stop is not None or self.departure is not None:
                raise ValueError("corridors use from_stop, to_stop and scheduled departure hour")
            if (self.from_stop is None) != (self.to_stop is None):
                raise ValueError("provide both from_stop and to_stop")
        elif self.from_stop is not None or self.to_stop is not None:
            raise ValueError("from_stop and to_stop apply to corridors")
        if self.group is not None:
            if self.group not in GROUP_COLUMNS or ranking:
                raise ValueError("group must be day, hour, day_type, weekday_hour or direction")
            if (self.end - self.start).days >= MAX_SERIES_DAYS:
                raise ValueError(f"a series can cover at most {MAX_SERIES_DAYS} days")
            if self.group == "direction" and (
                self.line is None or family.id in {_ALERT_COUNTS_ID, _VEHICLES_ID}
            ):
                raise ValueError(
                    "group=direction requires a measure that supports line and direction"
                )
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


def _info(family: Family, measure: Measure) -> dict[str, Any]:
    columns = _csv_columns(family)
    histogram = _histogram_text(family.bin_seconds) if measure.percentile else None
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
            else family.minimum_sample
        ),
        **(
            {"ranking_minimum_sample": measure.ranking_minimum_sample}
            if measure.ranking_minimum_sample is not None
            else {}
        ),
        **({"source": measure.source} if measure.source else {}),
        "evidence_fields": [
            *(key for key in _EVIDENCE_COLUMNS if key in columns),
            "counts",
            "excluded",
            *(_DELIVERY_EVIDENCE if family.id == _SERVICE_DELIVERED_ID else ()),
            *family.evidence_columns,
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
                "limits": getattr(measure.limits or family.limits, lang),
                **({"histogram": getattr(histogram, lang)} if histogram else {}),
            }
            for lang in ("en", "fr")
        },
    }


def _csv_columns(family: Family) -> dict[str, Text]:
    if family.columns:
        common = {key: label for key, label in _CSV_COLUMNS.items() if key != "share_observed"}
        return {**common, **family.columns, **family.evidence_columns}
    if family.id == _SERVICE_DELIVERED_ID:
        common = {key: label for key, label in _CSV_COLUMNS.items() if key != "share_observed"}
        return {**common, **_DELIVERY_COLUMNS, **_DELIVERY_EVIDENCE}
    return {
        **_CSV_COLUMNS,
        **{name: label for name, (_, label) in _COUNTS.items()},
        **{m.id: m.count_label for m in family.measures if m.count_label is not None},
    }


def methods() -> list[dict[str, Any]]:
    return [_info(family, measure) for family in _FAMILIES for measure in family.measures]


def _cuts(question: Question, hour_sql: str | None) -> tuple[str, list[object]]:
    filters = []
    parameters: list[object] = []
    for name, value in question.cuts().items():
        expression = {
            "line": "route_id",
            "direction": "direction_id",
            "stop": "stop_id",
            "departure": _DEPARTURE_SECONDS,
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
    if series:
        return series_sql(series, hour)
    return {
        None: "row(NULL::VARCHAR)",
        "line": "row(route_id)",
        "stop": "row(stop_id)",
        "departure": f"row(route_id, direction_id, ({_DEPARTURE_SECONDS})::BIGINT)",
        "segment": "row(route_id, direction_id, from_stop, to_stop)",
    }[group]


def _grouped_batches(
    rows: list[tuple[Any, ...]], counters: dict[str, str], sample: str, grouped: bool
) -> dict[EntityKey, Batch]:
    groups: dict[EntityKey, Batch] = {}
    for key, edge, routes, *values in rows:
        result = groups.setdefault(tuple(key) if grouped else (), Batch())
        bucket = dict(zip(counters, values, strict=True))
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
) -> tuple[str, list[object], dict[str, str]]:
    hour = _LOCAL_HOUR.format("scheduled_stop_utc")
    cut_sql, filters = _cuts(question, hour)
    parameters: list[object] = [
        *(paths[table] for table in family.tables),
        question.city,
        version,
        question.start,
        question.end,
        *filters,
    ]
    counters = {name: sql for name, (sql, _) in _COUNTS.items()}
    counters.update({m.id: f"count(*) FILTER ({m.band})" for m in family.measures if m.band})
    if group:
        counters["live_candidates"] = "count(*) FILTER (NOT added AND route_has_live_data)"
    aggregates = ", ".join(counters.values())
    routes = (
        "list(DISTINCT route_id) FILTER (NOT added AND route_id IS NOT NULL)" if group else "NULL"
    )
    edge = f"floor(delay_seconds::DOUBLE / {DELAY_BIN_SECONDS})::BIGINT * {DELAY_BIN_SECONDS}"
    if (group or question.group) and all(
        measure.percentile is None for measure in _SELECTIONS[question.measure][1]
    ):
        edge = "NULL::BIGINT"
    vehicle_filter = (
        "AND s.vehicle_id IN (SELECT vehicle_id FROM selected_vehicles)" if for_vehicles else ""
    )
    return (
        f"""
        WITH events AS (
            SELECT s.service_date, t.route_id, t.direction_id, s.stop_id, t.scheduled_start_utc,
                coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc) AS scheduled_stop_utc,
                t.scheduled_start_utc IS NULL AS added,
                NOT added AND t.state = 'cancelled' AS cancelled,
                NOT added AND NOT cancelled AND NOT t.route_has_live_data AS without_live_data,
                NOT (added OR cancelled OR without_live_data) AS scheduled,
                t.route_has_live_data,
                t.state_reason IS NOT DISTINCT FROM 'capture_gap' AS capture_gap,
                CASE WHEN scheduled AND NOT capture_gap THEN s.delay_seconds END AS delay_seconds
            FROM read_parquet(?, hive_partitioning = false) s
            JOIN read_parquet(?, hive_partitioning = false) t
              ON (s.provider, s.service_date, s.cleaning_version, s.trip_id) =
                 (t.provider, t.service_date, t.cleaning_version, t.trip_id)
            WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
                {vehicle_filter}
        )
        SELECT {_entity_sql(group, question.group, hour)} AS entity,
            {edge} AS lower_edge, {routes}, {aggregates}
        FROM events WHERE {cut_sql}
        GROUP BY entity, lower_edge
        """,
        parameters,
        counters,
    )


_PUNCTUALITY = Family(
    id="punctuality",
    method_version="punctuality-v2",
    since="2026-11-22",
    tables=(STOP_EVENTS, TRIP_DAYS),
    query=_punctuality_rows,
    minimum_sample=MIN_CLASSIFIED_STOP_EVENTS,
    counts=Text(
        "Each scheduled stop of each trip counts once. Shares divide the band count by the "
        "number of stops with a measured delay. Delay is signed seconds from the schedule.",
        "Chaque arrêt prévu de chaque trajet compte une fois. Pour chaque catégorie, on "
        "divise son nombre d’arrêts par le nombre d’arrêts dont l’écart a été mesuré. "
        "L’écart à l’horaire est exprimé en secondes, en négatif pour l’avance.",
    ),
    exclusions=Text(
        "Added trips, cancelled trips and lines without live data are excluded. Stops without "
        "a measured delay stay in the scheduled count, including stops affected by capture gaps.",
        "Les trajets ajoutés, les trajets annulés et les lignes sans données en direct sont "
        "exclus. Les arrêts sans écart mesuré restent dans le total prévu, y compris ceux "
        "touchés par une interruption de la collecte.",
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
    routes = (
        "list(DISTINCT route_id) FILTER (state <> 'added' AND route_id IS NOT NULL)"
        if group
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
            (key, edge, routes, *values)
            for key, edge, routes, values, _ in rows
            if values is not None
        ],
        counters,
        "cancellation_notices",
        grouped,
    )
    for key, _, _, _, boundary in rows:
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
    method_version="service-delivered-v1",
    since="2026-11-22",
    tables=(TRIP_DAYS,),
    query=_service_delivered_rows,
    minimum_sample=MIN_SERVICE_DELIVERED_TRIPS,
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
    weight = "epoch_us(ends_at) - epoch_us(observed_at_utc)"
    reading_cut = "matches"
    segments = ""
    entity_hour = "NULL"
    if question.group in HOUR_GROUPS:
        entity_hour = _LOCAL_HOUR.format("hour_start")
        segments = """
            CROSS JOIN LATERAL generate_series(time_bucket(INTERVAL '1 hour', observed_at_utc),
                ends_at, INTERVAL '1 hour') AS hours(hour_start)
            WHERE hour_start < ends_at OR hour_start <= observed_at_utc
        """
        reading_cut = "matches AND hour_start = time_bucket(INTERVAL '1 hour', observed_at_utc)"
        weight = f"""
            least(epoch_us(ends_at), epoch_us(hour_start) + {_US_PER_HOUR})
                - greatest(epoch_us(observed_at_utc), epoch_us(hour_start))
        """
    elif question.hour is not None:
        start_hour = _LOCAL_HOUR.format("observed_at_utc")
        segment_hour = _LOCAL_HOUR.format("hour_start")
        # Use elapsed-hour boundaries and then match the local hour, including both
        # occurrences of a repeated hour when the clocks go back.
        weight = f"""
            (SELECT coalesce(sum(
                least(epoch_us(ends_at), epoch_us(hour_start) + {_US_PER_HOUR})
                - greatest(epoch_us(observed_at_utc), epoch_us(hour_start))
            ), 0)::BIGINT
            FROM generate_series(time_bucket(INTERVAL '1 hour', observed_at_utc),
                ends_at, INTERVAL '1 hour') AS hours(hour_start)
            WHERE {segment_hour} = ?)
        """
        reading_cut = f"matches AND {start_hour} = ?"
        arguments.extend([question.hour] * 2)
    cap_us = CROWDING_TAIL_CAP_SECONDS * 1_000_000
    tail = vehicle_tail_sql("v.next_start", "v.last_seen_at_utc")
    rows = conn.execute(
        f"""
        WITH sequenced AS (
            SELECT provider, cleaning_version, service_date, trip_id, route_id, stop_id,
                observed_at_utc, last_seen_at_utc, readings, occupancy_status,
                occupancy_percentage, lead(observed_at_utc) OVER (
                    PARTITION BY filename, vehicle_id ORDER BY observed_at_utc, captured_at_utc
                ) AS next_start
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ?
        ), vehicles AS (
            SELECT v.route_id, v.stop_id, {direction} AS direction_id,
                v.observed_at_utc, v.readings,
                {tail} AS tail_us,
                greatest(v.observed_at_utc, v.last_seen_at_utc) +
                    greatest(0, least(tail_us, {cap_us})) * INTERVAL '1 microsecond' AS ends_at,
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
    method_version="crowding-v2",
    since="2026-11-22",
    tables=(VEHICLE_POSITIONS, TRIP_DAYS),
    minimum_sample=MIN_CROWDING_VEHICLE_HOURS,
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
        "We count the full span from the first to the last reading of a state. We then "
        "carry the last reading forward to the next interval for that vehicle, up to "
        f"{CROWDING_TAIL_CAP_SECONDS} seconds, to limit the weight of stale readings. The "
        f"last interval of each clean day gets {CROWDING_FINAL_TAIL_SECONDS} seconds, one "
        "scheduled feed poll. The one-vehicle-hour floor keeps a few minutes of reports "
        "from determining the share. "
        "We use the published status when usable and report exact percentages separately "
        "when only a percentage is usable. The full share also includes percentage-only "
        "values at or above 100%.",
        "On compte toute la durée entre le premier et le dernier relevé d’un état. On "
        "prolonge ensuite le dernier relevé jusqu’au prochain intervalle du même véhicule, "
        f"avec un maximum de {CROWDING_TAIL_CAP_SECONDS} secondes pour limiter le poids des "
        f"relevés périmés. Le dernier intervalle de chaque journée nettoyée reçoit "
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
    }[group]
    projection = "entity, source, alert_id, version, epoch_us(starts), epoch_us(ends)"
    segments = ""
    if question.group:
        local_day = "timezone('America/Toronto', bucket)::DATE"
        if question.group in HOUR_GROUPS:
            bucket_start = "bucket"
            bucket_end = "bucket + INTERVAL '1 hour'"
            series = """
                generate_series(time_bucket(INTERVAL '1 hour', starts), ends, INTERVAL '1 hour')
            """
            key_sql = f"row({local_day}::VARCHAR, {_LOCAL_HOUR.format('bucket')})"
        else:
            bucket_start = "timezone('America/Toronto', bucket)"
            bucket_end = "timezone('America/Toronto', bucket + INTERVAL '1 day')"
            series = """
                generate_series(
                    date_trunc('day', timezone('America/Toronto', starts)),
                    timezone('America/Toronto', ends), INTERVAL '1 day')
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
            SELECT timezone('America/Toronto', ?::DATE::TIMESTAMP) AS window_start,
                timezone('America/Toronto', (?::DATE + 1)::TIMESTAMP) AS window_end
        ), periods AS (
            SELECT source, alert_id, version, first_seen_at_utc, last_seen_at_utc,
                route_ids, stop_ids,
                unnest(CASE WHEN len(active_periods) = 0
                    THEN [{{'start_utc': NULL, 'end_utc': NULL}}]
                    ELSE active_periods END) AS period
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND ({" AND ".join(filters) or "true"})
        ), clipped AS (
            SELECT {group_sql} AS entity, source, alert_id, version,
                greatest(coalesce(period.start_utc, first_seen_at_utc), window_start) AS starts,
                least(coalesce(period.end_utc, last_seen_at_utc), window_end) AS ends,
                period.start_utc IS NULL AND period.end_utc IS NULL AS observed_only,
                first_seen_at_utc, last_seen_at_utc, window_end
            FROM periods CROSS JOIN bounds
        ), valid AS (
            SELECT DISTINCT entity, source, alert_id, version, starts, ends FROM clipped
            WHERE starts < ends OR (observed_only AND first_seen_at_utc = last_seen_at_utc
                AND starts = first_seen_at_utc AND starts < window_end AND starts = ends)
        )
        SELECT DISTINCT {projection} FROM valid {segments}
        """,
        [question.start, question.end, alert_paths, question.city, version, *arguments],
    ).fetchall()
    result: dict[EntityKey, Batch] = {}
    for entity, source, alert_id, revision, start, end in rows:
        key = tuple(entity) if question.group else (entity,) if group else ()
        result.setdefault(key, Batch()).alert_spans.add(
            AlertSpan(source, alert_id, revision, start, end)
        )
    return result


_ALERT_COUNTS = Family(
    id=_ALERT_COUNTS_ID,
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
        "Pairs without two usable observations", "Paires sans deux observations utilisables"
    ),
    "not_consecutive": Text(
        "Pairs with another observed passage between them",
        "Paires séparées par un autre passage observé",
    ),
    "overtaking_pairs": Text(
        "Pairs observed in reverse scheduled order",
        "Paires observées dans l’ordre inverse de l’horaire",
    ),
    "capture_gap": Text("Pairs without continuous capture", "Paires sans collecte continue"),
}
_WAITING_COLUMNS = {
    "scheduled_headways": Text("Scheduled headways", "Intervalles prévus"),
    "frequent_headways": Text(
        "Scheduled headways with live data in frequent periods",
        "Intervalles prévus avec données en direct en période fréquente",
    ),
    "observed_headways": Text("Matched observed headways", "Intervalles observés appariés"),
    "scheduled_seconds": Text("Matched scheduled seconds", "Secondes prévues appariées"),
    "observed_seconds": Text("Matched observed seconds", "Secondes observées appariées"),
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


def _waiting_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    hour = _LOCAL_HOUR.format("scheduled_stop_utc")
    scope, scope_params = _cuts(replace(question, hour=None, departure=None), hour)
    cut, cut_params = _cuts(question, hour)
    identity = "provider, cleaning_version, service_date, trip_id"
    counters = {
        "scheduled_stops": "count(*)",
        "live_candidates": "count(*) FILTER (route_has_live_data)",
        "live_direction_stops": "count(direction_id) FILTER (route_has_live_data)",
        "unknown_direction": "count(*) FILTER (direction_id IS NULL)",
        "scheduled_headways": "count(*) FILTER (scheduled_pair)",
        "frequent_headways": "count(*) FILTER (frequent AND route_has_live_data)",
        "observed_headways": "count(*) FILTER (eligible)",
        "scheduled_seconds": "coalesce(sum(scheduled_seconds) FILTER (eligible), 0)",
        "observed_seconds": "coalesce(sum(observed_seconds) FILTER (eligible), 0)",
        "scheduled_squared_seconds": (
            "coalesce(sum(scheduled_seconds * scheduled_seconds) FILTER (eligible), 0)"
        ),
        "observed_squared_seconds": (
            "coalesce(sum(observed_seconds * observed_seconds) FILTER (eligible), 0)"
        ),
        "route_without_live_data": ("count(*) FILTER (scheduled_pair AND NOT route_has_live_data)"),
        "non_frequent": (
            "count(*) FILTER (scheduled_pair AND route_has_live_data AND NOT frequent)"
        ),
        "missing_observation": (
            "count(*) FILTER (frequent AND route_has_live_data "
            "AND NOT trip_gap AND NOT observed_pair)"
        ),
        "not_consecutive": (
            "count(*) FILTER (frequent AND route_has_live_data "
            "AND observed_pair AND NOT overtaking AND NOT consecutive)"
        ),
        "overtaking_pairs": (
            "count(*) FILTER (frequent AND route_has_live_data AND observed_pair AND overtaking)"
        ),
        "capture_gap": (
            "count(*) FILTER (frequent AND route_has_live_data AND "
            "(trip_gap OR (observed_pair AND NOT overtaking AND consecutive AND NOT eligible)))"
        ),
    }
    counters.update(
        {m.id: f"count(*) FILTER (eligible AND ({m.band}))" for m in family.measures if m.band}
    )
    routes = "list(DISTINCT route_id)" if group else "NULL"
    window = [question.city, version, question.start, question.end]
    rows = conn.execute(
        f"""
        WITH events AS (
            SELECT s.service_date, s.trip_id, s.stop_id, s.stop_sequence,
                t.route_id, t.direction_id, t.scheduled_start_utc, t.route_has_live_data,
                CASE WHEN t.state <> 'added' THEN
                    coalesce(s.scheduled_arrival_utc, s.scheduled_departure_utc)
                END AS scheduled_stop_utc,
                s.observed_at_utc,
                t.state_reason IS NOT DISTINCT FROM 'capture_gap' AS trip_capture_gap,
                coalesce(t.state = 'ran' AND t.route_has_live_data AND
                    t.state_reason IS DISTINCT FROM 'capture_gap' AND
                    s.basis IN ('vehicle_stopped', 'trip_update_reported') AND
                    (s.observed_event = 'arrival' OR s.scheduled_arrival_utc IS NULL), false)
                    AS usable_observation
            FROM read_parquet(?, hive_partitioning = false) s
            JOIN read_parquet(?, hive_partitioning = false) t USING ({identity})
            WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
                AND t.route_id IS NOT NULL
        ), observed_order AS (
            SELECT *, row_number() OVER (
                PARTITION BY service_date, route_id, direction_id, stop_id
                ORDER BY observed_at_utc NULLS LAST, trip_id, stop_sequence
            ) AS observed_index
            FROM events WHERE {scope}
        ), timetable AS (
            SELECT *, {period_sql(hour)} AS period,
                timezone('America/Toronto', scheduled_stop_utc)::DATE AS local_date
            FROM observed_order WHERE scheduled_stop_utc IS NOT NULL
        ), pairs AS (
            SELECT *, epoch(scheduled_stop_utc - lag(scheduled_stop_utc) OVER schedule)::BIGINT
                    AS scheduled_seconds,
                lag(observed_at_utc) OVER schedule AS prev_observed,
                coalesce(observed_at_utc < prev_observed, false) AS overtaking,
                trip_capture_gap OR lag(trip_capture_gap, 1, false) OVER schedule AS trip_gap,
                usable_observation AND lag(usable_observation, 1, false) OVER schedule
                    AND prev_observed IS NOT NULL AND observed_at_utc IS NOT NULL
                    AND trip_id <> lag(trip_id, 1, trip_id) OVER schedule AS observed_pair,
                coalesce(abs(observed_index - lag(observed_index) OVER schedule) = 1, false)
                    AS consecutive
            FROM timetable
            WINDOW schedule AS (
                PARTITION BY service_date, route_id, direction_id, stop_id, local_date, period
                ORDER BY scheduled_stop_utc, trip_id, stop_sequence
            )
        ), frequent_periods AS (
            SELECT *,
                coalesce(scheduled_seconds > 0 AND direction_id IS NOT NULL, false)
                    AS scheduled_pair,
                coalesce(scheduled_pair AND
                avg(scheduled_seconds) FILTER (scheduled_seconds > 0) OVER (
                    PARTITION BY service_date, route_id, direction_id, stop_id, local_date, period
                ) <= {FREQUENT_HEADWAY_SECONDS}, false) AS frequent
            FROM pairs
        ),
        {POLL_COVERAGE_SQL},
        matched AS (
            SELECT p.*,
                epoch(observed_at_utc - prev_observed)::BIGINT AS observed_seconds,
                frequent AND route_has_live_data AND observed_pair AND consecutive
                    AND NOT overtaking AND coalesce(f.required_feeds = (
                        SELECT count(DISTINCT c.feed) FROM coverage c
                        WHERE c.service_date = p.service_date
                          AND c.covered_from <= least(p.observed_at_utc, p.prev_observed)
                          AND c.covered_to >= greatest(p.observed_at_utc, p.prev_observed)
                    ), false) AS eligible
            FROM frequent_periods p LEFT JOIN realtime_feed_counts f USING (service_date)
            WHERE {cut}
        )
        SELECT {_entity_sql(group, question.group, hour)} AS entity,
            NULL, {routes}, {", ".join(counters.values())}
        FROM matched GROUP BY entity
        """,
        [
            paths[STOP_EVENTS],
            paths[TRIP_DAYS],
            *window,
            *scope_params,
            paths[FEED_POLLS],
            *window,
            *cut_params,
        ],
    ).fetchall()
    return _grouped_batches(rows, counters, "observed_headways", bool(group or question.group))


_WAITING = Family(
    id=_WAITING_ID,
    method_version="1",
    since="2026-11-22",
    tables=(STOP_EVENTS, TRIP_DAYS, FEED_POLLS),
    minimum_sample=MIN_OBSERVED_HEADWAYS,
    counts=Text(
        "Evidence gives the number of scheduled and matched pairs, the sums and squared "
        "sums of their intervals and the counts of bunched and long intervals.",
        "Les données indiquent les nombres de paires prévues et appariées, la somme et la "
        "somme des carrés de leurs intervalles, et les nombres d’intervalles courts et prolongés.",
    ),
    exclusions=Text(
        "Pairs must be consecutive in the schedule and in the observations for the same "
        "line, stop and direction. Both trips must have run and both arrivals must be "
        "confirmed by a stopped vehicle or a time the agency marked exact. An exact "
        "departure is accepted at a stop with only a scheduled departure. Unobserved "
        "scheduled trips interrupt pairing. Every trip or vehicle feed recorded for the "
        "service date must have continuous capture between observations, with at most "
        f"{MAX_POLL_SPACING_SECONDS} seconds between "
        f"usable polls and {MAX_POLL_AGE_SECONDS} seconds of publication age. "
        "The direction must be known. Lines without live data are excluded.",
        "Les passages doivent se suivre dans l’horaire et les observations pour la même "
        "ligne, le même arrêt et la même direction. Les deux trajets doivent avoir eu lieu "
        "et les arrivées doivent être confirmées par un véhicule à l’arrêt ou une heure "
        "jugée exacte par l’exploitant. Un départ exact est accepté si seul le départ est "
        "prévu à l’horaire. Un trajet prévu non observé interrompt l’appariement. "
        "La collecte de chaque flux de trajets ou de véhicules consigné pour cette date de "
        "service doit couvrir l’intervalle entre les observations, avec au plus "
        f"{MAX_POLL_SPACING_SECONDS} secondes entre les relevés utilisables et "
        f"des publications datant d’au plus {MAX_POLL_AGE_SECONDS} secondes. "
        "La direction doit être connue. Les lignes sans données en direct sont exclues.",
    ),
    limits=Text(
        f"A frequent period has at least two distinct scheduled times and a mean scheduled "
        f"interval of at most {FREQUENT_HEADWAY_SECONDS // 60} minutes at that stop and "
        f"direction on that service date. Local periods are {periods_text('en')}. "
        "Each pair belongs to its later scheduled stop time and trip departure. "
        "Pairs where vehicles overtook each other are left out. This can understate bunching. "
        f"At least {MIN_OBSERVED_HEADWAYS} matched pairs are needed to report a value.",
        "Une période est fréquente si elle compte au moins deux heures de passage "
        f"distinctes et un intervalle prévu moyen d’au plus {FREQUENT_HEADWAY_SECONDS // 60} "
        "minutes à cet arrêt et dans cette direction à cette date de service. "
        f"Périodes locales : {periods_text('fr')}. Chaque paire est rattachée au dernier "
        "passage prévu et au départ de son trajet. "
        "Les paires où un véhicule a dépassé l’autre sont exclues. Cela peut sous-estimer "
        "les regroupements de véhicules. "
        f"Il faut au moins {MIN_OBSERVED_HEADWAYS} paires appariées pour publier une valeur.",
    ),
    measures=(
        Measure(
            "observed_headway",
            "seconds",
            Text(
                "Mean observed time between matched vehicles at a stop.",
                "Intervalle moyen observé entre les véhicules appariés à un arrêt.",
            ),
            ratio=("observed_seconds", "observed_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "scheduled_headway",
            "seconds",
            Text(
                "Mean scheduled time between the same matched vehicles.",
                "Intervalle moyen prévu entre les mêmes véhicules appariés.",
            ),
            ratio=("scheduled_seconds", "observed_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "bunching",
            "share",
            Text(
                f"Share of matched observed headways shorter than {BUNCHING_FRACTION:.0%} "
                "of their scheduled interval.",
                f"Part des intervalles observés appariés inférieurs à {BUNCHING_FRACTION:.0%} "
                "de l’intervalle prévu.",
            ),
            band=f"observed_seconds < {BUNCHING_FRACTION} * scheduled_seconds",
            ratio=("bunching", "observed_headways"),
            worst_first_descending=True,
            ranking_kinds=("line",),
        ),
        Measure(
            "long_gaps",
            "share",
            Text(
                f"Share of matched observed headways longer than {LONG_GAP_MULTIPLE} times "
                "their scheduled interval.",
                f"Part des intervalles observés appariés supérieurs à {LONG_GAP_MULTIPLE} fois "
                "l’intervalle prévu.",
            ),
            band=f"observed_seconds > {LONG_GAP_MULTIPLE} * scheduled_seconds",
            ratio=("long_gaps", "observed_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "excess_wait_time",
            "seconds",
            Text(
                "Excess Wait Time is observed average wait minus scheduled average wait. "
                "For riders arriving independently of the timetable, the average wait is "
                "the sum of squared headways divided by twice their sum, using the same "
                "matched pairs on both sides, following Transport for London practice.",
                "Le temps d’attente excédentaire est l’attente moyenne observée moins "
                "l’attente moyenne prévue. Pour les personnes qui arrivent sans consulter "
                "l’horaire, l’attente moyenne est la somme des carrés des intervalles "
                "divisée par deux fois leur somme. Le calcul utilise les mêmes paires "
                "appariées des deux côtés, selon la méthode de Transport for London.",
            ),
            source="https://assets.publishing.service.gov.uk/media/5a7f3f5940f0b62305b85fb7/measurement-template.pdf",
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
            period, sum(trips), count(*) FILTER (trips >= {MIN_TRIPS_PER_HOUR} * ({period_hours}))
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
    method_version="1",
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
        "excluded. A line and direction seen in the selected timetable can have zero trips "
        "in other periods and on other included dates.",
        "L’horaire inclut les lignes sans données en direct. Chaque trajet est compté au "
        "premier arrêt avec une heure prévue ou au premier passage avec une heure prévue "
        "à l’arrêt choisi. Les horaires manquants sont exclus. Une ligne et une direction "
        "présentes dans l’horaire choisi peuvent n’offrir aucun trajet à d’autres périodes "
        "ou dates incluses.",
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
    "unfinished_trips": Text("Unfinished trips", "Trajets non terminés"),
    "completion_sample": Text("Trips assessed for completion", "Trajets évalués"),
    "completion_capture_gap": Text("Trips with capture gaps", "Trajets avec collecte interrompue"),
    "completion_unknown": Text("Trips with unknown status", "Trajets à l’état inconnu"),
    **{f"punctuality_{key}": label for key, (_, label) in _COUNTS.items()},
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
    "of continuity within the day. A gap describes silence in the captured feed.",
    f"Le suivi est indisponible un jour si moins de {MIN_STABLE_READING_SHARE:.0%} des "
    f"relevés de véhicules nettoyés ont un identifiant vu au moins {MIN_STABLE_ID_READINGS} "
    "fois, ou si une part inférieure des trajets confirmés est liée à ces identifiants. "
    "La répétition d’un identifiant témoigne de sa continuité dans la journée. "
    "Une interruption indique un silence dans le flux capturé.",
)
_VEHICLE_REPORTING_EXCLUSIONS = Text(
    "The vehicle-position feed must have continuous capture across the silence. Usable polls "
    f"contain advancing, nonempty publications at most {MAX_POLL_AGE_SECONDS} seconds old "
    f"and are at most {MAX_POLL_SPACING_SECONDS} seconds apart. Silences across capture gaps "
    "are excluded from the count and duration and shown in the evidence.",
    "La collecte du flux de positions doit être continue pendant le silence. Les relevés "
    "utilisables contiennent des publications non vides plus récentes que les précédentes, "
    f"vieilles d’au plus {MAX_POLL_AGE_SECONDS} secondes et espacées d’au plus "
    f"{MAX_POLL_SPACING_SECONDS} secondes. Les silences pendant une interruption de la "
    "collecte sont exclus du nombre et de la durée et figurent dans les données justificatives.",
)
_VEHICLE_COMPLETION_METHOD = Text(
    "A confirmed stop before the scheduled terminal indicates an unfinished trip when the "
    "terminal was never confirmed and capture is continuous. Every recorded realtime feed "
    f"must be covered from {TRIP_CAPTURE_LEAD_SECONDS} seconds before scheduled departure "
    f"through {MAX_POLL_SPACING_SECONDS} seconds after the scheduled end or last observation, "
    "whichever is later. Usable polls contain advancing publications no more than "
    f"{MAX_POLL_AGE_SECONDS} seconds old, with spacing of at most "
    f"{MAX_POLL_SPACING_SECONDS} seconds.",
    "Un arrêt confirmé avant le terminus prévu indique un trajet non terminé si le terminus "
    "n’a jamais été confirmé et que la collecte est continue. Chaque flux temps réel consigné "
    f"doit être couvert de {TRIP_CAPTURE_LEAD_SECONDS} secondes avant le départ prévu à "
    f"{MAX_POLL_SPACING_SECONDS} secondes après la fin prévue ou la dernière observation, "
    "selon la plus tardive. Les relevés utilisables ont une publication plus récente que "
    f"les précédentes, vieille d’au plus {MAX_POLL_AGE_SECONDS} secondes, et sont espacés "
    f"d’au plus {MAX_POLL_SPACING_SECONDS} secondes.",
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
        group == "vehicle",
        question.measure == family.id or question.measure in _VEHICLE_REPORTING_IDS,
        question.measure == family.id or question.measure in _VEHICLE_COMPLETION_IDS,
        by_hour=question.group == "hour",
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
    method_version="vehicles-v1",
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
        "Trips without a confirmed stop, a scheduled endpoint, a unique assigned vehicle "
        "or continuous capture are excluded from the completion sample.",
        "Les trajets sans arrêt confirmé, terminus prévu, véhicule unique attribué ou "
        "collecte continue sont exclus de l’échantillon d’achèvement.",
    ),
    limits=_VEHICLE_LIMITS,
    columns=_VEHICLE_COLUMNS,
    evidence_columns={
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
            Text(
                "Trips observed short of the last scheduled stop per 100 trips assessed.",
                "Trajets observés avant leur dernier arrêt prévu par 100 trajets évalués.",
            ),
            counts=Text(
                f"{_VEHICLE_COMPLETION_METHOD.en} Rankings require "
                f"{MIN_VEHICLE_RANKING_TRIPS} assessed trips, so each trip moves the rate "
                "by at most five per 100 trips.",
                f"{_VEHICLE_COMPLETION_METHOD.fr} Le classement exige "
                f"{MIN_VEHICLE_RANKING_TRIPS} trajets évalués. Chaque trajet change le taux "
                "d’au plus cinq par 100 trajets.",
            ),
            extra_tables=(STOP_EVENTS, FEED_POLLS),
            worst_first_descending=True,
            ranking_kinds=("vehicle",),
            ranking_minimum_sample=MIN_VEHICLE_RANKING_TRIPS,
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
    routes = "list(DISTINCT route_id)" if group else "NULL"
    window = [question.city, version, question.start, question.end]
    rows = conn.execute(
        f"""
        WITH {CORRIDOR_RUNS_SQL.format(cut=cut)}
        SELECT {_entity_sql(group, question.group, hour)} AS entity,
            CASE WHEN exclusion IS NULL THEN {edge} END AS edge,
            {routes}, {", ".join(counters.values())}
        FROM runs GROUP BY entity, edge
        """,
        [paths[STOP_EVENTS], paths[TRIP_DAYS], *window, paths[FEED_POLLS], *window, *parameters],
    ).fetchall()
    return _grouped_batches(rows, counters, "observed_runs", bool(group or question.group))


_CORRIDORS = Family(
    id=_CORRIDORS_ID,
    method_version="1",
    since="2026-11-22",
    tables=(STOP_EVENTS, TRIP_DAYS, FEED_POLLS),
    minimum_sample=MIN_SEGMENT_RUNS,
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
        "vehicles, exact agency reports and estimates backed by vehicle progression. We "
        "exclude cancelled trips, missing observations or live data, nonpositive scheduled "
        f"durations, negative observed durations and runs over {MAX_SEGMENT_RUN_MULTIPLE} "
        "times their scheduled duration. Every recorded trip or vehicle feed must cover the "
        f"observed span with poll intervals of at most {MAX_POLL_SPACING_SECONDS} seconds and "
        f"publication age of at most {MAX_POLL_AGE_SECONDS} seconds.",
        "Les deux arrêts doivent avoir la même base d’observation. Les données distinguent "
        "les véhicules vus à l’arrêt, les rapports exacts et les estimations confirmées par "
        "la progression du véhicule. Sont exclus les trajets annulés, les observations ou "
        "données en direct manquantes, les durées prévues non positives, les durées observées "
        f"négatives et celles dépassant {MAX_SEGMENT_RUN_MULTIPLE} fois la durée prévue. Chaque "
        "flux de trajets ou de véhicules enregistré doit couvrir l’intervalle observé, avec "
        f"au plus {MAX_POLL_SPACING_SECONDS} secondes entre relevés et "
        f"{MAX_POLL_AGE_SECONDS} secondes depuis la publication.",
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


_FAMILIES = (
    _PUNCTUALITY,
    _SERVICE_DELIVERED,
    _CROWDING,
    _ALERT_COUNTS,
    _WAITING,
    _SERVICE_OFFERED,
    _VEHICLES,
    _CORRIDORS,
)
_SELECTIONS = {
    key: (family, selected)
    for family in _FAMILIES
    for key, selected in (
        (family.id, family.measures),
        *((measure.id, (measure,)) for measure in family.measures),
    )
}


def _percentile(
    histogram: list[tuple[int, int]],
    count: int,
    percentile: int,
    bin_seconds: int = DELAY_BIN_SECONDS,
) -> float:
    # Zero-based ranks for a continuous percentile using each bin's midpoint.
    rank, remainder = divmod((count - 1) * percentile, 100)
    seen = 0
    lower_midpoint = None
    for edge, occurrences in histogram:
        midpoint = edge + bin_seconds / 2
        seen += occurrences
        if lower_midpoint is None and seen > rank:
            lower_midpoint = midpoint
        if lower_midpoint is not None and seen > rank + bool(remainder):
            return lower_midpoint + (midpoint - lower_midpoint) * remainder / 100
    raise RuntimeError("histogram counts do not match the sample count")


def _state(
    family: Family,
    sample: int,
    scheduled_with_live: int,
    captures_missing: int,
    without_live: int,
    missing_days: bool,
) -> str:
    if missing_days or (scheduled_with_live and captures_missing == scheduled_with_live):
        return "not_measured"
    if not scheduled_with_live and without_live:
        return "no_live_data"
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
        )

    state = trip_state(counts["eligible"])
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
            measure_state = _state(
                family,
                bottom,
                sum(row.scheduled for row in edge) - without_live,
                sum(row.capture_gap for row in edge),
                without_live,
                missing_days,
            )
        states[measure.id] = measure_state
        samples[measure.id] = sample
        values[measure.id] = top / bottom if measure_state == "measured" else None
    notices = counts["cancellation_notices"]
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
        "share_eligible": counts["eligible"] / counts["scheduled"] if counts["scheduled"] else None,
        "share_unconfirmed": (
            counts["unconfirmed"] / counts["scheduled"] if counts["scheduled"] else None
        ),
        "median_cancellation_lead_seconds": (
            _percentile(sorted(histogram.items()), notices, 50) if notices else None
        ),
        "boundary_departures": [row._asdict() for row in departures] if departures else None,
        "measure_states": states,
    }
    return states[selected[0].id] if len(selected) == 1 else state, values, evidence, samples


@dataclass
class ReadWindow:
    paths: dict[str, list[str]]
    measured: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    included: list[str] = field(default_factory=list)
    missing_in_cut: bool = False
    not_tracked: list[str] = field(default_factory=list)
    batch_days: int | None = None

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

    def batches(self) -> Iterator[dict[str, list[str]]]:
        size = self.batch_days or DAYS_PER_QUERY_BATCH
        days_read = len(next(iter(self.paths.values())))
        for offset in range(0, days_read, size):
            yield {table: files[offset : offset + size] for table, files in self.paths.items()}

    def evidence(
        self, store: Store, question: Question, family: Family, started: float
    ) -> dict[str, Any]:
        untracked = set(self.not_tracked) if family.id == _VEHICLES_ID else set()
        return {
            "city": question.city,
            "start_date": question.start.isoformat(),
            "end_date": question.end.isoformat(),
            "cuts": question.cuts(),
            "days_measured": [day for day in self.measured if day not in untracked],
            "days_not_measured": self.missing,
            "days_included": self.measured
            if family.id == _ALERT_COUNTS_ID
            else [day for day in self.included if day not in untracked],
            "cleaning_versions": [store.cleaning_version] if self.included else [],
            "method_version": family.method_version,
            "query_ms": (perf_counter() - started) * 1000,
            **(
                {"days_not_tracked": self.not_tracked, "days_alerts_tracked": self.measured}
                if family.id == _ALERT_COUNTS_ID
                else {}
            ),
            **({"days_not_tracked": self.not_tracked} if family.id == _VEHICLES_ID else {}),
        }

    def record_vehicle_tracking(
        self, family: Family, offset: int, result: dict[EntityKey, Batch]
    ) -> None:
        if family.id == _VEHICLES_ID and (None,) in result:
            self.not_tracked.append(self.included[offset])


def read_window(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    group: EntityKind | None = None,
) -> ReadWindow:
    tables = tuple(
        dict.fromkeys((*family.tables, *(table for m in selected for table in m.extra_tables)))
    )
    if group and family.id == _ALERT_COUNTS_ID:
        tables += (TRIP_DAYS, STOP_EVENTS) if group == "stop" else (TRIP_DAYS,)
    # Keep the window sorts over dense position and corridor stop records to one day.
    batch_days = 1 if VEHICLE_POSITIONS in tables or family.id == _CORRIDORS_ID else None
    window = ReadWindow({table: [] for table in tables}, batch_days=batch_days)
    for ordinal in range(question.start.toordinal(), question.end.toordinal() + 1):
        day = date.fromordinal(ordinal)
        in_cut = question.day_type is None or question.day_type == _DAY_TYPES[day.weekday()]
        files = store.files(
            conn,
            question.city,
            day,
            tables,
            allow_untracked_alerts=family.id == _ALERT_COUNTS_ID,
        )
        if files is None:
            window.missing.append(day.isoformat())
            window.missing_in_cut |= in_cut
        else:
            dated = (
                window.not_tracked
                if family.id == _ALERT_COUNTS_ID and not files[0]
                else (window.measured)
            )
            dated.append(day.isoformat())
            if in_cut:
                window.included.append(day.isoformat())
            # A weekday schedule can establish that a line exists for a weekend zero.
            if in_cut or family.id == _SERVICE_OFFERED_ID:
                for table, path in zip(tables, files, strict=True):
                    window.paths[table].append(path)
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
        return _waiting_answer(
            family, selected, totals.counts, window.included, window.no_days_measured
        )
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
    scheduled = counts["scheduled_runs"]
    without_live = counts["route_without_live_data"]
    state = _state(
        family,
        sample,
        scheduled - without_live,
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
                    histogram, sample, measure.percentile, family.bin_seconds
                )
            else:
                values[measure.id] = lost / (sample if measure.id == "mean_time_lost" else 60)
    evidence = {
        "counts": {key: counts[key] if window.included else None for key in _CORRIDOR_COUNTS},
        "excluded": {key: counts[key] if window.included else None for key in _CORRIDOR_EXCLUSIONS},
        "share_observed": sample / scheduled if scheduled else None,
    }
    return state, values, evidence, dict.fromkeys(values, sample)


def _waiting_answer(
    family: Family,
    selected: tuple[Measure, ...],
    counts: Counter[str],
    included: list[str],
    missing_days: bool,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    sample = counts["observed_headways"]
    frequent = counts["frequent_headways"]
    state = _state(
        family,
        sample,
        frequent,
        counts["capture_gap"],
        0,
        missing_days,
    )
    if not missing_days and not frequent:
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
                values[measure.id] = counts[numerator] / counts[denominator]
            elif counts["observed_seconds"]:
                actual = counts["observed_squared_seconds"] / (2 * counts["observed_seconds"])
                scheduled = counts["scheduled_squared_seconds"] / (2 * counts["scheduled_seconds"])
                values[measure.id] = actual - scheduled
            else:
                states[measure.id] = "unknown"
    evidence = {
        "counts": {
            key: counts[key] if included else None
            for key in _WAITING_COLUMNS
            if key not in _WAITING_EXCLUDED
        },
        "excluded": {key: counts[key] if included else None for key in _WAITING_EXCLUDED},
        "share_observed": sample / frequent if frequent else None,
        "measure_states": states,
    }
    return (
        states[selected[0].id] if len(selected) == 1 else state,
        values,
        evidence,
        dict.fromkeys(values, sample),
    )


def _offered_answer(
    selected: tuple[Measure, ...],
    offered: list[OfferedCounts],
    included: list[str],
    missing_days: bool,
    hour: int | None,
    *,
    units: int | None = None,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    # A sparse period with no departures still counts for a scope seen in the timetable.
    if units is None:
        units = len({(row.route_id, row.direction_id) for row in offered})
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
            assessed = days * units if p.id == "evening" or day_type != "weekday" else 0
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
                states[measure.id] = "no_evening_or_weekend_periods"
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


def ask(store: Store, question: Question) -> dict[str, Any]:
    """Read validated days and compute the selected measure or family with its evidence."""
    started = perf_counter()
    family, selected = _SELECTIONS[question.measure]
    if question.group:
        return _series_answer(store, question, family, selected, question.group, started)
    totals = Batch()
    with store.connect() as conn:
        window = read_window(conn, store, question, family, selected)
        for offset, batch in enumerate(window.batches()):
            result = family.query(conn, family, batch, question, str(store.cleaning_version), None)
            window.record_vehicle_tracking(family, offset, result)
            if () in result:
                totals.update(result[()])
    state, values, family_evidence, _ = evaluate(
        family, selected, totals, window, hour=question.hour
    )
    return {
        "measure": question.measure,
        "value": values,
        "state": state,
        "state_text": _STATES[state]._asdict(),
        "coverage_note": window.coverage_note,
        "evidence": {**window.evidence(store, question, family, started), **family_evidence},
        "info": [_info(family, measure) for measure in selected],
    }


def _date_key(group: SeriesGroup, day: str, hour_key: EntityKey = ()) -> EntityKey:
    if group == "day":
        return (day,)
    if group == "day_type":
        return (_DAY_TYPES[date.fromisoformat(day).weekday()],)
    if group == "weekday_hour":
        return (date.fromisoformat(day).isoweekday(), *hour_key)
    return hour_key


def _series_keys(
    question: Question, group: SeriesGroup, observed: set[EntityKey]
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
    return [(0,), (1,), *([(None,)] if (None,) in observed else [])]


def _series_answer(
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    group: SeriesGroup,
    started: float,
) -> dict[str, Any]:
    totals: dict[EntityKey, Batch] = {}
    alerts = family.id == _ALERT_COUNTS_ID
    vehicles = family.id == _VEHICLES_ID
    crowding = family.id == _CROWDING_ID
    offered = family.id == _SERVICE_OFFERED_ID
    hourly = group in HOUR_GROUPS
    # Position files are already queried one service day at a time. Their manifest
    # date also covers occupancy observations that have no trip or service date.
    position_series = (vehicles or crowding) and group != "direction"
    query = replace(question, group="hour" if hourly else None) if position_series else question
    occupancy_days: set[str] = set()
    with store.connect() as conn:
        window = read_window(conn, store, question, family, selected)
        alert_days = set(window.measured) if alerts else set()
        for offset, batch in enumerate(window.batches()):
            result = family.query(conn, family, batch, query, str(store.cleaning_version), None)
            window.record_vehicle_tracking(family, offset, result)
            if crowding and any(part.counts["published_intervals"] for part in result.values()):
                occupancy_days.add(window.included[offset])
            for key, part in result.items():
                if alerts:
                    day, *hours = key
                    if not isinstance(day, str) or day not in alert_days:
                        continue
                    key = _date_key(group, day, tuple(hours))
                elif position_series:
                    if vehicles and key == (None,):
                        continue
                    key = _date_key(group, window.included[offset], key)
                totals.setdefault(key, Batch()).update(part)

    # A line's published timetable establishes that an empty hour can have zero service.
    schedule_units = {
        (row.route_id, row.direction_id) for part in totals.values() for row in part.offered
    }
    cells = []
    columns = GROUP_COLUMNS[group]
    untracked = set(window.not_tracked)
    for key in _series_keys(question, group, set(totals)):
        cell_hour = key[-1] if hourly else question.hour
        assert cell_hour is None or isinstance(cell_hour, int)
        in_cut = (not hourly or question.hour is None or cell_hour == question.hour) and (
            group != "direction" or question.direction is None or key[0] == question.direction
        )
        included = [day for day in window.included if in_cut and matches_date(group, key, day)]
        cell_window = ReadWindow(
            {},
            measured=[day for day in included if not alerts or day not in untracked],
            included=included,
            not_tracked=[day for day in included if day in untracked],
        )
        part = totals.get(key, Batch()) if included else Batch()
        if offered:
            units = (
                sum(direction == key[0] for _, direction in schedule_units)
                if group == "direction"
                else len(schedule_units)
            )
            state, values, evidence, _ = _offered_answer(
                selected, part.offered, included, not included, cell_hour, units=units
            )
        else:
            if hourly and occupancy_days.intersection(included):
                part.counts["published_intervals"] = 1
            state, values, evidence, _ = evaluate(
                family, selected, part, cell_window, hour=cell_hour
            )
        cells.append(
            {
                "key": dict(zip(columns, key, strict=True)),
                "value": values,
                "state": state,
                "state_text": _STATES[state]._asdict(),
                "evidence": {
                    **evidence,
                    "days_included": [day for day in included if day not in untracked],
                },
            }
        )
    headings = {
        **{key: _GROUP_LABELS[key] for key in columns},
        **_csv_columns(family),
    }
    return {
        "measure": question.measure,
        "group": group,
        "cells": cells,
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


def _punctuality_answer(
    family: Family,
    selected: tuple[Measure, ...],
    counts: Counter[str],
    histogram: Counter[int],
    included: list[str],
    missing_days: bool,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
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
        bins = sorted(histogram.items())
        for measure in selected:
            values[measure.id] = (
                counts[measure.id] / classified
                if measure.percentile is None
                else _percentile(bins, classified, measure.percentile)
            )
    return (
        state,
        values,
        {
            "counts": {
                key: counts[key] if included else None
                for key in ("scheduled", "classified", *(m.id for m in family.measures if m.band))
            },
            "excluded": {
                key: counts[key] if included else None
                for key in _COUNTS
                if key not in ("scheduled", "classified")
            },
            "share_observed": classified / scheduled if scheduled else None,
        },
        dict.fromkeys((m.id for m in selected), classified),
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
    vehicle_counts = {
        "days_in_service": counts["days_in_service"],
        "hours_in_service": hours,
        "lines_run": len(totals.vehicle_routes),
        "trips_run": counts["trips_run"],
        "reporting_gaps": counts["reporting_gaps"],
        "silent_hours": counts["silent_us"] / _US_PER_HOUR,
        "unfinished_trips": counts["unfinished_trips"],
        "completion_sample": completion_sample,
    }
    excluded = {key: counts[key] for key in ("completion_capture_gap", "completion_unknown")}
    states = dict.fromkeys((m.id for m in selected), state)
    values: dict[str, float | None] = dict.fromkeys(states)
    samples = dict.fromkeys(states, 0)
    punctuality_selected = tuple(
        measure for measure in _PUNCTUALITY.measures if f"vehicle_{measure.id}" in states
    )
    timing_evidence: dict[str, int | None] = {}
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
        for key, value in timing_values.items():
            name = f"vehicle_{key}"
            states[name] = timing_state if tracked else state
            values[name] = value if tracked else None
            samples[name] = timing_samples[key]
    if tracked:
        for name in states.keys() - _VEHICLE_PUNCTUALITY_IDS:
            if name in _VEHICLE_COMPLETION_IDS:
                samples[name] = completion_sample
                if not completion_sample:
                    states[name] = "not_measured" if counts["completion_capture_gap"] else "unknown"
                elif name == "vehicle_unfinished_trips":
                    values[name] = counts["unfinished_trips"]
                else:
                    values[name] = 100 * counts["unfinished_trips"] / completion_sample
            elif name == VEHICLE_RANKING_DEFAULT:
                samples[name] = counts["service_us"]
                if hours:
                    values[name] = 100 * counts["reporting_gaps"] / hours
                else:
                    states[name] = "unknown"
            else:
                values[name] = vehicle_counts[name.removeprefix("vehicle_")]

    if not any(value is not None for value in values.values()):
        state = next(iter(states.values()))
    reporting_measured = tracked and any(m.id in _VEHICLE_REPORTING_IDS for m in selected)
    completion_measured = tracked and any(m.id in _VEHICLE_COMPLETION_IDS for m in selected)
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
                        "unfinished_trips",
                        "completion_sample",
                        "reporting_gaps",
                        "silent_hours",
                    }
                },
                "unfinished_trips": counts["unfinished_trips"] if completion_measured else None,
                "completion_sample": completion_sample if completion_measured else None,
                "reporting_gaps": counts["reporting_gaps"] if reporting_measured else None,
                "silent_hours": vehicle_counts["silent_hours"] if reporting_measured else None,
                **{
                    key: timing_evidence.get(key.removeprefix("punctuality_"))
                    for key in _VEHICLE_COLUMNS
                    if key.startswith("punctuality_")
                },
            },
            "excluded": {
                **{key: value if completion_measured else None for key, value in excluded.items()},
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
        },
        samples,
    )


def answer_csv(answer: dict[str, Any], language: Language) -> str:
    family, _ = _SELECTIONS[answer["measure"]]
    columns = _csv_columns(family)
    group = answer.get("group")
    if group:
        columns = {**{key: _GROUP_LABELS[key] for key in GROUP_COLUMNS[group]}, **columns}
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
        writer.writerow(
            json.dumps(row[name], ensure_ascii=False)
            if isinstance(row[name], (dict, list))
            else row[name]
            for name in columns
        )
    return output.getvalue()
