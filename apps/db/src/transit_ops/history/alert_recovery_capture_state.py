"""Bounded chronological reconstruction of Silver alert episodes, without I/O."""

import json
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import UTC
from zoneinfo import ZoneInfo

from transit_ops.silver.i3 import RawI3AlertSnapshot, normalize_i3_alert_payload

type Row = dict[str, object]
type Key = tuple[object, object]


@dataclass(frozen=True)
class AlertCaptureState:
    alert_rows: tuple[Row, ...]
    entity_rows: tuple[Row, ...]
    period_rows: tuple[Row, ...]
    limitations: tuple[str, ...] = (
        "Retained captures only; observations before/after the interval unknown.",
        "Reconstructed from empty state; pre-window Silver state unknown.",
        "Chronological capture order with numeric id ties; original load order unknown.",
    )


def _checked_snapshots(snapshots: Iterable[RawI3AlertSnapshot]) -> list[RawI3AlertSnapshot]:
    unique: dict[int, RawI3AlertSnapshot] = {}
    zones: dict[str, str] = {}
    for snapshot in snapshots:
        number = snapshot.i3_alert_snapshot_id
        if type(number) is not int or number <= 0:
            raise ValueError("capture id must be a positive integer")
        if snapshot.captured_at_utc.utcoffset() is None:
            raise ValueError("capture time must be aware")
        snapshot = replace(snapshot, captured_at_utc=snapshot.captured_at_utc.astimezone(UTC))
        ZoneInfo(snapshot.provider_timezone)
        if (
            zones.setdefault(snapshot.provider_id, snapshot.provider_timezone)
            != snapshot.provider_timezone
        ):
            raise ValueError("contradictory provider timezone")
        payload = snapshot.raw_payload_json
        if isinstance(payload, dict):
            payload = next(
                (
                    payload[k]
                    for k in ("alerts", "messages", "data", "items", "results")
                    if isinstance(payload.get(k), list)
                ),
                None,
            )
        if not isinstance(payload, list) or any(not isinstance(item, dict) for item in payload):
            raise ValueError("invalid alert container")
        # Preserve decoded types; let normalization decide which key order matters.
        if number in unique and (
            unique[number] != snapshot
            or json.dumps(unique[number].raw_payload_json, allow_nan=False, sort_keys=True)
            != json.dumps(snapshot.raw_payload_json, allow_nan=False, sort_keys=True)
            or normalize_i3_alert_payload(unique[number]) != normalize_i3_alert_payload(snapshot)
        ):
            raise ValueError("contradictory capture id")
        unique[number] = snapshot
    return sorted(unique.values(), key=lambda s: (s.captured_at_utc, s.i3_alert_snapshot_id))


def _observe(row: Row, active: dict[Key, Row], alerts: list[Row]) -> Key:
    identity = (row["provider_id"], row["content_hash"])
    survivor = active.get(identity)
    if survivor is None:
        survivor = {
            **row,
            "first_seen_at": row["captured_at_utc"],
            "valid_to": None,
        }
        alerts.append(survivor)
        active[identity] = survivor
    # silver/i3.py:135-143: only these message fields change on a hash repeat.
    survivor.update(
        {
            field: row[field]
            for field in (
                "alert_header_text_en",
                "description_text_en",
                "url",
                "url_en",
                "raw_alert_json",
            )
        }
    )
    survivor.update(
        last_seen_at=row["captured_at_utc"],
        message_snapshot_id=row["i3_alert_snapshot_id"],
        message_alert_index=row["alert_index"],
    )
    return survivor["i3_alert_snapshot_id"], survivor["alert_index"]


def _retain_children(
    children: list[Row],
    survivors: dict[object, Key],
    index: str,
    retained: dict[tuple[object, object, object], Row],
) -> None:
    for child in children:
        snap_id, alert_index = survivors[child["alert_index"]]
        key = (snap_id, alert_index, child[index])
        # silver/i3.py:775-818: redirect to episode key before index conflict handling.
        retained.setdefault(
            key, {**child, "i3_alert_snapshot_id": snap_id, "alert_index": alert_index}
        )


def fold_alert_snapshots(snapshots: Iterable[RawI3AlertSnapshot]) -> AlertCaptureState:
    """Replay each unique capture once; refuse contradictory ids or invalid containers.

    Rows keep the normalizer's column names, plus Silver's observation/message and
    closure fields. Input order is immaterial. Bounds and byte verification belong
    to the caller; this state cannot establish source coverage or historical parity.
    """
    active: dict[Key, Row] = {}
    alerts: list[Row] = []
    entities: dict[tuple[object, object, object], Row] = {}
    periods: dict[tuple[object, object, object], Row] = {}
    for snapshot in _checked_snapshots(snapshots):
        rows, child_rows, period_rows = normalize_i3_alert_payload(snapshot)
        rows, child_rows, period_rows = deepcopy((rows, child_rows, period_rows))
        survivors = {row["alert_index"]: _observe(row, active, alerts) for row in rows}
        _retain_children(child_rows, survivors, "entity_index", entities)
        _retain_children(period_rows, survivors, "period_index", periods)
        if rows:
            present = {row["content_hash"] for row in rows}
            vanished = [
                key for key in active if key[0] == snapshot.provider_id and key[1] not in present
            ]
            # silver/i3.py:820-832: empty batches do not close active hashes.
            for key in vanished:
                active.pop(key)["valid_to"] = snapshot.captured_at_utc.astimezone(UTC)
    return AlertCaptureState(tuple(alerts), tuple(entities.values()), tuple(periods.values()))
