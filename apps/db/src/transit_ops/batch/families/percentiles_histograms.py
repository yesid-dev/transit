"""Capture-local-day route and stop percentiles through the batch seam."""

from collections.abc import Mapping
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.gold import rollups
from transit_ops.gold.delay_periods import GHOST_DELAY_ABS_SECONDS
from transit_ops.sql_registry import named_query

_PREFIX = "batch.percentiles_histograms"
_SOURCES = (
    rollups.UPSERT_ROUTE_DELAY_PERCENTILE_DAILY,
    rollups.UPSERT_STOP_DELAY_PERCENTILE_DAILY,
)


def _create(entity: str) -> TextClause:
    # Migration 0093:1184-1192,1334-1342; primary keys:1815-1817,1850-1852.
    return named_query(
        f"{_PREFIX}.{entity}.create",
        f"""CREATE TABLE gold.{entity}_delay_percentile_daily (
            provider_id TEXT NOT NULL, provider_local_date DATE NOT NULL,
            {entity}_id TEXT NOT NULL, delay_observation_count INTEGER NOT NULL,
            p50_delay_seconds DECIMAL(12,2), p90_delay_seconds DECIMAL(12,2),
            built_at_utc TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (provider_id, provider_local_date, {entity}_id))""",
    )


class PercentilesHistogramsBuilder:
    family_id = "percentiles_histograms"
    tables = ("gold.route_delay_percentile_daily", "gold.stop_delay_percentile_daily")
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
        for day in request.local_dates:
            first = datetime.combine(day, time(), ZoneInfo(request.timezone)).astimezone(UTC)
            # Capture-day membership needs the whole local day, as rollups.py:2020-2035.
            if first < cutoff:
                raise ValueError(f"retention_edge_day {day}: cutoff={cutoff.isoformat()}")
        return (InputNeed("core.providers", "all"),) + tuple(
            InputNeed("gold.fact_trip_delay_snapshot", day) for day in utc_days(request)
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        # dim_provider is the view of the exported provider base (migration 0093:561-576).
        session.execute(
            named_query(
                f"{_PREFIX}.provider_view",
                "CREATE VIEW gold.dim_provider AS SELECT provider_id, timezone FROM core.providers",
            )
        )
        tables = {}
        for entity, source, relation in zip(("route", "stop"), _SOURCES, self.tables, strict=True):
            session.execute(_create(entity))
            # Preserve rollups.py:194-225 population/grouping. Integer delays give p50
            # half-seconds and p90 tenths; explicit scale matches the destination numeric.
            sql = str(source).split("\n", 1)[1].replace("::numeric", "::DECIMAL(12,2)")
            # A range excludes INTEGER_MIN ghosts without overflowing ABS (R28).
            bound = GHOST_DELAY_ABS_SECONDS
            sql = sql.replace(
                f"ABS(f.delay_seconds) <= {bound}",
                f"f.delay_seconds BETWEEN {-bound} AND {bound}",
            )
            statement = named_query(f"{_PREFIX}.{entity}.upsert", sql)
            for day in request.local_dates:
                session.execute(
                    statement,
                    dict(
                        provider_id=request.provider_id,
                        local_date=day,
                        built_at_utc=request.as_of_utc,
                    ),
                )
            key = ("provider_id", "provider_local_date", f"{entity}_id")
            result = session.execute(
                named_query(
                    f"{_PREFIX}.{entity}.read",
                    f"SELECT * FROM {relation} ORDER BY {', '.join(key)}",
                )
            )
            tables[relation] = TableRows(relation, result.columns, key, tuple(map(tuple, result)))
        return FamilyOutput(tables, {})


builder = PercentilesHistogramsBuilder()
