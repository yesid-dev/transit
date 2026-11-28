"""Declare measures here. Use ask() for answers and methods() for their definitions."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from dataclasses import InitVar, dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from functools import partial as bind
from hashlib import sha256
from itertools import batched
from time import perf_counter
from typing import Any, Literal, NamedTuple

import duckdb

from transit_engine.cancellation import check_query, track_connection
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
    SEGMENT_RUNS_VERSION,
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
    clear_run_times,
)
from transit_engine.histogram import DELAY_BIN_SECONDS as DELAY_BIN_SECONDS
from transit_engine.histogram import percentile as _percentile
from transit_engine.notice_reissues import (
    NoticeKey,
    NoticeVariant,
    notice_text,
    translation_reissues,
)
from transit_engine.schedule import (
    BUNCHING_FRACTION,
    FREQUENT_HEADWAY_SECONDS,
    FREQUENT_SPAN_SECONDS,
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
from transit_engine.stretches import MIN_PASSES as MIN_STRETCH_PASSES
from transit_engine.stretches import Cut as StretchCut
from transit_engine.stretches import (
    month_rollup,
    remote_stretches,
    stretch_day,
    stretch_readings,
)
from transit_engine.vehicles import (
    MIN_REPORTING_SILENCE_MINUTES,
    MIN_STABLE_ID_READINGS,
    MIN_STABLE_READING_SHARE,
    MIN_VEHICLE_RANKING_HOURS,
    MIN_VEHICLE_TERMINUS_SHARE,
    TRACKED_VEHICLES_SQL,
    VEHICLE_COUNTS,
    vehicle_cadence_join,
    vehicle_cadence_sql,
    vehicle_duration_us_sql,
    vehicle_end_sql,
    vehicle_gap_us_sql,
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

    @property
    def publication(self) -> NoticeKey:
        return self.source, self.alert_id, self.version


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
    alert_variants: dict[NoticeKey, NoticeVariant] = field(default_factory=dict)
    alert_messages: dict[NoticeKey, dict[str, Any]] = field(default_factory=dict)
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
        self.alert_variants.update(other.alert_variants)
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


def _fr_pct(value: float) -> str:
    return f"{round(value * 100)}\u00a0%"


def _histogram_text(seconds: int) -> Text:
    return Text(
        f"Percentiles come from {seconds}-s bins starting at multiples of {seconds} s "
        "(lower edge included). Cumulative counts locate the two ranks for the percentile, "
        "then Transit interpolates between their bin midpoints, within half a bin of the "
        "exact sample value.",
        f"Les centiles sont calculés à partir de classes de {seconds}\u00a0s commençant aux "
        f"multiples de {seconds}\u00a0s, borne inférieure incluse. Les effectifs cumulés "
        "situent les deux rangs du centile, puis Transit interpole entre les milieux des "
        "classes correspondantes, à au plus une demi-classe de la valeur exacte.",
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
_CLEAR_RUN_ID = "clear_run"
CLEAR_RUN_TIME_LOST = "clear_run_time_lost"
_STRETCH_ID = "stretch_timing"
STRETCH_TIME_LOST = "stretch_time_lost"
STRETCH_CLEAR_RUN_SPEED = "stretch_clear_run_speed"
STRETCH_MEASURES = frozenset((_STRETCH_ID, STRETCH_TIME_LOST, STRETCH_CLEAR_RUN_SPEED))
CORRIDOR_RANKING_DEFAULT = "median_time_lost"
_ACCESSIBILITY_ID = "accessibility"
_DELAY_DISTRIBUTION_ID = "delay_distribution"
_DELAY_MINUTE_SECONDS = 60
_DELAY_TAIL_START = -5 * _DELAY_MINUTE_SECONDS
_DELAY_TAIL_END = 15 * _DELAY_MINUTE_SECONDS
VEHICLE_RANKING_DEFAULT = "vehicle_reporting_gaps_per_100_hours"
_BOUNDARIES = ("first_trip", "last_trip")


class NetworkCorridorsUnavailable(Exception):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


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
    include_overall: bool = False
    lines: tuple[str, ...] = ()
    route_type: int | None = None
    time_band: str | None = None
    hour_from: int | None = None
    hour_to: int | None = None

    def __post_init__(self, ranking: bool) -> None:
        if self.measure not in _SELECTIONS:
            raise ValueError("unknown measure")
        if not CITY.fullmatch(self.city) or self.start > self.end:
            raise ValueError("provide a city and an ordered service date range")
        family, _ = _SELECTIONS[self.measure]
        if (
            self.measure in STRETCH_MEASURES or self.measure == CLEAR_RUN_TIME_LOST
            or self.group in ("line_stop", "stretch")
        ):
            if not self.layer_map:
                raise ValueError("clear runs and waits by line and stop require their map view")
        map_readings = self.map_view and (self.measure, self.group) in {
            ("late", "stop_id"),
            ("mean_time_lost", "segment"),
        }
        layer_cuts = {"lines", "route_type", "time_band", "hour_from", "hour_to"}
        if self.layer_map or map_readings:
            allowed = layer_cuts | {"line", "direction", "hour", "day_type"}
            if self.group == "line_stop":
                allowed.add("stop")
            if self.cuts().keys() - allowed:
                raise ValueError("invalid map layer cut")
            if self.line is not None and self.lines:
                raise ValueError("choose line or lines")
            if self.route_type is not None and not 0 <= self.route_type <= 9999:
                raise ValueError("invalid route_type")
            if self.time_band is not None and (
                self.time_band != "all" and self.time_band not in {period.id for period in PERIODS}
            ):
                raise ValueError("invalid time_band")
            has_range = self.hour_from is not None or self.hour_to is not None
            if has_range and (
                self.hour_from is None
                or self.hour_to is None
                or not (0 <= self.hour_from <= 23 and 0 <= self.hour_to <= 24)
                or self.hour_from == self.hour_to
            ):
                raise ValueError("provide different start and end hours")
            if (
                self.layer_map and self.measure not in STRETCH_MEASURES
                and self.hour_from is not None and self.hour_to is not None
                and self.hour_from > self.hour_to
            ):
                raise ValueError("clear runs and waits require hours in the same day")
            if sum((has_range, self.hour is not None, self.time_band is not None)) > 1:
                raise ValueError("choose hour, time_band, or a custom hour range")
        elif self.cuts().keys() & layer_cuts:
            raise ValueError("layer filters require a map reading")
        if self.measure == _DELAY_DISTRIBUTION_ID and (ranking or self.group is not None):
            raise ValueError("delay_distribution requires an ungrouped measure")
        if self.include_overall and not (
            self.measure == _VEHICLES_ID and self.group == "day" and self.vehicle is not None
        ):
            raise ValueError("include_overall requires vehicles by day for one vehicle")
        if self.map_view and not (self.layer_map or map_readings):
            raise ValueError("map view requires a supported map reading")
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
            if family.query is None and family.id != _STRETCH_ID:
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
        if self.measure in _BOUNDARIES:
            if self.stop is not None:
                raise ValueError("first and last departures do not support a stop cut")
            if (self.line is None and not ranking) or (
                self.day_type is None and self.group is None
            ):
                raise ValueError("first and last trip require line and day_type")
            if self.hour is not None or self.departure is not None:
                raise ValueError("first and last trip use the full day, without hour or departure")
        if self.departure is not None and (self.line is None or self.direction is None):
            raise ValueError("departure requires line and direction")

    @property
    def network_corridors(self) -> bool:
        return (
            self.map_view and self.measure == "mean_time_lost"
            and self.group == "segment" and self.line is None
        )

    @property
    def layer_map(self) -> bool:
        return self.map_view and (
            (self.measure == CLEAR_RUN_TIME_LOST and self.group == "segment")
            or (self.measure in STRETCH_MEASURES and self.group == "stretch")
            or (self.measure == "excess_wait_time" and self.group == "line_stop")
        )

    def layer_hours(self) -> tuple[int, int] | None:
        if self.hour_from is not None and self.hour_to is not None:
            return self.hour_from, self.hour_to
        if self.time_band is not None:
            return next(
                ((p.start_hour, p.end_hour) for p in PERIODS if p.id == self.time_band), None
            )
        if self.hour is not None:
            return (self.hour, self.hour + 1) if self.measure in STRETCH_MEASURES else None
        timed = self.measure == CLEAR_RUN_TIME_LOST or self.measure in STRETCH_MEASURES
        return (6, 24) if timed else None

    def cuts(self) -> dict[str, str | int | tuple[str, ...]]:
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
            "lines": self.lines or None,
            "route_type": self.route_type,
            "time_band": self.time_band,
            "hour_from": self.hour_from,
            "hour_to": self.hour_to,
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
    "weekday": Text("Service weekday", "Jour de la semaine de service"),
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
    "km_per_hour": Text("Kilometres per hour", "Kilomètres par heure"),
    "periods": Text("Periods", "Périodes"),
    "per_100_vehicle_hours": Text("Per 100 vehicle-hours", "Par 100 heures-véhicules"),
    "per_100_trips": Text("Per 100 trips", "Par 100 trajets"),
}


_RANKING_FLOOR_LABELS = {
    "classified": Text("observed stop events", "passages observés aux arrêts"),
    "observed_trips": Text("observed trips", "trajets observés"),
    "observed_service_dates": Text("observed service dates", "dates de service observées"),
    "observed_trip_pairs": Text("distinct trip pairs", "paires de trajets distinctes"),
    "observed_headways": Text("observed intervals", "intervalles observés"),
    "occupancy_vehicle_hours": Text(
        "vehicle-hours with occupancy", "heures-véhicules avec occupation"
    ),
    "eligible": Text("eligible trips", "trajets admissibles"),
}
_RANKING_FLOOR_KINDS = {
    "line": Text("Line rankings", "Les classements par ligne"),
    "stop": Text("Stop rankings", "Les classements par arrêt"),
    "departure": Text("Departure rankings", "Les classements par départ"),
}

_ALERT_MESSAGE_COLUMN = {
    "alert_messages": Text("Agency messages", "Avis de la société de transport")
}
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
            f"{limits.fr} Sous {_fr_pct(minimum)} de couverture, le résultat est non mesuré. "
            f"Sous {_fr_pct(warning)}, les données signalent une faible couverture.",
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
            f"{limits.fr} Le préavis médian d’annulation exige au moins "
            f"{MIN_CANCELLATION_NOTICES} avis.",
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
        per_hours = measure.unit in {"per_100_hours", "per_100_vehicle_hours"}
        limits = Text(
            f"{limits.en} This rate requires at least {measure.minimum_sample} "
            f"{'vehicle-hours' if per_hours else 'assessed trips'}.",
            f"{limits.fr} Ce taux exige au moins {measure.minimum_sample} "
            f"{'heures-véhicules' if per_hours else 'trajets évalués'}.",
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
        {
            **_info(
                family,
                measure,
                _DELAY_DISTRIBUTION_COLUMNS if measure is _DELAY_DISTRIBUTION else None,
            ),
            "family_text": {"en": family.label.en, "fr": family.label.fr},
        }
        for family in _FAMILIES
        for measure in (
            (*family.measures, _DELAY_DISTRIBUTION) if family is _PUNCTUALITY else family.measures
        )
    ]


def _cuts(
    question: Question, hour_sql: str | None, *, departure_sql: str = _DEPARTURE_SECONDS
) -> tuple[str, list[object]]:
    filters = []
    parameters: list[object] = []
    for name, value in question.cuts().items():
        if name == "lines":
            filters.append("route_id = ANY(?)")
            parameters.append(list(value) if isinstance(value, tuple) else value)
            continue
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
    if question.map_view and hour_sql is not None and (hours := question.layer_hours()):
        start, end = hours
        joiner = "AND" if start < end else "OR"
        filters.append(f"(({hour_sql}) >= ? {joiner} ({hour_sql}) < ?)")
        parameters.extend(hours)
    return " AND ".join(filters) or "true", parameters


def _trip_type_cut(
    question: Question, version: str, paths: dict[str, list[str]]
) -> tuple[str, list[object]]:
    if question.route_type is None:
        return "", []
    if int(version) < 6:
        return "AND false", []
    return """
        AND EXISTS (
            SELECT 1 FROM read_parquet(?, hive_partitioning = false) t
            WHERE t.provider = s.provider AND t.cleaning_version = s.cleaning_version
                AND t.service_date = s.service_date AND t.trip_id = s.trip_id
                AND t.route_type = ?
        )
    """, [paths[TRIP_DAYS], question.route_type]


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
    type_cut, type_parameters = (
        _trip_type_cut(question, version, paths) if clean_events else ("", [])
    )
    parameters: list[object] = [paths[STOP_EVENTS], *scope, *type_parameters, *filters]
    if not clean_events:
        trip_parameters: list[object] = [
            paths[TRIP_DAYS], *scope, *([question.line] if trip_cut else [])
        ]
        if question.route_type is not None:
            if int(version) >= 6:
                trip_cut += " AND route_type = ?"
                trip_parameters.append(question.route_type)
            else:
                trip_cut += " AND false"
        parameters[:0] = trip_parameters
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
    distribution = question.measure == _DELAY_DISTRIBUTION_ID
    with_histogram = distribution or (for_vehicles and question.group is None) or any(
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
    stop_scan = f"""
        FROM read_parquet(?, hive_partitioning = false) s
        WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
        {type_cut}
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
    # The Lines list applies the ranking floors itself, so the network-wide line series
    # carries the same observed-trip count a line ranking reads.
    line_series = (
        group is None
        and question.group == "line"
        and question.stop is None
        and question.line is None
        and clean_events
        and by_delay_bin
        and not for_vehicles
    )
    if group in {"line", "departure"} or line_series:
        sample_key = (
            "observed_trips" if group == "line" or line_series else "observed_service_dates"
        )
        distinct = "service_date" if group == "departure" else "(service_date, trip_id)"
        counters[sample_key] = ""
        ctes += f""", ranking_samples AS (
            SELECT {entity} AS sample_entity, count(DISTINCT {distinct}) AS ranking_sample
            FROM events
            WHERE {cut_sql} AND scheduled AND NOT capture_gap AND delay_seconds IS NOT NULL
            GROUP BY sample_entity
        )"""
        parameters.extend(filters)
        # The series rolls its bins up by the entity column, not the route column.
        ranking_join = (
            "LEFT JOIN ranking_samples ON entity = sample_entity"
            if line_series
            else f"LEFT JOIN ranking_samples ON ({entity}) = sample_entity"
        )
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
        if distribution:
            # Whole-minute bins share the punctuality cut: exactly +300 s
            # closes the last on-time bin, and +301 s opens the first late bin.
            delay_bucket = (
                f"WHEN delay_seconds < {_DELAY_TAIL_START} "
                f"THEN {_DELAY_TAIL_START - _DELAY_MINUTE_SECONDS} "
                f"WHEN delay_seconds >= {_DELAY_TAIL_END} THEN {_DELAY_TAIL_END} "
                f"WHEN delay_seconds = {LATE_LIMIT_SECONDS} "
                f"THEN {LATE_LIMIT_SECONDS - _DELAY_MINUTE_SECONDS} "
                f"ELSE floor(delay_seconds::DOUBLE / {_DELAY_MINUTE_SECONDS})::BIGINT "
                f"* {_DELAY_MINUTE_SECONDS}"
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
        "Each scheduled stop on each trip counts once, and each share is out of the "
        "stops with a measured delay. Negative values mean early; positive values mean late. "
        "Long trips and frequent lines carry more weight because each stop counts once, and "
        "multi-day totals pool stop events so busier weekdays weigh more. The whole record "
        "was recomputed with this method on 22 November 2026. The archived timetable and trip "
        "timing assign the service day, including trips that cross midnight. "
        "At a trip’s first stop, departure is taken from the last nearby "
        "stopped report before the vehicle is seen further along. When a feed never reports "
        "vehicles as stopped during the day’s capture window, arrival is estimated when "
        "consecutive GPS fixes at most 160 s apart cross into 50 m of the stop, and first-stop "
        "departure uses the last fix within 50 m before the vehicle reaches a later stop. "
        "Without a qualifying vehicle observation, Transit uses an exact agency time or the "
        "last prediction before confirmed passage.",
        "Chaque arrêt prévu de chaque trajet compte une fois, et chaque part se calcule "
        "sur les arrêts dont le retard a été mesuré. Un nombre négatif indique une "
        "avance et un nombre positif, un retard. Les trajets longs et les lignes fréquentes "
        "pèsent davantage parce que chaque arrêt compte une fois, et les totaux sur plusieurs "
        "jours regroupent les passages, donc les journées plus achalandées pèsent plus lourd. "
        "Tout le bilan a été recalculé avec cette méthode le 22 novembre 2026. L’horaire "
        "archivé et les heures du trajet déterminent le jour de service, même après minuit. "
        "Au premier arrêt, le départ correspond au dernier "
        "relevé du véhicule immobilisé à proximité avant qu’il soit vu plus loin. Si un flux "
        "ne signale aucun véhicule à l’arrêt pendant la collecte du jour de service, l’arrivée "
        "est estimée lorsque deux positions GPS espacées d’au plus 160\u00a0s entrent dans un "
        "rayon de 50\u00a0m de l’arrêt, et le départ au premier arrêt utilise la dernière "
        "position dans ce rayon avant qu’il soit vu à un arrêt suivant. Sans observation valide "
        "du véhicule, Transit utilise une heure exacte de la société de transport ou la "
        "dernière prévision avant le passage confirmé.",
    ),
    exclusions=Text(
        "Added trips, cancelled trips and lines without live data are left out of every rate. "
        "Scheduled stops without a measured delay stay in the scheduled count. An unobserved "
        "stop is marked as a capture gap when any required live feed lacked continuous "
        "capture at its scheduled time.",
        "Les trajets ajoutés, les trajets annulés et les lignes sans données en direct sont "
        "exclus de tous les taux. Les arrêts prévus sans retard mesuré restent dans le total "
        "prévu. Un arrêt non observé est marqué comme touché par "
        "une interruption si la collecte d’un flux requis n’était pas continue à l’heure prévue.",
    ),
    limits=Text(
        "It cannot tell how long riders waited, how many people were on board or why a vehicle "
        "was early or late. Results cover measured days only, and a small sample can be "
        "dominated by a few stops.",
        "Elle ne dit pas combien de temps les usagers ont attendu, combien de personnes "
        "étaient à bord ni pourquoi un véhicule était en avance ou en retard. Le résultat "
        "porte seulement sur les jours mesurés, et quelques arrêts peuvent peser lourd dans "
        "un petit échantillon.",
    ),
    measures=(
        Measure(
            "early",
            "share",
            Text(
                f"Share of measured stops more than {abs(EARLY_LIMIT_SECONDS) // 60} minute early.",
                "Part des arrêts mesurés avec plus d’une minute d’avance.",
            ),
            band=f"delay_seconds < {EARLY_LIMIT_SECONDS}",
            count_label=Text("Early stops", "Arrêts en avance"),
            worst_first_descending=True,
        ),
        Measure(
            "on_time",
            "share",
            Text(
                f"Share of measured stops from {abs(EARLY_LIMIT_SECONDS) // 60} minute early to "
                f"{LATE_LIMIT_SECONDS // 60} minutes late, including both limits.",
                f"Part des arrêts mesurés entre {abs(EARLY_LIMIT_SECONDS) // 60} minute d’avance "
                f"et {LATE_LIMIT_SECONDS // 60} minutes de retard, limites incluses.",
            ),
            band=f"delay_seconds BETWEEN {EARLY_LIMIT_SECONDS} AND {LATE_LIMIT_SECONDS}",
            count_label=Text("On-time stops", "Arrêts à l’heure"),
        ),
        Measure(
            "late",
            "share",
            Text(
                f"Share of measured stops more than {LATE_LIMIT_SECONDS // 60} minutes late.",
                f"Part des arrêts mesurés avec plus de {LATE_LIMIT_SECONDS // 60} minutes "
                "de retard.",
            ),
            band=f"delay_seconds > {LATE_LIMIT_SECONDS}",
            count_label=Text("Late stops", "Arrêts en retard"),
            worst_first_descending=True,
        ),
        Measure(
            "median_delay",
            "seconds",
            Text(
                "Middle delay across measured stops: half were at or below it, half at or above.",
                "Retard médian aux arrêts mesurés\u00a0: la moitié des passages étaient à ce "
                "niveau ou en dessous, l’autre moitié au-dessus.",
            ),
            percentile=50,
            worst_first_descending=True,
        ),
        Measure(
            "p90_delay",
            "seconds",
            Text(
                "Delay at or below which about 9 in 10 measured stops fall.",
                "Retard que ne dépassent pas environ 90\u00a0% des arrêts mesurés.",
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
    trip_cut = replace(question, stop=None) if question.stop is not None else question
    cut_sql, filters = _cuts(trip_cut, hour_sql)
    scope = [question.city, version, question.start, question.end]
    stop_join = ""
    stop_params: list[object] = []
    if question.stop is not None:
        # A scheduled trip's stop rows keep its timetable, including untimed calls.
        # A semi join keeps one trip instance even if it calls at the stop twice.
        stop_join = f"""
            SEMI JOIN (
                SELECT service_date, trip_id FROM read_parquet(?, hive_partitioning = false)
                WHERE {window} AND stop_id = ?
            ) stops USING (service_date, trip_id)
        """
        stop_params = [paths[STOP_EVENTS], *scope, question.stop]
    trips_sql = f"""
        SELECT service_date, trip_id, route_id, direction_id, scheduled_start_utc, state,
            route_has_live_data,
            state_reason IS NOT DISTINCT FROM 'route_without_live_data' AS without_live_data,
            state_reason IS NOT DISTINCT FROM 'capture_gap' AS capture_gap,
            state IN ('ran', 'cancelled', 'missing') AS eligible,
            CASE WHEN state = 'cancelled'
                THEN epoch(scheduled_start_utc - cancellation_notice_utc) END AS lead_seconds
        FROM read_parquet(?, hive_partitioning = false) {stop_join}
        WHERE {window} AND {cut_sql}
    """
    parameters = [paths[TRIP_DAYS], *stop_params, *scope, *filters]
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
    boundaries = question.stop is None and (
        question.line is not None if group is None else question.measure in _BOUNDARIES
    )
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
    "Counts how often the day’s first or last scheduled departure ran for a chosen line and "
    "day type. All trips tied at that scheduled time count, and at least "
    f"{MIN_SERVICE_DELIVERED_TRIPS} eligible trips are required. Evidence lists the "
    "scheduled departure time and run counts by date.",
    "Compte à quelle fréquence le premier ou le dernier départ prévu de la journée a été "
    "effectué pour une ligne et un type de jour choisis (avec une direction au besoin). "
    "Tous les trajets prévus à cette heure comptent, et il faut au moins "
    f"{MIN_SERVICE_DELIVERED_TRIPS} trajets admissibles. Les données indiquent l’heure "
    "prévue et les trajets effectués par date.",
)
_BOUNDARY_LIMITS = Text(
    "It cannot tell the exact time the trip actually departed, only whether it was confirmed. "
    "Dates with no scheduled departure add no trip.",
    "Elle ne révèle pas l’heure réelle du départ, seulement s’il a été confirmé. Les dates "
    "sans départ prévu n’ajoutent aucun trajet.",
)
_STOP_DELIVERY_COUNTS = Text(
    "For this stop, each trip scheduled to call here counts once, even if it calls twice. "
    "An outcome applies to the whole trip. A trip that ran may have been confirmed "
    "at another stop.",
    "Ce bilan compte une fois chaque trajet dont l’horaire prévoit un passage à cet arrêt, même "
    "s’il y passe deux fois. L’issue s’applique au trajet entier. Un trajet effectué peut avoir "
    "été confirmé à un autre arrêt.",
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
        "Each scheduled trip counts once, and rates use trips whose outcome is known: "
        "ran, cancelled or missing. A trip counts as having run if at least one stop was "
        f"confirmed. At least {MIN_SERVICE_DELIVERED_TRIPS} trips with a known outcome are "
        "needed so one trip cannot move the share by more than five percentage points.",
        "Chaque trajet prévu compte une fois, et les taux utilisent les trajets dont l’issue "
        "est connue\u00a0: effectué, annulé ou manquant. Un trajet est compté comme effectué "
        f"s’il a au moins un arrêt confirmé. Il faut au moins {MIN_SERVICE_DELIVERED_TRIPS} "
        "trajets dont l’issue est connue pour qu’un seul trajet ne déplace pas la part de "
        "plus de cinq points de pourcentage.",
    ),
    exclusions=Text(
        "Added trips, lines without live data, capture gaps and unconfirmed trips stay out of "
        "the rate and are shown separately. Unconfirmed trips appeared in the feed without a "
        "confirmed stop, so they count as neither run nor missing.",
        "Les trajets ajoutés, les lignes sans données en direct, les interruptions de la "
        "collecte et les trajets non confirmés sont exclus du taux et présentés à part. Les "
        "trajets non confirmés ont été vus sans arrêt confirmé; ils ne sont donc comptés ni "
        "comme effectués ni comme manquants.",
    ),
    limits=Text(
        "It cannot tell whether a trip served every scheduled stop or how many riders were on "
        "board.",
        "Elle ne dit pas si le trajet a desservi tous ses arrêts prévus ni combien d’usagers "
        "étaient à bord.",
    ),
    measures=(
        Measure(
            "trips_run",
            "share",
            Text(
                "Share of scheduled trips with a known outcome that ran.",
                "Part des trajets prévus à l’issue connue qui ont été effectués.",
            ),
            ratio=("ran", "eligible"),
        ),
        Measure(
            "cancelled_trips",
            "share",
            Text(
                "Share of scheduled trips with a known outcome that the agency marked cancelled.",
                "Part des trajets prévus à l’issue connue que la société de transport a marqués "
                "annulés.",
            ),
            counts=Text(
                "Counts cancelled trips and estimates the median advance notice before scheduled "
                "departure. Notice 30 minutes ahead is +30 minutes; negative offsets mark "
                "notices issued after scheduled start and are counted separately.",
                "Compte les trajets annulés et estime le préavis médian avant le départ prévu. "
                "Un avis donné 30 minutes à l’avance vaut +30 minutes; un délai négatif indique "
                "un avis publié après le départ prévu, compté à part.",
            ),
            limits=Text(
                "It cannot tell when riders saw the cancellation, only when the feed published "
                "it. Cancellations without a notice time have no lead time.",
                "Elle ne dit pas quand les usagers ont appris l’annulation, seulement quand le "
                "flux l’a publiée. Sans heure d’avis, le préavis ne peut pas être calculé.",
            ),
            percentile=50,
            ratio=("cancelled", "eligible"),
            worst_first_descending=True,
        ),
        Measure(
            "missing_trips",
            "share",
            Text(
                "Share of scheduled trips with a known outcome that were never seen while "
                "capture was complete.",
                "Part des trajets prévus à l’issue connue qui n’ont jamais été vus malgré une "
                "collecte complète.",
            ),
            ratio=("missing", "eligible"),
            worst_first_descending=True,
        ),
        Measure(
            "service_hours",
            "share",
            Text(
                "Share of scheduled service hours covered by trips that ran.",
                "Part des heures de service prévues couverte par les trajets effectués.",
            ),
            counts=Text(
                "Adds scheduled durations for trips that ran and divides by all eligible "
                "scheduled hours. Each trip’s duration runs from its first timed stop’s "
                "departure to its last timed stop’s arrival, using the other time at either end "
                f"if needed. At least {MIN_SERVICE_DELIVERED_TRIPS} eligible trips with a "
                "usable duration are required.",
                "Additionne les durées prévues des trajets effectués et les divise par "
                "l’ensemble des heures prévues admissibles. La durée d’un trajet va du départ "
                "du premier arrêt horodaté à l’arrivée au dernier, en prenant l’autre heure au "
                f"besoin. Il faut au moins {MIN_SERVICE_DELIVERED_TRIPS} trajets admissibles "
                "dotés d’une durée utilisable.",
            ),
            limits=Text(
                "It cannot establish actual time in service because durations come from the "
                "timetable. Trips without a usable scheduled duration add no hours.",
                "Elle ne mesure pas la durée réelle du service parce que les durées proviennent "
                "de l’horaire. Les trajets sans durée prévue utilisable n’ajoutent aucune heure.",
            ),
            ratio=("ran_seconds", "scheduled_seconds"),
            extra_tables=(SCHEDULED_STOP_TIMES,),
        ),
        Measure(
            "first_trip",
            "share",
            Text(
                "Share of days when the first scheduled departure ran.",
                "Part des journées où le premier départ prévu a été effectué.",
            ),
            counts=_BOUNDARY_COUNTS,
            limits=_BOUNDARY_LIMITS,
            ratio=("ran", "eligible"),
        ),
        Measure(
            "last_trip",
            "share",
            Text(
                "Share of days when the last scheduled departure ran.",
                "Part des journées où le dernier départ prévu a été effectué.",
            ),
            counts=_BOUNDARY_COUNTS,
            limits=_BOUNDARY_LIMITS,
            ratio=("ran", "eligible"),
        ),
    ),
)

MIN_CROWDING_VEHICLE_HOURS = 1
_US_PER_HOUR = 3_600_000_000
_OCCUPANCY_LEVELS = {
    0: (
        "crowding_empty",
        Text(
            "Share of reported vehicle time when vehicles reported being empty.",
            "Part du temps-véhicule signalé pendant laquelle les véhicules se déclaraient vides.",
        ),
    ),
    1: (
        "crowding_many_seats",
        Text(
            "Share of reported vehicle time when vehicles reported many seats available.",
            "Part du temps-véhicule signalé pendant laquelle les véhicules déclaraient "
            "plusieurs places assises libres.",
        ),
    ),
    2: (
        "crowding_few_seats",
        Text(
            "Share of reported vehicle time when vehicles reported few seats available.",
            "Part du temps-véhicule signalé pendant laquelle les véhicules déclaraient "
            "peu de places assises libres.",
        ),
    ),
    3: (
        "crowding_standing",
        Text(
            "Share of reported vehicle time when vehicles reported standing room only.",
            "Part du temps-véhicule signalé pendant laquelle les véhicules déclaraient "
            "des places debout seulement.",
        ),
    ),
    4: (
        "crowding_crushed",
        Text(
            "Share of reported vehicle time when vehicles reported limited standing room.",
            "Part du temps-véhicule signalé pendant laquelle les véhicules déclaraient "
            "peu de places debout.",
        ),
    ),
    5: (
        "crowding_full",
        Text(
            "Share of reported vehicle time when vehicles reported being full.",
            "Part du temps-véhicule signalé pendant laquelle les véhicules se déclaraient pleins.",
        ),
    ),
}
_CROWDING_COLUMNS = {
    "intervals": Text("Vehicle state intervals", "Intervalles d’état des véhicules"),
    "readings": Text("Vehicle readings", "Relevés de véhicules"),
    "occupancy_readings": Text("Readings with occupancy", "Relevés avec occupation"),
    "occupancy_vehicle_seconds": Text(
        "Vehicle-seconds with occupancy", "Secondes-véhicules avec occupation"
    ),
    "readings_without_occupancy": Text("Readings without occupancy", "Relevés sans occupation"),
    "capped_intervals": Text(
        "Intervals with a capped tail", "Intervalles avec prolongement plafonné"
    ),
    "level_vehicle_seconds": Text("Vehicle-seconds by level", "Secondes-véhicules par niveau"),
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
    positions = """
        FROM read_parquet(?, hive_partitioning = false)
        WHERE provider = ? AND cleaning_version = ?
    """
    inputs: list[object] = [paths[VEHICLE_POSITIONS], question.city, version]
    if question.line is not None:
        matching_vehicles = conn.execute(
            f"SELECT DISTINCT vehicle_id {positions} AND route_id = ?",
            [*inputs, question.line],
        ).fetchall()
        if not matching_vehicles:
            return {}
        # A position on a different line can end an interval on the requested line.
        # Keep the whole partition for every vehicle seen on the requested line.
        ids = [row[0] for row in matching_vehicles if row[0] is not None]
        candidates = []
        if ids:
            candidates.append(f"vehicle_id IN ({', '.join('?' for _ in ids)})")
            inputs.extend(ids)
        if len(ids) != len(matching_vehicles):
            candidates.append("vehicle_id IS NULL")
        positions += f" AND ({' OR '.join(candidates)})"
    if question.direction is not None or question.group == "direction":
        direction = "t.direction_id"
        join = """
            LEFT JOIN read_parquet(?, hive_partitioning = false) t
              ON (v.provider, v.cleaning_version, v.service_date, v.trip_id) =
                 (t.provider, t.cleaning_version, t.service_date, t.trip_id)
        """
        inputs.append(paths[TRIP_DAYS])
    weight = vehicle_duration_us_sql(
        "captured_at_utc", "last_seen_at_utc", "tail_us", "cadence_us"
    )
    tie_breaker = ", filename" if len(paths[VEHICLE_POSITIONS]) > 1 else ""
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
    tail = vehicle_tail_sql("v.next_start", "v.last_seen_at_utc", "cadence.cadence_us")
    rows = conn.execute(
        f"""
        WITH cadence AS ({vehicle_cadence_sql()}
        ), sequenced AS (
            SELECT provider, cleaning_version, service_date, trip_id, route_id, stop_id,
                captured_at_utc, last_seen_at_utc, readings, occupancy_status,
                occupancy_percentage, lead(captured_at_utc) OVER (
                    PARTITION BY vehicle_id ORDER BY captured_at_utc{tie_breaker}
                ) AS next_start
            {positions}
        ), vehicles AS (
            SELECT v.route_id, v.stop_id, {direction} AS direction_id,
                v.captured_at_utc, v.last_seen_at_utc, cadence.cadence_us, v.readings,
                {tail} AS tail_us,
                {vehicle_gap_us_sql("cadence.cadence_us")} AS cap_us,
                {vehicle_end_sql(
                    "v.captured_at_utc", "v.last_seen_at_utc", "tail_us", "cadence.cadence_us"
                )} AS ends_at,
                CASE WHEN v.occupancy_status BETWEEN 0 AND 5 THEN v.occupancy_status END AS status,
                CASE WHEN status IS NULL AND v.occupancy_percentage >= 0
                     THEN v.occupancy_percentage END AS percentage
            FROM sequenced v
            {vehicle_cadence_join("v.last_seen_at_utc")}
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
            count(*) FILTER (tail_us > cap_us AND (reading_cut OR (matches AND weight > 0))),
            count(*)
        FROM cuts GROUP BY entity, status, percentage
        """,
        [
            paths[FEED_POLLS],
            question.city,
            version,
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
    label=Text("Crowding", "Occupation des véhicules"),
    method_version="crowding-v4",
    since="2026-11-22",
    tables=(VEHICLE_POSITIONS, TRIP_DAYS, FEED_POLLS),
    minimum_sample=MIN_CROWDING_VEHICLE_HOURS,
    ranking_floors={"line": {"occupancy_vehicle_hours": 10}},
    query=_crowding_rows,
    columns=_CROWDING_COLUMNS,
    evidence_columns={
        "share_occupancy_readings": Text(
            "Share of readings with occupancy", "Part avec occupation"
        ),
        "percentage_levels": Text("Percentage-only levels", "Niveaux publiés en pourcentage"),
    },
    counts=Text(
        "Divides vehicle time spent at each level by total vehicle time with a usable occupancy "
        "report. Coverage divides readings carrying occupancy by all readings in the selection. "
        "Each state runs from its first capture to its last, then extends toward the vehicle’s "
        "next report by up to three reporting intervals (or one for the day’s last report), "
        "where the reporting interval is that day’s median spacing between feed publications. "
        "Vehicle time splits at hour boundaries; readings count in their interval’s starting "
        "hour. Published categories take priority over percentages, and percentage-only values "
        "of 100% or higher also count toward full.",
        "Divise le temps-véhicule passé à chaque niveau par le temps-véhicule total disposant "
        "d’un relevé d’occupation utilisable. La couverture divise les relevés comportant "
        "l’occupation par l’ensemble des relevés de la sélection. Chaque état court de sa "
        "première à sa dernière collecte, puis se prolonge jusqu’au relevé suivant du véhicule, "
        "jusqu’à trois intervalles de signalement (ou un seul pour le dernier relevé du jour), "
        "l’intervalle de signalement étant l’écart médian entre les publications du flux ce "
        "jour-là. Le temps-véhicule est réparti aux changements d’heure et les relevés sont "
        "comptés dans l’heure de début de l’intervalle. L’état publié a priorité sur le "
        "pourcentage, et les pourcentages seuls d’au moins 100\u00a0% entrent aussi dans la "
        "part des véhicules pleins.",
    ),
    exclusions=Text(
        "Reports without a usable occupancy level, boarding restrictions and unavailable codes "
        "are left out of the shares. Those reports still count in coverage. Filtering by "
        "direction requires a matched trip, and filtering by stop uses the stop reported by "
        "the vehicle. A network or line is marked not tracked when no usable occupancy was "
        "published.",
        "Les relevés sans niveau d’occupation utilisable, les restrictions d’embarquement et "
        "les codes d’indisponibilité sont exclus des parts. Ces relevés restent comptés dans "
        "la couverture. Le filtre par direction exige un trajet reconnu et le filtre par arrêt "
        "utilise l’arrêt signalé par le véhicule. Un réseau ou une ligne est marqué comme non "
        "suivi lorsqu’aucune valeur d’occupation utilisable n’a été publiée.",
    ),
    limits=Text(
        "It cannot tell how many riders were on board or guarantee a seat: it reflects vehicle "
        "time in broad levels reported by the agency. At least one vehicle-hour is required so "
        "a few minutes of reports do not swing the shares.",
        "Elle ne dit pas combien d’usagers étaient à bord et ne garantit pas une place "
        "assise\u00a0: elle reflète le temps-véhicule réparti dans les niveaux publiés par la "
        "société de transport. Il faut au moins une heure-véhicule pour éviter que quelques "
        "minutes de relevés ne déterminent les parts.",
    ),
    measures=tuple(
        Measure(
            key,
            "share",
            definition,
            worst_first_descending=True,
            ranking_kinds=("line",) if status == 5 else (),
        )
        for status, (key, definition) in _OCCUPANCY_LEVELS.items()
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
    notice_columns = (
        ", route_ids, stop_ids, effect, cause, published_periods, "
        "header_en, header_fr, description_en, description_fr"
    )
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
                route_ids, stop_ids, effect, cause, header_en, header_fr,
                description_en, description_fr,
                CASE WHEN list_count(list_transform(active_periods, lambda p: p.start_utc)) > 0
                    THEN to_json(active_periods) END AS published_periods,
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
                first_seen_at_utc, last_seen_at_utc, window_end{notice_columns}
            FROM periods CROSS JOIN bounds
        ), valid AS (
            SELECT DISTINCT entity, source, alert_id, version, starts, ends{notice_columns}
            FROM clipped
            WHERE starts < ends OR (observed_only AND first_seen_at_utc = last_seen_at_utc
                AND starts = first_seen_at_utc AND starts < window_end AND starts = ends)
        )
        SELECT DISTINCT {projection}{notice_columns} FROM valid {segments}
        """,
        [question.start, question.end, alert_paths, question.city, version, *arguments],
    ).fetchall()
    result: dict[EntityKey, Batch] = {}
    for entity, source, alert_id, revision, start, end, *notice in rows:
        key = tuple(entity) if temporal else (entity,) if group or question.group else ()
        batch = result.setdefault(key, Batch())
        span = AlertSpan(source, alert_id, revision, start, end)
        batch.alert_spans.add(span)
        (
            routes, stops, effect, cause, periods, header_en, header_fr,
            description_en, description_fr,
        ) = notice
        if periods and span.publication not in batch.alert_variants:
            batch.alert_variants[span.publication] = NoticeVariant(
                (tuple(routes), tuple(stops), periods, effect, cause),
                notice_text(header_en, description_en),
                notice_text(header_fr, description_fr),
            )
        if question.alert_details:
            batch.alert_messages[span.publication] = {
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
    method_version="alert-counts-v2",
    since="2026-11-22",
    tables=(ALERTS,),
    minimum_sample=0,
    query=_alert_rows,
    columns={
        "alerts": Text("Distinct alerts", "Avis distincts"),
        "alert_versions": Text("Distinct alert versions", "Versions d’avis distinctes"),
        "active_spans": Text("Distinct active spans", "Périodes actives distinctes"),
        "alert_seconds": Text("Alert-seconds", "Secondes d’avis"),
    },
    evidence_columns={
        "days_not_tracked": Text("Days not tracked", "Jours sans suivi"),
        "days_alerts_tracked": Text("Days with alert tracking", "Jours avec suivi des avis"),
    },
    counts=Text(
        "A notice and its bilingual reissue count as one when they share the message in one "
        "language, the same published periods with a known start, and the same lines, stops, "
        "cause and effect. If the source supplies an ID, it must match. Each published version "
        "is counted separately. For each notice, "
        "overlapping periods are merged, clipped to the requested local dates, then added up.",
        "Un avis et sa réémission bilingue comptent pour un seul avis s’ils ont le même texte "
        "dans une langue, les mêmes périodes publiées avec un début connu, ainsi que les mêmes "
        "lignes, arrêts, cause et effet. Si la source fournit un identifiant, il doit être "
        "le même. Chaque version publiée est comptée séparément. Pour "
        "chaque avis, les périodes qui se chevauchent sont fusionnées, limitées aux dates "
        "locales demandées, puis additionnées.",
    ),
    exclusions=Text(
        "Line and stop views include only alerts tagged with that line or stop by the agency; "
        "untagged alerts stay in the network total. Effect and cause use the agency’s published "
        "labels. Zero means no matching alert appeared in the tracked record; networks without "
        "alert capture are marked not tracked.",
        "Les vues par ligne et par arrêt retiennent uniquement les avis rattachés à cette ligne "
        "ou à cet arrêt par la société de transport; les autres restent dans le total du "
        "réseau. L’effet et la cause reprennent les libellés publiés par la société de "
        "transport. Zéro indique qu’aucun avis correspondant n’a été enregistré; un réseau "
        "sans collecte des avis est indiqué comme non suivi.",
    ),
    limits=Text(
        "It cannot tell whether a disruption actually occurred on the street or how many riders "
        "it affected, only what notices were published. Published start and end times can "
        "extend beyond the days an alert was collected. A missing bound falls back to the first "
        "or last sighting of that version on its collection day, and archive gaps can miss "
        "other notices.",
        "Elle ne dit pas si une perturbation a réellement eu lieu sur le terrain ni combien "
        "d’usagers ont été touchés, seulement quels avis ont été publiés. Les bornes publiées "
        "peuvent dépasser les jours de collecte de l’avis. Une borne manquante est remplacée "
        "par la première ou la dernière observation de cette version ce jour-là, et les "
        "lacunes des archives peuvent laisser d’autres avis de côté.",
    ),
    measures=(
        Measure(
            "alerts",
            "count",
            Text(
                "Number of distinct service alerts in effect during the selected dates.",
                "Nombre d’avis de service distincts en vigueur aux dates choisies.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "alert_versions",
            "count",
            Text(
                "Number of distinct alert revisions published during the selected dates.",
                "Nombre de versions d’avis distinctes publiées aux dates choisies.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "alert_hours",
            "hours",
            Text(
                "Total hours that published service alerts were in effect during the selected "
                "dates.",
                "Nombre total d’heures pendant lesquelles les avis de service publiés étaient "
                "en vigueur aux dates choisies.",
            ),
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
    "bunching": Text("Bunched headways", "Véhicules trop rapprochés"),
    "long_gaps": Text("Long headways", "Intervalles prolongés"),
    **_WAITING_EXCLUDED,
}


_WAITING_PERIOD_KEYS = "service_date, route_id, direction_id, stop_id, period"


def _waiting_schedule_summary(
    aggregates: str, entity: str, routes: str, counters: dict[str, str], *, by_stop: bool = False
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
                AND live_candidates > 0 AND span_seconds >= {FREQUENT_SPAN_SECONDS}
                AND scheduled_mean <= {FREQUENT_HEADWAY_SECONDS}
        ), irregular_frequency AS (
            SELECT {keys},
                avg(headway) FILTER (route_has_live_data AND headway > 0) AS scheduled_mean
            FROM irregular_pairs GROUP BY {keys}
            HAVING scheduled_mean <= {FREQUENT_HEADWAY_SECONDS}
                AND max(event_at) - min(event_at) >= {FREQUENT_SPAN_SECONDS * 1_000_000}
        ), frequent_periods AS (
            SELECT * FROM simple_frequency UNION ALL SELECT * FROM irregular_frequency
        )
    """
    totals = ", ".join(f"sum({name}) AS {name}" for name in counters)
    schedule_keys = "s.route_id, s.direction_id, s.stop_id" if by_stop else "s.route_id"
    passage_keys = "p.route_id, p.direction_id, p.stop_id" if by_stop else "p.route_id"
    evidence = f"""
        simple_evidence AS (
            SELECT {schedule_keys}, scheduled_stops, live_candidates,
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
            SELECT {passage_keys}, {aggregates}
            FROM (
                SELECT p.*, f.scheduled_mean IS NOT NULL AS frequent
                FROM irregular_pairs p LEFT JOIN irregular_frequency f USING ({keys})
            ) p
            GROUP BY {passage_keys}
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
    wait_counts: tuple[str, ...] = (
        "covered_scheduled_headways", "scheduled_seconds", "scheduled_squared_seconds",
    )
    if question.layer_map:
        layer_counts = ("scheduled_stops", "live_candidates", "live_direction_stops")
        schedule_counts = {
            key: schedule_counts[key] for key in (*layer_counts, "frequent_headways")
        }
        observed_counts = {"observed_headways": observed_counts["observed_headways"]}
        wait_counts = ()
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
            SELECT {keys},
                avg(headway) FILTER (route_has_live_data AND headway > 0) AS scheduled_mean
            FROM scheduled_pairs
            GROUP BY {keys}
            HAVING scheduled_mean <= {FREQUENT_HEADWAY_SECONDS}
                AND max(event_at) - min(event_at) >= {FREQUENT_SPAN_SECONDS * 1_000_000}
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
        and question.group in (None, "line_stop")
        and question.hour is None
        and question.departure is None
        and question.layer_hours() is None
    ):
        schedule_sql, schedule_evidence = _waiting_schedule_summary(
            schedule_aggregates, entity, routes, schedule_counts,
            by_stop=question.group == "line_stop",
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
    trip_type = "AND route_type = ?" if question.route_type is not None else ""
    trip_type_params = [question.route_type] if question.route_type is not None else []
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
                        {trip_type}
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
                epoch_us(scheduled_at) AS planned_at,
                make_timestamp({observed_local}) AS local_at,
                hour(local_at) AS local_hour,
                {period} AS period
            FROM events
            WHERE observed_at IS NOT NULL
        ), observed_pairs AS (
            SELECT p.* EXCLUDE (local_at, planned_at), f.scheduled_mean,
                lag(event_at) OVER arrivals AS previous_at,
                lag(trip_id) OVER arrivals AS previous_trip,
                abs(planned_at - lag(planned_at) OVER arrivals) / 1000000 AS planned_gap,
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
                p.scheduled_mean, p.planned_gap, p.previous_at, p.event_at,
                c.covered_from, u.unknown_at,
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
            -- Eligible windows are disjoint for each stop/period/entity. A
            -- positive interval fits in at most one, even at a shared boundary.
            JOIN observed_windows w
                ON s.entity = w.entity AND s.service_date = w.service_date
                AND s.route_id = w.route_id AND s.direction_id = w.direction_id
                AND s.stop_id = w.stop_id AND s.period = w.period
                AND s.previous_at >= w.window_start AND s.event_at <= w.window_end
            GROUP BY ALL
        ), waiting AS (
            SELECT entity, sum(scheduled_count) AS covered_scheduled_headways,
                sum(scheduled_elapsed) AS scheduled_seconds,
                sum(scheduled_squared) AS scheduled_squared_seconds,
                sum(scheduled_elapsed) FILTER (actual_elapsed > 0) AS wait_weight,
                -- Sum the same terms in a fixed order regardless of join or thread order.
                sum(0.5 * (actual_squared * (scheduled_elapsed / nullif(actual_elapsed, 0))
                    - scheduled_squared)
                    ORDER BY service_date, route_id, direction_id, stop_id, period
                ) AS weighted_excess
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
            *trip_type_params,
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
    method_version="4",
    since="2026-11-27",
    tables=(STOP_EVENTS, TRIP_DAYS, FEED_POLLS),
    minimum_sample=MIN_OBSERVED_HEADWAYS,
    coverage=(0.25, 0.50),
    ranking_floors={"line": {"observed_trip_pairs": 20, "observed_headways": 50}},
    counts=Text(
        "Measures time between successive vehicles at a stop during frequent service "
        f"(scheduled every {FREQUENT_HEADWAY_SECONDS // 60} minutes or less). A period is "
        "frequent when the first and last scheduled passages for a line, stop and direction "
        f"are at least {FREQUENT_SPAN_SECONDS // 60} minutes apart on that service date, "
        f"with a mean scheduled gap of at most {FREQUENT_HEADWAY_SECONDS // 60} minutes. "
        "Coverage compares observed intervals with scheduled ones in frequent "
        "periods, up to 100%. For excess wait, each period’s average wait for riders arriving "
        "without checking the timetable is the sum of squared intervals divided by twice their "
        "sum; scheduled wait uses complete scheduled intervals inside windows of known observed "
        "intervals, and periods are weighted by their covered scheduled time. Local periods are "
        f"{periods_text('en')}.",
        "Mesure le temps entre deux véhicules successifs à un arrêt en période de service "
        f"fréquent (horaire prévu aux {FREQUENT_HEADWAY_SECONDS // 60} minutes ou moins). "
        "Une période est fréquente lorsque, pour une ligne, un arrêt et une direction, "
        "le premier et le dernier passage prévus sont espacés d’au moins "
        f"{FREQUENT_SPAN_SECONDS // 60} minutes à cette date de service, avec un intervalle "
        f"prévu moyen d’au plus {FREQUENT_HEADWAY_SECONDS // 60} minutes. La couverture "
        "compare le nombre d’intervalles observés au nombre prévu en période fréquente, "
        "jusqu’à 100\u00a0%. Pour l’attente excédentaire, l’attente moyenne d’un usager "
        "arrivant sans consulter l’horaire vaut, dans chaque période, la somme des carrés des "
        "intervalles divisée par deux fois leur somme; l’attente prévue utilise les intervalles "
        "prévus entièrement compris dans les plages d’intervalles observés connus, et chaque "
        "période est pondérée selon sa durée prévue couverte. Les périodes locales sont "
        f"{periods_text('fr')}.",
    ),
    exclusions=Text(
        "Non-frequent periods, lines without live data, stops with unknown direction and gaps "
        "broken by a missed observation or capture outage are left out. Both passages must fall "
        "in the same local period, and no unobserved trip that ran or could not be confirmed "
        "may be scheduled between them. Every recorded vehicle or trip-update feed must cover "
        f"the entire interval, with usable polls at most {MAX_POLL_SPACING_SECONDS} s apart "
        f"and publication age at most {MAX_POLL_AGE_SECONDS} s plus the declared source lag. "
        "The ending passage sets the hour; a departure filter uses the ending trip’s scheduled "
        "departure.",
        "Les périodes non fréquentes, les lignes sans données en direct, les arrêts sans "
        "direction connue et les intervalles rompus par un passage non observé ou une "
        "interruption de collecte sont exclus. Les deux passages doivent appartenir à la même "
        "période locale, sans trajet effectué ou non confirmé prévu entre eux qui n’aurait pas "
        "été observé à cet arrêt. Chaque flux de positions ou de mises à jour des trajets "
        "enregistré doit couvrir tout l’intervalle, avec des relevés utilisables espacés d’au "
        f"plus {MAX_POLL_SPACING_SECONDS}\u00a0s et des publications datant d’au plus "
        f"{MAX_POLL_AGE_SECONDS}\u00a0s plus le décalage déclaré de la source. Le passage qui "
        "termine l’intervalle détermine l’heure, et un filtre par départ utilise l’heure de "
        "départ prévue de ce trajet.",
    ),
    limits=Text(
        "It assumes riders arrive without checking the timetable and does not measure lines "
        f"scheduled wider than {FREQUENT_HEADWAY_SECONDS // 60} minutes. At least "
        f"{MIN_OBSERVED_HEADWAYS} observed intervals are required to report a value.",
        "Elle suppose des usagers qui arrivent sans consulter l’horaire et ne mesure pas les "
        f"lignes dont l’intervalle prévu dépasse {FREQUENT_HEADWAY_SECONDS // 60} minutes. "
        f"Il faut au moins {MIN_OBSERVED_HEADWAYS} intervalles observés pour publier une "
        "valeur.",
    ),
    measures=(
        Measure(
            "observed_headway",
            "seconds",
            Text(
                "Average time between two successive observed vehicles at a stop during "
                "frequent service.",
                "Temps moyen entre deux véhicules observés successifs à un arrêt en période "
                "fréquente.",
            ),
            ratio=("observed_seconds", "observed_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "scheduled_headway",
            "seconds",
            Text(
                "Average scheduled time between vehicles in the same frequent periods where "
                "real intervals were observed.",
                "Temps moyen prévu entre deux véhicules dans les mêmes périodes fréquentes où "
                "les intervalles ont été observés.",
            ),
            ratio=("scheduled_seconds", "covered_scheduled_headways"),
            ranking_kinds=(),
        ),
        Measure(
            "bunching",
            "share",
            Text(
                f"Share of observed intervals shorter than {BUNCHING_FRACTION:.0%} of the "
                "period’s scheduled average, excluding pairs the timetable puts closer "
                "together than that.",
                f"Part des intervalles observés inférieurs à {_fr_pct(BUNCHING_FRACTION)} "
                "de l’intervalle prévu moyen de la période, sauf si l’horaire prévoit déjà "
                "un écart inférieur à ce seuil entre les deux trajets.",
            ),
            band=(
                f"headway < {BUNCHING_FRACTION} * scheduled_mean "
                f"AND (planned_gap IS NULL OR planned_gap >= {BUNCHING_FRACTION} * scheduled_mean)"
            ),
            ratio=("bunching", "observed_headways"),
            worst_first_descending=True,
            ranking_kinds=("line",),
        ),
        Measure(
            "long_gaps",
            "share",
            Text(
                f"Share of observed intervals longer than {LONG_GAP_MULTIPLE} times the "
                "period’s scheduled average.",
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
                "Extra time riders wait on average beyond what the timetable promises during "
                "frequent service. Within each period, average wait is the sum of squared "
                "intervals divided by twice their sum, comparing observed intervals with "
                "complete scheduled intervals inside the same observed windows and weighting "
                "each period by its covered scheduled time.",
                "Temps d’attente moyen supplémentaire au-delà de ce que promet l’horaire en "
                "période fréquente. Dans chaque période, l’attente moyenne est la somme des "
                "carrés des intervalles divisée par deux fois leur somme, en comparant les "
                "intervalles observés aux intervalles prévus entièrement compris dans les "
                "mêmes plages observées, avec une pondération selon la durée prévue couverte.",
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
        "Counts trips and hourly frequency directly from the published timetable, including "
        "lines without live data. Each trip is placed at its first timed stop (or its first "
        "timed visit to a selected stop). Evidence breaks counts down by day type and local "
        f"period: {periods_text('en')}.",
        "Compte les trajets et la fréquence horaire directement dans l’horaire publié, y "
        "compris pour les lignes sans données en direct. Chaque trajet est placé à son premier "
        "arrêt horodaté (ou à son premier passage horodaté à l’arrêt choisi). Les données "
        f"détaillent les totaux par type de jour et période locale\u00a0: {periods_text('fr')}.",
    ),
    exclusions=Text(
        "Dates without a validated timetable are left out. Minimum service is checked for each "
        "line and direction on dates when the published timetable includes that line; an "
        "evening or weekend period on such a date may still have zero trips.",
        "Les dates sans horaire validé sont exclues. Le seuil de service minimal est vérifié "
        "pour chaque ligne et direction aux dates où l’horaire publié inclut cette ligne; une "
        "période en soirée ou en fin de semaine à cette date peut tout de même ne compter "
        "aucun trajet.",
    ),
    limits=Text(
        "It describes only what was planned on paper, not whether those trips actually ran. "
        f"At least {_MIN_SCHEDULE_DAYS} service day with a validated schedule is required. "
        "Frequencies use clock-hour slots, including on clock-change days, and overnight trips "
        "stay on their service date.",
        "Elle décrit uniquement ce qui était prévu à l’horaire, et non ce qui a réellement "
        f"circulé. Il faut au moins {_MIN_SCHEDULE_DAYS} jour de service avec un horaire "
        "validé. Les fréquences utilisent les tranches horaires de l’horloge, même les jours "
        "de changement d’heure, et les trajets de nuit conservent leur date de service.",
    ),
    measures=(
        Measure(
            "scheduled_trips",
            "trips",
            Text(
                "Number of trips planned in the selected timetable.",
                "Nombre de trajets prévus dans l’horaire choisi.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "scheduled_frequency",
            "trips_per_hour",
            Text(
                "Average number of scheduled trips per hour across the selected dates and periods.",
                "Nombre moyen de trajets prévus par heure aux dates et périodes choisies.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "below_minimum_service",
            "periods",
            Text(
                f"Number of evening and weekend periods averaging fewer than {MIN_TRIPS_PER_HOUR} "
                "scheduled trips per hour. That threshold matches a half-hour interval when "
                "departures are evenly spaced, assessed per date, line and direction.",
                "Nombre de périodes en soirée ou en fin de semaine comptant en moyenne moins de "
                f"{MIN_TRIPS_PER_HOUR} trajets prévus par heure. Ce seuil correspond à un "
                "intervalle d’une demi-heure lorsque les passages sont réguliers, évalué par "
                "date, ligne et direction.",
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
    "A vehicle’s lateness mostly reflects the lines and hours it is assigned to.",
    "Le retard d’un véhicule reflète surtout les lignes et les heures auxquelles il est affecté.",
)
_VEHICLE_PUNCTUALITY = tuple(
    replace(
        measure,
        id=f"vehicle_{measure.id}",
        counts=_PUNCTUALITY.counts,
        exclusions=_PUNCTUALITY.exclusions,
        limits=Text(
            f"{_VEHICLE_PUNCTUALITY_CAUTION.en} {_PUNCTUALITY.limits.en}",
            f"{_VEHICLE_PUNCTUALITY_CAUTION.fr} {_PUNCTUALITY.limits.fr}",
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
    "A reporting gap shows silence in the captured feed: it cannot tell whether the vehicle "
    "was in the garage or on the road with a silent transmitter. A day is marked not tracked "
    f"when fewer than {MIN_STABLE_READING_SHARE:.0%} of vehicle readings carry an ID seen at "
    f"least {MIN_STABLE_ID_READINGS} times, or when fewer than that share of confirmed trips "
    "link to those IDs. Repeated IDs provide continuity within the day. Vehicle hours use "
    "capture times and never extend past the next capture.",
    "Une interruption signale un silence dans le flux capturé\u00a0: elle ne dit pas si le "
    "véhicule était au garage ou sur la route avec un émetteur silencieux. Un jour est marqué "
    f"comme non suivi si moins de {_fr_pct(MIN_STABLE_READING_SHARE)} des relevés portent un "
    f"identifiant vu au moins {MIN_STABLE_ID_READINGS} fois, ou si une part inférieure des "
    "trajets confirmés est liée à ces identifiants. La répétition d’un identifiant témoigne "
    "de sa continuité dans la journée. Les heures-véhicules utilisent les heures de collecte "
    "et ne dépassent jamais le relevé suivant.",
)
_VEHICLE_REPORTING_EXCLUSIONS = Text(
    "Silences that overlap a capture outage are left out of the count and duration. The "
    "vehicle-position feed must have continuous capture across the silence, with advancing, "
    f"nonempty publications at most {MAX_POLL_AGE_SECONDS} s old plus the declared source lag "
    f"and at most {MAX_POLL_SPACING_SECONDS} s apart. Excluded silences appear separately in "
    "the evidence.",
    "Les silences qui coïncident avec une interruption de la collecte sont exclus du nombre "
    "et de la durée. La collecte du flux de positions doit être continue pendant le silence, "
    "avec des publications non vides et plus récentes que les précédentes datant d’au plus "
    f"{MAX_POLL_AGE_SECONDS}\u00a0s plus le décalage déclaré de la source et espacées d’au "
    f"plus {MAX_POLL_SPACING_SECONDS}\u00a0s. Les silences exclus figurent à part dans les "
    "données justificatives.",
)
# Keep the upstream reassignment rule as diagnostic evidence. Revisit publication when a feed
# demonstrates confirmed reassignments on real service dates and terminus coverage is sufficient.
_VEHICLE_COMPLETION_METHOD = Text(
    "Trips not finished are marked not tracked because live feeds do not reliably show when "
    "a trip ends early.",
    "Les trajets non terminés sont marqués comme non suivis parce que les flux en direct ne "
    "montrent pas de façon fiable quand un trajet se termine tôt.",
)


def _vehicle_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
    *,
    include_network: bool = False,
) -> dict[EntityKey, Batch]:
    stats, stats_params = vehicle_stats_query(
        paths,
        [question.city, version, question.start, question.end],
        group == "vehicle" or question.group == "vehicle",
        question.measure == family.id or question.measure in _VEHICLE_REPORTING_IDS,
        question.measure == family.id or question.measure in _VEHICLE_COMPLETION_IDS,
        by_hour=question.group == "hour",
        by_line=question.group == "line",
        vehicle=question.vehicle,
        include_network=include_network,
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
            entity = stats_row["entity"]
            network_total = include_network and entity is None
            key = (entity,) if (group or question.group) and not network_total else ()
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
    method_version="vehicles-v5",
    since="2026-11-22",
    tables=(VEHICLE_POSITIONS, TRIP_DAYS, FEED_POLLS),
    query=_vehicle_rows,
    minimum_sample=1,
    counts=Text(
        "Follows vehicles carrying a stable identifier during the day across their trip-linked "
        "reports. Network days count dates with at least one tracked vehicle in service; "
        "network hours add time across vehicles, while lines and dated trips count once across "
        "the fleet.",
        "Suit les véhicules dotés d’un identifiant stable au fil de la journée à partir de "
        "leurs relevés liés à un trajet. À l’échelle du réseau, les jours comptent les dates "
        "où au moins un véhicule suivi est en service; les heures s’additionnent entre "
        "véhicules, tandis que les lignes et les trajets datés sont comptés une seule fois.",
    ),
    exclusions=Text(
        "Reports without a stable vehicle ID or without a trip link are left out of vehicle "
        "service totals. Because live feeds cannot reliably confirm early trip endings, "
        "unfinished-trip measures remain marked not tracked while diagnostic evidence separates "
        "reached termini, confirmed reassignments, unknown outcomes and capture gaps.",
        "Les relevés sans identifiant de véhicule stable ou sans trajet associé sont exclus "
        "des totaux de service par véhicule. Comme les flux en direct ne permettent pas de "
        "confirmer de façon fiable les fins de trajet anticipées, les mesures sur les trajets "
        "non terminés restent marquées comme non suivies, tandis que les données de diagnostic "
        "distinguent les terminus atteints, les réaffectations confirmées, les issues "
        "inconnues et les interruptions de collecte.",
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
                "Days on which a tracked vehicle sent at least one position while on a trip.",
                "Jours où un véhicule suivi a transmis au moins une position pendant un trajet.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_hours_in_service",
            "hours",
            Text(
                "Observed time a vehicle spent on trips. Each reading extends up to three "
                "reporting intervals toward the next state, or one reporting interval for the "
                "final reading, using that day’s median spacing between feed publications.",
                "Durée observée pendant laquelle un véhicule a assuré des trajets. Chaque "
                "relevé est augmenté d’au plus trois intervalles de signalement jusqu’à l’état "
                "suivant, ou d’un intervalle pour le dernier relevé, selon l’écart médian "
                "entre les publications du flux ce jour-là.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_lines_run",
            "count",
            Text(
                "Distinct lines a vehicle served on confirmed trips or trip-linked reports.",
                "Lignes distinctes desservies par un véhicule selon les trajets confirmés et "
                "les relevés liés à un trajet.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_trips_run",
            "count",
            Text(
                "Distinct dated trips confirmed or linked to a vehicle’s position reports.",
                "Trajets datés distincts confirmés ou liés aux relevés de position d’un véhicule.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_reporting_gaps",
            "count",
            Text(
                f"Counts pauses longer than {MIN_REPORTING_SILENCE_MINUTES} minutes and longer "
                "than three times the feed’s median reporting interval that day, between two "
                "successive vehicle reports on the same trip.",
                f"Compte les interruptions de plus de {MIN_REPORTING_SILENCE_MINUTES} minutes "
                "qui dépassent aussi trois fois l’intervalle de signalement médian du flux "
                "ce jour-là, entre deux relevés successifs du véhicule sur le même trajet.",
            ),
            extra_tables=(FEED_POLLS,),
            exclusions=_VEHICLE_REPORTING_EXCLUSIONS,
            ranking_kinds=(),
        ),
        Measure(
            "vehicle_silent_hours",
            "hours",
            Text(
                "Total time spent inside counted reporting gaps.",
                "Durée totale passée dans les interruptions de signalement comptées.",
            ),
            extra_tables=(FEED_POLLS,),
            exclusions=_VEHICLE_REPORTING_EXCLUSIONS,
            ranking_kinds=(),
        ),
        Measure(
            VEHICLE_RANKING_DEFAULT,
            "per_100_vehicle_hours",
            Text(
                "Rate of reporting gaps per 100 observed vehicle-hours in service. A gap "
                f"counts when it exceeds {MIN_REPORTING_SILENCE_MINUTES} minutes and three "
                "times the feed’s median reporting interval that day, between successive "
                "reports on the same trip.",
                "Taux d’interruptions du signal par 100 heures-véhicules observées en service. "
                f"Une interruption compte si elle dépasse {MIN_REPORTING_SILENCE_MINUTES} minutes "
                "et trois fois l’intervalle de signalement médian du flux ce jour-là, entre "
                "deux relevés successifs sur le même trajet.",
            ),
            counts=Text(
                "Divides counted reporting gaps by observed hours in service, scaled to 100 "
                f"hours. Rankings require at least {MIN_VEHICLE_RANKING_HOURS} hours in "
                "service so one gap changes the rate by at most 10 per 100 hours.",
                "Divise le nombre d’interruptions comptées par les heures observées en "
                "service, ramené à 100 heures. Le classement exige au moins "
                f"{MIN_VEHICLE_RANKING_HOURS} heures en service afin qu’une interruption ne "
                "modifie le taux que d’au plus 10 par 100 heures.",
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


def _clear_run_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
    group: EntityKind | None,
) -> dict[EntityKey, Batch]:
    hour = local_hour_sql(conn, "scheduled_departure_at", question.start, question.end)
    cut, parameters = _cuts(question, hour)
    window = [question.city, version, question.start, question.end]
    if question.route_type is not None:
        cut += """ AND (service_date, trip_id) IN (
            SELECT service_date, trip_id FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
                AND route_type = ?
        )"""
        parameters.extend((paths[TRIP_DAYS], *window, question.route_type))
    runs = SEGMENT_RUNS_SQL.format(
        cut=f"route_id IS NOT NULL AND ({cut})", trip_identity="trip_id,"
    )
    rows = conn.execute(
        f"""
        WITH {runs}, timed_runs AS (
            SELECT *, exclusion IS NULL AND observed_seconds > 0 AS timed FROM runs
        )
        SELECT row(route_id, direction_id, from_stop, to_stop),
            histogram(observed_seconds) FILTER (timed),
            count(*) AS scheduled_runs,
            count(*) FILTER (timed) AS observed_runs,
            count(DISTINCT (service_date, trip_id)) FILTER (timed) AS trips_counted,
            coalesce(sum(observed_seconds) FILTER (timed), 0) AS observed_seconds,
            count(*) FILTER (exclusion = 'route_without_live_data') AS without_live,
            count(*) FILTER (exclusion = 'cancelled') AS cancelled,
            count(*) FILTER (exclusion = 'capture_gap') AS capture_gap
        FROM timed_runs GROUP BY route_id, direction_id, from_stop, to_stop
        """,
        [paths[FEED_POLLS], *window, paths[SEGMENT_RUNS], *window, *parameters],
    ).fetchall()
    names = (
        "scheduled_runs", "observed_runs", "trips_counted", "observed_seconds",
        "route_without_live_data", "cancelled", "capture_gap",
    )
    return {
        tuple(key): Batch(
            counts=Counter(dict(zip(names, counts, strict=True))),
            histogram=Counter(histogram or {}),
        )
        for key, histogram, *counts in rows
    }


_CLEAR_RUN = Family(
    id=_CLEAR_RUN_ID,
    label=Text("Clear run", "Parcours fluide"),
    method_version="clear-run-v1",
    since="2026-11-27",
    tables=(SEGMENT_RUNS, FEED_POLLS),
    minimum_cleaning_version=SEGMENT_RUNS_VERSION,
    minimum_sample=MIN_SEGMENT_RUNS,
    coverage=(0.25, 0.50),
    query=_clear_run_rows,
    counts=Text(
        "Sorts eligible stop-to-stop times for the same line and direction. The clear run "
        "is the observed time at the fastest tenth's boundary. Time lost is the exact median "
        "minus that time. At least 20 runs are needed. By default, the scheduled departure "
        "at the first stop must fall from 06:00 up to midnight in the local time zone.",
        "Classe les durées admissibles entre deux arrêts pour la même ligne et la même direction. "
        "Le parcours fluide est la durée observée à la limite du dixième le plus rapide. "
        "Le temps perdu est la médiane exacte moins cette durée. Il faut au moins 20 parcours. "
        "Par défaut, le départ prévu au premier arrêt doit tomber de 6 h à minuit, heure locale.",
    ),
    exclusions=Text(
        "Uses consecutive stop observations with comparable timing sources and continuous "
        "feed coverage. Runs with missing readings, equal timestamps or implausible times "
        "are left out.",
        "Utilise les signalements à deux arrêts consécutifs, de source comparable, avec une "
        "collecte continue. Les parcours aux relevés manquants, aux heures identiques ou aux "
        "durées invraisemblables sont exclus.",
    ),
    limits=Text(
        "A run can include time spent stopped at one end. The result locates extra time "
        "on the stretch. It cannot identify the cause, and a slowdown shared by all trips "
        "is already part of the reference.",
        "Un parcours peut inclure le temps passé à l’un des deux arrêts. Le résultat situe "
        "le temps supplémentaire sur le tronçon. Il ne précise pas la cause, et un "
        "ralentissement commun à tous les trajets fait déjà partie de la référence.",
    ),
    measures=(Measure(
        CLEAR_RUN_TIME_LOST,
        "seconds",
        Text(
            "Extra time on a typical trip compared with the fastest tenth of observed runs.",
            "Temps supplémentaire d’un trajet typique par rapport au dixième le plus rapide "
            "des parcours observés.",
        ),
        ranking_kinds=(),
    ),),
)


_STRETCH_TIMING = Family(
    id=_STRETCH_ID,
    label=Text("Stretch timing", "Temps par tronçon"),
    method_version="stretch-timing-v1",
    since="2026-11-28",
    tables=(TRIP_DAYS,),
    minimum_cleaning_version=SEGMENT_RUNS_VERSION,
    minimum_sample=MIN_STRETCH_PASSES,
    query=None,
    counts=Text(
        "Each stop-to-stop run is cut into pieces of about 100 m, and each vehicle's pass "
        "through a piece is timed from its position readings. For each piece, passes are "
        "sorted by time. The clear run is the pass time at the fastest tenth's boundary. "
        "Time lost is the exact median minus that time. Total time lost adds, over every "
        "pass slower than the clear run, how much slower it was. The clear-run speed is the "
        "speed while moving at the same boundary from the fast end, in whole km/h. At least "
        "20 passes are needed. By default, a pass must start from 06:00 up to midnight in "
        "the local time zone.",
        "Chaque parcours entre deux arrêts est découpé en morceaux d’environ 100 m, et le "
        "passage de chaque véhicule dans un morceau est chronométré à partir de ses positions. "
        "Pour chaque morceau, les passages sont classés par durée. Le parcours fluide est la "
        "durée à la limite du dixième le plus rapide. Le temps perdu est la médiane exacte "
        "moins cette durée. Le temps perdu total additionne, pour chaque passage plus lent que "
        "le parcours fluide, l’écart avec celui-ci. La vitesse du parcours fluide est la "
        "vitesse en mouvement à la même limite, du côté rapide, en km/h entiers. Il faut au "
        "moins 20 passages. Par défaut, un passage doit commencer de 6 h à minuit, heure locale.",
    ),
    exclusions=Text(
        "Uses passes timed from readings at most 90 s apart, with a measured speed. "
        "The first and last 30 m of each trip and layovers at line ends are left out. A "
        "position repeated while the vehicle moved on is not counted as a stop.",
        "Utilise les passages chronométrés à partir de positions espacées d’au plus 90 s, "
        "avec une vitesse mesurée. Les 30 premiers et 30 derniers mètres de chaque "
        "trajet et les battements en bout de ligne sont exclus. Une position répétée alors que "
        "le véhicule avançait n’est pas comptée comme un arrêt.",
    ),
    limits=Text(
        "Positions arrive about every 20 to 60 s, so a single pass is timed to about 15 s. "
        "The result locates extra time on the stretch. It cannot identify the "
        "cause, and a slowdown shared by all passes is already part of the clear run. A "
        "stretch with fewer than 20 passes in the chosen period is not measured.",
        "Les positions arrivent environ toutes les 20 à 60 s, donc un passage est "
        "chronométré à environ 15 s près. Le résultat situe le temps supplémentaire "
        "sur le tronçon. Il ne précise pas la cause, et un ralentissement commun à tous les "
        "passages fait déjà partie du parcours fluide. Un tronçon qui compte moins de 20 "
        "passages sur la période choisie n’est pas mesuré.",
    ),
    measures=(
        Measure(
            STRETCH_TIME_LOST,
            "seconds",
            Text(
                "Extra time a typical pass takes on this stretch, compared with the fastest "
                "tenth of passes.",
                "Temps supplémentaire d’un passage typique sur ce tronçon, par rapport au "
                "dixième le plus rapide des passages.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            STRETCH_CLEAR_RUN_SPEED,
            "km_per_hour",
            Text(
                "How fast vehicles move on this stretch when nothing holds them up. Time "
                "stopped is not counted.",
                "Vitesse des véhicules sur ce tronçon quand rien ne les retient. Le temps "
                "d’arrêt n’est pas compté.",
            ),
            ranking_kinds=(),
        ),
    ),
)


def _stretch_answer(
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    started: float,
) -> dict[str, Any]:
    hours = question.layer_hours()
    assert hours is not None
    lines = question.lines or ((question.line,) if question.line is not None else ())
    cut = StretchCut(hours, question.route_type, lines, question.direction)
    with service_query(store, question.city) as conn:
        window = read_window(conn, store, question, family, selected)
        remote = None if store.s3_endpoint else remote_stretches(conn)
        measured = set(window.measured)
        months: list[dict[str, str]] = []
        rolled: set[str] = set()
        if not cut.by_line:
            for month in sorted({day_key[:7] for day_key in window.included}):
                rollup = month_rollup(conn, remote or store, question.city, month)
                if rollup is None:
                    continue
                month_paths, rollup_days = rollup
                keys = {day.isoformat() for day in rollup_days}
                # A month stands in for its days only when every one of them is in the
                # window and measured; otherwise its days are read one by one.
                inside = all(question.start <= day <= question.end for day in rollup_days)
                if inside and keys <= measured:
                    months.append(month_paths)
                    rolled |= keys
        days, trip_days, included = [], [], []
        for index, day_key in enumerate(window.included):
            if day_key in rolled:
                included.append(day_key)
                continue
            day = date.fromisoformat(day_key)
            paths = stretch_day(conn, store, question.city, day)
            if paths is None and remote is not None:
                paths = stretch_day(conn, remote, question.city, day)
            if paths is None:
                # The v12 day exists, but its stretch timing is not published yet.
                window.measured.remove(day_key)
                window.missing.append(day_key)
                window.unmeasured_reasons[day_key] = "stretch_timing_missing"
                continue
            included.append(day_key)
            days.append(paths)
            trip_days.append(window.paths[TRIP_DAYS][index])
        window.included = included
        window.missing.sort()
        readings = stretch_readings(conn, days, cut, trip_days, months, question.day_type)
    columns = (
        "from_stop", "to_stop", "pieces", "piece", "length_m",
        "from_lat", "from_lon", "to_lat", "to_lon", "passes",
        "clear_run_seconds", "median_seconds", "time_lost_seconds",
        "total_time_lost_seconds", "clear_run_speed_kmh",
    )  # fmt: skip
    fields: dict[str, list[Any]] = {column: [] for column in (*columns, "value", "state")}
    value_of = {
        STRETCH_TIME_LOST: "time_lost_seconds",
        STRETCH_CLEAR_RUN_SPEED: "clear_run_speed_kmh",
    }.get(question.measure)
    for reading in readings:
        check_query()
        for column in columns:
            fields[column].append(getattr(reading, column))
        timed = reading.clear_run_seconds is not None
        fields["value"].append(getattr(reading, value_of) if value_of and timed else None)
        fields["state"].append("measured" if timed else "too_few_to_judge")
    return {
        "measure": question.measure,
        "minimum_sample": family.minimum_sample,
        **fields,
        "evidence": window.evidence(store, question, family, started),
        "info": [_info(family, measure) for measure in selected],
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
    if question.lines:
        trip_filter += " AND t.route_id = ANY(?)"
        trip_parameters.append(list(question.lines))
    clean_events = int(version) >= STOP_ELIGIBILITY_VERSION
    stop_filter = trip_filter.replace("t.", "s.") if clean_events else ""
    stop_parameters = trip_parameters.copy() if clean_events else []
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
    entity = _entity_sql(group, question.group, hour)
    if question.network_corridors:
        entity_columns = "from_stop, to_stop"
        entity = "row(from_stop, to_stop)"
    routes = "list(DISTINCT route_id)" if group or question.network_corridors else "NULL"
    window = [question.city, version, question.start, question.end]
    if SEGMENT_RUNS in paths:
        type_cut, type_parameters = _trip_type_cut(question, version, paths)
        runs = SEGMENT_RUNS_SQL.format(cut=f"({cut}) {type_cut}", trip_identity="")
        args = [
            paths[FEED_POLLS], *window, paths[SEGMENT_RUNS], *window, *parameters, *type_parameters
        ]
    else:
        if question.route_type is not None:
            if int(version) >= 6:
                trip_filter += " AND t.route_type = ?"
                trip_parameters.append(question.route_type)
            else:
                trip_filter += " AND false"
        runs = CORRIDOR_RUNS_SQL.format(cut=cut, trip_filter=trip_filter, stop_filter=stop_filter)
        args = [
            paths[STOP_EVENTS], *window, *stop_parameters,
            paths[TRIP_DAYS], *window, *trip_parameters,
            paths[FEED_POLLS], *window, *parameters,
        ]
    rows = conn.execute(
        f"""
        WITH {runs}
        SELECT {entity} AS entity,
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
        "Compares observed travel time between two consecutive stops of the same trip against "
        "the timetable. Time lost is observed elapsed time minus scheduled elapsed time between "
        "matching stop events; an arrival at the first stop or departure at the second includes "
        "that stop’s dwell in both durations. Hour uses the first stop’s scheduled departure "
        "(or arrival if missing), and day type uses the trip’s service date.",
        "Compare le temps de parcours observé entre deux arrêts consécutifs d’un même trajet "
        "au temps prévu à l’horaire. Le temps perdu correspond à la durée observée moins la "
        "durée prévue entre les passages correspondants; une arrivée au premier arrêt ou un "
        "départ au second inclut le temps d’arrêt correspondant dans les deux durées. L’heure "
        "suit le départ prévu au premier arrêt (ou son arrivée à défaut), et le type de jour "
        "suit la date de service du trajet.",
    ),
    exclusions=Text(
        "Cancelled trips, lines without live data, segments missing an endpoint observation, "
        "mismatched observation types and capture outages are left out. Both stops must share "
        "the same observation basis (stopped vehicle, nearby GPS fix, exact agency report or "
        "passed-stop estimate). Runs with nonpositive scheduled time, negative observed time or "
        f"observed time above {MAX_SEGMENT_RUN_MULTIPLE} times the schedule are also excluded. "
        "Every recorded trip or vehicle feed must cover the run with polls at most "
        f"{MAX_POLL_SPACING_SECONDS} s apart and publication age at most "
        f"{MAX_POLL_AGE_SECONDS} s plus the declared source lag.",
        "Les trajets annulés, les lignes sans données en direct, les segments sans observation "
        "aux deux extrémités, les observations de types non comparables et les interruptions de "
        "collecte sont exclus. Les deux arrêts doivent reposer sur la même base d’observation "
        "(véhicule à l’arrêt, GPS à proximité, rapport exact ou estimation après passage). Les "
        "parcours ayant une durée prévue nulle ou négative, une durée observée négative ou une "
        f"durée dépassant {MAX_SEGMENT_RUN_MULTIPLE} fois la durée prévue sont aussi exclus. "
        "Chaque flux de trajets ou de véhicules enregistré doit couvrir le parcours avec des "
        f"relevés espacés d’au plus {MAX_POLL_SPACING_SECONDS}\u00a0s et une publication "
        f"datant d’au plus {MAX_POLL_AGE_SECONDS}\u00a0s plus le décalage déclaré de la source.",
    ),
    limits=Text(
        "It shows where vehicles lose time relative to the schedule, not the cause of delay or "
        f"how many riders were delayed. At least {MIN_SEGMENT_RUNS} observed runs are required "
        "per result so the upper tenth represents at least two runs. Line totals pool matched "
        "runs across segments.",
        "Elle indique où les véhicules perdent du temps par rapport à l’horaire, sans dire la "
        f"cause du retard ni le nombre d’usagers touchés. Il faut au moins {MIN_SEGMENT_RUNS} "
        "parcours observés par résultat afin que le dixième supérieur représente au moins deux "
        "parcours. Les totaux d’une ligne regroupent les parcours appariés de ses segments.",
    ),
    measures=(
        Measure(
            CORRIDOR_RANKING_DEFAULT,
            "seconds",
            Text(
                "Middle time lost per stop-to-stop run compared with the schedule.",
                "Temps perdu médian par parcours entre deux arrêts par rapport à l’horaire.",
            ),
            percentile=50,
            worst_first_descending=True,
            ranking_kinds=("segment",),
        ),
        Measure(
            "p90_time_lost",
            "seconds",
            Text(
                "Time lost per run at or below which about 9 in 10 observed runs fall.",
                "Temps perdu par parcours que ne dépassent pas environ 90\u00a0% des parcours "
                "observés.",
            ),
            percentile=90,
            ranking_kinds=(),
        ),
        Measure(
            "mean_time_lost",
            "seconds",
            Text(
                "Average time lost per stop-to-stop run compared with the schedule.",
                "Temps perdu moyen par parcours entre deux arrêts par rapport à l’horaire.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "total_vehicle_minutes_lost",
            "vehicle_minutes",
            Text(
                "Net vehicle-minutes lost across observed runs, counting time saved against "
                "time lost.",
                "Minutes-véhicules nettes perdues sur l’ensemble des parcours observés, en "
                "tenant compte du temps gagné.",
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
    "Percentiles above 10 minutes are reported as over 10 minutes. Median and 90th percentile "
    "use 1-s bins up to 10 minutes.",
    "Un centile dépassant 10 minutes est indiqué comme supérieur à 10 minutes. La médiane et "
    "le 90e centile utilisent des classes de 1\u00a0s jusqu’à 10 minutes.",
)
_VEHICLE_SCORECARD_LIMITS = Text(
    "Vehicle reporting time is inferred from captured positions rather than continuous "
    "tracking. Each state extends to the next capture, capped at three reporting intervals "
    "after its last sighting (or one interval for the final sighting), using that day’s "
    "median spacing between feed publications; an hour filter keeps only time within that "
    "local hour.",
    "La durée de signalement est estimée à partir des positions captées plutôt que d’un suivi "
    "continu. Chaque état se prolonge jusqu’à la collecte suivante, au plus trois intervalles "
    "de signalement après sa dernière collecte (ou un intervalle pour la dernière), selon "
    "l’écart médian entre les publications du flux ce jour-là; le filtre horaire ne retient "
    "que la durée comprise dans cette heure locale.",
)
_SCORECARD = Family(
    id=SCORECARD,
    label=Text("Open data scorecard", "Bilan des données ouvertes"),
    method_version="3",
    since="2026-11-22",
    tables=(),
    minimum_sample=MIN_SCORECARD_SAMPLES,
    counts=Text(
        "Counts accompany each scorecard result.",
        "Les effectifs accompagnent chaque résultat du bilan.",
    ),
    exclusions=Text(
        "Days without the required daily data are left out.",
        "Les jours sans les données quotidiennes requises sont exclus.",
    ),
    limits=Text(
        "This scorecard reflects only the public feeds Transit collected, not internal agency "
        "systems.",
        "Ce bilan porte uniquement sur les flux publics recueillis par Transit, et non sur les "
        "systèmes internes de la société de transport.",
    ),
    measures=(
        Measure(
            "poll_success",
            "share",
            Text(
                "Share of capture attempts that returned a valid feed, including empty or "
                "unchanged replies.",
                "Part des tentatives de collecte ayant renvoyé un flux valide, y compris les "
                "flux vides ou inchangés.",
            ),
            counts=Text(
                "Counts capture attempts by outcome and tracks how often a feed came back empty.",
                "Compte les tentatives par résultat et suit la part des réponses vides.",
            ),
            exclusions=Text(
                "Duplicate attempts spanning two day windows count once.",
                "Les tentatives communes à deux journées ne comptent qu’une fois.",
            ),
            limits=Text(
                "Feeds without recorded capture attempts have no measured share.",
                "La part reste non mesurée pour les flux sans tentative enregistrée.",
            ),
            extra_tables=(FEED_POLLS,),
        ),
        Measure(
            "feed_update_interval",
            "seconds",
            Text(
                "Time between consecutive changes in a feed’s published timestamp.",
                "Temps entre deux changements successifs de l’horodatage publié par un flux.",
            ),
            counts=Text(
                "Counts valid timestamped captures, intervals between updates and values over "
                "10 minutes.",
                "Compte les collectes valides horodatées, les intervalles entre mises à jour "
                "et les valeurs dépassant 10 minutes.",
            ),
            exclusions=Text(
                "Intervals crossing a capture gap of more than 2 minutes or moving backward in "
                "time are left out. Updates use valid timestamped attempts, while all attempts "
                "(including errors) are checked for gaps.",
                "Les intervalles qui traversent une interruption de plus de 2 minutes ou dont "
                "l’horodatage recule sont exclus. Les mises à jour utilisent les tentatives "
                "valides horodatées, mais toutes les tentatives (erreurs comprises) servent à "
                "repérer les interruptions.",
            ),
            limits=Text(
                "Transit cannot see updates faster than its own polling interval: faster feeds "
                "appear to update on every poll. " + _FEED_HISTOGRAM_LIMITS.en,
                "Transit ne peut pas observer de mises à jour plus rapides que sa propre "
                "fréquence de collecte\u00a0: un flux plus rapide semble se mettre à jour à "
                "chaque collecte. " + _FEED_HISTOGRAM_LIMITS.fr,
            ),
            extra_tables=(FEED_POLLS,),
        ),
        Measure(
            "feed_age_at_capture",
            "seconds",
            Text(
                "Elapsed time from when a feed says it was published to when Transit collected "
                "it.",
                "Temps écoulé entre l’horodatage publié par un flux et sa collecte par Transit.",
            ),
            counts=Text(
                "Counts valid timestamped captures, measured ages and values over 10 minutes.",
                "Compte les collectes valides horodatées, les âges mesurés et les valeurs "
                "dépassant 10 minutes.",
            ),
            exclusions=Text(
                "Captures with a missing timestamp or a negative age are left out and counted "
                "separately.",
                "Les collectes sans horodatage ou dont l’âge est négatif sont exclues et "
                "comptées à part.",
            ),
            limits=_FEED_HISTOGRAM_LIMITS,
            extra_tables=(FEED_POLLS,),
        ),
        Measure(
            "vehicle_field_completeness",
            "share",
            Text(
                "Share of vehicle reporting time that includes each field: trip, line, stop, "
                "current state, occupancy level or percentage, and position.",
                "Part de la durée de signalement des véhicules où chaque champ est "
                "présent\u00a0: trajet, ligne, arrêt, état actuel, niveau ou pourcentage "
                "d’occupation et position.",
            ),
            counts=Text(
                "Compares vehicle reporting time carrying each field against total reporting "
                "time.",
                "Compare la durée de signalement comportant chaque champ à la durée totale de "
                "signalement.",
            ),
            exclusions=Text(
                "Fields declared unpublished by the network are shown as not published.",
                "Les champs déclarés non publiés par le réseau sont indiqués comme non publiés.",
            ),
            limits=_VEHICLE_SCORECARD_LIMITS,
            extra_tables=(VEHICLE_POSITIONS, FEED_POLLS),
        ),
        Measure(
            "live_trip_coverage",
            "share",
            Text(
                "Share of scheduled trips on live-tracked lines that appeared at least once in "
                "the realtime feed.",
                "Part des trajets prévus sur les lignes suivies en direct qui sont apparus au "
                "moins une fois dans le flux en temps réel.",
            ),
            counts=Text(
                "Compares trips seen in realtime with scheduled trips on lines seen on any "
                "measured day. Evidence also reports the count and share of scheduled trips on "
                "lines never seen in the selection.",
                "Compare les trajets vus en temps réel aux trajets prévus sur les lignes vues "
                "au moins un jour mesuré. Les données indiquent aussi le nombre et la part des "
                "trajets sur des lignes jamais vues dans la sélection.",
            ),
            exclusions=Text(
                "Added trips, days with capture gaps and lines never seen in realtime are left "
                "out of the coverage rate.",
                "Les trajets ajoutés, les jours touchés par une interruption de collecte et "
                "les lignes jamais vues en temps réel sont exclus du taux.",
            ),
            limits=Text(
                "A line only has to appear once in the selected dates to enter the live-tracked "
                "group; unseen trips may reflect missing feeds rather than cancelled service. "
                "Verified trip days can still confirm a line’s presence even when a capture "
                "gap excludes that day from the rate. Hour uses scheduled trip start, and stop "
                "filters keep trips serving that stop.",
                "Il suffit qu’une ligne apparaisse une fois aux dates choisies pour entrer "
                "dans le groupe suivi en direct; un trajet absent peut refléter un manque du "
                "flux plutôt qu’une annulation. Les jours vérifiés peuvent confirmer la "
                "présence d’une ligne même lorsqu’une interruption exclut ce jour du taux. "
                "L’heure suit le départ prévu du trajet et le filtre d’arrêt retient les "
                "trajets qui desservent cet arrêt.",
            ),
            extra_tables=(TRIP_DAYS,),
        ),
        Measure(
            "vehicles_without_trip",
            "share",
            Text(
                "Share of vehicle reporting time sent without a trip identifier.",
                "Part de la durée de signalement des véhicules transmise sans identifiant de "
                "trajet.",
            ),
            counts=Text(
                "Compares reporting time missing a trip ID against total reporting time, and "
                "counts distinct vehicles affected.",
                "Compare la durée de signalement sans identifiant de trajet à la durée totale, "
                "et compte les véhicules distincts touchés.",
            ),
            exclusions=Text(
                "Line, direction and stop filters keep only reports that include a matching "
                "line, direction or stop.",
                "Les filtres par ligne, direction et arrêt retiennent uniquement les relevés "
                "contenant une correspondance.",
            ),
            limits=_VEHICLE_SCORECARD_LIMITS,
            extra_tables=(VEHICLE_POSITIONS, FEED_POLLS),
        ),
        Measure(
            "prediction_error",
            "seconds",
            Text(
                "How close arrival predictions were to observed stops at each lead time, "
                "reporting median error (predicted minus observed), 90th percentile error and "
                "share within 1 minute.",
                "Écart entre les prévisions d’arrivée et les passages observés selon "
                "l’horizon, en indiquant l’erreur médiane (prévision moins observation), le "
                "90e centile de l’erreur absolue et la part à au plus une minute près.",
            ),
            counts=Text(
                "Counts observed stop events by observation type and how many predictions "
                "landed within 1 minute of actual arrival.",
                "Compte les passages observés aux arrêts par type d’observation et le nombre "
                "de prévisions tombant à au plus une minute de l’arrivée réelle.",
            ),
            exclusions=Text(
                "Passed stops are left out because their recorded time is itself a prediction. "
                "Error figures use vehicles seen stopped at a stop, while nearby GPS fixes and "
                "exact agency times are counted separately.",
                "Les arrêts dépassés sont exclus parce que leur heure enregistrée est "
                "elle-même une prévision. Les statistiques d’erreur reposent sur les véhicules "
                "vus à l’arrêt, tandis que les positions GPS à proximité et les heures exactes "
                "de la société de transport sont comptées à part.",
            ),
            limits=Text(
                "It checks only stops where a vehicle was observed stopped, not every "
                "prediction riders saw on a screen. Each horizon requires at least "
                f"{MIN_PREDICTION_SAMPLES} observed stop events. Percentiles use "
                f"{DELAY_BIN_SECONDS}-s bins, and the ±1-minute band includes both boundaries. "
                "The whole record was recomputed with this method on 22 November 2026. "
                "Each horizon takes the latest forecast from its lower "
                "lead bound up to the next horizon (exclusive), with the 30-minute bucket "
                "ending before 40 minutes ahead. Trip-update capture must cover the lead window "
                "continuously, and hour uses the observed local hour.",
                "Elle ne vérifie que les arrêts où un véhicule a été observé à l’arrêt, et non "
                "toutes les prévisions affichées aux usagers. Chaque horizon exige au moins "
                f"{MIN_PREDICTION_SAMPLES} passages observés aux arrêts. Les centiles "
                f"utilisent des classes de {DELAY_BIN_SECONDS}\u00a0s, et la bande d’au plus "
                "une minute inclut ses bornes. Tout le bilan a été recalculé avec cette méthode "
                "le 22 novembre 2026. Chaque horizon retient la prévision la plus récente "
                "entre son délai minimal et l’horizon "
                "suivant, exclu; l’horizon de 30 minutes exclut les prévisions faites "
                "40 minutes ou plus à l’avance. La collecte des mises à jour des trajets doit "
                "être continue pendant cette période, et l’heure suit l’heure locale observée.",
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
    "trips_not_published": Text(
        "Trips without a published accessibility field",
        "Trajets sans champ d’accessibilité publié",
    ),
    "stops_accessible": Text("Accessible stops", "Arrêts accessibles"),
    "stops_not_accessible": Text("Not accessible stops", "Arrêts non accessibles"),
    "stops_no_information": Text("Stops without information", "Arrêts sans information"),
    "stops_not_published": Text(
        "Stops without a published accessibility field",
        "Arrêts sans champ d’accessibilité publié",
    ),
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
        "Divides scheduled trips or distinct served stops declared wheelchair accessible by "
        "those with a published declaration. Each scheduled trip or distinct served stop "
        "counts once, using each stop’s declaration on its latest service date in the "
        "selection. In GTFS, 1 means accessible and 0 means no information.",
        "Divise les trajets prévus ou les arrêts distincts desservis déclarés accessibles en "
        "fauteuil roulant par ceux qui comportent une déclaration publiée. Chaque trajet prévu "
        "ou arrêt distinct desservi compte une fois, selon la déclaration de l’arrêt à sa "
        "dernière date de service dans la sélection. En GTFS, 1 signifie accessible et 0 "
        "signifie aucune information.",
    ),
    exclusions=Text(
        "Added trips are left out, and trips or stops in schedules without an accessibility "
        "field are marked not published rather than counted as zero.",
        "Les trajets ajoutés sont exclus, et les trajets ou arrêts dont l’horaire ne publie "
        "pas le champ d’accessibilité sont indiqués comme non publiés, jamais comptés comme zéro.",
    ),
    limits=Text(
        "It reflects what the agency declares in its timetable, not whether a ramp worked or "
        "an elevator was in service. A stop inherits its parent station’s declaration when it "
        "publishes none of its own.",
        "Elle reflète ce que déclare la société de transport dans son horaire, et non si une "
        "rampe fonctionnait ou si un ascenseur était en service. Un arrêt hérite de la "
        "déclaration de sa station parente lorsqu’il n’en publie pas lui-même.",
    ),
    measures=(
        Measure(
            "accessible_trips",
            "share",
            Text(
                "Share of scheduled trips the agency declares wheelchair accessible.",
                "Part des trajets prévus que la société de transport déclare accessibles en "
                "fauteuil roulant.",
            ),
            ranking_kinds=(),
        ),
        Measure(
            "accessible_stops",
            "share",
            Text(
                "Share of distinct served stops the agency declares wheelchair accessible.",
                "Part des arrêts distincts desservis que la société de transport déclare "
                "accessibles en fauteuil roulant.",
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
    _CLEAR_RUN,
    _STRETCH_TIMING,
    _SCORECARD,
    _ACCESSIBILITY,
)
_DELAY_DISTRIBUTION = Measure(
    id=_DELAY_DISTRIBUTION_ID,
    unit="share",
    definition=Text(
        "Share of observed stop events falling in each one-minute delay band against the "
        "timetable. Outer bands count more than 5 minutes early and 15 minutes late or more. "
        "Exactly 1 minute early and exactly 5 minutes late both count as on time.",
        "Part des passages observés aux arrêts dans chaque tranche d’une minute par rapport à "
        "l’horaire. Les tranches extrêmes comptent plus de 5 minutes d’avance et 15 minutes de "
        "retard ou plus. Un passage avec exactement 1 minute d’avance ou 5 minutes de retard "
        "est à l’heure.",
    ),
    ranking_kinds=(),
)
_DELAY_DISTRIBUTION_COLUMNS = {
    "min_seconds": Text("Minimum delay (s)", "Retard minimal (s)"),
    "max_seconds": Text("Maximum delay (s)", "Retard maximal (s)"),
    "stop_events": Text("Stop events", "Passages aux arrêts"),
}
_SELECTIONS = {
    key: (family, selected)
    for family in _FAMILIES
    for key, selected in (
        (family.id, family.measures),
        *((measure.id, (measure,)) for measure in family.measures),
    )
}
_SELECTIONS[_DELAY_DISTRIBUTION_ID] = (_PUNCTUALITY, (_DELAY_DISTRIBUTION,))


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
    partial_receipts: dict[str, str] = field(default_factory=dict)

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
                "The record of notices is missing for some dates. Published periods can still "
                "cover those dates.",
                "Le bilan des avis manque pour certaines dates. Les périodes publiées "
                "peuvent quand même couvrir ces dates.",
            )._asdict()
        return _PARTIAL._asdict() if self.measured and self.missing else None

    def batches(self, *, days: int | None = None) -> Iterator[dict[str, list[str]]]:
        size = self.batch_days or days or DAYS_PER_QUERY_BATCH
        days_read = len(next(iter(self.paths.values())))
        for offset in range(0, days_read, size):
            check_query()
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


def _partial_scope(question: Question, family: Family) -> bool:
    if question.layer_map:
        return True
    cuts = question.cuts()
    if family.id == _SERVICE_DELIVERED_ID:
        return cuts.keys() == {"stop"} and question.group in {None, "day"}
    if family.id == _VEHICLES_ID:
        return (
            (question.measure == "vehicle_days_in_service" and question.group == "vehicle"
             and not cuts)
            or (question.vehicle is not None and cuts.keys() == {"vehicle"}
                and question.group in {None, "day"})
        )
    return not cuts and question.group is None and (
        family.id in {_CROWDING_ID, _WAITING_ID}
        or question.measure in {"vehicle_field_completeness", "vehicles_without_trip"}
    )


def _daily_partial[T](
    store: Store,
    window: ReadWindow,
    family: Family,
    question: Question,
    day: str,
    measure: str,
    compute: Callable[[], T],
) -> T:
    if store.partial_results is None or day not in window.partial_receipts:
        return compute()
    key: tuple[str | None, ...] = (
        store.root, question.city, day, str(window.versions[day]), family.id,
        family.method_version, measure, question.group, question.vehicle, question.stop,
        window.partial_receipts[day],
    )
    if question.layer_map:
        key += (json.dumps(question.cuts(), sort_keys=True),)
    return store.partial_results.read_or_compute(key, compute)


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
    if family is _CLEAR_RUN and question.route_type is not None:
        tables += (TRIP_DAYS,)
    if family.id == _CORRIDORS_ID:
        preferred_tables = (SEGMENT_RUNS, FEED_POLLS)
        if group is not None or question.route_type is not None:
            preferred_tables += (TRIP_DAYS,)
    if question.network_corridors:
        tables = preferred_tables
        preferred_tables = ()
    if group and family.id == _ALERT_COUNTS_ID:
        tables += (TRIP_DAYS, STOP_EVENTS) if group == "stop" else (TRIP_DAYS,)
    # Bound window sorts over dense position records and stop sequences.
    batch_days = (
        1 if VEHICLE_POSITIONS in tables or family.id in {_WAITING_ID, _CLEAR_RUN_ID}
        or (family.id == _SERVICE_DELIVERED_ID and question.stop is not None)
        or (family.id == _CORRIDORS_ID and not question.network_corridors) else None
    )
    window = ReadWindow({table: [] for table in tables}, batch_days=batch_days)
    uses_poll_coverage = FEED_POLLS in tables and family.query is not None
    cacheable = (
        store.partial_results is not None and store.s3_endpoint is None and group is None
        and _partial_scope(question, family)
    )
    if (uses_poll_coverage or cacheable) and receipts is None:
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
            with track_connection(conn.cursor()) as cursor:
                checked = store.query_day(cursor, question.city, day, tables, receipts=receipt)
            return day, checked, receipt

        with ThreadPoolExecutor(max_workers=4) as executor:
            for days in batched(map(date.fromordinal, ordinals), 16):
                futures = [executor.submit(copy_context().run, check, day) for day in days]
                for future in futures:
                    day, checked, receipt = future.result()
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
            if (question.network_corridors or family is _CLEAR_RUN) and (
                checked.invalid_table == SEGMENT_RUNS
            ):
                raise NetworkCorridorsUnavailable(
                    "segment_runs_missing", f"Clean segment runs are unavailable for {day_key}"
                )
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
                if cacheable and settled and receipts is not None:
                    window.partial_receipts[day_key] = sha256(receipts[day_key]).hexdigest()
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


def _canonical_alert_spans(
    spans: set[AlertSpan], reissues: dict[NoticeKey, NoticeKey]
) -> set[AlertSpan]:
    if not reissues:
        return spans
    return {
        AlertSpan(*reissues.get(span.publication, span.publication), span.start, span.end)
        for span in spans
    }


def _alert_answer(
    selected: tuple[Measure, ...], totals: Batch, window: ReadWindow
) -> tuple[str, dict[str, float | None], dict[str, Any], dict[str, int]]:
    spans = _canonical_alert_spans(totals.alert_spans, translation_reissues(totals.alert_variants))
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
    version_count = len({span.publication for span in totals.alert_spans})
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
    state, scheduled = _corridor_state(family, counts, window)
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


def _corridor_state(
    family: Family, counts: Counter[str], window: ReadWindow
) -> tuple[str, int]:
    without_live = counts["route_without_live_data"]
    scheduled = counts["scheduled_runs"] - without_live - counts["cancelled"]
    return _state(
        family, counts["observed_runs"], scheduled, counts["capture_gap"],
        without_live, window.no_days_measured,
    ), scheduled


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
    state = _waiting_state(family, counts, window)
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


def _waiting_state(family: Family, counts: Counter[str], window: ReadWindow) -> str:
    sample = counts["observed_headways"]
    frequent = counts["frequent_headways"]
    if not window.no_days_measured and not frequent and not sample:
        if counts["live_direction_stops"]:
            return "no_frequent_periods"
        if counts["scheduled_stops"] and not counts["live_candidates"]:
            return "no_live_data"
    return _state(
        family, sample, frequent, 0, 0, window.no_days_measured,
        coverage_sample=min(sample, frequent),
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
                counts, ids = _daily_partial(
                    store, window, family, question, day, "vehicle_fields",
                    bind(
                        vehicle_counts, conn,
                        paths[VEHICLE_POSITIONS], paths[FEED_POLLS], paths.get(TRIP_DAYS),
                        question.city, [str(window.versions[day])], filters, arguments,
                        question.hour,
                    ),
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
    if (question.network_corridors or question.measure == CLEAR_RUN_TIME_LOST) and (
        store.cleaning_version < SEGMENT_RUNS_VERSION
    ):
        raise NetworkCorridorsUnavailable(
            "segment_runs_version_required",
            f"Network corridors require cleaning version {SEGMENT_RUNS_VERSION} or later",
        )
    family, selected = _SELECTIONS[question.measure]
    if family is _SERVICE_DELIVERED and question.stop is not None:
        family = replace(family, tables=(*family.tables, STOP_EVENTS))
        selected = tuple(
            replace(measure, counts=Text(
                f"{_STOP_DELIVERY_COUNTS.en} {(measure.counts or family.counts).en}",
                f"{_STOP_DELIVERY_COUNTS.fr} {(measure.counts or family.counts).fr}",
            ))
            for measure in selected
        )
    if family is _STRETCH_TIMING:
        return _stretch_answer(store, question, family, selected, started)
    if question.group:
        return _series_answer(store, question, family, selected, question.group, started)
    totals = Batch()
    with service_query(store, question.city) as conn:
        if family.query is None:
            return _scorecard_answer(conn, store, question, family, selected, started)
        window = read_window(conn, store, question, family, selected)
        batches = _series_query_batches(conn, store, family, question, window)
        for offset, result in enumerate(batches):
            window.record_vehicle_tracking(family, offset, result)
            if () in result:
                totals.update(result[()])
    return measure_answer(store, question, family, selected, totals, window, started)


def measure_answer(
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    totals: Batch,
    window: ReadWindow,
    started: float,
) -> dict[str, Any]:
    distribution = question.measure == _DELAY_DISTRIBUTION_ID
    state, values, family_evidence, _ = evaluate(
        family, () if distribution else selected, totals, window, hour=question.hour
    )
    if family.id == _SERVICE_DELIVERED_ID and _single_day_departure(question):
        family_evidence["trip_ids"] = sorted(totals.trip_ids)
    if question.alert_details:
        messages = None
        if state == "measured":
            reissues = translation_reissues(totals.alert_variants)
            spans = _canonical_alert_spans(totals.alert_spans, reissues)
            reissue_ids: dict[NoticeKey, set[str]] = {}
            for original, target in reissues.items():
                if original[1] != target[1]:
                    reissue_ids.setdefault(target, set()).add(original[1])
            periods: dict[NoticeKey, list[dict[str, str]]] = {}
            epoch = datetime(1970, 1, 1, tzinfo=UTC)
            for span in sorted(spans, key=lambda span: (span.start, span.end)):
                periods.setdefault(span.publication, []).append({
                    "start": (epoch + timedelta(microseconds=span.start)).isoformat(),
                    "end": (epoch + timedelta(microseconds=span.end)).isoformat(),
                })
            messages = [
                {
                    **totals.alert_messages[key],
                    "periods": periods[key],
                    **({"reissue_ids": sorted(reissue_ids[key])} if key in reissue_ids else {}),
                }
                for key in sorted(periods)
            ]
        family_evidence["alert_messages"] = messages
    return {
        "measure": question.measure,
        **(
            {
                "group": "delay_minute",
                "cells": _delay_distribution_cells(totals, state, window.included),
            }
            if distribution
            else {"value": values}
        ),
        "state": state,
        "state_text": _STATES[state]._asdict(),
        "coverage_note": window.coverage_note,
        "evidence": {**window.evidence(store, question, family, started), **family_evidence},
        "info": [
            _info(
                family,
                measure,
                _DELAY_DISTRIBUTION_COLUMNS if distribution
                else _ALERT_MESSAGE_COLUMN if question.alert_details else None,
            )
            for measure in selected
        ],
    }


def _delay_distribution_cells(
    totals: Batch, state: str, included: list[str]
) -> list[dict[str, Any]]:
    if state != "measured":
        return []
    cells = []
    for edge in range(
        _DELAY_TAIL_START - _DELAY_MINUTE_SECONDS,
        _DELAY_TAIL_END + _DELAY_MINUTE_SECONDS,
        _DELAY_MINUTE_SECONDS,
    ):
        count = totals.histogram[edge]
        next_edge = edge + _DELAY_MINUTE_SECONDS
        lower = edge + 1 if edge == LATE_LIMIT_SECONDS else edge
        upper = next_edge if next_edge == LATE_LIMIT_SECONDS else next_edge - 1
        cells.append({
            "key": {
                "min_seconds": None if edge < _DELAY_TAIL_START else lower,
                "max_seconds": None if edge == _DELAY_TAIL_END else upper,
                "band": (
                    "early" if edge < EARLY_LIMIT_SECONDS else
                    "on_time" if edge < LATE_LIMIT_SECONDS else "late"
                ),
            },
            "value": {
                _DELAY_DISTRIBUTION_ID: count / totals.counts["classified"],
                "stop_events": count,
            },
            "state": state,
            "state_text": _STATES[state]._asdict(),
            "evidence": {
                "counts": {"stop_events": count}, "excluded": {}, "days_included": included,
            },
        })
    return cells


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
    query = family.query
    assert query is not None
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
            result = query(conn, family, window.paths, question, version, None)
        except duckdb.OutOfMemoryException:
            pass
        else:
            yield result
            return
    for offset, batch in enumerate(window.batches()):
        if window.partial_receipts:
            yield _daily_partial(
                store, window, family, question, window.included[offset], question.measure,
                bind(query, conn, family, batch, question, version, None),
            )
        else:
            yield query(conn, family, batch, question, version, None)


# No data (0) covers both insufficient coverage and an unknown observation.
_MAP_STATES = {"too_few_to_judge": 1, "no_live_data": 2, "measured": 3}


def _layer_totals(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    question: Question,
    family: Family,
    window: ReadWindow,
) -> dict[EntityKey, Batch]:
    query = family.query
    assert query is not None
    version = str(store.cleaning_version)

    def daily(paths: dict[str, list[str]]) -> dict[
        EntityKey, tuple[dict[str, int], dict[int, int], float]
    ]:
        return {
            key: (dict(part.counts), dict(part.histogram), part.waiting_weighted_excess)
            for key, part in query(conn, family, paths, question, version, None).items()
        }

    totals: dict[EntityKey, Batch] = {}
    for offset, paths in enumerate(window.batches()):
        parts = _daily_partial(
            store, window, family, question, window.included[offset],
            question.measure, bind(daily, paths),
        )
        for key, (counts, histogram, weighted_excess) in parts.items():
            part = totals.get(key)
            if part is None:
                totals[key] = Batch(
                    counts=Counter(counts), histogram=Counter(histogram),
                    waiting_weighted_excess=weighted_excess,
                )
            else:
                part.counts.update(counts)
                part.histogram.update(histogram)
                part.waiting_weighted_excess += weighted_excess
    return totals


def _layer_map_answer(
    store: Store,
    question: Question,
    family: Family,
    selected: tuple[Measure, ...],
    group: SeriesGroup,
    started: float,
    window: ReadWindow,
    totals: dict[EntityKey, Batch],
) -> dict[str, Any]:
    fields: dict[str, list[Any]] = {column: [] for column in GROUP_COLUMNS[group]}
    for column in ("value", "sample", "state", "share_observed", "low_coverage"):
        fields[column] = []
    clear = family is _CLEAR_RUN
    extras = (
        ("clear_run_seconds", "median_run_seconds", "trips_counted", "observed_seconds")
        if clear else ("frequent_headways", "wait_weight", "weighted_excess")
    )
    fields.update({column: [] for column in extras})
    for key in sorted(totals, key=lambda row: tuple((value is None, value) for value in row)):
        check_query()
        part = totals[key]
        counts = part.counts
        readings: tuple[int | float | None, ...]
        if clear:
            state, scheduled = _corridor_state(family, counts, window)
            sample = counts["observed_runs"]
            coverage = _coverage_evidence(family, sample, scheduled)
            reference = median = value = None
            if state == "measured":
                reference, median = clear_run_times(part.histogram, sample)
                value = median - reference
            readings = (reference, median, counts["trips_counted"], counts["observed_seconds"])
        else:
            state = _waiting_state(family, counts, window)
            sample, frequent = counts["observed_headways"], counts["frequent_headways"]
            coverage = _coverage_evidence(family, min(sample, frequent), frequent)
            weight = counts["wait_weight"]
            weighted = part.waiting_weighted_excess if weight else None
            value = weighted / weight if state == "measured" and weighted is not None else None
            if state == "measured" and value is None:
                state = "unknown"
            readings = (frequent, weight, weighted)
        for column, item in zip(GROUP_COLUMNS[group], key, strict=True):
            fields[column].append(item)
        for column, reading in zip(extras, readings, strict=True):
            fields[column].append(reading)
        fields["value"].append(value)
        fields["sample"].append(sample)
        fields["state"].append(state)
        fields["share_observed"].append(coverage.get("share_observed"))
        fields["low_coverage"].append(coverage.get("low_coverage", False))
    return {
        "measure": question.measure,
        "minimum_sample": family.minimum_sample,
        **fields,
        "evidence": window.evidence(store, question, family, started),
        "info": [_info(family, measure) for measure in selected],
    }


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
    columns: tuple[str, ...] = ("stop",) if stops else ("direction", "from_stop", "to_stop")
    network = question.network_corridors
    if network:
        columns = ("from_stop", "to_stop")
    keys: dict[str, list[str | int | None]] = {column: [] for column in columns}
    lines: list[list[str]] = []
    samples: list[int] = []
    states: list[int] = []
    values: list[float | int | None] = []
    ordered_keys = sorted(totals) if network else _series_keys(question, group, set(totals), {})
    for key in ordered_keys:
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
        if network:
            lines.append(sorted(part.scheduled_routes))
        for column, item in zip(columns, key if stops or network else key[1:], strict=True):
            keys[column].append(item)
        samples.append(sample)
        states.append(_MAP_STATES.get(state, 0))
        values.append(value)
    return {
        "measure": question.measure,
        **keys,
        **({"lines": lines} if network else {}),
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
    overall = Batch()
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
        replace(question, group="hour" if hourly else None, include_overall=False)
        if position_series and group not in ("line", "vehicle")
        else question
    )
    occupancy_days: set[str] = set()
    with service_query(store, question.city) as conn:
        window = read_window(conn, store, question, family, selected)
        if question.layer_map:
            layer_totals = _layer_totals(conn, store, question, family, window)
            return _layer_map_answer(
                store, question, family, selected, group, started, window, layer_totals
            )
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
                    if question.include_overall:
                        overall.update(part)
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
    combined = {}
    if question.include_overall:
        state, values, evidence, _ = _vehicle_answer(selected, overall, window)
        overall_question = replace(question, group=None, include_overall=False)
        combined["overall"] = {
            "measure": question.measure,
            "value": values,
            "state": state,
            "state_text": _STATES[state]._asdict(),
            "coverage_note": window.coverage_note,
            "evidence": {
                **window.evidence(store, overall_question, family, started),
                **evidence,
            },
            "info": [_info(family, measure) for measure in selected],
        }
    return {
        "measure": question.measure,
        "group": group,
        "cells": cells,
        **series_state,
        **combined,
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
    if answer["measure"] == _DELAY_DISTRIBUTION_ID:
        columns.update(_DELAY_DISTRIBUTION_COLUMNS)
    elif group:
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
