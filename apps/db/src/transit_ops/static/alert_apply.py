"""Apply captures to seeded local alerts; recovery requires the seed and every capture."""

import json
from dataclasses import replace
from datetime import datetime
from decimal import Decimal
from typing import Any

import duckdb

from transit_ops.live.local_file import LocalFile
from transit_ops.silver.i3 import I3SilverLoadResult, RawI3AlertSnapshot, normalize_i3_alert_payload
from transit_ops.static.alert_observations import record_alert_observations
from transit_ops.static.alert_seed_contract import TABLES


def _jsonb(value: Any) -> str:
    # jsonb orders object keys by UTF-8 byte length, then byte value, recursively.
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: (len(k.encode("utf-8")), k.encode("utf-8")))
        return "{" + ", ".join(f"{_jsonb(k)}: {_jsonb(value[k])}" for k in keys) + "}"
    if isinstance(value, list):
        return "[" + ", ".join(_jsonb(item) for item in value) + "]"
    if isinstance(value, float):
        number = Decimal(str(value))
        # PostgreSQL numeric removes zero's sign without changing its decimal scale.
        if number.is_zero():
            number = number.copy_abs()
        return format(number, "f")
    if isinstance(value, str):
        value.encode("utf-8")
        if "\x00" in value:
            raise ValueError("jsonb cannot represent NUL")
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _insert(duck: duckdb.DuckDBPyConnection, table: str, row: dict[str, Any]) -> None:
    values = [_jsonb(v) if k.startswith("raw_") else v for k, v in row.items()]
    duck.execute(
        f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)}) "
        "ON CONFLICT DO NOTHING",
        values,
    )


def _upsert_alert(duck: duckdb.DuckDBPyConnection, row: dict[str, Any]) -> tuple[int, int]:
    surviving = duck.execute(
        "SELECT i3_alert_snapshot_id, alert_index FROM silver.i3_alerts "
        "WHERE provider_id=? AND content_hash=? AND valid_to IS NULL",
        [row["provider_id"], row["content_hash"]],
    ).fetchone()
    if surviving is not None:
        fields = ("alert_header_text_en", "description_text_en", "url", "url_en")
        duck.execute(
            "UPDATE silver.i3_alerts SET last_seen_at=?, raw_alert_json=?, "
            "message_snapshot_id=?, message_alert_index=?, "
            + ", ".join(f"{field}=?" for field in fields)
            + " WHERE i3_alert_snapshot_id=? AND alert_index=?",
            [
                row["captured_at_utc"],
                _jsonb(row["raw_alert_json"]),
                row["i3_alert_snapshot_id"],
                row["alert_index"],
                *(row[field] for field in fields),
                *surviving,
            ],
        )
        return int(surviving[0]), int(surviving[1])
    _insert(
        duck,
        TABLES[0],
        row
        | {
            "message_snapshot_id": row["i3_alert_snapshot_id"],
            "message_alert_index": row["alert_index"],
            "first_seen_at": row["captured_at_utc"],
            "last_seen_at": row["captured_at_utc"],
        },
    )
    return int(row["i3_alert_snapshot_id"]), int(row["alert_index"])


def _apply_rows(
    duck: duckdb.DuckDBPyConnection, snapshot: RawI3AlertSnapshot, loaded_at: datetime
) -> I3SilverLoadResult:
    alerts, entities, periods = normalize_i3_alert_payload(snapshot)
    for table in reversed(TABLES[:3]):
        duck.execute(
            f"DELETE FROM {table} WHERE i3_alert_snapshot_id=?", [snapshot.i3_alert_snapshot_id]
        )
    survivors = {row["alert_index"]: _upsert_alert(duck, row) for row in alerts}
    redirected = sum(key != (snapshot.i3_alert_snapshot_id, i) for i, key in survivors.items())
    for table, rows in ((TABLES[1], entities), (TABLES[2], periods)):
        for row in rows:
            sid, index = survivors[row["alert_index"]]
            _insert(duck, table, row | {"i3_alert_snapshot_id": sid, "alert_index": index})
    superseded = []
    if alerts:
        hashes = [row["content_hash"] for row in alerts]
        superseded = duck.execute(
            "UPDATE silver.i3_alerts SET valid_to=? WHERE provider_id=? AND valid_to IS NULL "
            "AND content_hash IS NOT NULL AND content_hash NOT IN ("
            + ", ".join("?" for _ in hashes)
            + ") RETURNING i3_alert_snapshot_id",
            [snapshot.captured_at_utc, snapshot.provider_id, *hashes],
        ).fetchall()
    return I3SilverLoadResult(
        snapshot.provider_id,
        snapshot.i3_alert_snapshot_id,
        len(alerts),
        len(entities),
        loaded_at,
        alerts_redirected_to_existing=redirected,
        alerts_superseded=len(superseded),
    )


def apply_alert_snapshot(
    local: LocalFile, snapshot: RawI3AlertSnapshot, *, loaded_at_utc: datetime
) -> I3SilverLoadResult:
    """Apply atomically on the caller's single connection, using already allocated ids.

    Requires a verified alert seed. Capture ownership and durable raw records belong
    to the caller. Original snapshot replay deliberately deletes and rebuilds its rows,
    just as PostgreSQL does; empty captures still record observations.
    """
    with local.transaction() as duck:
        if duck.execute("SELECT provider_id FROM meta").fetchall() != [(snapshot.provider_id,)]:
            raise ValueError("alert snapshot provider differs from local file")
        if duck.execute("SELECT provider_id FROM alert_seed_checkpoint").fetchall() != [
            (snapshot.provider_id,)
        ]:
            raise ValueError("verified alert seed required for provider")
        # Match the JSON round-trip at PostgreSQL's raw capture read before normalization.
        encoded = json.dumps(snapshot.raw_payload_json, ensure_ascii=False, allow_nan=False)
        snapshot = replace(snapshot, raw_payload_json=json.loads(_jsonb(json.loads(encoded))))
        if not record_alert_observations(duck, snapshot):
            return I3SilverLoadResult(
                snapshot.provider_id,
                snapshot.i3_alert_snapshot_id,
                0,
                0,
                loaded_at_utc,
                skipped_older_capture=True,
            )
        return _apply_rows(duck, snapshot, loaded_at_utc)
