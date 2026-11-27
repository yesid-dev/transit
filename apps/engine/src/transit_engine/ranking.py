"""Rank scheduled entities using the measure registry's values and evidence."""

import csv
import io
import json
import re
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from math import sqrt
from time import perf_counter
from typing import Any, NamedTuple

import duckdb

from transit_engine.cities import service_query
from transit_engine.clean_manifest import ALERTS, STOP_EVENTS, TRIP_DAYS
from transit_engine.measures import (
    _ALERT_COUNTS_ID,
    _BOUNDARIES,
    _CORRIDORS_ID,
    _CROWDING_ID,
    _PUNCTUALITY,
    _SELECTIONS,
    _SERVICE_DELIVERED_ID,
    _STATES,
    _US_PER_HOUR,
    _VEHICLE_COMPLETION_IDS,
    _VEHICLES_ID,
    _WAITING_ID,
    VEHICLE_RANKING_DEFAULT,
    Batch,
    EntityKey,
    EntityKind,
    Family,
    Language,
    Measure,
    Question,
    ReadWindow,
    Text,
    _coverage_evidence,
    _csv_columns,
    _info,
    _punctuality_evidence,
    _punctuality_values,
    _vehicle_rows,
    evaluate,
    measure_answer,
    read_window,
)
from transit_engine.schedule import FREQUENT_HEADWAY_SECONDS, FREQUENT_SPAN_SECONDS
from transit_engine.series import LOCAL_HOUR as _LOCAL_HOUR
from transit_engine.store import Store

# Transit R5, "Rankings" and "Evidence, on every number":
# https://app.notion.com/p/41e3e863069081e193eaeee433839958
# One worst-first list per kind. Compare like lines, show the uncertainty and
# disclose each unranked entity's reason. Capabilities come from the cleaned data.
NIGHT_END_HOUR = 5
# Morning commute gives a consistent local window. At ten minutes or less, the
# scheduled frequency permits a short wait without choosing a particular trip.
PEAK_START_HOUR = 7
PEAK_END_HOUR = 9
MAX_LIMIT = 500
DEFAULT_LIMIT = 100
_Z_95 = 1.959963984540054
_IDENTITY_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))

_RANGE_NOTES = {
    "matched_headways": Text(
        "Calculated from matched headways. Sampling uncertainty is unknown.",
        "Calculé à partir des intervalles appariés. L’incertitude d’échantillonnage est inconnue.",
    ),
    "observed_segment_runs": Text(
        "Total for the observed runs. Sampling uncertainty is unknown.",
        "Total des parcours observés. L’incertitude d’échantillonnage est inconnue.",
    ),
    "wilson_95": Text(
        "95% Wilson interval. Stop events on the same trip are dependent. "
        "Treat this range as a guide.",
        "Intervalle de Wilson à 95\u00a0%. Les passages aux arrêts d’un même trajet "
        "sont dépendants. Cet intervalle sert de guide.",
    ),
    "duration_weighted_wilson_95": Text(
        "Approximate 95% Wilson interval using an effective trip sample weighted "
        "by scheduled duration. Treat this range as a guide.",
        "Intervalle de Wilson approximatif à 95\u00a0% avec un effectif de trajets "
        "pondéré par la durée prévue. Cet intervalle sert de guide.",
    ),
    "histogram_half_bin": Text(
        "The histogram estimate is within half a bin of the exact sample percentile.",
        "L’estimation est à une demi-classe ou moins du centile exact de l’échantillon.",
    ),
    "occupancy_weighted_wilson_95": Text(
        "Approximate 95% Wilson interval using an effective sample of state intervals "
        "weighted by vehicle time. Intervals from the same vehicle can be dependent.",
        "Intervalle de Wilson approximatif à 95\u00a0% avec un effectif d’intervalles "
        "pondéré par le temps-véhicule. Les intervalles d’un véhicule peuvent être dépendants.",
    ),
    "recorded_alert_hours": Text(
        "Recorded duration from the published alert history. Both bounds equal that duration.",
        "Durée calculée à partir de l’historique des avis. Les deux bornes égalent cette durée.",
    ),
    "vehicle_reporting_uncertainty_unknown": Text(
        "Repeated reporting gaps can be related. The uncertainty of this rate is unknown.",
        "Les interruptions de signalement peuvent être liées. L’incertitude du taux est inconnue.",
    ),
    "vehicle_completion_wilson_95": Text(
        "95% Wilson interval. Trips assigned to the same vehicle can be dependent. "
        "Treat this range as a guide.",
        "Intervalle de Wilson à 95\u00a0%. Les trajets attribués au même véhicule peuvent être "
        "dépendants. Cet intervalle sert de guide.",
    ),
}
_INSUFFICIENT_COVERAGE = Text(
    "Insufficient coverage", "Couverture insuffisante",
)
_NOT_MEASURED_ON_DATES = Text("Not measured on those dates", "Non mesuré à ces dates")
# An entity under its family's low-coverage limit is never ranked: too little of its
# scheduled service has a reading for its value to lead a list.
_LOW_COVERAGE = Text("Low coverage", "Faible couverture")


@dataclass(frozen=True)
class Ranking:
    question: Question
    kind: EntityKind
    service_class: str | None = None
    limit: int = DEFAULT_LIMIT

    def __post_init__(self) -> None:
        if self.question.group is not None:
            raise ValueError("group applies to /measure")
        family, measures = _SELECTIONS[self.question.measure]
        if family.query is None:
            raise ValueError("this family does not support rankings")
        if len(measures) != 1:
            raise ValueError("choose a single registry measure")
        kinds = measures[0].ranking_kinds
        # Old completion ranking URLs still resolve to the measure's unavailable state.
        unavailable_completion = (
            self.kind == "vehicle" and self.question.measure in _VEHICLE_COMPLETION_IDS
        )
        if kinds is not None and self.kind not in kinds and not unavailable_completion:
            raise ValueError("this measure does not apply to this ranking kind")
        if self.kind == "segment" and family.id != _CORRIDORS_ID:
            raise ValueError("segment rankings require a corridor measure")
        if (
            family.id != _CORRIDORS_ID
            and self.kind != "departure"
            and (self.question.line is not None or self.question.direction is not None)
        ):
            raise ValueError("line and direction ranking filters apply to corridors or departures")
        if self.kind == "vehicle" and family.id != _VEHICLES_ID:
            raise ValueError("vehicle rankings require a vehicle measure")
        if family.id == _SERVICE_DELIVERED_ID and (
            self.kind == "stop" or self.question.stop is not None
        ):
            raise ValueError("trip measures do not apply to stops")
        if self.question.measure in _BOUNDARIES and self.kind != "line":
            raise ValueError("first and last trip measures apply to lines")
        if self.service_class is not None and self.kind != "line":
            raise ValueError("class applies to line rankings")
        if self.service_class not in {None, "all"} and not re.fullmatch(
            r"(?:[0-9]+|unknown|mixed):(?:night|frequent|regular)", self.service_class or ""
        ):
            raise ValueError("class must be all or a route-type:service-pattern class")
        if not 1 <= self.limit <= MAX_LIMIT:
            raise ValueError(f"limit must be from 1 to {MAX_LIMIT}")


@dataclass
class LineSchedule:
    route_types: set[int] = field(default_factory=set)
    trips: int = 0
    night: int = 0
    peak_seconds: float = 0
    peak_gaps: int = 0

    @property
    def service_class(self) -> str:
        mode = "unknown"
        if len(self.route_types) == 1:
            mode = str(next(iter(self.route_types)))
        elif self.route_types:
            mode = "mixed"
        pattern = "regular"
        if self.night * 2 > self.trips:
            pattern = "night"
        elif self.peak_gaps and self.peak_seconds <= FREQUENT_HEADWAY_SECONDS * self.peak_gaps:
            pattern = "frequent"
        return f"{mode}:{pattern}"


def _line_schedules(
    conn: duckdb.DuckDBPyConnection,
    paths: list[str],
    store: Store,
    question: Question,
    lines: dict[str, LineSchedule],
) -> None:
    route_type = "route_type" if store.cleaning_version >= 6 else "NULL::INTEGER"
    hour = _LOCAL_HOUR.format("scheduled_start_utc")
    # Only a sustained peak on one date and in one direction can contribute headways.
    # Collapse coincident trips, which add capacity without shortening the wait.
    rows = conn.execute(
        f"""
        WITH trips AS (
            SELECT service_date, route_id, direction_id, scheduled_start_utc,
                {route_type} AS route_type, {hour} AS local_hour
            FROM read_parquet(?, hive_partitioning = false)
            WHERE provider = ? AND cleaning_version = ? AND service_date BETWEEN ? AND ?
                AND state <> 'added' AND route_id IS NOT NULL
        ), peak AS (
            SELECT DISTINCT service_date, route_id, direction_id, scheduled_start_utc
            FROM trips WHERE local_hour >= {PEAK_START_HOUR} AND local_hour < {PEAK_END_HOUR}
                AND (isodow(service_date) <= 5 OR ?)
        ), peak_periods AS (
            SELECT route_id,
                epoch(max(scheduled_start_utc) - min(scheduled_start_utc)) AS span,
                count(*) - 1 AS gaps
            FROM peak GROUP BY service_date, route_id, direction_id
            HAVING span >= {FREQUENT_SPAN_SECONDS}
        ), frequency AS (
            SELECT route_id, sum(span) AS seconds, sum(gaps) AS gaps
            FROM peak_periods GROUP BY route_id
        ), service AS (
            SELECT route_id, list(DISTINCT route_type) FILTER (route_type IS NOT NULL) AS modes,
                count(*) AS trips,
                count(*) FILTER (local_hour < {NIGHT_END_HOUR}) AS night
            FROM trips GROUP BY route_id
        )
        SELECT route_id, modes, trips, night, coalesce(seconds, 0), coalesce(gaps, 0)
        FROM service LEFT JOIN frequency USING (route_id)
        """,
        [
            paths, question.city, str(store.cleaning_version), question.start, question.end,
            not any(
                date.fromordinal(day).weekday() < 5
                for day in range(question.start.toordinal(),
                                 min(question.end.toordinal() + 1, question.start.toordinal() + 7))
            ),
        ],
    ).fetchall()
    for route, modes, trips, night, seconds, gaps in rows:
        line = lines.setdefault(route, LineSchedule())
        line.route_types.update(modes or ())
        line.trips += trips
        line.night += night
        line.peak_seconds += seconds
        line.peak_gaps += gaps


def wilson_interval(share: float, sample: float) -> tuple[float, float]:
    z_squared = _Z_95**2
    scale = 1 + z_squared / sample
    center = (share + z_squared / (2 * sample)) / scale
    radius = _Z_95 * sqrt((share * (1 - share) + z_squared / (4 * sample)) / sample) / scale
    lower = 0.0 if share == 0 else max(0.0, center - radius)
    upper = 1.0 if share == 1 else min(1.0, center + radius)
    return lower, upper


def _range(
    value: float, sample: int, measure: Measure, counts: Counter[str], family: Family
) -> dict[str, Any]:
    if measure.id == "excess_wait_time":
        return {"lower": None, "upper": None, "method": "matched_headways"}
    if measure.id == VEHICLE_RANKING_DEFAULT:
        return {"lower": None, "upper": None, "method": "vehicle_reporting_uncertainty_unknown"}
    if measure.unit == "vehicle_minutes":
        return {"lower": None, "upper": None, "method": "observed_segment_runs"}
    if measure.unit == "seconds":
        half_bin = (family.bin_seconds - 1) / 2
        lower, upper = value - half_bin, value + half_bin
        method = "histogram_half_bin"
    elif family.id == _ALERT_COUNTS_ID:
        lower = upper = value
        method = "recorded_alert_hours"
    elif family.id == _CROWDING_ID:
        effective_sample = counts["occupancy_us"] ** 2 / counts["squared_occupancy_us"]
        lower, upper = wilson_interval(value, effective_sample)
        method = "occupancy_weighted_wilson_95"
    elif measure.id == "service_hours":
        effective_sample = counts["scheduled_seconds"] ** 2 / counts["squared_duration"]
        lower, upper = wilson_interval(value, effective_sample)
        method = "duration_weighted_wilson_95"
    else:
        lower, upper = wilson_interval(value, sample)
        method = "wilson_95"
    return {"lower": lower, "upper": upper, "method": method}


def _identity(kind: EntityKind, key: EntityKey, classes: list[str]) -> dict[str, Any]:
    identity: dict[str, Any] = {
        "id": key[0],
        "class": classes[0] if len(classes) == 1 else None,
        "classes": classes,
    }
    if kind == "departure":
        line, direction, seconds = key
        assert isinstance(seconds, int)
        hours, remainder = divmod(seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        departure = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        identity.update(
            id=_IDENTITY_ENCODER.encode([line, direction, departure]),
            line=line,
            direction=direction,
            departure=departure,
        )
    if kind == "segment":
        line, direction, from_stop, to_stop = key
        identity.update(
            id=_IDENTITY_ENCODER.encode(key),
            line=line,
            direction=direction,
            from_stop=from_stop,
            to_stop=to_stop,
        )
    return identity


class _PunctualityCandidate(NamedTuple):
    key: EntityKey
    classes: list[str]
    value: float
    sample: int
    counts: Counter[str]
    ranking_bound: float | None


def _punctuality_shortlist(
    candidates: list[_PunctualityCandidate], ranking: Ranking, order: int
) -> list[tuple[dict[str, Any], int, Counter[str]]]:
    if not candidates:
        return []

    def score(candidate: _PunctualityCandidate) -> tuple[float, int]:
        bound = candidate.ranking_bound
        score_value = candidate.value if bound is None else bound
        return order * score_value, -candidate.sample

    candidates.sort(key=score)
    last = min(len(candidates), ranking.limit) - 1
    # Include every tie at the limit so the public ID still breaks it.
    end = bisect_right(candidates, score(candidates[last]), lo=last + 1, key=score)
    return [
        (
            {
                **_identity(ranking.kind, key, classes), "value": value, "sample": sample,
                "ranking_bound": bound,
            },
            sample,
            counts,
        )
        for key, classes, value, sample, counts, bound in candidates[:end]
    ]


def _historical_schedule(
    conn: duckdb.DuckDBPyConnection,
    paths: dict[str, list[str]],
    kind: EntityKind,
    totals: dict[EntityKey, Batch],
    city: str,
    version: str,
) -> None:
    trips = paths[TRIP_DAYS]
    tracked = (
        [trip for trip, alert in zip(trips, paths[ALERTS], strict=True) if alert]
        if ALERTS in paths
        else trips
    )
    source = "read_parquet(?, hive_partitioning = false) t"
    entity = "t.route_id"
    bindings: list[object] = [tracked, tracked, trips]
    if kind == "stop":
        source += """
            JOIN read_parquet(?, hive_partitioning = false) s
            USING (provider, cleaning_version, service_date, trip_id)
        """
        entity = "s.stop_id"
        bindings.append(paths[STOP_EVENTS])
    rows = conn.execute(
        f"""
        SELECT {entity} AS entity, t.route_id, bool_or(list_contains(?, t.filename)),
            bool_or(NOT list_contains(?, t.filename))
        FROM {source}
        WHERE t.provider = ? AND t.cleaning_version = ? AND t.state <> 'added'
            AND t.route_id IS NOT NULL AND entity IS NOT NULL
        GROUP BY entity, t.route_id
        """,
        [*bindings, city, version],
    ).fetchall()
    for key, route, has_tracking, lacks_tracking in rows:
        result = totals.setdefault((key,), Batch())
        result.scheduled_routes.add(route)
        result.counts.update(schedule_tracked=has_tracking, schedule_not_tracked=lacks_tracking)


def _rank_batches(
    conn: duckdb.DuckDBPyConnection,
    store: Store,
    ranking: Ranking,
    family: Family,
    window: ReadWindow,
    *,
    historical: bool = False,
    days: int | None = None,
    include_network: bool = False,
) -> dict[EntityKey, Batch]:
    assert family.query is not None
    question = ranking.question
    version = str(store.cleaning_version)
    totals: dict[EntityKey, Batch] = {}
    for offset, batch in enumerate(window.batches(days=days)):
        if historical and ranking.kind != "vehicle":
            _historical_schedule(conn, batch, ranking.kind, totals, question.city, version)
        if include_network:
            results = _vehicle_rows(
                conn, family, batch, question, version, ranking.kind, include_network=True
            )
        else:
            results = family.query(conn, family, batch, question, version, ranking.kind)
        window.record_vehicle_tracking(family, offset, results)
        for key, result in results.items():
            if key and (key[0] is None or (ranking.kind == "departure" and key[2] is None)):
                continue
            if key in totals:
                totals[key].update(result)
            else:
                totals[key] = result
    return totals


def rank(store: Store, ranking: Ranking, *, with_reference: bool = True) -> dict[str, Any]:
    started = perf_counter()
    question = ranking.question
    family, selected = _SELECTIONS[question.measure]
    (measure,) = selected
    lines: dict[str, LineSchedule] = {}
    by_vehicle = ranking.kind == "vehicle"
    include_network = with_reference and by_vehicle and question.measure == VEHICLE_RANKING_DEFAULT
    historical = family.id in {_CROWDING_ID, _ALERT_COUNTS_ID, _VEHICLES_ID}
    has_own_states = historical or family.id in {_WAITING_ID, _CORRIDORS_ID}
    with service_query(store, question.city) as conn:
        window = read_window(conn, store, question, family, selected, ranking.kind)
        if (
            family is _PUNCTUALITY
            and ranking.kind == "departure"
            and measure.percentile is None
            and store.memory_mib >= 2048
        ):
            # Merge the large departure result in DuckDB before transferring it to Python.
            # Keep the normal bounded batches available for denser providers.
            try:
                totals = _rank_batches(conn, store, ranking, family, window, days=365)
            except duckdb.OutOfMemoryException:
                totals = _rank_batches(conn, store, ranking, family, window)
        else:
            totals = _rank_batches(
                conn, store, ranking, family, window,
                historical=historical, include_network=include_network,
            )
        if not by_vehicle:
            for batch in window.batches():
                _line_schedules(conn, batch[TRIP_DAYS], store, question, lines)

    network = totals.pop((), Batch()) if include_network else None
    classes = {route: schedule.service_class for route, schedule in lines.items()}
    class_sizes: Counter[str] = Counter()
    frequent_class_sizes: Counter[str] = Counter()
    for result in totals.values():
        # A class whose lines never carry live data can never be ranked, so it is not offered.
        if ranking.kind == "line" and (has_own_states or result.counts["live_candidates"]):
            for route in result.scheduled_routes:
                class_sizes[classes[route]] += lines[route].trips
                if (
                    family.id == _WAITING_ID
                    and result.counts["observed_headways"] >= family.minimum_sample
                ):
                    frequent_class_sizes[classes[route]] += lines[route].trips
    chosen_class = ranking.service_class
    if ranking.kind == "line" and chosen_class is None and class_sizes:
        candidates = frequent_class_sizes or class_sizes
        chosen_class = min(candidates, key=lambda name: (-candidates[name], name))
    rows: list[tuple[dict[str, Any], int, Counter[str]]] = []
    punctuality_candidates: list[_PunctualityCandidate] = []
    excluded: list[dict[str, Any]] = []
    punctuality = family is _PUNCTUALITY
    no_days_measured = window.no_days_measured
    for key, result in totals.items():
        if not by_vehicle and not result.scheduled_routes:
            continue
        service_classes = sorted({classes[route] for route in result.scheduled_routes})
        if chosen_class not in {None, "all"} and chosen_class not in service_classes:
            continue
        if punctuality:
            state, values = _punctuality_values(
                family, selected, result.counts, result.histogram, no_days_measured
            )
            sample = result.counts["classified"]
            evidence: dict[str, Any] = {}
        else:
            state, values, evidence, samples = evaluate(family, selected, result, window)
            sample = samples[measure.id]
        value = values[measure.id]
        displayed_sample = (
            sample / _US_PER_HOUR if measure.id == VEHICLE_RANKING_DEFAULT else sample
        )
        floors = family.ranking_floors.get(ranking.kind, {})
        floor_counts = result.counts
        if "occupancy_vehicle_hours" in floors:
            # Sample is in microseconds for query aggregation and in hours in the registry.
            floors = {"occupancy_us": floors["occupancy_vehicle_hours"] * _US_PER_HOUR}
        if value is not None and (
            any(floor_counts[name] < floor for name, floor in floors.items())
            or (measure.ranking_minimum_sample is not None
                and displayed_sample < measure.ranking_minimum_sample)
        ):
            state, value = "too_few_to_judge", None
        if not has_own_states and not result.counts["live_candidates"]:
            state, value = "no_live_data", None
        coverage = (
            _coverage_evidence(family, result.counts["classified"], result.counts["scheduled"])
            if punctuality else evidence
        )
        if value is not None and coverage.get("low_coverage"):
            excluded.append({
                **_identity(ranking.kind, key, service_classes),
                "sample": displayed_sample,
                **evidence,
                **(_punctuality_evidence(family, result.counts, window.included)
                   if punctuality else {}),
                "reason": "low_coverage",
                "reason_text": _LOW_COVERAGE._asdict(),
            })
            continue
        range_ = _range(value, sample, measure, result.counts, family) if value is not None else {}
        bound = (
            range_["lower" if measure.worst_first_descending else "upper"]
            if value is not None and measure.unit == "share" else None
        )
        if punctuality and value is not None:
            punctuality_candidates.append(
                _PunctualityCandidate(key, service_classes, value, sample, result.counts, bound)
            )
            continue
        entry = {
            **_identity(ranking.kind, key, service_classes),
            "sample": displayed_sample,
            **evidence,
        }
        if historical and state in {"not_tracked", "not_measured"}:
            entry["sample"] = None
        elif family.id == _CROWDING_ID:
            entry["sample"] = sample / _US_PER_HOUR
        if value is None:
            if state == "unknown" and not has_own_states:
                state = "too_few_to_judge"
            if punctuality:
                entry.update(_punctuality_evidence(family, result.counts, window.included))
            reason = (
                _INSUFFICIENT_COVERAGE if entry.get("coverage_reason")
                else _NOT_MEASURED_ON_DATES if state == "not_measured" else _STATES[state]
            )
            excluded.append({**entry, "reason": state, "reason_text": reason._asdict()})
        else:
            rows.append((
                {**entry, "value": value, "ranking_bound": bound, "range": range_},
                sample, result.counts,
            ))
    order = -1 if measure.worst_first_descending else 1
    if punctuality:
        rows = _punctuality_shortlist(punctuality_candidates, ranking, order)
    def row_order(item: tuple[dict[str, Any], int, Counter[str]]) -> tuple[float, float, str]:
        row = item[0]
        bound = row["ranking_bound"]
        return order * (row["value"] if bound is None else bound), -row["sample"], row["id"]

    rows.sort(key=row_order)
    excluded.sort(key=lambda row: row["id"])
    evidence = window.evidence(store, question, family, started)
    if chosen_class:
        evidence["cuts"]["class"] = chosen_class
    historical_state = {}
    if has_own_states:
        reasons = {entry["reason"] for entry in excluded}
        if question.measure in _VEHICLE_COMPLETION_IDS:
            state = "not_tracked"
        elif rows:
            state = "measured"
        elif len(reasons) == 1:
            state = reasons.pop()
        elif family.id == _ALERT_COUNTS_ID and window.not_tracked and not window.measured:
            state = "not_tracked"
        elif by_vehicle and window.not_tracked and len(window.not_tracked) == len(window.included):
            state = "not_tracked"
        else:
            state = "not_measured" if window.no_days_measured else "unknown"
        historical_state = {"state": state, "state_text": _STATES[state]._asdict()}
    return {
        "measure": measure.id,
        "kind": ranking.kind,
        "class": chosen_class,
        "available_classes": sorted(class_sizes),
        "ranked_count": len(punctuality_candidates) if punctuality else len(rows),
        "rows": [
            {
                "rank": position,
                **row,
                **(_punctuality_evidence(family, counts, window.included) if punctuality else {}),
                "range": row["range"] if "range" in row else
                    _range(row["value"], sample, measure, counts, family),
            }
            for position, (row, sample, counts) in enumerate(rows[: ranking.limit], start=1)
        ],
        "excluded": excluded,
        "coverage_note": window.coverage_note,
        "range_notes": {method: note._asdict() for method, note in _RANGE_NOTES.items()},
        "info": [_info(family, measure)],
        "evidence": evidence,
        **(
            {"reference": measure_answer(
                store, question, family, selected, network, window, started
            )}
            if network is not None else {}
        ),
        **historical_state,
    }


_RANKING_COLUMNS = {
    "rank": Text("Rank", "Rang"),
    "kind": Text("Kind", "Type"),
    "id": Text("ID", "Identifiant"),
    "classes": Text("Service classes", "Classes de service"),
    "sample": Text("Sample", "Échantillon"),
    "ranking_bound": Text("Ranking bound", "Borne de classement"),
    "lower": Text("Range lower bound", "Borne inférieure"),
    "upper": Text("Range upper bound", "Borne supérieure"),
    "range_note": Text("Range note", "Note sur l’intervalle"),
}


def ranking_csv(answer: dict[str, Any], language: Language) -> str:
    family, _ = _SELECTIONS[answer["measure"]]
    columns = {**_RANKING_COLUMNS, **_csv_columns(family)}
    if family.id == _CROWDING_ID or answer["measure"] == VEHICLE_RANKING_DEFAULT:
        columns["sample"] = Text("Sample (vehicle-hours)", "Échantillon (heures-véhicules)")
    elif family.id == _VEHICLES_ID:
        columns["sample"] = Text("Sample (trips)", "Échantillon (trajets)")
    if answer["kind"] == "segment":
        columns.update(
            line=Text("Line", "Ligne"),
            direction=Text("Direction", "Direction"),
            from_stop=Text("From stop", "Arrêt de départ"),
            to_stop=Text("To stop", "Arrêt d’arrivée"),
        )
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(getattr(label, language) for label in columns.values())
    common = {
        **answer["evidence"],
        "measure": answer["measure"],
        "kind": answer["kind"],
        "unit": answer["info"][0]["text"][language]["unit"],
        "coverage_note": (answer["coverage_note"] or {}).get(language),
    }
    entries = [*answer["rows"], *answer["excluded"]]
    if not entries:
        # Keep the window evidence exportable even when there are no known entities.
        reason = _STATES.get(answer.get("state", "")) or (
            _STATES["unknown"] if common["days_included"] else _NOT_MEASURED_ON_DATES
        )
        entries.append({"reason_text": reason._asdict(), "counts": {}, "excluded": {}})
    for entry in entries:
        bounds = entry.get("range", {})
        row = {
            **common,
            **entry,
            **entry["counts"],
            **entry["excluded"],
            **bounds,
            "range_note": answer["range_notes"].get(bounds.get("method"), {}).get(language),
            "state": entry.get("reason_text", _STATES["measured"]._asdict())[language],
        }
        values = (row.get(name) for name in columns)
        writer.writerow(
            json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value
            for value in values
        )
    return output.getvalue()
