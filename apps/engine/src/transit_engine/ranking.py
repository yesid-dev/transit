"""Rank scheduled entities using the measure registry's values and evidence."""

import csv
import io
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from math import sqrt
from time import perf_counter
from typing import Any

import duckdb

from transit_engine.clean_manifest import ALERTS, STOP_EVENTS, TRIP_DAYS
from transit_engine.measures import (
    _ALERT_COUNTS_ID,
    _BOUNDARIES,
    _CROWDING_ID,
    _LOCAL_HOUR,
    _SELECTIONS,
    _SERVICE_DELIVERED_ID,
    _STATES,
    _US_PER_HOUR,
    _WAITING_ID,
    DELAY_BIN_SECONDS,
    Batch,
    EntityKey,
    EntityKind,
    Language,
    Measure,
    Question,
    Text,
    _csv_columns,
    _info,
    evaluate,
    read_window,
)
from transit_engine.schedule import FREQUENT_HEADWAY_SECONDS
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

_RANGE_NOTES = {
    "matched_headways": Text(
        "Calculated from matched headways. Sampling uncertainty is unknown.",
        "Calculé à partir des intervalles appariés. L’incertitude d’échantillonnage est inconnue.",
    ),
    "wilson_95": Text(
        "95% Wilson interval. Stop events on the same trip are dependent. "
        "Treat this range as a guide.",
        "Intervalle de Wilson à 95 %. Les observations d’arrêts d’un même trajet "
        "sont dépendantes. Cet intervalle sert de guide.",
    ),
    "duration_weighted_wilson_95": Text(
        "Approximate 95% Wilson interval using an effective trip sample weighted "
        "by scheduled duration. Treat this range as a guide.",
        "Intervalle de Wilson approximatif à 95 % avec un effectif de trajets "
        "pondéré par la durée prévue. Cet intervalle sert de guide.",
    ),
    "histogram_half_bin": Text(
        "The histogram estimate is within half a bin of the exact sample percentile.",
        "L’estimation est à une demi-classe ou moins du centile exact de l’échantillon.",
    ),
    "occupancy_weighted_wilson_95": Text(
        "Approximate 95% Wilson interval using an effective sample of state intervals "
        "weighted by vehicle time. Intervals from the same vehicle can be dependent.",
        "Intervalle de Wilson approximatif à 95 % avec un effectif d’intervalles "
        "pondéré par le temps-véhicule. Les intervalles d’un véhicule peuvent être dépendants.",
    ),
    "recorded_alert_hours": Text(
        "Recorded duration from the published alert history. Both bounds equal that duration.",
        "Durée calculée à partir de l’historique des alertes. Les deux bornes égalent cette durée.",
    ),
}
_NOT_MEASURED_ON_DATES = Text("Not measured on those dates", "Non mesuré à ces dates")


@dataclass(frozen=True)
class Ranking:
    question: Question
    kind: EntityKind
    service_class: str | None = None
    limit: int = DEFAULT_LIMIT

    def __post_init__(self) -> None:
        family, measures = _SELECTIONS[self.question.measure]
        if len(measures) != 1:
            raise ValueError("choose a single registry measure")
        kinds = measures[0].ranking_kinds
        if kinds is not None and self.kind not in kinds:
            raise ValueError("this measure does not apply to this ranking kind")
        if self.kind == "stop" and family.id == _SERVICE_DELIVERED_ID:
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
    peak_seconds: int = 0
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
    route_type = "route_type" if store.cleaning_version == 6 else "NULL::INTEGER"
    hour = _LOCAL_HOUR.format("scheduled_start_utc")
    # Restrict headways to consecutive departures on the same date and direction.
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
        ), headways AS (
            SELECT route_id, epoch(scheduled_start_utc - lag(scheduled_start_utc) OVER (
                PARTITION BY route_id, service_date, direction_id ORDER BY scheduled_start_utc
            ))::BIGINT AS gap
            FROM peak
        ), frequency AS (
            SELECT route_id, coalesce(sum(gap), 0) AS seconds, count(gap) AS gaps
            FROM headways GROUP BY route_id
        ), service AS (
            SELECT route_id, list(DISTINCT route_type) FILTER (route_type IS NOT NULL) AS modes,
                count(*) AS trips,
                count(*) FILTER (local_hour < {NIGHT_END_HOUR}) AS night
            FROM trips GROUP BY route_id
        )
        SELECT route_id, modes, trips, night, coalesce(seconds, 0), coalesce(gaps, 0)
        FROM service LEFT JOIN frequency USING (route_id)
        """,
        [paths, question.city, str(store.cleaning_version), question.start, question.end],
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
    value: float, sample: int, measure: Measure, counts: Counter[str], family_id: str
) -> dict[str, Any]:
    if measure.id == "excess_wait_time":
        return {"lower": None, "upper": None, "method": "matched_headways"}
    if measure.unit == "seconds":
        half_bin = DELAY_BIN_SECONDS / 2
        lower, upper = value - half_bin, value + half_bin
        method = "histogram_half_bin"
    elif family_id == _ALERT_COUNTS_ID:
        lower = upper = value
        method = "recorded_alert_hours"
    elif family_id == _CROWDING_ID:
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
            id=json.dumps([line, direction, departure], ensure_ascii=False, separators=(",", ":")),
            line=line,
            direction=direction,
            departure=departure,
        )
    return identity


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


def rank(store: Store, ranking: Ranking) -> dict[str, Any]:
    started = perf_counter()
    question = ranking.question
    family, selected = _SELECTIONS[question.measure]
    (measure,) = selected
    totals: dict[EntityKey, Batch] = {}
    lines: dict[str, LineSchedule] = {}
    historical = family.id in {_CROWDING_ID, _ALERT_COUNTS_ID}
    with store.connect() as conn:
        window = read_window(conn, store, question, family, selected, ranking.kind)
        for batch in window.batches():
            _line_schedules(conn, batch[TRIP_DAYS], store, question, lines)
            if historical:
                _historical_schedule(
                    conn, batch, ranking.kind, totals, question.city, str(store.cleaning_version)
                )
            for key, result in family.query(
                conn, family, batch, question, str(store.cleaning_version), ranking.kind
            ).items():
                if key[0] is None or (ranking.kind == "departure" and key[2] is None):
                    continue
                totals.setdefault(key, Batch()).update(result)

    classes = {route: schedule.service_class for route, schedule in lines.items()}
    class_sizes: Counter[str] = Counter()
    frequent_class_sizes: Counter[str] = Counter()
    for result in totals.values():
        if ranking.kind == "line":
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
    rows: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for key, result in totals.items():
        if not result.scheduled_routes:
            continue
        service_classes = sorted({classes[route] for route in result.scheduled_routes})
        if chosen_class not in {None, "all"} and chosen_class not in service_classes:
            continue
        state, values, evidence, samples = evaluate(family, selected, result, window)
        value, sample = values[measure.id], samples[measure.id]
        entry = {
            **_identity(ranking.kind, key, service_classes),
            "sample": sample,
            **evidence,
        }
        if historical and state in {"not_tracked", "not_measured"}:
            entry["sample"] = None
        elif family.id == _CROWDING_ID:
            entry["sample"] = sample / _US_PER_HOUR
        if not historical and family.id != _WAITING_ID and not result.counts["live_candidates"]:
            state, value = "no_live_data", None
        if value is None:
            if state == "unknown" and not historical and family.id != _WAITING_ID:
                state = "too_few_to_judge"
            reason = _NOT_MEASURED_ON_DATES if state == "not_measured" else _STATES[state]
            excluded.append({**entry, "reason": state, "reason_text": reason._asdict()})
        else:
            rows.append(
                {
                    **entry,
                    "value": value,
                    "range": _range(value, sample, measure, result.counts, family.id),
                }
            )
    order = -1 if measure.worst_first_descending else 1
    rows.sort(key=lambda row: (order * row["value"], -row["sample"], row["id"]))
    excluded.sort(key=lambda row: row["id"])
    evidence = window.evidence(store, question, family, started)
    if chosen_class:
        evidence["cuts"]["class"] = chosen_class
    historical_state = {}
    if historical or family.id == _WAITING_ID:
        reasons = {entry["reason"] for entry in excluded}
        if rows:
            state = "measured"
        elif len(reasons) == 1:
            state = reasons.pop()
        elif family.id == _ALERT_COUNTS_ID and window.not_tracked and not window.measured:
            state = "not_tracked"
        else:
            state = "not_measured" if window.no_days_measured else "unknown"
        historical_state = {"state": state, "state_text": _STATES[state]._asdict()}
    return {
        "measure": measure.id,
        "kind": ranking.kind,
        "class": chosen_class,
        "available_classes": sorted(class_sizes),
        "ranked_count": len(rows),
        "rows": [
            {"rank": position, **row} for position, row in enumerate(rows[: ranking.limit], start=1)
        ],
        "excluded": excluded,
        "coverage_note": window.coverage_note,
        "range_notes": {method: note._asdict() for method, note in _RANGE_NOTES.items()},
        "info": [_info(family, measure)],
        "evidence": evidence,
        **historical_state,
    }


_RANKING_COLUMNS = {
    "rank": Text("Rank", "Rang"),
    "kind": Text("Kind", "Type"),
    "id": Text("ID", "Identifiant"),
    "classes": Text("Service classes", "Classes de service"),
    "sample": Text("Sample", "Échantillon"),
    "lower": Text("Range lower bound", "Borne inférieure"),
    "upper": Text("Range upper bound", "Borne supérieure"),
    "range_note": Text("Range note", "Note sur l’intervalle"),
}


def ranking_csv(answer: dict[str, Any], language: Language) -> str:
    family, _ = _SELECTIONS[answer["measure"]]
    columns = {**_RANKING_COLUMNS, **_csv_columns(family)}
    if family.id == _CROWDING_ID:
        columns["sample"] = Text("Sample (vehicle-hours)", "Échantillon (heures-véhicules)")
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
