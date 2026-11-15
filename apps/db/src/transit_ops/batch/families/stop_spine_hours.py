"""Capture-day stop spines and open-window hourly refresh on DuckDB."""

from collections.abc import Mapping
from datetime import UTC, date, datetime, time, timedelta
from functools import cache
from zoneinfo import ZoneInfo

from sqlalchemy import bindparam
from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.gold import rollups
from transit_ops.gold.delay_periods import GHOST_DELAY_ABS_SECONDS
from transit_ops.sql_registry import named_query

_PREFIX = "batch.stop_spine_hours"
_NAMES = ("stop_delay_spine", "stop_delay_shift_daily", "stop_delay_hourly")
_KEYS = (
    ("provider_id", "stop_id", "route_id", "provider_local_date"),
    ("provider_id", "stop_id", "route_id", "provider_local_date", "shift"),
    ("provider_id", "period_start_utc", "stop_id", "route_id"),
)


@cache
def _check_hour_offsets(timezone: str, day: date) -> None:
    zone = ZoneInfo(timezone)
    start = datetime.combine(day, time(), zone).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
    # TZif transitions and UTC offsets have integer-second precision. Checking every
    # UTC second covers short historical offset intervals as well as DST folds.
    for second in range(int(start.timestamp()), int(end.timestamp())):
        offset = datetime.fromtimestamp(second, zone).utcoffset()
        if offset is None or offset % timedelta(hours=1):
            raise ValueError(f"fractional_utc_offset {timezone} {day.isoformat()}")


def _query(name: str, sql: str) -> TextClause:
    return named_query(f"{_PREFIX}.{name}", sql)


def _create(index: int) -> TextClause:
    # DDL/PK: migration 0093:1082-1092,1343-1363,1847-1858.
    columns = "provider_id TEXT NOT NULL, "
    if index == 2:
        columns += "period_start_utc TIMESTAMPTZ NOT NULL, "
    columns += "stop_id TEXT NOT NULL, route_id TEXT NOT NULL, "
    if index != 2:
        columns += "provider_local_date DATE NOT NULL, "
    if index == 1:
        columns += "shift TEXT NOT NULL, "
    columns += "observation_count INTEGER DEFAULT 0 NOT NULL, "
    if index == 2:
        columns += (
            "avg_arrival_delay_seconds DECIMAL(12,2), avg_departure_delay_seconds DECIMAL(12,2), "
        )
    columns += "severe_delay_count INTEGER DEFAULT 0 NOT NULL, "
    if index != 2:
        columns += "sum_delay_seconds BIGINT DEFAULT 0 NOT NULL, "
    columns += "built_at_utc TIMESTAMPTZ NOT NULL, "
    columns += f"PRIMARY KEY ({', '.join(_KEYS[index])})"
    return _query(f"{_NAMES[index]}.create", f"CREATE TABLE gold.{_NAMES[index]} ({columns})")


def _portable(statement: TextClause) -> str:
    return (
        str(statement)
        .split("\n", 1)[1]
        .replace(
            f"ABS(f.delay_seconds) <= {GHOST_DELAY_ABS_SECONDS}",
            f"f.delay_seconds BETWEEN -{GHOST_DELAY_ABS_SECONDS} AND {GHOST_DELAY_ABS_SECONDS}",
        )
        .replace(
            "make_interval(days => :open_window_days)",
            "CAST(:open_window_days AS INTEGER) * INTERVAL '1 day'",
        )
    )


def _hourly(session: BatchSession, params: dict[str, object]) -> None:
    # rollups.py:1035-1070: numeric AVG rounded to cents, using an exact integer ratio.
    # DuckDB AVG(DECIMAL) returns DOUBLE; avoid a binary intermediate at half cents.
    total, count = "SUM(f.delay_seconds)::BIGINT", "COUNT(*)"
    cents = (
        f"((ABS({total}) * 100 // {count}) + "
        f"CASE WHEN (ABS({total}) * 100 % {count}) * 2 >= {count} THEN 1 ELSE 0 END)"
    )
    mean = f"CAST(SIGN({total}) * {cents} AS DECIMAL(12,0)) * 0.01::DECIMAL(3,2)"
    sql = _portable(rollups.CREATE_STOP_DELAY_HOURLY_SOURCE_SUMMARY)
    sql = sql.replace(" ON COMMIT DROP", "").replace(
        "ROUND(AVG(f.delay_seconds::numeric), 2)", mean
    )
    session.execute(_query("hourly.source", sql), params)
    # One writer in the batch session replaces PostgreSQL's try-lock/work_mem/ANALYZE.
    session.execute(
        _query(
            "hourly.delete", _portable(rollups.DELETE_REPORTING_AGGREGATES["stop_delay_hourly"])
        ),
        params,
    )
    session.execute(_query("hourly.upsert", _portable(rollups.UPSERT_STOP_DELAY_HOURLY)), params)


def _read_rows(session: BatchSession, index: int, request: BuildRequest) -> TableRows:
    relation = f"gold.{_NAMES[index]}"
    scope = (
        "WHERE timezone(:timezone, period_start_utc)::DATE IN :local_dates " if index == 2 else ""
    )
    statement = _query(
        f"{_NAMES[index]}.read",
        f"SELECT * FROM {relation} {scope}ORDER BY {', '.join(_KEYS[index])}",
    )
    params: dict[str, object] = {}
    if index == 2:
        statement = statement.bindparams(bindparam("local_dates", expanding=True))
        params = dict(timezone=request.timezone, local_dates=request.local_dates)
    result = session.execute(statement, params)
    return TableRows(relation, result.columns, _KEYS[index], tuple(map(tuple, result)))


class StopSpineHoursBuilder:
    family_id = "stop_spine_hours"
    tables = tuple(f"gold.{name}" for name in _NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        for day in request.local_dates:
            _check_hour_offsets(request.timezone, day)
        # These statements filter capture time, so R26's feed-key skew does not apply.
        # Hourly reporting refresh reads every capture day from its UTC cutoff onward.
        first = (request.as_of_utc - timedelta(days=request.open_window_days)).date()
        last = request.as_of_utc.date()
        days = set(utc_days(request)) | {
            (first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)
        }
        return (
            (InputNeed("core.providers", "all"),)
            + tuple(InputNeed("gold.fact_trip_delay_snapshot", day) for day in sorted(days))
            + tuple(
                InputNeed("gold.stop_delay_hourly", f"local:{day}") for day in request.local_dates
            )
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        session.execute(
            _query(
                "provider",
                "CREATE VIEW gold.dim_provider AS SELECT provider_id, timezone FROM core.providers",
            )
        )
        session.execute(
            _query(
                "hourly.prior",
                "CREATE TEMP TABLE prior_stop_hours AS SELECT * FROM gold.stop_delay_hourly",
            )
        )
        session.execute(_query("hourly.drop_input", "DROP VIEW gold.stop_delay_hourly"))
        params: dict[str, object] = dict(
            provider_id=request.provider_id,
            built_at_utc=request.as_of_utc,
            open_window_days=request.open_window_days,
        )
        tables = {}
        for index, relation in enumerate(self.tables):
            session.execute(_create(index))
            if index == 2:
                session.execute(
                    _query(
                        "hourly.carry",
                        "INSERT INTO gold.stop_delay_hourly SELECT * FROM prior_stop_hours "
                        "WHERE provider_id=:provider_id",
                    ),
                    params,
                )
                _hourly(session, params)
            else:
                source = (rollups.UPSERT_STOP_DELAY_SPINE, rollups.UPSERT_STOP_DELAY_SHIFT_DAILY)[
                    index
                ]
                statement = _query(f"{_NAMES[index]}.upsert", _portable(source))
                for day in request.local_dates:
                    session.execute(statement, {**params, "local_date": day})
            tables[relation] = _read_rows(session, index, request)
        return FamilyOutput(tables, {})


builder = StopSpineHoursBuilder()
