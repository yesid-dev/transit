"""Search the latest available schedule edition and recent tracked vehicle numbers."""

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import duckdb

from transit_engine.cities import public_declaration, service_zone
from transit_engine.clean_manifest import TRIP_DAYS, VEHICLE_POSITIONS
from transit_engine.store import Store
from transit_engine.vehicles import TRACKED_VEHICLES_SQL


def schedule_index(
    store: Store, city: str, end: date, *, index: Literal["search", "maps"] = "search"
) -> dict[str, Any] | None:
    schedule = None
    with store.connect() as conn:
        for offset in range(7):
            day = end - timedelta(days=offset)
            prefix = f"{store.root.rstrip('/')}/{index}/v1"
            path = f"{prefix}/{city}/{day}/v{store.cleaning_version}.json"
            if store.s3_endpoint:
                raw = None
                if conn.execute("SELECT file FROM glob(?)", [path]).fetchone():
                    row = conn.execute("SELECT content FROM read_blob(?)", [path]).fetchone()
                    raw = row[0] if row else None
            else:
                try:
                    raw = Path(path).read_bytes()
                except FileNotFoundError:
                    raw = None
            if raw is not None:
                schedule = json.loads(raw)
                break

    return schedule


def _recent_vehicles(
    store: Store, conn: duckdb.DuckDBPyConnection, city: str, days: list[date]
) -> tuple[list[dict[str, str]] | None, str]:
    ids: set[str] = set()
    vehicle_state = "unavailable"
    version = str(store.cleaning_version)
    for day in days:
        files = store.files(conn, city, day, (VEHICLE_POSITIONS, TRIP_DAYS))
        if files is None:
            continue
        positions, trips = files
        # Use the fleet's stability and trip association rules. Search only needs IDs,
        # so it can skip ordering position intervals and computing service statistics.
        row = conn.execute(
            f"""
            SELECT CASE WHEN ids IS NOT NULL THEN coalesce(in_service_ids, []) END
            FROM ({TRACKED_VEHICLES_SQL})
            """,
            [[positions], city, version, [trips], city, version],
        ).fetchone()
        assert row is not None
        if row[0] is not None:
            ids.update(row[0])
            vehicle_state = "ready"
        elif vehicle_state == "unavailable":
            vehicle_state = "not_tracked"
    vehicles = [{"id": value} for value in sorted(ids)] if vehicle_state == "ready" else None
    return vehicles, vehicle_state


def search_index(store: Store, city: str) -> dict[str, Any]:
    _, identity, public = public_declaration(city)
    end = datetime.now(UTC).astimezone(service_zone(identity)).date() - timedelta(days=1)
    edition = schedule_index(store, city, end)
    schedule = {key: edition[key] for key in ("date", "routes", "stops")} if edition else None

    if public.get("stable_vehicle_ids") is False:
        vehicles, vehicle_state = None, "not_tracked"
    else:
        days = [end - timedelta(days=offset) for offset in range(7)]
        with store.connect() as conn:
            vehicles, vehicle_state = _recent_vehicles(store, conn, city, days)
    return {"schedule": schedule, "vehicles": vehicles, "vehicle_state": vehicle_state}
