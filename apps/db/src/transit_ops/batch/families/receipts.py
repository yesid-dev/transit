"""Accountability only; historic receipt publication is a separate packet."""

from collections.abc import Mapping
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.sql.elements import TextClause

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.engine import BatchSession
from transit_ops.sql_registry import named_query

_TABLE = "gold.citizen_accountability_daily"
_KEY = ("provider_id", "provider_local_date")
_CREATE = named_query(
    "batch.receipts.create",
    # DDL: 0093_alert_publication_provenance.py:317-327, PK:1769-1771.
    f"""CREATE TABLE {_TABLE} (
        provider_id TEXT NOT NULL, provider_local_date DATE NOT NULL,
        affected_route_count INTEGER DEFAULT 0, affected_stop_count INTEGER DEFAULT 0,
        delayed_trip_count INTEGER DEFAULT 0 NOT NULL,
        severe_delay_count INTEGER DEFAULT 0 NOT NULL, alert_count INTEGER DEFAULT 0 NOT NULL,
        rider_impact_score DECIMAL(8,4), built_at_utc TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (provider_id, provider_local_date))""",
)
_UPSERT = named_query(
    "batch.receipts.upsert",
    """
    WITH route_hour AS (
        SELECT route_id, hour_of_day_local,
            SUM(severe_delay_count)::HUGEINT severe,
            SUM(delayed_trip_count)::HUGEINT delayed,
            SUM(sum_delay_seconds)::HUGEINT delay_sum,
            -- Copy-out stores arrays as PG text; native family inputs use LIST.
            -- Decode both as the declared int2[], preserving NULL/empty arrays.
            SUM(COALESCE(list_sum(CAST(replace(replace(
                delay_histogram::VARCHAR, '{', '['), '}', ']') AS SMALLINT[])), 0))::HUGEINT samples
        FROM gold.route_delay_spine
        WHERE provider_id = :provider_id AND provider_local_date = :day
        GROUP BY route_id, hour_of_day_local
    ), route_daily AS (
        SELECT COUNT(DISTINCT route_id) FILTER (
            WHERE severe > 0 OR (samples > 0 AND delay_sum * 200 >= samples * 60001)
        )::INTEGER affected, SUM(delayed)::INTEGER delayed, SUM(severe)::INTEGER severe
        FROM route_hour HAVING COUNT(*) > 0
    ), stop_daily AS (
        SELECT COUNT(DISTINCT stop_id) FILTER (
            WHERE COALESCE(avg_arrival_delay_seconds, avg_departure_delay_seconds) > 300
               OR severe_delay_count > 0
        )::INTEGER affected
        FROM gold.stop_delay_hourly
        WHERE provider_id = :provider_id
          AND timezone(:timezone, period_start_utc)::DATE = :day
        HAVING COUNT(*) > 0
    ), alerts AS (
        SELECT COUNT(DISTINCT md5(COALESCE(description_text, '') || COALESCE(severity, '')
            || COALESCE(cause, '') || COALESCE(effect, '')))::INTEGER alerts
        FROM silver.i3_alerts
        WHERE provider_id = :provider_id
          AND timezone(:timezone, captured_at_utc)::DATE = :day
        HAVING COUNT(*) > 0
    )
    INSERT INTO gold.citizen_accountability_daily
    SELECT :provider_id, :day, r.affected, s.affected,
        COALESCE(r.delayed, 0), COALESCE(r.severe, 0), COALESCE(a.alerts, 0),
        CASE WHEN r.affected IS NULL AND s.affected IS NULL THEN NULL
        ELSE LEAST(9999.9999::DECIMAL(8,4),
            (COALESCE(r.affected, 0)::HUGEINT * 2 + COALESCE(s.affected, 0)
             + COALESCE(r.delayed, 0)::HUGEINT + COALESCE(r.severe, 0)::HUGEINT * 3
             + COALESCE(a.alerts, 0)::HUGEINT * 2)::DECIMAL(38,4)) END,
        :built_at_utc
    FROM (SELECT 1) seed
    LEFT JOIN route_daily r ON true LEFT JOIN stop_daily s ON true LEFT JOIN alerts a ON true
    WHERE r.affected IS NOT NULL OR s.affected IS NOT NULL OR a.alerts IS NOT NULL
    """,
)


class ReceiptsBuilder:
    family_id = "receipts"
    tables = (_TABLE,)
    published_keys: tuple[str, ...] = ()
    variants: Mapping[str, TextClause] = {}

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        zone = ZoneInfo(request.timezone)
        for day in request.local_dates:
            start = datetime.combine(day, time(), zone).astimezone(UTC)
            end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
            instant = start
            while instant <= end:
                offset = instant.astimezone(zone).utcoffset()
                if offset is None or offset.total_seconds() % 3600:
                    raise ValueError(f"fractional_utc_offset: {request.timezone} {day}")
                instant += timedelta(hours=1)
        return (
            InputNeed("core.providers", "all"),
            # R27b: working-only, so archive replay requires an explicit source ruling.
            InputNeed("silver.i3_alerts", "all"),
            *(InputNeed("gold.route_delay_spine", f"local:{day}") for day in request.local_dates),
            *(InputNeed("gold.stop_delay_hourly", day) for day in utc_days(request)),
        )

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        timezone = session.execute(
            named_query(
                "batch.receipts.provider",
                "SELECT timezone FROM core.providers WHERE provider_id = :provider_id",
            ),
            dict(provider_id=request.provider_id),
        ).scalar_one()
        if timezone != request.timezone:
            raise ValueError("provider_timezone_mismatch")
        session.execute(_CREATE)
        # Fixed input files replace whole requested days. The PG open-window delete
        # (rollups.py:1003-1016) is unnecessary in a fresh output table (R29).
        # ROUND(sum/count,2)>300 iff 200*sum>=60001*count for positive count;
        # this integer comparison preserves the halfway case without floating division.
        for day in request.local_dates:
            session.execute(
                _UPSERT,
                dict(
                    provider_id=request.provider_id,
                    day=day,
                    timezone=request.timezone,
                    built_at_utc=request.as_of_utc,
                ),
            )
        result = session.execute(
            named_query(
                "batch.receipts.read",
                f"SELECT * FROM {_TABLE} ORDER BY provider_id, provider_local_date",
            )
        )
        return FamilyOutput(
            {_TABLE: TableRows(_TABLE, result.columns, _KEY, tuple(map(tuple, result)))}, {}
        )


builder = ReceiptsBuilder()
