"""Headways from exact DuckDB trip-instance gaps and family-local numeric math."""

import re
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows
from transit_ops.batch.engine import BatchSession
from transit_ops.gold import rollups
from transit_ops.gold.delay_periods import GHOST_DELAY_ABS_SECONDS
from transit_ops.sql_registry import named_query

_NAMES = ("route_headway_by_shift", "route_headway_by_direction_shift", "route_headway_shift_daily")
_KEYS = (
    ("provider_id", "route_id", "shift"),
    ("provider_id", "route_id", "direction_id", "shift", "service_day_kind"),
    ("provider_id", "route_id", "provider_local_date", "shift", "direction_id"),
)
# Column order and keys: migration 0093:1208-1241,1821-1828. R28c permits
# unconstrained numeric as exact text at TableRows, without narrowing DuckDB DDL.
_COLUMNS = (
    _KEYS[0]
    + ("observed_headway_min", "sample_count", "built_at_utc", "headway_cov", "bunched_count"),
    _KEYS[1] + ("observed_headway_min", "sample_count", "built_at_utc"),
    _KEYS[2]
    + (
        "gap_count",
        "sum_gap_min",
        "sum_gap_sq_min",
        "bunched_gap_count",
        "trip_count",
        "gap_histogram",
        "built_at_utc",
    ),
)
_SOURCES = (
    rollups.UPSERT_ROUTE_HEADWAY_DAILY,
    rollups.UPSERT_ROUTE_HEADWAY_DIRECTION_DAILY,
    rollups.UPSERT_ROUTE_HEADWAY_SHIFT_DAILY,
)


def _inputs_query(index: int) -> TextClause:
    # Reuse every eligibility, instance, direction, daytype and shift predicate
    # from rollups.py:1408-1791. Only the numeric projection crosses R28c's seam.
    sql = str(_SOURCES[index]).split("\n", 1)[1]
    if index == 1:
        sql = sql.split("    INSERT INTO", 1)[0].rstrip()
    else:
        sql = sql.split("    filtered AS (", 1)[0]
        # The preceding comma belongs to the removed filtered CTE.
        sql = sql[: sql.rfind("    ),")] + "    )\n"
    pattern = (
        r"EXTRACT\(\s*EPOCH FROM \(\s*trip_start_utc - "
        r"(LAG\(trip_start_utc\) OVER \(.*?\))\s*\)\s*\)\s*/ 60\.0 AS gap_min"
    )
    sql, count = re.subn(
        pattern, r"(epoch_us(trip_start_utc) - epoch_us(\1)) AS gap_us", sql, flags=re.S
    )
    if count != 1:
        raise ValueError(f"headways: source gap expression changed for {_NAMES[index]}")
    sql = sql.replace(
        "make_interval(days => :fact_retention_days)",
        "(CAST(:fact_retention_days AS INTEGER) * INTERVAL '1 day')",
    )
    sql = sql.replace(
        "ABS(f.delay_seconds) <= 3600",
        f"f.delay_seconds BETWEEN {-GHOST_DELAY_ABS_SECONDS} AND {GHOST_DELAY_ABS_SECONDS}",
    )
    if index == 0:
        select = "SELECT provider_id, route_id, shift, gap_us FROM gaps"
    elif index == 1:
        select = (
            "SELECT provider_id, route_id, direction_id, shift, service_day_kind, gap_us FROM gaps"
        )
    else:
        select = (
            "SELECT provider_id, route_id, CAST(:local_date AS DATE), shift, direction_id, gap_us, "
            "(SELECT COUNT(*) FROM shifted s WHERE s.provider_id=g.provider_id "
            "AND s.route_id=g.route_id AND s.direction_id=g.direction_id "
            "AND s.shift=g.shift) AS trip_count FROM gaps g"
        )
    return named_query(
        f"batch.headways.{_NAMES[index]}.inputs",
        sql + select + " WHERE gap_us > 0 AND gap_us < 14400000000",
    )


def _divide(left: Decimal, right: Decimal) -> Decimal:
    # PostgreSQL numeric.c select_div_scale: normalized base-10000 weights,
    # >=16 significant digits and at least both display scales. Division rounds
    # half away from zero. numeric_mul adds scales; numeric_sum keeps max scale.
    # https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/numeric.c
    def leading(value: Decimal) -> tuple[int, int]:
        weight = value.adjusted() // 4 if value else 0
        return weight, int(abs(value).scaleb(-4 * weight))

    w1, d1 = leading(left)
    w2, d2 = leading(right)
    weight = w1 - w2 - (d1 <= d2)
    scale = max(16 - weight * 4, _scale(left), _scale(right))
    return (left / right).quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_UP)


def _gap(microseconds: int) -> Decimal:
    # EXTRACT(EPOCH FROM interval) has display scale 6, divisor 60.0 scale 1.
    return _divide(Decimal(microseconds).scaleb(-6), Decimal("60.0"))


def _scale(value: Decimal) -> int:
    exponent = value.as_tuple().exponent
    if not isinstance(exponent, int):
        raise ValueError("headways: non-finite numeric")
    return -exponent


def _median(values: list[Decimal]) -> Decimal:
    ordered = sorted(values)
    middle = len(values) // 2
    return ordered[middle] if len(values) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _cov(gaps: list[Decimal]) -> Decimal | None:
    if len(gaps) < 2:
        return None
    n = Decimal(len(gaps))
    total = sum(gaps, Decimal(0))
    squares = sum((v * v for v in gaps), Decimal(0))
    # numeric_stddev_internal: (N*sumX2 - sumX^2)/(N*(N-1)), then sqrt at
    # that division's scale; numeric_avg and final division select scale again.
    variance = _divide(n * squares - total * total, n * (n - 1))
    sd = variance.sqrt().quantize(Decimal(1).scaleb(-_scale(variance)), rounding=ROUND_HALF_UP)
    return _divide(sd, _divide(total, n)).quantize(Decimal(".0001"), rounding=ROUND_HALF_UP)


def _bunched(gaps: list[int]) -> int:
    ordered = sorted(gaps)
    middle = len(ordered) // 2
    # Strict half-median decisions precede numeric division and its rounding.
    if len(ordered) % 2:
        return sum(2 * gap < ordered[middle] for gap in gaps)
    return sum(4 * gap < ordered[middle - 1] + ordered[middle] for gap in gaps)


def _row(
    index: int, key: tuple[Any, ...], values: list[tuple[int, int]], stamp: datetime
) -> tuple[object, ...]:
    with localcontext() as context:
        # Gaps have at most 24 fractional digits; squares 48. Include count
        # digits so summation remains exact regardless of the ambient context.
        context.prec = 100 + len(str(len(values)))
        gaps = [_gap(v[0]) for v in values]
        med = _median(gaps)
        bunched = _bunched([v[0] for v in values])
        if index < 2:
            observed = format(med.quantize(Decimal(".1"), rounding=ROUND_HALF_UP), "f")
            extra = (_cov(gaps), bunched) if index == 0 else ()
            return (*key, observed, len(gaps), stamp, *extra)
        histogram = [0] * 20
        for value in gaps:
            histogram[min(bisect_right(rollups.HEADWAY_GAP_HISTOGRAM_EDGES, value), 20) - 1] += 1
        if any(v > 32767 for v in histogram):
            raise OverflowError("headways.gap_histogram exceeds PostgreSQL smallint")
        return (
            *key,
            len(gaps),
            format(sum(gaps, Decimal(0)), "f"),
            format(sum((v * v for v in gaps), Decimal(0)), "f"),
            bunched,
            values[0][1],
            "{" + ",".join(map(str, histogram)) + "}",
            stamp,
        )


class HeadwaysBuilder:
    family_id = "headways"
    tables = tuple(f"gold.{name}" for name in _NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
        zone = ZoneInfo(request.timezone)
        for day in request.local_dates:
            first = datetime.combine(day, time(), zone).astimezone(UTC)
            if first - timedelta(days=1) < cutoff:
                raise ValueError(f"retention_edge_day {day}: cutoff={cutoff.isoformat()}")
        days = (request.as_of_utc.date() - cutoff.date()).days + 1
        return (InputNeed("core.providers", "all"),) + tuple(
            InputNeed(
                "gold.fact_trip_delay_snapshot", (cutoff.date() + timedelta(days=i)).isoformat()
            )
            for i in range(days)
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        session.execute(
            named_query(
                "batch.headways.provider_view",
                "CREATE VIEW gold.dim_provider AS SELECT provider_id, timezone FROM core.providers",
            )
        )
        tables = {}
        for index, relation in enumerate(self.tables):
            groups: dict[tuple[Any, ...], list[tuple[int, int]]] = defaultdict(list)
            for day in request.local_dates if index == 2 else (None,):
                if isinstance(day, date) and day.isoweekday() > 5:
                    continue
                params: dict[str, object] = dict(provider_id=request.provider_id)
                if day is None:
                    params.update(
                        as_of_utc=request.as_of_utc, fact_retention_days=request.fact_retention_days
                    )
                else:
                    params.update(local_date=day, date_key=int(day.strftime("%Y%m%d")))
                for record in session.execute(_inputs_query(index), params):
                    record_values = tuple(record)
                    size = len(_KEYS[index])
                    gap = record_values[size]
                    trips = record_values[size + 1] if index == 2 else 0
                    if not isinstance(gap, int) or not isinstance(trips, int):
                        raise ValueError("headways: integer gap and trip count required")
                    groups[record_values[:size]].append((gap, trips))
            rows = tuple(
                _row(index, key, values, request.as_of_utc)
                for key, values in sorted(groups.items())
            )
            tables[relation] = TableRows(relation, _COLUMNS[index], _KEYS[index], rows)
        return FamilyOutput(tables, {})


builder = HeadwaysBuilder()
