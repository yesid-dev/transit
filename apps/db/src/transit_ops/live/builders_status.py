"""Complete borrowed local bundle, intentionally unwired and without clock/IO ownership."""

import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast

from transit_ops.gold.reader import otp_pct as _otp_pct
from transit_ops.gold.reader import round_half_away
from transit_ops.live import builders_movement as movement
from transit_ops.live.local_file import LocalFile
from transit_ops.live.publication_context import PublicationContext, aware, event
from transit_ops.live.running import Projection, ScheduleInputs, TripHolder, project_running
from transit_ops.silver.i3 import alert_message_provenance
from transit_ops.snapshots.builders._helpers import (
    _OCCUPANCY_MAP,
    _SURFACES,
    _alert_active_periods,
    _iso,
    _opt_iso,
    _percentile,
    _sane_en,
    _severity_code,
)
from transit_ops.snapshots.builders.live import (
    _data_health_gate,
    _delay_histogram,
    _derive_capabilities,
)
from transit_ops.snapshots.contract import (
    Alert,
    AlertMessageProvenance,
    AlertsFile,
    DataHealth,
    DataHealthFeed,
    LaneHealth,
    Manifest,
    ManifestFiles,
    ManifestHistoricFiles,
    ManifestLiveFiles,
    ManifestStaticFiles,
    NetworkFile,
    NonRespondingRoute,
    OccupancyMix,
    Severity,
    StatusDist,
)
from transit_ops.snapshots.serialization import snapshot_json_bytes
from transit_ops.static.alert_apply import _jsonb
from transit_ops.static.alert_seed_contract import SCHEMAS


def _rows(local: LocalFile, table: str, provider: str) -> list[dict[str, Any]]:
    # Fetch timestamptz as ISO text: DuckDB's Python conversion requires optional pytz.
    columns = SCHEMAS[table]
    fields = [
        f"strftime({c}, '%Y-%m-%dT%H:%M:%S.%f+00:00')" if t == "timestamp with time zone" else c
        for c, t in columns.items()
    ]
    values = local.connection.execute(
        f"SELECT {', '.join(fields)} FROM {table} WHERE provider_id=?", [provider]
    ).fetchall()
    return [
        {
            c: datetime.fromisoformat(v)
            if v is not None and columns[c] == "timestamp with time zone"
            else v
            for c, v in zip(columns, row, strict=True)
        }
        for row in values
    ]


def _observed(local: LocalFile, context: PublicationContext) -> datetime | None:
    row = local.connection.execute(
        "SELECT strftime(max(observed_at_utc), '%Y-%m-%dT%H:%M:%S.%f+00:00') "
        "FROM raw.alert_feed_observations WHERE provider_id=?",
        [context.provider_id],
    ).fetchone()
    return event(row[0] if row else None, context.cycle, "alert observation")


def _key(row: dict[str, Any]) -> str:
    upstream = (row["alert_id"] or "").strip()
    if upstream:
        return "upstream:" + upstream
    # Preserve PostgreSQL jsonb's timestamp numeric scale for stable published IDs.
    parts = [row["alert_header_text"] or "", row["description_text"] or ""]
    epochs = [
        None if row[k] is None else _epoch(row[k])
        for k in ("active_period_start_utc", "active_period_end_utc")
    ]
    encoded = (
        "["
        + ", ".join(
            [*(_jsonb(v) for v in parts), *("null" if v is None else str(v) for v in epochs)]
        )
        + "]"
    )
    return "synthetic:" + hashlib.md5(encoded.encode()).hexdigest()


def _epoch(stamp: datetime) -> Decimal:
    delta = stamp - datetime(1970, 1, 1, tzinfo=UTC)
    return (
        Decimal(delta.days * 86400 + delta.seconds) + Decimal(delta.microseconds) / 1000000
    ).quantize(Decimal("0.000001"))


def _alert(local: LocalFile, row: dict[str, Any], key: str) -> Alert:
    identity = [row["i3_alert_snapshot_id"], row["alert_index"]]
    children = local.connection.execute(
        "SELECT route_id, stop_id FROM silver.i3_alert_informed_entities "
        "WHERE i3_alert_snapshot_id=? AND alert_index=?",
        identity,
    ).fetchall()
    periods = local.connection.execute(
        "SELECT strftime(start_utc, '%Y-%m-%dT%H:%M:%S.%f+00:00'), "
        "strftime(end_utc, '%Y-%m-%dT%H:%M:%S.%f+00:00') FROM silver.i3_alert_active_periods "
        "WHERE i3_alert_snapshot_id=? AND alert_index=? ORDER BY period_index",
        identity,
    ).fetchall()
    start, end = row["active_period_start_utc"], row["active_period_end_utc"]
    return Alert(
        id=(row["alert_id"] or "").strip() or f"{row['provider_id']}-alert-{key[10:22]}",
        message=cast(
            AlertMessageProvenance | None,
            alert_message_provenance(
                json.loads(row["raw_alert_json"]),
                row["message_snapshot_id"],
                row["message_alert_index"],
                row["last_seen_at"] or row["captured_at_utc"],
            ),
        ),
        severity=cast(Severity, _severity_code(row["severity"])),
        header_key=row["alert_header_text"] or "",
        header_text=row["alert_header_text"] or "",
        description=row["description_text"],
        header_text_en=_sane_en(row["alert_header_text_en"]),
        description_en=_sane_en(row["description_text_en"]),
        routes=sorted({r[0] for r in children if r[0] is not None}),
        stops=sorted({r[1] for r in children if r[1] is not None}),
        start_utc=_opt_iso(start),
        end_utc=_opt_iso(end),
        cause=row["cause"],
        effect=row["effect"],
        severity_level=row["severity"],
        url=row["url"],
        url_en=_sane_en(row["url_en"]),
        active_periods=_alert_active_periods(
            [dict(start_utc=s, end_utc=e) for s, e in periods], start, end
        ),
    )


def build_alerts(local: LocalFile, context: PublicationContext, enabled: bool) -> AlertsFile:
    cycle = aware(context.cycle, "cycle")
    if not enabled:
        return AlertsFile(generated_utc=_iso(cycle), alerts=[], feed_captured_utc=None)
    _require_alert_seed(local, context)
    selected: dict[str, dict[str, Any]] = {}
    for row in _rows(local, "silver.i3_alerts", context.provider_id):
        if row["valid_to"] is not None:
            continue
        event(row["last_seen_at"] or row["captured_at_utc"], cycle, "alert message")
        key = _key(row)

        def rank(r: dict[str, Any]) -> tuple[Any, ...]:
            return (
                r["last_seen_at"] or r["captured_at_utc"],
                r["message_snapshot_id"] or r["i3_alert_snapshot_id"],
                r["message_alert_index"]
                if r["message_alert_index"] is not None
                else r["alert_index"],
                r["i3_alert_snapshot_id"],
                r["alert_index"],
            )

        if key not in selected or rank(row) > rank(selected[key]):
            selected[key] = row
    ordered = sorted(
        selected.items(),
        key=lambda p: (
            p[1]["active_period_start_utc"] is None,
            p[1]["active_period_start_utc"] or cycle,
            p[1]["alert_header_text"] is None,
            p[1]["alert_header_text"] or "",
            p[1]["description_text"] is None,
            p[1]["description_text"] or "",
        ),
    )
    stamp = _observed(local, context)
    return AlertsFile(
        generated_utc=_iso(cycle),
        alerts=[_alert(local, r, k) for k, r in ordered],
        feed_captured_utc=_opt_iso(stamp),
    )


def _certificate(
    local: LocalFile, endpoint: str, evidence: Any, cycle: datetime
) -> datetime | None:
    row = local.connection.execute(
        "SELECT capture_row_id, captured_at_utc FROM local_serving WHERE endpoint_key=?", [endpoint]
    ).fetchone()
    if row is None:
        return None
    stamp = event(row[1].replace(tzinfo=UTC), cycle, endpoint)
    assert stamp is not None
    actual = (evidence.capture_id, evidence.captured_at)
    if actual == (row[0], stamp):
        return stamp
    if (
        actual[0] is None
        or actual[1] is None
        or actual[0] == row[0]
        or (actual[1], actual[0]) < (stamp, row[0])
    ):
        raise ValueError(f"local_{endpoint}_serving_mismatch")
    return None


def _non_responding(
    local: LocalFile, context: PublicationContext, projection: Projection, endpoints: set[str]
) -> list[NonRespondingRoute]:
    # Presence uses every successfully applied vehicle, even one without map coordinates.
    from transit_ops.live.running import _vehicles

    raw, _ = (
        _vehicles(local, context.provider_id) if "vehicle_positions" in endpoints else ([], None)
    )
    seen = {r["trip_id"] for r in raw}
    missing = Counter(route for route, trip in projection.running if trip not in seen)
    return [
        NonRespondingRoute(route_id=r, count=n)
        for r, n in sorted(missing.items(), key=lambda pair: (-pair[1], pair[0]))
    ]


def _freshness(
    local: LocalFile, context: PublicationContext, projection: Projection, endpoints: set[str]
) -> int | None:
    stamps = [
        _certificate(local, e, evidence, context.cycle)
        for e, evidence in (
            ("trip_updates", projection.trip_evidence),
            ("vehicle_positions", projection.vehicle_evidence),
        )
        if e in endpoints
    ]
    freshness = (
        max((context.cycle - s).total_seconds() for s in stamps if s is not None)
        if stamps and all(s is not None for s in stamps)
        else None
    )
    return int(round_half_away(freshness, 0)) if freshness is not None else None


def build_network(
    local: LocalFile, context: PublicationContext, projection: Projection, endpoints: set[str]
) -> NetworkFile:
    dist = StatusDist()
    occupancy: Counter[str] = Counter()
    vehicles = [r for r in projection.vehicles if r["trip_id"]]
    for row in vehicles:
        code = movement._status(row["trip_avg_delay_seconds"])
        setattr(dist, code, getattr(dist, code) + 1)
        if row["occupancy_status"] in _OCCUPANCY_MAP:
            occupancy[_OCCUPANCY_MAP[row["occupancy_status"]]] += 1
    known = len(vehicles) - dist.unknown
    delays = sorted(float(r["avg_delay_seconds"]) / 60 for r in projection.delays)
    routes = _non_responding(local, context, projection, endpoints)
    total = sum(occupancy.values())
    return NetworkFile(
        generated_utc=_iso(context.cycle),
        vehicles_in_service=len(vehicles),
        on_time_pct=_otp_pct(dist.on_time + dist.late, known),
        status_dist=dist,
        delay_p50_min=int(round_half_away(_percentile(delays, 0.5), 0)) if delays else None,
        delay_p90_min=int(round_half_away(_percentile(delays, 0.9), 0)) if delays else None,
        occupancy_mix=OccupancyMix(
            **{
                k: occupancy[k] / total
                for k in ("empty", "many_seats", "few_seats", "standing", "full")
            }
        )
        if total
        else None,
        non_responding=sum(r.count for r in routes),
        feed_freshness_s=_freshness(local, context, projection, endpoints),
        coverage_pct=_otp_pct(known, len(vehicles)),
        delay_histogram=_delay_histogram(delays),
        non_responding_by_route=routes or None,
    )


def build_manifest(
    context: PublicationContext,
    provider: dict[str, Any],
    endpoints: set[str],
    tiers: list[dict[str, Any]],
) -> Manifest:
    versions = context.rows("editions")
    for row in versions:
        event(row["loaded_at_utc"], context.cycle, "edition loaded_at_utc")
    version = max(versions, key=lambda r: datetime.fromisoformat(r["loaded_at_utc"]), default={})
    stamps = {
        r["tier"]: _opt_iso(event(r.get("generated_utc"), context.cycle, "tier")) for r in tiers
    }
    base = provider["public_base_url"].rstrip("/")
    basemap = bool(provider["basemap_url"])
    return Manifest(
        provider=context.provider_id,
        display_name=provider["display_name"] or context.provider_id,
        short_name=provider["short_name"] or None,
        city=provider["city"] or None,
        tz=provider["timezone"] or "America/Toronto",
        default_lang=provider["default_language"] or "fr",
        attribution=provider["attribution_text"] or "",
        bbox=[
            float(provider[k] or 0)
            for k in ("min_longitude", "min_latitude", "max_longitude", "max_latitude")
        ],
        dataset_version=str(
            version.get("source_version") or version.get("dataset_version_id") or "unknown"
        ),
        basemap=f"{base}/v1/{context.provider_id}/static/basemap.json" if basemap else None,
        labels={"fr": "labels/fr.json", "en": "labels/en.json"},
        surfaces=list(_SURFACES),
        capabilities=_derive_capabilities(endpoints),
        files=ManifestFiles(
            live=ManifestLiveFiles(
                generated_utc=_iso(context.cycle), source_lag_s=provider["source_lag_s"]
            ),
            static=ManifestStaticFiles(
                basemap="static/basemap.json" if basemap else None,
                generated_utc=stamps.get("static"),
            ),
            historic=ManifestHistoricFiles(generated_utc=stamps.get("historic")),
        ),
    )


def build_data_health(
    local: LocalFile,
    context: PublicationContext,
    projection: Projection,
    tiers: list[dict[str, Any]],
) -> DataHealth:
    lanes = []
    for tier, label in (("live", "live"), ("static", "static"), ("historic", "rollup")):
        for row in (r for r in tiers if r["tier"] == tier):
            stamp = event(row.get("generated_utc"), context.cycle, "tier")
            event(row.get("gate_generated_utc"), context.cycle, "gate")
            lanes.append(
                LaneHealth(
                    lane=label,
                    last_publish_utc=_opt_iso(stamp),
                    age_s=int((context.cycle - stamp).total_seconds() // 1) if stamp else None,
                    files_written=row.get("files_written"),
                    files_skipped=row.get("files_skipped"),
                    files_total=row.get("files_total"),
                    gate=_data_health_gate(row),
                )
            )
    feeds = []
    evidence = {
        "trip_updates": projection.trip_evidence,
        "vehicle_positions": projection.vehicle_evidence,
    }
    for row in sorted(context.rows("feeds"), key=lambda r: r["endpoint_key"]):
        endpoint = row["endpoint_key"]
        if endpoint in evidence:
            stamp = _certificate(local, endpoint, evidence[endpoint], context.cycle)
        elif endpoint in ("i3_alerts", "service_alerts"):
            stamp = _observed(local, context)
        else:
            stamp = event(row["successful_completed_at_utc"], context.cycle, "successful poll")
        feeds.append(
            DataHealthFeed(
                feed=endpoint,
                status=row["status"],
                age_s=(
                    int(round_half_away((context.cycle - stamp).total_seconds(), 0))
                    if stamp
                    else None
                ),
            )
        )
    return DataHealth(generated_utc=_iso(context.cycle), lanes=lanes, feeds=feeds)


def _project(
    local: LocalFile, holder: TripHolder, inputs: ScheduleInputs, context: PublicationContext
) -> tuple[dict[str, Any], set[str], list[dict[str, Any]], Projection]:
    cycle = aware(context.cycle, "cycle")
    local.require_committed()
    providers = context.rows("provider")
    if len(providers) != 1:
        raise ValueError("provider context requires exactly one row")
    provider = providers[0]
    versions = context.rows("editions")
    if {r["dataset_version_id"] for r in versions} != inputs.current_ids:
        raise ValueError("publication all-current edition inventory differs")
    endpoints = {r["endpoint_key"] for r in context.rows("endpoints")}
    tiers = context.rows("tiers")
    if context.trip_policy is None or context.vehicle_policy is None:
        raise ValueError("publication_context_missing:feed_policy")
    if (context.trip_policy.enabled, context.vehicle_policy.enabled) != (
        "trip_updates" in endpoints,
        "vehicle_positions" in endpoints,
    ):
        raise ValueError("feed policy differs from enabled endpoints")
    projection = project_running(
        local,
        holder,
        inputs,
        provider_id=context.provider_id,
        timezone=provider["timezone"],
        cycle=cycle,
        trip_policy=context.trip_policy,
        vehicle_policy=context.vehicle_policy,
    )
    return provider, endpoints, tiers, projection


def build_bundle(
    local: LocalFile, holder: TripHolder, inputs: ScheduleInputs, context: PublicationContext
) -> dict[str, bytes]:
    provider, endpoints, tiers, projection = _project(local, holder, inputs, context)
    cycle = aware(context.cycle, "cycle")
    assert context.trip_policy is not None
    stamp = movement._serving_stamp(
        local, projection.trip_evidence, cycle, enabled=context.trip_policy.enabled
    )
    generated = _iso(cycle)
    payloads = {
        "vehicles.json": movement._vehicles(
            projection,
            generated,
            (
                provider["min_longitude"],
                provider["min_latitude"],
                provider["max_longitude"],
                provider["max_latitude"],
            ),
        ),
        "trips.json": movement._trips(projection, cycle, stamp),
        "stop_departures.json": movement._departures(projection, generated, stamp),
        "alerts.json": build_alerts(
            local, context, bool(endpoints & {"i3_alerts", "service_alerts"})
        ),
        "network.json": build_network(local, context, projection, endpoints),
        "status/data_health.json": build_data_health(local, context, projection, tiers),
        "manifest.json": build_manifest(context, provider, endpoints, tiers),
    }
    return {key: snapshot_json_bytes(value) for key, value in payloads.items()}


def _require_alert_seed(local: LocalFile, context: PublicationContext) -> None:
    if not local.connection.execute(
        "SELECT 1 FROM duckdb_tables() WHERE database_name=current_database() "
        "AND schema_name='main' AND table_name='alert_seed_checkpoint'"
    ).fetchone():
        raise ValueError("publication_context_missing:alert_seed")
    checkpoint = local.connection.execute(
        "SELECT provider_id FROM alert_seed_checkpoint"
    ).fetchall()
    if checkpoint != [(context.provider_id,)]:
        raise ValueError("alert_seed_context_missing")
