"""Search the latest available schedule edition and recent tracked vehicle numbers."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from transit_engine.capture import provider_declaration
from transit_engine.measures import Question, ask
from transit_engine.store import CITY, Store


class UnknownSearchCity(ValueError):
    """The city has no active public declaration."""


def search_index(store: Store, city: str) -> dict[str, Any]:
    declaration = provider_declaration(city) if CITY.fullmatch(city) else {}
    identity = declaration.get("provider")
    if isinstance(identity, dict):
        public = declaration.get("public")
        enabled = identity.get("is_active") is True and (
            isinstance(public, dict) and public.get("enabled") is True
        )
    else:
        identity = declaration
        public = declaration.get("overrides")
        enabled = declaration.get("stage") == "public"
    if not enabled:
        raise UnknownSearchCity("unknown city")
    zone = identity.get("timezone")
    if not isinstance(zone, str):
        raise RuntimeError("missing service timezone")
    end = datetime.now(UTC).astimezone(ZoneInfo(zone)).date() - timedelta(days=1)
    start = end - timedelta(days=6)

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

    vehicles: list[dict[str, str]] | None = None
    vehicle_state = "unavailable"
    if isinstance(public, dict) and public.get("stable_vehicle_ids") is False:
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
