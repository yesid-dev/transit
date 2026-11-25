"""Select declared map extracts for the refresh workflow."""

import argparse
import json
import re
from pathlib import PurePosixPath

from transit_ops.providers.registry import ProviderRegistry


def basemap_plan(
    registry: ProviderRegistry, requested: str = "", *, plan_only: bool = False
) -> list[dict[str, str]]:
    jobs = []
    for provider_id in [requested] if requested else registry.list_provider_ids():
        manifest = registry.get_provider(provider_id)
        public = manifest.public
        if not (public.enabled and manifest.provider.is_active):
            if not requested:
                continue
            if not plan_only:
                raise ValueError("A private city requires plan_only")
        bounds = public.basemap_bounds
        if not bounds or not public.basemap_url:
            raise ValueError(f"Missing basemap configuration: {provider_id}")
        prefix = f"/data/v1/{provider_id}/static/basemap/"
        file = PurePosixPath(public.basemap_url).name
        if public.basemap_url != prefix + file or not re.fullmatch(
            r"[a-zA-Z0-9_-]+\.pmtiles", file
        ):
            raise ValueError(f"Foreign basemap path: {provider_id}")
        coordinates = (
            bounds.min_longitude,
            bounds.min_latitude,
            bounds.max_longitude,
            bounds.max_latitude,
        )
        jobs.append(
            {
                "provider": provider_id,
                "bbox": ",".join(map(str, coordinates)),
                "key": public.basemap_url.removeprefix("/data/"),
                "file": file,
            }
        )
    if not jobs:
        raise ValueError("No providers selected")
    return jobs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", default="")
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    jobs = basemap_plan(
        ProviderRegistry.from_project_root(), args.provider, plan_only=args.plan_only
    )
    print(json.dumps({"include": jobs}))
