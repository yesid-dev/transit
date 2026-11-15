"""Closed-day occupancy and co-observed crowding through the batch seam."""

from collections.abc import Mapping
from datetime import date, timedelta

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.gold import rollups
from transit_ops.sql_registry import named_query

_BANDS = (
    "observation_count",
    "empty_count",
    "many_seats_count",
    "few_seats_count",
    "standing_count",
    "full_count",
)
_PREFIX = "batch.occupancy_crowding"
_SOURCES = (
    rollups.UPSERT_ROUTE_OCCUPANCY_BAND_DAILY,
    rollups.UPSERT_ROUTE_OCCUPANCY_BAND_HOURLY,
    rollups.UPSERT_STOP_OCCUPANCY_BAND_DAILY,
    rollups.UPSERT_ROUTE_DELAY_BY_CROWDING_DAILY,
)
_NAMES = (
    "route_occupancy_band_daily",
    "route_occupancy_band_hourly",
    "stop_occupancy_band_daily",
    "route_delay_by_crowding_daily",
)
_KEYS = (
    ("provider_id", "provider_local_date", "route_id"),
    ("provider_id", "route_id", "provider_local_date", "hour_of_day_local"),
    ("provider_id", "provider_local_date", "stop_id"),
    ("provider_id", "provider_local_date", "route_id", "band"),
)


def _upsert(index: int) -> TextClause:
    # Reuse the PostgreSQL filters/grouping (rollups.py:399-497) verbatim.
    sql = str(_SOURCES[index]).split("\n", 1)[1]
    if index == 3:
        # PostgreSQL unconstrained numeric: integer SUM has scale 0, median scale 2.
        # Integer inputs yield exact whole/half-second medians in float8 as well.
        sql = sql.replace("SUM(delay_seconds)::numeric", "SUM(delay_seconds)::DECIMAL(38,0)")
        sql = sql.replace("delay_seconds)::numeric, 2)", "delay_seconds)::DECIMAL(38,2), 2)")
    return named_query(f"{_PREFIX}.{_NAMES[index]}.upsert", sql)


def _create(index: int) -> TextClause:
    # DDL: migration 0093:1174-1183,1242-1267,1364-1375;
    # primary keys: 1810-1812,1829-1834,1859-1861.
    key = _KEYS[index]
    types = {"provider_local_date": "DATE", "hour_of_day_local": "SMALLINT"}
    columns = [f"{name} {types.get(name, 'TEXT')} NOT NULL" for name in key]
    if index == 3:
        columns += [
            "delay_observation_count INTEGER DEFAULT 0 NOT NULL",
            "sum_delay_seconds DECIMAL(38,0) DEFAULT 0 NOT NULL",
            "p50_delay_seconds DECIMAL(38,2)",
        ]
    else:
        columns += [f"{name} INTEGER DEFAULT 0 NOT NULL" for name in _BANDS]
    columns += ["built_at_utc TIMESTAMPTZ NOT NULL", f"PRIMARY KEY ({', '.join(key)})"]
    return named_query(
        f"{_PREFIX}.{_NAMES[index]}.create",
        f"CREATE TABLE gold.{_NAMES[index]} ({', '.join(columns)})",
    )


class OccupancyCrowdingBuilder:
    family_id = "occupancy_crowding"
    tables = tuple(f"gold.{name}" for name in _NAMES)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        capture_days = utc_days(request)
        # Occupancy selects feed-day keys, whereas files partition by capture day (R26).
        # Allow one prior UTC day of clock skew and arbitrary capture lag until the stamp.
        first = max(
            date.fromisoformat(capture_days[0]) - timedelta(days=1),
            (request.as_of_utc - timedelta(days=request.fact_retention_days)).date(),
        )
        last = request.as_of_utc.date()
        occupancy_days = tuple(
            (first + timedelta(days=offset)).isoformat()
            for offset in range((last - first).days + 1)
        )
        return (InputNeed("core.providers", "all"),) + tuple(
            InputNeed(relation, day)
            for relation, days in (
                ("gold.fact_vehicle_snapshot", occupancy_days),
                ("gold.fact_trip_delay_snapshot", capture_days),
            )
            for day in days
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        # dim_provider is a PostgreSQL view; copy-out owns its base table (0093:561-576).
        session.execute(
            named_query(
                f"{_PREFIX}.provider_view",
                "CREATE VIEW gold.dim_provider AS SELECT provider_id, timezone FROM core.providers",
            )
        )
        tables = {}
        for index, relation in enumerate(self.tables):
            session.execute(_create(index))
            statement = _upsert(index)
            for day in request.local_dates:
                session.execute(
                    statement,
                    dict(
                        provider_id=request.provider_id,
                        local_date=day,
                        date_key=int(day.strftime("%Y%m%d")),
                        built_at_utc=request.as_of_utc,
                    ),
                )
            # LS2.2's reader represents unconstrained PostgreSQL numeric as exact text.
            projection = (
                "* REPLACE (sum_delay_seconds::TEXT AS sum_delay_seconds, "
                "p50_delay_seconds::TEXT AS p50_delay_seconds)"
                if index == 3
                else "*"
            )
            result = session.execute(
                named_query(
                    f"{_PREFIX}.{_NAMES[index]}.read",
                    f"SELECT {projection} FROM {relation} ORDER BY {', '.join(_KEYS[index])}",
                )
            )
            tables[relation] = TableRows(
                relation, result.columns, _KEYS[index], tuple(map(tuple, result))
            )
        return FamilyOutput(tables, {})


builder = OccupancyCrowdingBuilder()
