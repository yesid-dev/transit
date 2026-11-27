"""Select the provider days that the clean-days workflow builds.

Scheduled runs build every public provider and every capture-enabled private one.
Private entries publish to the same clean storage, which only the proxy and the
engine read, and both refuse a private city. The workflow keeps their output out of
public logs.
"""

import argparse
import json
import os
from datetime import UTC, date, datetime, timedelta

import typer

from transit_ops.clean_days import parse_date, run_clean_days
from transit_ops.providers.registry import ProviderRegistry

MAX_PROVIDER_DAYS = 256


def plan_entries(
    registry: ProviderRegistry,
    *,
    requested: str = "",
    manual: bool = False,
    first: date | None = None,
    last: date | None = None,
) -> list[dict[str, object]]:
    providers = registry.list_provider_ids()
    public = [
        provider
        for provider in registry.list_active_provider_ids()
        if registry.get_public_config(provider).enabled
    ]
    if requested and requested not in providers:
        raise ValueError("Requested provider is unknown")
    if manual:
        selected = [requested] if requested else public
        if first is None or last is None:
            raise ValueError("A manual run needs from and to dates")
        if last < first:
            raise ValueError("From date must be on or before to date")
        days = (last - first).days + 1
        if days * len(selected) > MAX_PROVIDER_DAYS:
            raise ValueError("GitHub Actions allows at most 256 provider-days per backfill")
        entries: list[dict[str, object]] = [
            {
                "provider": provider,
                "day": (first + timedelta(days=offset)).isoformat(),
                "private": provider not in public,
            }
            for provider in selected
            for offset in range(days)
        ]
    else:
        private = [
            provider
            for provider in providers
            if provider not in public and registry.get_provider(provider).capture_enabled
        ]
        entries = [{"provider": provider, "private": False} for provider in public]
        entries += [{"provider": provider, "private": True} for provider in private]
    if not entries:
        raise ValueError("No eligible providers declared")
    return entries


def _run_scheduled() -> None:
    scheduled_at = datetime.now(UTC)
    failed = False
    for entry in plan_entries(ProviderRegistry.from_project_root()):
        provider = str(entry["provider"])
        typer.echo(f"Cleaning {provider}")
        try:
            run_clean_days(
                provider, "s3://transit-raw", "s3://transit-clean", selection=scheduled_at
            )
        except typer.Exit:
            failed = True
    if failed:
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-scheduled", action="store_true")
    if parser.parse_args().run_scheduled:
        _run_scheduled()
        return
    manual = os.environ["GITHUB_EVENT_NAME"] == "workflow_dispatch"
    try:
        entries = plan_entries(
            ProviderRegistry.from_project_root(),
            requested=os.environ.get("CLEAN_PROVIDER", ""),
            manual=manual,
            first=parse_date(os.environ["CLEAN_FROM"]) if manual else None,
            last=parse_date(os.environ["CLEAN_TO"]) if manual else None,
        )
    except ValueError as error:
        raise SystemExit(str(error)) from None
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print("matrix=" + json.dumps({"include": entries}), file=output)
        if not manual:
            print("scheduled_at=" + datetime.now(UTC).isoformat(), file=output)


if __name__ == "__main__":
    main()
