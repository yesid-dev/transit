"""Observation recording and capture admission in the caller's local transaction."""

from dataclasses import astuple
from zoneinfo import ZoneInfo

import duckdb

from transit_ops.silver.i3 import RawI3AlertSnapshot, build_alert_language_observations


def _source_alert_count(payload: object) -> int:
    if isinstance(payload, dict):
        payload = next(
            (
                payload[k]
                for k in ("alerts", "messages", "data", "items", "results")
                if isinstance(payload.get(k), list)
            ),
            [],
        )
    return sum(isinstance(item, dict) for item in payload) if isinstance(payload, list) else 0


def record_alert_observations(
    duck: duckdb.DuckDBPyConnection, snapshot: RawI3AlertSnapshot
) -> bool:
    """Record even stale/empty captures; return whether alert state may change.

    The caller owns the transaction and the already-verified local alert schema.
    Equal timestamps replace observations, matching the PostgreSQL loader.
    """
    observations = build_alert_language_observations(snapshot)
    day = snapshot.captured_at_utc.astimezone(ZoneInfo(snapshot.provider_timezone)).date()
    duck.execute(
        "INSERT INTO raw.alert_feed_observations VALUES (?, ?, ?, ?) "
        "ON CONFLICT (provider_id, observation_date) DO UPDATE SET "
        "alert_count=excluded.alert_count, observed_at_utc=excluded.observed_at_utc "
        "WHERE excluded.observed_at_utc >= alert_feed_observations.observed_at_utc",
        [
            snapshot.provider_id,
            day,
            _source_alert_count(snapshot.raw_payload_json),
            snapshot.captured_at_utc,
        ],
    )
    if observations:
        duck.executemany(
            "INSERT INTO raw.alert_language_observations VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (provider_id, alert_logical_id, observation_date) DO UPDATE SET "
            "has_explicit_fr=excluded.has_explicit_fr, has_explicit_en=excluded.has_explicit_en, "
            "undetermined=excluded.undetermined, observed_at_utc=excluded.observed_at_utc "
            "WHERE excluded.observed_at_utc >= alert_language_observations.observed_at_utc",
            [astuple(observation) for observation in observations],
        )
    return (
        duck.execute(
            "SELECT 1 FROM raw.alert_feed_observations "
            "WHERE provider_id=? AND observed_at_utc > ? LIMIT 1",
            [snapshot.provider_id, snapshot.captured_at_utc],
        ).fetchone()
        is None
    )
