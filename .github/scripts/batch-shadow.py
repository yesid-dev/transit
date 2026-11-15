"""Bounded daily orchestration; run from apps/db with its pinned environment.

Only export receives the production URL. All catalog, replay and edition reads
afterwards use the disposable service. Archive/shadow writers remain create-only.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

ROOT = Path("artifacts/batch-shadow")


def target_day(stamp: datetime, timezone: str, alerts: bool, manual: str) -> str:
    zone = ZoneInfo(timezone)
    day = (
        date.fromisoformat(manual) if manual else stamp.astimezone(zone).date() - timedelta(days=1)
    )
    if manual and manual != day.isoformat():
        raise ValueError("invalid_date: expected YYYY-MM-DD")
    while True:
        end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
        if end <= stamp and (not alerts or end + timedelta(hours=6) <= stamp):
            return day.isoformat()
        if manual:
            raise ValueError("bundle_coverage" if alerts else "day_not_closed")
        day -= timedelta(days=1)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, sort_keys=True, indent=2) + "\n", encoding="utf8")


def require_configuration(export: bool = False) -> None:
    names = ["BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"]
    if export:
        names += ["DATABASE_URL"]
    missing = [name for name in names if not os.environ.get(name)]
    if os.environ.get("BATCH_SHADOW_PROVISIONED") != "true":
        missing.append("batch-shadow environment: BATCH_SHADOW_PROVISIONED=true")
    if missing:
        raise ValueError("provisioning_missing: " + ", ".join(missing))


def selection(value: str, available: Any) -> list[str]:
    selected = value.split(",") if value else list(available)
    if not selected or len(set(selected)) != len(selected):
        raise ValueError("invalid_selection: empty or duplicate")
    for name in selected:
        if not re.fullmatch(r"[a-z0-9_]+", name) or name not in available:
            raise ValueError(f"invalid_selection: {name}")
    return sorted(selected)


def plan(stamp: datetime) -> dict[str, Any]:
    from transit_ops.batch.build import BuildRequest, FamilyBuilder
    from transit_ops.batch.editions import with_editions
    from transit_ops.batch.families.registry import FAMILIES, resolve_builder
    from transit_ops.batch.input_sources import replay_catalog
    from transit_ops.batch.replay import (
        family_input_needs,
        parent_input_needs,
        postgres_input_needs,
    )
    from transit_ops.history.datasets import get_dataset
    from transit_ops.lake.alert_bundle import MEMBERS
    from transit_ops.providers import ProviderRegistry
    from transit_ops.settings import Settings

    settings = Settings()
    registry = ProviderRegistry.from_project_root(settings=settings)
    providers = {p: registry.get_provider(p).provider for p in registry.list_active_provider_ids()}
    resolved = {name: resolve_builder(name) for name in FAMILIES}
    implemented = {
        name: builder for name, builder in resolved.items() if isinstance(builder, FamilyBuilder)
    }
    families = selection(os.environ.get("FAMILIES", ""), implemented)
    rows: list[dict[str, Any]] = []
    datasets: set[str] = set()
    with replay_catalog() as catalog:
        for provider in selection(os.environ.get("PROVIDERS", ""), providers):
            for family in families:
                builder = implemented[family]
                request = BuildRequest(
                    provider,
                    (
                        date.fromisoformat(
                            target_day(
                                stamp,
                                providers[provider].timezone,
                                False,
                                os.environ.get("DAY", ""),
                            )
                        ),
                    ),
                    stamp,
                    settings.GOLD_FACT_RETENTION_DAYS,
                    settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
                    providers[provider].timezone,
                )
                # Relation selection only. The real edition is resolved from the proven bootstrap.
                request = with_editions(request, [family], [(1, "static_schedule", True)])
                alerts = any(n.relation in MEMBERS for n in builder.inputs(request))
                day = target_day(stamp, request.timezone, alerts, os.environ.get("DAY", ""))
                request = replace(
                    request,
                    local_dates=(date.fromisoformat(day),),
                    edition_by_day={date.fromisoformat(day): 1} if request.edition_by_day else None,
                )
                needs = family_input_needs([builder], request) + postgres_input_needs(
                    request, (1,) if request.edition_by_day else ()
                )
                # Before source proofs exist, unknown child counts require all FK parents.
                datasets.update(n.relation for n in parent_input_needs(needs, catalog))
                rows.append(
                    {
                        "provider": provider,
                        "day": day,
                        "families": [family],
                        "alerts": alerts,
                        "timezone": request.timezone,
                    }
                )
    for dataset in datasets:
        get_dataset(dataset)  # Never run an unfiltered migration for undeclared inputs.
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["provider"], row["day"])
        if key not in grouped:
            grouped[key] = dict(row, families=[])
        grouped[key]["families"].extend(row["families"])
        grouped[key]["alerts"] |= row["alerts"]
    return {
        "code_commit": os.environ["GITHUB_SHA"],
        "planned_at": stamp.isoformat(),
        "input_mode": os.environ.get("INPUT_MODE", "export"),
        "matrix": list(grouped.values()),
        "datasets": sorted(datasets),
    }


def invoke(args: list[str], receipt: Path, *, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(
        ["uv", "run", "--frozen", "transit-ops", *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    # CLI target headers are already redacted. Also suppress credential fragments
    # from connection diagnostics before preserving failure evidence.
    output = result.stdout + result.stderr
    for name in ("DATABASE_URL", "BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"):
        secret = (env or os.environ).get(name, "")
        if secret:
            output = output.replace(secret, "[redacted]")
            password = urlsplit(secret).password if name == "DATABASE_URL" else None
            if password:
                output = output.replace(password, "[redacted]")
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(output, encoding="utf8")
    if result.returncode:
        reason = next(
            (
                name
                for name in (
                    "migration_running",
                    "migration_lock_lost",
                    "not_after",
                    "work_space",
                    "bundle_coverage",
                    "bundle_parent_missing",
                    "copy_group_partial",
                    "missing proven sources",
                    "closure_conflict",
                    "input_not_archived",
                )
                if name in output
            ),
            "command_failed",
        )
        raise ValueError(f"{reason}: {args[0]} {args[1]}; see {receipt}")


def export_inputs(data: dict[str, Any]) -> None:
    import psycopg

    require_configuration(export=True)
    if shutil.disk_usage(ROOT).free < 20_000_000_000:
        raise ValueError("work_space: 20 GB start/stop rule")
    parts = urlsplit(os.environ["DATABASE_URL"])
    with psycopg.connect(
        urlunsplit(parts._replace(scheme="postgresql")),
        options="-c default_transaction_read_only=on -c statement_timeout=300000",
        connect_timeout=5,
    ) as conn:
        if conn.execute("SHOW transaction_read_only").fetchone() != ("on",):
            raise ValueError("not_read_only")
        result = conn.execute("SELECT count(*) FROM core.providers").fetchone()
        count = result[0] if result else 0
    if not count:
        raise ValueError("providers_missing")
    # Reserve for ALL providers, including STO. The exporter rechecks at group start.
    allowance = (2 * count + 7) * 300 + 600
    deadline = datetime.now(UTC) + timedelta(seconds=allowance + 3600)
    args = [
        "lake",
        "migrate",
        "--execute",
        "--include-open",
        "--work-dir",
        str(ROOT / "export"),
        "--copied-by",
        data["code_commit"],
        "--statement-timeout-s",
        "300",
        "--not-after",
        deadline.isoformat(),
    ]
    for dataset in data["datasets"]:
        args += ["--dataset", dataset]
    # No --provider: an alert copy group must include every production provider.
    invoke(args, ROOT / "export-command.log")
    data["export_finished_at"] = datetime.now(UTC).isoformat()
    data["export_not_after"] = deadline.isoformat()
    data["source_provider_count"] = count


def gate(report: dict[str, Any], row: dict[str, Any], stamp: str, commit: str) -> None:
    if (report["provider_id"], report["local_date"], report["code_commit"]) != (
        row["provider"],
        row["day"],
        commit,
    ) or datetime.fromisoformat(report["as_of_utc"]) != datetime.fromisoformat(stamp):
        raise ValueError("incomplete_replay: provenance")
    families = report["families"]
    if sorted(f["family_id"] for f in families) != sorted(row["families"]):
        raise ValueError("incomplete_replay: missing, duplicate or unexpected family")
    for family in families:
        if family["status"] not in {"identical", "identical_after_normalization"}:
            raise ValueError(f"incomplete_replay: {family['family_id']} {family['status']}")
        if not family.get("output_digests") or not re.fullmatch(
            r"[0-9a-f]{64}", family.get("build_id") or ""
        ):
            raise ValueError("incomplete_replay: output digest or build missing")
        if family["code_commit"] != commit or family["engine_version"] != report["duckdb_version"]:
            raise ValueError("incomplete_replay: family provenance")
        digests = family["output_digests"]
        for table in digests.get("tables", {}).values():
            if (
                not re.fullmatch(r"[0-9a-f]{64}", table.get("sha256", ""))
                or type(table.get("rows")) is not int
                or table["rows"] < 0
            ):
                raise ValueError("incomplete_replay: invalid output digest")
        for digest in digests.get("bodies", {}).values():
            if not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("incomplete_replay: invalid body digest")


def run_row(row: dict[str, Any], index: int, stamp: str, commit: str) -> None:
    if shutil.disk_usage(ROOT).free < 20_000_000_000:
        raise ValueError("work_space: 20 GB start/stop rule")
    area = ROOT / str(index)
    inputs, work = area / "inputs", area / "replay"
    common = [
        "--provider",
        row["provider"],
        "--date",
        row["day"],
        "--as-of",
        stamp,
        "--inputs",
        str(inputs),
    ]
    for family in row["families"]:
        common += ["--family", family]
    invoke(
        ["batch", "fetch-inputs", *common, "--bodies", "--timezone", row["timezone"]],
        area / "fetch-receipts.json",
    )
    invoke(
        ["batch", "replay-day", *common, "--workdir", str(work), "--bodies"],
        area / "replay-command.log",
    )
    path = work / f"report-{row['provider']}-{row['day']}.json"
    report = json.loads(path.read_bytes())
    gate(report, row, stamp, commit)
    # Exact body/table digests and math invariants are checked again by shadow's
    # build_checked -> accept -> write_shadow boundary, before accepted.json.
    env = dict(os.environ, DATABASE_URL=os.environ["TRANSIT_REPLAY_DATABASE_URL"])
    invoke(
        ["batch", "shadow-build", *common, "--workdir", str(work), "--accept-from", str(path)],
        area / "shadow-command.log",
        env=env,
    )
    write_json(
        area / "complete.json",
        {
            "provider": row["provider"],
            "day": row["day"],
            "families": row["families"],
            "report_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "sanity": "build_checked on replay and shadow",
            "accepted": True,
        },
    )


def main(stage: str) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    receipt = ROOT / "daily-inputs.json"
    if stage == "plan":
        require_configuration()
        if os.environ.get("INPUT_MODE", "export") not in {"export", "archive"}:
            raise ValueError("invalid_input_mode")
        manual = os.environ.get("AS_OF", "")
        stamp = datetime.fromisoformat(manual) if manual else datetime.now(UTC)
        if stamp.utcoffset() != timedelta(0) or stamp > datetime.now(UTC):
            raise ValueError("invalid_as_of: expected past aware UTC time")
        if manual and os.environ.get("INPUT_MODE", "export") == "export":
            raise ValueError("invalid_as_of: export must pin its actual completed cuts")
        data = plan(stamp)
    else:
        data = json.loads(receipt.read_bytes())
        if stage == "export":
            export_inputs(data)
        elif stage == "run":
            require_configuration()
            manual = os.environ.get("AS_OF", "")
            stamp = datetime.fromisoformat(manual) if manual else datetime.now(UTC)
            if stamp.utcoffset() != timedelta(0) or stamp > datetime.now(UTC):
                raise ValueError("invalid_as_of: expected past aware UTC time")
            if stamp < datetime.fromisoformat(data.get("export_finished_at", data["planned_at"])):
                raise ValueError("invalid_as_of: precedes selected export cuts")
            data["as_of_utc"] = stamp.isoformat()
            write_json(receipt, data)
            for index, row in enumerate(data["matrix"]):
                run_row(row, index, stamp.isoformat(), data["code_commit"])
            data["complete"] = True
        else:
            raise ValueError("unknown_stage")
    write_json(receipt, data)


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as error:
        # Preserve named failures without dumping connection diagnostics/secrets.
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        write_json(ROOT / "refusal.json", {"refusal": reason, "stage": sys.argv[1]})
        print(reason, file=sys.stderr)
        sys.exit(1)
