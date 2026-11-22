"""Declare measures here. Use ask() for answers and methods() for their definitions."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import InitVar, dataclass, field
from datetime import date
from time import perf_counter
from typing import Any, Literal, NamedTuple

import duckdb

from transit_engine.clean_manifest import SCHEDULED_STOP_TIMES, STOP_EVENTS, TRIP_DAYS
from transit_engine.store import CITY, Store

Language = Literal["en", "fr"]
EntityKind = Literal["line", "stop", "departure"]
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


@dataclass
class Batch:
    counts: Counter[str] = field(default_factory=Counter)
    histogram: Counter[int] = field(default_factory=Counter)
    departures: list[Departure] = field(default_factory=list)
    scheduled_routes: set[str] = field(default_factory=set)

    def update(self, other: Batch) -> None:
        self.counts.update(other.counts)
        self.histogram.update(other.histogram)
        self.departures.extend(other.departures)
        self.scheduled_routes.update(other.scheduled_routes)


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


_HISTOGRAM = Text(
    f"Bins are {DELAY_BIN_SECONDS} seconds wide, starting at multiples of "
    f"{DELAY_BIN_SECONDS} seconds with the lower edge included. Cumulative counts locate "
    "the two ranks for the percentile, then we interpolate between the midpoints of "
    "their bins. The error is at most half a bin.",
    f"Les classes ont une largeur de {DELAY_BIN_SECONDS} secondes. Elles commencent aux "
    f"multiples de {DELAY_BIN_SECONDS} secondes, borne inférieure incluse. Les effectifs "
    "cumulés situent les deux rangs du centile, puis on interpole entre les milieux des "
    "classes correspondantes. L’erreur est d’au plus une demi-classe.",
)

_STATES = {
    "measured": Text("Measured", "Mesuré"),
    "no_live_data": Text("No live data", "Aucune donnée en direct"),
    "not_measured": Text("Not measured", "Non mesuré"),
    "too_few_to_judge": Text("Too few to judge", "Trop peu de données pour conclure"),
    "unknown": Text("Unknown", "Inconnu"),
}
_PARTIAL = Text("Only measured days are included.", "Seuls les jours mesurés sont inclus.")
# Both supported cities use the same service timezone. Departures reverse the
# GTFS local-noon-minus-12-elapsed-hours anchor used by the cleaner, even on DST days.
_LOCAL_HOUR = "hour(timezone('America/Toronto', {}))"
_DEPARTURE_SECONDS = """
    epoch(scheduled_start_utc)
    - epoch(timezone('America/Toronto', service_date + INTERVAL '12 hours')) + 43200
"""
_DAY_TYPES = ("weekday", "weekday", "weekday", "weekday", "weekday", "saturday", "sunday")
_SERVICE_DELIVERED_ID = "service_delivered"
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

    def __post_init__(self, ranking: bool) -> None:
        if self.measure not in _SELECTIONS:
            raise ValueError("unknown measure")
        if not CITY.fullmatch(self.city) or self.start > self.end:
            raise ValueError("provide a city and an ordered service date range")
        family, _ = _SELECTIONS[self.measure]
        if family.id == _SERVICE_DELIVERED_ID and self.stop is not None:
            raise ValueError("stop does not apply to service delivered trip measures")
        if self.measure in _BOUNDARIES:
            if (self.line is None and not ranking) or self.day_type is None:
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
_UNIT_LABELS = {"share": Text("Share", "Part"), "seconds": Text("Seconds", "Secondes")}


def _info(family: Family, measure: Measure) -> dict[str, Any]:
    return {
        "id": measure.id,
        "family": family.id,
        "unit": measure.unit,
        "method_version": family.method_version,
        "since": family.since,
        "tables": (*family.tables, *measure.extra_tables),
        "minimum_sample": family.minimum_sample,
        "evidence_fields": [
            *(
                key
                for key in _EVIDENCE_COLUMNS
                if family.id != _SERVICE_DELIVERED_ID or key != "share_observed"
            ),
            "counts",
            "excluded",
            *(_DELIVERY_EVIDENCE if family.id == _SERVICE_DELIVERED_ID else ()),
        ],
        "csv_columns": {
            lang: [getattr(label, lang) for label in _csv_columns(family).values()]
            for lang in ("en", "fr")
        },
        "text": {
            lang: {
                "definition": getattr(measure.definition, lang),
                "unit": getattr(_UNIT_LABELS[measure.unit], lang),
                "counts": getattr(measure.counts or family.counts, lang),
                "exclusions": getattr(family.exclusions, lang),
                "limits": getattr(measure.limits or family.limits, lang),
                **({"histogram": getattr(_HISTOGRAM, lang)} if measure.percentile else {}),
            }
            for lang in ("en", "fr")
        },
    }


def _csv_columns(family: Family) -> dict[str, Text]:
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


def _cuts(question: Question, hour_sql: str) -> tuple[str, list[object]]:
    filters = []
    parameters: list[object] = []
    for name, value in question.cuts().items():
        expression = {
            "line": "route_id",
            "direction": "direction_id",
            "stop": "stop_id",
            "departure": _DEPARTURE_SECONDS,
            "hour": hour_sql,
        }.get(name)
        if expression is not None:
            filters.append(f"({expression}) = ?")
            if name == "departure":
                hour, minute, second = map(int, str(value).split(":"))
                parameters.append(hour * 3600 + minute * 60 + second)
            else:
                parameters.append(value)
    return " AND ".join(filters) or "true", parameters


def _entity_sql(group: EntityKind | None) -> str:
    return {
        None: "row(NULL::VARCHAR)",
        "line": "row(route_id)",
        "stop": "row(stop_id)",
        "departure": f"row(route_id, direction_id, ({_DEPARTURE_SECONDS})::BIGINT)",
    }[group]


def _grouped_batches(
    rows: list[tuple[Any, ...]], counters: dict[str, str], sample: str, group: EntityKind | None
) -> dict[EntityKey, Batch]:
    groups: dict[EntityKey, Batch] = {}
    for key, edge, routes, *values in rows:
        result = groups.setdefault(tuple(key) if group else (), Batch())
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
    cut_sql, filters = _cuts(question, _LOCAL_HOUR.format("scheduled_stop_utc"))
    parameters = [
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
    if group and all(measure.percentile is None for measure in _SELECTIONS[question.measure][1]):
        edge = "NULL::BIGINT"
    rows = conn.execute(
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
        )
        SELECT {_entity_sql(group)} AS entity,
            {edge} AS lower_edge, {routes}, {aggregates}
        FROM events WHERE {cut_sql}
        GROUP BY entity, lower_edge
        """,
        parameters,
    ).fetchall()
    return _grouped_batches(rows, counters, "classified", group)


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
    cut_sql, filters = _cuts(question, _LOCAL_HOUR.format("scheduled_start_utc"))
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
    rows = conn.execute(
        f"""
        WITH trips AS ({trips_sql}), durations AS ({duration_sql})
        SELECT {_entity_sql(group)} AS entity,
            floor(lead_seconds / {DELAY_BIN_SECONDS})::BIGINT * {DELAY_BIN_SECONDS}
                AS lower_edge, {routes}, {aggregates}
        FROM durations
        GROUP BY entity, lower_edge
        """,
        [*parameters, *duration_params],
    ).fetchall()
    groups = _grouped_batches(rows, counters, "cancellation_notices", group)
    boundaries = question.line if group is None else question.measure in _BOUNDARIES
    if boundaries and question.day_type and question.hour is None and question.departure is None:
        route_partition = ", route_id" if group == "line" else ""
        edges = conn.execute(
            f"""
            WITH trips AS ({trips_sql}), scheduled AS (
                SELECT *, ({_DEPARTURE_SECONDS})::BIGINT AS departure_seconds
                FROM trips WHERE state <> 'added'
            ), bounds AS (
                SELECT *, min(departure_seconds) OVER day AS first_start,
                    max(departure_seconds) OVER day AS last_start
                FROM scheduled
                WINDOW day AS (PARTITION BY service_date{route_partition})
            )
            SELECT {_entity_sql(group)} AS entity, measure, service_date, departure_seconds,
                count(*),
                count(*) FILTER (eligible), count(*) FILTER (state = 'ran'),
                count(*) FILTER (state = 'unconfirmed'),
                count(*) FILTER (without_live_data), count(*) FILTER (capture_gap)
            FROM bounds, LATERAL (VALUES ('first_trip', first_start), ('last_trip', last_start))
                AS edge(measure, start_seconds)
            WHERE departure_seconds = start_seconds
            GROUP BY entity, measure, service_date, departure_seconds
            ORDER BY service_date, measure
            """,
            parameters,
        ).fetchall()
        for key, measure, day, seconds, *counts in edges:
            hour, remainder = divmod(seconds, 3600)
            minute, second = divmod(remainder, 60)
            groups[tuple(key) if group else ()].departures.append(
                Departure(
                    measure, day.isoformat(), f"{hour:02d}:{minute:02d}:{second:02d}", *counts
                )
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

_FAMILIES = (_PUNCTUALITY, _SERVICE_DELIVERED)
_SELECTIONS = {
    key: (family, selected)
    for family in _FAMILIES
    for key, selected in (
        (family.id, family.measures),
        *((measure.id, (measure,)) for measure in family.measures),
    )
}


def _percentile(histogram: list[tuple[int, int]], count: int, percentile: int) -> float:
    # Zero-based ranks for a continuous percentile using each bin's midpoint.
    rank, remainder = divmod((count - 1) * percentile, 100)
    seen = 0
    lower_midpoint = None
    for edge, occurrences in histogram:
        midpoint = edge + DELAY_BIN_SECONDS / 2
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

    @property
    def no_days_measured(self) -> bool:
        return not self.measured or (self.missing_in_cut and not self.included)

    @property
    def coverage_note(self) -> dict[str, str] | None:
        return _PARTIAL._asdict() if self.measured and self.missing else None

    def batches(self) -> Iterator[dict[str, list[str]]]:
        for offset in range(0, len(self.included), DAYS_PER_QUERY_BATCH):
            yield {
                table: files[offset : offset + DAYS_PER_QUERY_BATCH]
                for table, files in self.paths.items()
            }

    def evidence(
        self, store: Store, question: Question, family: Family, started: float
    ) -> dict[str, Any]:
        return {
            "city": question.city,
            "start_date": question.start.isoformat(),
            "end_date": question.end.isoformat(),
            "cuts": question.cuts(),
            "days_measured": self.measured,
            "days_not_measured": self.missing,
            "days_included": self.included,
            "cleaning_versions": [store.cleaning_version] if self.included else [],
            "method_version": family.method_version,
            "query_ms": (perf_counter() - started) * 1000,
        }


def read_window(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
) -> ReadWindow:
    tables = tuple(
        dict.fromkeys((*family.tables, *(table for m in selected for table in m.extra_tables)))
    )
    window = ReadWindow({table: [] for table in tables})
    for ordinal in range(question.start.toordinal(), question.end.toordinal() + 1):
        day = date.fromordinal(ordinal)
        in_cut = question.day_type is None or question.day_type == _DAY_TYPES[day.weekday()]
        files = store.files(conn, question.city, day, tables)
        if files is None:
            window.missing.append(day.isoformat())
            window.missing_in_cut |= in_cut
        else:
            window.measured.append(day.isoformat())
            if in_cut:
                window.included.append(day.isoformat())
                for table, path in zip(tables, files, strict=True):
                    window.paths[table].append(path)
    return window


def evaluate(
    family: Family,
    selected: tuple[Measure, ...],
    totals: Batch,
    included: list[str],
    missing_days: bool,
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    if family.id == _SERVICE_DELIVERED_ID:
        return _delivery_answer(
            family,
            selected,
            totals.counts,
            totals.histogram,
            totals.departures,
            included,
            missing_days,
        )
    return _punctuality_answer(
        family, selected, totals.counts, totals.histogram, included, missing_days
    )


def ask(store: Store, question: Question) -> dict[str, Any]:
    """Read validated days and compute the selected measure or family with its evidence."""
    started = perf_counter()
    family, selected = _SELECTIONS[question.measure]
    totals = Batch()
    with store.connect() as conn:
        window = read_window(conn, store, question, family, selected)
        for batch in window.batches():
            result = family.query(conn, family, batch, question, str(store.cleaning_version), None)
            if () in result:
                totals.update(result[()])
    state, values, family_evidence, _ = evaluate(
        family, selected, totals, window.included, window.no_days_measured
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


def answer_csv(answer: dict[str, Any], language: Language) -> str:
    family, _ = _SELECTIONS[answer["measure"]]
    columns = _csv_columns(family)
    evidence = answer["evidence"]
    common = {**evidence, **evidence["counts"], **evidence["excluded"]}
    common["coverage_note"] = (answer["coverage_note"] or {}).get(language)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(getattr(label, language) for label in columns.values())
    for measure in answer["info"]:
        key = measure["id"]
        state = evidence.get("measure_states", {}).get(key, answer["state"])
        row = {
            **common,
            "state": getattr(_STATES[state], language),
            "measure": key,
            "unit": measure["text"][language]["unit"],
            "value": answer["value"][key],
        }
        writer.writerow(
            json.dumps(row[name], ensure_ascii=False)
            if isinstance(row[name], (dict, list))
            else row[name]
            for name in columns
        )
    return output.getvalue()
