"""Declare measures here. Use ask() for answers and methods() for their definitions."""

from __future__ import annotations

import csv
import io
import json
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from time import perf_counter
from typing import Any, Literal, NamedTuple

import duckdb

from transit_engine.clean_manifest import STOP_EVENTS, TRIP_DAYS
from transit_engine.store import CITY, Store

Language = Literal["en", "fr"]


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
        [duckdb.DuckDBPyConnection, Family, dict[str, list[str]], Question, str],
        tuple[Counter[str], Counter[int]],
    ]


_HISTOGRAM = Text(
    f"Bins are {DELAY_BIN_SECONDS} seconds wide, starting at multiples of "
    f"{DELAY_BIN_SECONDS} seconds with the lower edge included. Cumulative counts locate "
    "the two ranks for the percentile, then we interpolate between their lower edges. "
    "The error is at most one bin.",
    f"Les classes ont une largeur de {DELAY_BIN_SECONDS} secondes. Elles commencent aux "
    f"multiples de {DELAY_BIN_SECONDS} secondes, borne inférieure incluse. Les effectifs "
    "cumulés situent les deux rangs du centile, puis on interpole entre leurs bornes "
    "inférieures. L’erreur est d’au plus une classe.",
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
_LOCAL_HOUR = "hour(timezone('America/Toronto', scheduled_stop_utc))"
_DEPARTURE_SECONDS = """
    epoch(scheduled_start_utc)
    - epoch(timezone('America/Toronto', service_date + INTERVAL '12 hours')) + 43200
"""
_DAY_TYPES = ("weekday", "weekday", "weekday", "weekday", "weekday", "saturday", "sunday")


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

    def __post_init__(self) -> None:
        if self.measure not in _SELECTIONS:
            raise ValueError("unknown measure")
        if not CITY.fullmatch(self.city) or self.start > self.end:
            raise ValueError("provide a city and an ordered service date range")
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
    **{name: label for name, (_, label) in _COUNTS.items()},
}
_UNIT_LABELS = {"share": Text("Share", "Part"), "seconds": Text("Seconds", "Secondes")}


def _info(family: Family, measure: Measure) -> dict[str, Any]:
    return {
        "id": measure.id,
        "family": family.id,
        "unit": measure.unit,
        "method_version": family.method_version,
        "since": family.since,
        "tables": family.tables,
        "minimum_sample": family.minimum_sample,
        "evidence_fields": [*_EVIDENCE_COLUMNS, "counts", "excluded"],
        "csv_columns": {
            lang: [getattr(label, lang) for label in _csv_columns(family).values()]
            for lang in ("en", "fr")
        },
        "text": {
            lang: {
                "definition": getattr(measure.definition, lang),
                "unit": getattr(_UNIT_LABELS[measure.unit], lang),
                "counts": getattr(family.counts, lang),
                "exclusions": getattr(family.exclusions, lang),
                "limits": getattr(family.limits, lang),
                **({"histogram": getattr(_HISTOGRAM, lang)} if measure.percentile else {}),
            }
            for lang in ("en", "fr")
        },
    }


def _csv_columns(family: Family) -> dict[str, Text]:
    return {
        **_CSV_COLUMNS,
        **{m.id: m.count_label for m in family.measures if m.count_label is not None},
    }


def methods() -> list[dict[str, Any]]:
    return [_info(family, measure) for family in _FAMILIES for measure in family.measures]


def _punctuality_rows(
    conn: duckdb.DuckDBPyConnection,
    family: Family,
    paths: dict[str, list[str]],
    question: Question,
    version: str,
) -> tuple[Counter[str], Counter[int]]:
    parameters: list[object] = [
        *(paths[table] for table in family.tables),
        question.city,
        version,
        question.start,
        question.end,
    ]
    filters = []
    for name, value in question.cuts().items():
        expression = {
            "line": "route_id",
            "direction": "direction_id",
            "stop": "stop_id",
            "departure": _DEPARTURE_SECONDS,
            "hour": _LOCAL_HOUR,
        }.get(name)
        if expression is not None:
            filters.append(f"({expression}) = ?")
            if name == "departure":
                hour, minute, second = map(int, str(value).split(":"))
                parameters.append(hour * 3600 + minute * 60 + second)
            else:
                parameters.append(value)

    counters = {name: sql for name, (sql, _) in _COUNTS.items()}
    counters.update({m.id: f"count(*) FILTER ({m.band})" for m in family.measures if m.band})
    cut_sql = " AND ".join(filters) or "true"
    aggregates = ", ".join(counters.values())
    rows = conn.execute(
        f"""
        WITH events AS (
            SELECT s.service_date, t.route_id, t.direction_id, s.stop_id, t.scheduled_start_utc,
                coalesce(s.scheduled_departure_utc, s.scheduled_arrival_utc) AS scheduled_stop_utc,
                t.scheduled_start_utc IS NULL AS added,
                NOT added AND t.state = 'cancelled' AS cancelled,
                NOT added AND NOT cancelled AND NOT t.route_has_live_data AS without_live_data,
                NOT (added OR cancelled OR without_live_data) AS scheduled,
                t.state_reason IS NOT DISTINCT FROM 'capture_gap' AS capture_gap,
                CASE WHEN scheduled AND NOT capture_gap THEN s.delay_seconds END AS delay_seconds
            FROM read_parquet(?, hive_partitioning = false) s
            JOIN read_parquet(?, hive_partitioning = false) t
              ON (s.provider, s.service_date, s.cleaning_version, s.trip_id) =
                 (t.provider, t.service_date, t.cleaning_version, t.trip_id)
            WHERE s.provider = ? AND s.cleaning_version = ? AND s.service_date BETWEEN ? AND ?
        )
        SELECT floor(delay_seconds::DOUBLE / {DELAY_BIN_SECONDS})::BIGINT * {DELAY_BIN_SECONDS}
            AS lower_edge, {aggregates}
        FROM events WHERE {cut_sql}
        GROUP BY lower_edge
        """,
        parameters,
    ).fetchall()
    totals: Counter[str] = Counter()
    histogram: Counter[int] = Counter()
    for edge, *values in rows:
        bucket = dict(zip(counters, values, strict=True))
        totals.update(bucket)
        if edge is not None:
            histogram[edge] = bucket["classified"]
    return totals, histogram


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
        ),
        Measure(
            "median_delay",
            "seconds",
            Text("Median delay across measured stops.", "Écart médian aux arrêts mesurés."),
            percentile=50,
        ),
        Measure(
            "p90_delay",
            "seconds",
            Text(
                "The delay at or below which about 90% of measured stops fall.",
                "L’écart à l’horaire que ne dépassent pas environ 90 % des arrêts mesurés.",
            ),
            percentile=90,
        ),
    ),
)

_FAMILIES = (_PUNCTUALITY,)
_SELECTIONS = {
    key: (family, selected)
    for family in _FAMILIES
    for key, selected in (
        (family.id, family.measures),
        *((measure.id, (measure,)) for measure in family.measures),
    )
}


def _percentile(histogram: list[tuple[int, int]], count: int, percentile: int) -> float:
    # Zero-based ranks for a continuous percentile on the ordered, bin-rounded delays.
    rank, remainder = divmod((count - 1) * percentile, 100)
    seen = 0
    lower = None
    for edge, occurrences in histogram:
        seen += occurrences
        if lower is None and seen > rank:
            lower = edge
        if lower is not None and seen > rank + bool(remainder):
            return lower + (edge - lower) * remainder / 100
    raise RuntimeError("histogram counts do not match the classified count")


def ask(store: Store, question: Question) -> dict[str, Any]:
    """Read validated days and compute the selected measure or family with its evidence."""
    started = perf_counter()
    family, selected = _SELECTIONS[question.measure]
    measured: list[str] = []
    missing: list[str] = []
    included: list[str] = []
    missing_in_cut = False
    paths: dict[str, list[str]] = {table: [] for table in family.tables}
    counts: Counter[str] = Counter()
    histogram: Counter[int] = Counter()
    with store.connect() as conn:
        for ordinal in range(question.start.toordinal(), question.end.toordinal() + 1):
            day = date.fromordinal(ordinal)
            in_cut = question.day_type is None or question.day_type == _DAY_TYPES[day.weekday()]
            files = store.files(conn, question.city, day)
            if files is None:
                missing.append(day.isoformat())
                missing_in_cut |= in_cut
            else:
                measured.append(day.isoformat())
                if in_cut:
                    included.append(day.isoformat())
                    for table, path in zip((STOP_EVENTS, TRIP_DAYS), files, strict=True):
                        if table in paths:
                            paths[table].append(path)
        for offset in range(0, len(included), DAYS_PER_QUERY_BATCH):
            batch = {
                table: files[offset : offset + DAYS_PER_QUERY_BATCH]
                for table, files in paths.items()
            }
            batch_counts, batch_bins = family.query(
                conn, family, batch, question, str(store.cleaning_version)
            )
            counts.update(batch_counts)
            histogram.update(batch_bins)

    classified = counts["classified"]
    scheduled = counts["scheduled"]
    if (
        not measured
        or (missing_in_cut and not included)
        or (scheduled and counts["capture_gap"] == scheduled)
    ):
        state = "not_measured"
    elif not scheduled and counts["route_without_live_data"]:
        state = "no_live_data"
    elif not classified:
        state = "unknown"
    elif classified < family.minimum_sample:
        state = "too_few_to_judge"
    else:
        state = "measured"

    values: dict[str, float | None] = dict.fromkeys(m.id for m in selected)
    if state == "measured":
        bins = sorted(histogram.items())
        for measure in selected:
            values[measure.id] = (
                counts[measure.id] / classified
                if measure.percentile is None
                else _percentile(bins, classified, measure.percentile)
            )
    return {
        "measure": question.measure,
        "value": values,
        "state": state,
        "state_text": _STATES[state]._asdict(),
        "coverage_note": _PARTIAL._asdict() if measured and missing else None,
        "evidence": {
            "city": question.city,
            "start_date": question.start.isoformat(),
            "end_date": question.end.isoformat(),
            "cuts": question.cuts(),
            "days_measured": measured,
            "days_not_measured": missing,
            "days_included": included,
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
            "cleaning_versions": [store.cleaning_version] if included else [],
            "method_version": family.method_version,
            "query_ms": (perf_counter() - started) * 1000,
        },
        "info": [_info(family, measure) for measure in selected],
    }


def answer_csv(answer: dict[str, Any], language: Language) -> str:
    family, _ = _SELECTIONS[answer["measure"]]
    columns = _csv_columns(family)
    evidence = answer["evidence"]
    common = {**evidence, **evidence["counts"], **evidence["excluded"]}
    common["state"] = answer["state_text"][language]
    common["coverage_note"] = (answer["coverage_note"] or {}).get(language)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(getattr(label, language) for label in columns.values())
    for measure in answer["info"]:
        key = measure["id"]
        row = {
            **common,
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
