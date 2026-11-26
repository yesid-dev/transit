"""Public city metadata from the same declarations as the capture readers."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb

from transit_engine.capture import provider_declaration, provider_directory
from transit_engine.revision import compute_answer_revision
from transit_engine.store import CITY, Store

ANSWER_REVISION = compute_answer_revision(Path(__file__).parent, provider_directory())

FEED_KINDS = (
    "static_schedule",
    "gis_static",
    "trip_updates",
    "vehicle_positions",
    "i3_alerts",
    "service_alerts",
)
BOUNDS_KEYS = ("min_longitude", "min_latitude", "max_longitude", "max_latitude")


class UnknownCity(ValueError):
    """The city has no active public declaration."""


def public_declaration(city: str) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    declaration = provider_declaration(city) if CITY.fullmatch(city) else {}
    identity = declaration.get("provider")
    if isinstance(identity, dict):
        public = declaration.get("public")
        if (
            identity.get("is_active") is True
            and isinstance(public, dict)
            and public.get("enabled") is True
        ):
            return declaration, identity, public
    elif declaration.get("stage") == "public":
        overrides = declaration.get("overrides")
        return declaration, declaration, overrides if isinstance(overrides, dict) else {}
    raise UnknownCity("unknown city")


def service_zone(identity: dict[str, Any]) -> ZoneInfo:
    zone = identity.get("timezone")
    if not isinstance(zone, str):
        raise RuntimeError("missing service timezone")
    return ZoneInfo(zone)


@contextmanager
def service_query(store: Store, city: str) -> Iterator[duckdb.DuckDBPyConnection]:
    _, identity, _ = public_declaration(city)
    with store.connect() as conn:
        conn.execute("SET VARIABLE service_timezone = ?", [service_zone(identity).key])
        yield conn


def _bounds(value: Any) -> list[float] | None:
    if isinstance(value, dict):
        return [value[key] for key in BOUNDS_KEYS]
    return value if isinstance(value, list) else None


def _inputs(feeds: Any) -> dict[str, bool]:
    if isinstance(feeds, dict):
        enabled = {feed["feed_kind"] for feed in feeds.values() if feed.get("is_enabled", True)}
    else:
        kinds = {"schedule": "static_schedule", "geometry": "gis_static"}
        enabled = set()
        for feed in feeds:
            family = feed["family"]
            if family == "alerts":
                enabled.add(
                    "service_alerts"
                    if feed.get("format", "gtfs-rt") == "gtfs-rt"
                    else "i3_alerts"
                )
            else:
                enabled.add(kinds.get(family, family))
    return {kind: kind in enabled for kind in FEED_KINDS}


def city_catalog() -> dict[str, Any]:
    directory = provider_directory()
    default_city = (directory / "default-city.txt").read_text(encoding="utf-8").strip()
    providers = []
    for path in sorted(directory.glob("*.yaml")):
        city = path.stem
        try:
            declaration, identity, public = public_declaration(city)
        except UnknownCity:
            continue
        legacy = identity is not declaration
        labels = (public if legacy else identity).get("labels", {})
        fallback = {
            "city": identity.get("city") or next(iter(labels.values()))["city"],
            "operator": identity.get("short_name")
            or identity.get("display_name")
            or identity.get("name"),
        }
        map_info = public if legacy else declaration.get("map") or {}
        realtime = declaration.get("realtime", {}) if legacy else declaration
        name_separators = (public if legacy else declaration).get("name_separators")
        inputs = _inputs(declaration.get("feeds", {}))
        for capability in ("stable_vehicle_ids", "occupancy"):
            if isinstance(public.get(capability), bool):
                inputs[capability] = public[capability]
        providers.append(
            {
                "id": city,
                "timezone": service_zone(identity).key,
                "labels": {lang: labels.get(lang, fallback) for lang in ("en", "fr")},
                "bounds": _bounds(identity.get("bounds") if legacy else public.get("bounds")),
                "fit_bounds": _bounds(public.get("fit_bounds")),
                "max_bounds": _bounds(public.get("max_bounds")),
                "geocode_context": public.get("geocode_context"),
                "posters_url": map_info.get("posters_url"),
                "basemap_url": map_info.get("basemap_url"),
                "attribution": identity.get("attribution_text"),
                "live_source_lag_seconds": identity.get("live_source_lag_seconds", 0),
                "alert_links": (public if legacy else declaration).get("alert_links") or {},
                "inputs": inputs,
                "download_licence": (public if legacy else declaration).get("download_licence"),
                **({"name_separators": name_separators} if name_separators is not None else {}),
                # The declared first complete day; earlier dates are outside the city's record.
                **(
                    {"record_from": str(declaration["clean_days_from"])}
                    if declaration.get("clean_days_from")
                    else {}
                ),
                "lines_without_live_data": [
                    {key: gap.get(key, []) for key in ("route_types", "route_ids")}
                    for gap in realtime.get("lines_without_live_data") or []
                ],
            }
        )
    if default_city not in {provider["id"] for provider in providers}:
        raise RuntimeError("default city must be a public provider")
    return {
        "answer_revision": ANSWER_REVISION,
        "default_provider": default_city,
        "providers": providers,
    }
