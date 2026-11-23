"""Search the latest available schedule edition and recent tracked vehicle numbers."""

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from transit_engine.cities import public_declaration, service_zone
from transit_engine.measures import Question, ask
from transit_engine.store import Store


def schedule_index(store: Store, city: str, end: date) -> dict[str, Any] | None:
    schedule = None
    with store.connect() as conn:
        for offset in range(7):
            day = end - timedelta(days=offset)
            path = f"{store.root.rstrip('/')}/search/v1/{city}/{day}/v{store.cleaning_version}.json"
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


def search_index(store: Store, city: str) -> dict[str, Any]:
    _, identity, public = public_declaration(city)
    end = datetime.now(UTC).astimezone(service_zone(identity)).date() - timedelta(days=1)
    start = end - timedelta(days=6)
    edition = schedule_index(store, city, end)
    schedule = {key: edition[key] for key in ("date", "routes", "stops")} if edition else None

    vehicles: list[dict[str, str]] | None = None
    vehicle_state = "unavailable"
    if public.get("stable_vehicle_ids") is False:
        vehicle_state = "not_tracked"
    else:
        answer = ask(
            store,
            Question(
                city=city, start=start, end=end, measure="vehicle_days_in_service", group="vehicle"
            ),
        )
        evidence = answer["evidence"]
        if evidence.get("days_not_tracked") and not evidence.get("days_measured"):
            vehicle_state = "not_tracked"
        elif evidence.get("days_measured"):
            vehicle_state = "ready"
            vehicles = [
                {"id": cell["key"]["vehicle"]}
                for cell in answer["cells"]
                if cell["value"].get("vehicle_days_in_service")
            ]
    return {"schedule": schedule, "vehicles": vehicles, "vehicle_state": vehicle_state}
