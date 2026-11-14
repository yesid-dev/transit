"""Project bounded reconstructed Silver episodes into prepared archive evidence."""

from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, text

from transit_ops.gold.alert_archive import prepare_recovered_archive_record
from transit_ops.history.alert_recovery_capture_state import fold_alert_snapshots
from transit_ops.history.alert_recovery_models import Candidate
from transit_ops.silver.i3 import RawI3AlertSnapshot, alert_message_provenance

# gold/alert_archive.py:37-43: PostgreSQL rendering is part of anonymous identity.
_ANONYMOUS_ID = text("""
    SELECT MD5(JSONB_BUILD_ARRAY(
        COALESCE(CAST(:header AS text), ''), COALESCE(CAST(:description AS text), ''),
        EXTRACT(EPOCH FROM CAST(:start AS timestamptz)),
        EXTRACT(EPOCH FROM CAST(:end AS timestamptz))
    )::text)
""")
type Row = dict[str, Any]


def _identity(connection: Connection, row: Row, provider_id: str) -> str:
    upstream = (row["alert_id"] or "").strip()
    if upstream:
        return str(upstream)
    digest = connection.execute(
        _ANONYMOUS_ID,
        {
            "header": row["alert_header_text"],
            "description": row["description_text"],
            "start": row["active_period_start_utc"],
            "end": row["active_period_end_utc"],
        },
    ).scalar_one()
    return f"{provider_id}-alert-{digest[:12]}"


def _key(row: Row) -> tuple[int, int]:
    return row["i3_alert_snapshot_id"], row["alert_index"]


def _latest_values(rows: list[Row]) -> tuple[Row, Row]:
    # gold/alert_archive.py:67-101: message and nonnull enrichment have distinct orders.
    latest = max(
        rows,
        key=lambda r: (
            r["last_seen_at"],
            r["message_snapshot_id"],
            r["message_alert_index"],
            *_key(r),
        ),
    )
    ordered = sorted(
        rows, key=lambda r: (r["last_seen_at"], r["captured_at_utc"], *_key(r)), reverse=True
    )
    result = {
        name: latest[source]
        for name, source in (
            ("header_text", "alert_header_text"),
            ("header_text_en", "alert_header_text_en"),
            ("description_text", "description_text"),
            ("description_text_en", "description_text_en"),
            ("url", "url"),
            ("url_en", "url_en"),
        )
    }
    for name, source in (
        ("severity", "severity"),
        ("cause", "cause"),
        ("effect", "effect"),
        ("start_utc", "active_period_start_utc"),
        ("end_utc", "active_period_end_utc"),
    ):
        result[name] = next((r[source] for r in ordered if r[source] is not None), None)
    return latest, result


def _project(rows: list[Row], entities: list[Row], periods: list[Row], zone: ZoneInfo) -> Row:
    latest, result = _latest_values(rows)
    # gold/alert_archive.py:102-153, 165-169: episode unions, fallback, local month.
    result["first_seen_utc"] = min(r["first_seen_at"] for r in rows)
    result["last_seen_utc"] = max(r["last_seen_at"] for r in rows)
    result["archive_month"] = (
        (result["start_utc"] or result["first_seen_utc"]).astimezone(zone).date().replace(day=1)
    )
    keys = {_key(r) for r in rows}
    for name in ("route_id", "stop_id"):
        result[name + "s"] = [e[name] for e in entities if _key(e) in keys and e[name] is not None]
    values = [
        {"start_utc": p["start_utc"], "end_utc": p["end_utc"]} for p in periods if _key(p) in keys
    ]
    child_keys = {_key(p) for p in periods}
    values += [
        {"start_utc": r["active_period_start_utc"], "end_utc": r["active_period_end_utc"]}
        for r in rows
        if _key(r) not in child_keys
    ]
    result["active_periods"] = [
        {k: v.isoformat().replace("+00:00", "Z") if v is not None else None for k, v in p.items()}
        for p in values
    ]
    result["message"] = alert_message_provenance(
        latest["raw_alert_json"],
        latest["message_snapshot_id"],
        latest["message_alert_index"],
        latest["last_seen_at"],
    )
    return result


def prepare_capture_candidates(
    connection: Connection,
    *,
    snapshots: Iterable[RawI3AlertSnapshot],
    provider_id: str,
    provider_timezone: str,
    recovered_at_utc: datetime,
    source_locator: str,
) -> tuple[Candidate, ...]:
    """Read only; the caller owns interval/coverage checks and the transaction.

    Replay starts empty; pre-window state and original load order remain unknown.
    The locator describes the bounded aggregate, rather than one capture object.
    """
    zone = ZoneInfo(provider_timezone)
    snapshots = tuple(snapshots)
    if not provider_id or any(
        s.provider_id != provider_id or s.provider_timezone != provider_timezone for s in snapshots
    ):
        raise ValueError("provider scope mismatch")
    if recovered_at_utc.utcoffset() is None:
        raise ValueError("aware recovery timestamp required")
    state = fold_alert_snapshots(snapshots)
    groups: dict[str, list[Row]] = defaultdict(list)
    for row in state.alert_rows:
        groups[_identity(connection, row, provider_id)].append(row)
    candidates = []
    for identity, rows in groups.items():
        source = _project(rows, list(state.entity_rows), list(state.period_rows), zone)
        # gold/alert_archive.py:388-411, 470-520 owns ordering, validation and hashing.
        record = prepare_recovered_archive_record(
            {**source, "alert_id": identity},
            provider_id=provider_id,
            recovered_at_utc=recovered_at_utc,
        )
        candidates.append(
            Candidate(
                provider_id, identity, record["archive_month"], record, "capture", source_locator
            )
        )
    return tuple(sorted(candidates, key=lambda c: (c.archive_month, c.alert_id)))
