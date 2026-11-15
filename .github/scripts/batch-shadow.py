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
REFUSALS = (
    "migration_running",
    "migration_lock_lost",
    "not_after",
    "work_space",
    "role_can_write",
    "bundle_coverage",
    "bundle_parent_missing",
    "copy_group_partial",
    "timezone_mismatch",
    "missing proven sources",
    "closure_conflict",
    "input_not_archived",
    "family_not_replayable",
    "open_window_unsupported",
    "window_selection_unsupported",
    "window_coverage",
    "provisioning_missing",
    "invalid_as_of",
    "invalid_input_mode",
    "incomplete_replay",
    "not_read_only",
    "edition_unresolved",
    "ServerChanged",
    "UnverifiedCopy",
    "InputDigestMismatch",
)


def refusal_name(message: str) -> str:
    return next((name for name in REFUSALS if name in message), "command_failed")


def safe_evidence(value: Any, key: str = "") -> Any:
    """Allowlist public summaries. Drop diagnostics, target headers and row payloads."""
    identifiers = {
        "dataset_id",
        "provider_id",
        "provider",
        "family_id",
        "family",
        "window_key",
        "window",
        "day",
        "local_date",
        "families",
        "datasets",
    }
    stamps = {
        "as_of_utc",
        "planned_at",
        "export_finished_at",
        "export_not_after",
        "cut_utc",
        "snapshot_at_utc",
        "bundle_snapshot_at_utc",
        "coverage_from_utc",
    }
    containers = {
        "spec",
        "matrix",
        "family_refusals",
        "needs",
        "receipts",
        "outcomes",
        "families",
        "members",
        "windows",
        "records",
    }
    if isinstance(value, dict):
        if key and key not in containers:
            return None
        return {k: clean for k, v in value.items() if (clean := safe_evidence(v, k)) is not None}
    if isinstance(value, list) and key in containers | {"datasets"}:
        return [clean for v in value if (clean := safe_evidence(v, key)) is not None]
    if type(value) is int and key in {
        "rows",
        "rows_kept",
        "rows_dropped",
        "bytes",
        "source_provider_count",
        "difference_count",
    }:
        return value
    if type(value) is bool and key in {"complete", "accepted"}:
        return value
    if isinstance(value, str):
        if key == "key" and re.fullmatch(r"(?:archive|rescue)/v1/[A-Za-z0-9_./=-]+", value):
            return value
        if key in identifiers and re.fullmatch(r"[a-z0-9_.:-]+", value):
            return value
        if key == "windows" and re.fullmatch(r"[a-z0-9_.-]+:[a-z0-9_-]+:[a-z0-9-]+", value):
            return value
        if key in stamps and re.fullmatch(r"[0-9T:Z.+-]+", value):
            return value
        if key in {"code_commit", "build_id", "sha256", "object_sha256", "report_sha256"}:
            return value if re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value) else None
        if key in {"reason", "refusal"}:
            return refusal_name(value)
        if key in {"outcome", "status"} and value in {
            "copied",
            "already_copied",
            "failed",
            "identical",
            "identical_after_normalization",
            "different",
            "not_compared",
            "not_implemented",
            "command_failed",
        }:
            return value
    return None


def replay_environment() -> dict[str, str]:
    allowed = {
        "PATH",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "HOME",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "UV_CACHE_DIR",
        "UV_PYTHON_INSTALL_DIR",
        "UV_PROJECT_ENVIRONMENT",
        "VIRTUAL_ENV",
        "TRANSIT_REPLAY_DATABASE_URL",
        "TRANSIT_TEST_DATABASE_DISPOSABLE",
        "GOLD_FACT_RETENTION_DAYS",
        "GOLD_REPORTING_OPEN_WINDOW_DAYS",
    }
    env = {k: v for k, v in os.environ.items() if k in allowed}
    env["DATABASE_URL"] = os.environ["TRANSIT_REPLAY_DATABASE_URL"]
    env["BRONZE_STORAGE_BACKEND"] = "local"
    return env


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


def require_configuration(export: bool = False, *, storage: bool = True) -> None:
    names = ["BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"] if storage else []
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
        if not re.fullmatch(r"[a-z0-9_-]+", name) or name not in available:
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
    explicit = os.environ.get("FAMILIES", "")
    families = selection(explicit, FAMILIES)
    rows: list[dict[str, Any]] = []
    datasets: set[str] = set()
    logical_needs: list[dict[str, str]] = []
    refusals = []
    with replay_catalog() as catalog:
        for provider in selection(os.environ.get("PROVIDERS", ""), providers):
            for family in families:
                builder = resolved[family]
                if not isinstance(builder, FamilyBuilder):
                    if explicit:
                        raise ValueError(f"family_not_replayable: {family}")
                    refusals.append(
                        {"provider": provider, "family": family, "reason": "family_not_replayable"}
                    )
                    continue
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
                try:
                    needs = family_input_needs([builder], request) + postgres_input_needs(
                        request, (1,) if request.edition_by_day else ()
                    )
                except ValueError as error:
                    if explicit or not str(error).startswith("input_not_archived"):
                        raise
                    refusals.append({"provider": provider, "family": family, "reason": str(error)})
                    continue
                # Before source proofs exist, unknown child counts require all FK parents.
                expanded = parent_input_needs(
                    tuple(n for n in needs if n.relation not in MEMBERS), catalog
                )
                expanded += tuple(n for n in needs if n.relation in MEMBERS)
                datasets.update(n.relation for n in expanded)
                logical_needs.extend(
                    {
                        "provider": provider,
                        "relation": n.relation,
                        "window": n.window,
                        "timezone": request.timezone,
                    }
                    for n in expanded
                )
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
        "needs": [
            dict(provider=p, relation=r, window=w, timezone=z)
            for p, r, w, z in sorted(
                {(n["provider"], n["relation"], n["window"], n["timezone"]) for n in logical_needs}
            )
        ],
        "family_refusals": refusals,
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
    output = result.stdout + "\n" + result.stderr
    for name in ("DATABASE_URL", "BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"):
        secret = (env or os.environ).get(name, "")
        if secret:
            output = output.replace(secret, "[redacted]")
            password = urlsplit(secret).password if name == "DATABASE_URL" else None
            if password:
                output = output.replace(password, "[redacted]")
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(output, encoding="utf8")
    records = []
    for line in output.splitlines():
        try:
            records.append(safe_evidence(json.loads(line)))
        except (ValueError, TypeError):
            pass
    if args[:2] == ["lake", "migrate"] and "--work-dir" in args:
        migration_log = Path(args[args.index("--work-dir") + 1]) / "migration-log.jsonl"
        if migration_log.is_file():
            with migration_log.open(encoding="utf8") as stream:
                for line in stream:
                    try:
                        records.append(safe_evidence(json.loads(line)))
                    except (ValueError, TypeError):
                        pass
    summary = {"records": records, "refusal": refusal_name(output) if result.returncode else None}
    write_json(ROOT / "public" / receipt.relative_to(ROOT).with_suffix(".json"), summary)
    if result.returncode:
        reason = refusal_name(output)
        raise ValueError(f"{reason}: {args[0]} {args[1]}; see {receipt}")


def export_inputs(data: dict[str, Any]) -> None:
    import psycopg

    from transit_ops.batch.daily_inputs import (
        PlanningReads,
        assert_group_deadline,
        assert_read_role,
        exact_windows,
        group_deadline,
        require_window_support,
    )
    from transit_ops.lake.alert_bundle import MEMBERS

    require_configuration(export=True)
    if shutil.disk_usage(ROOT).free < 20_000_000_000:
        raise ValueError("work_space: 20 GB start/stop rule")
    stamp = datetime.fromisoformat(data["planned_at"])
    require_window_support(data["needs"], stamp)
    parts = urlsplit(os.environ["DATABASE_URL"])
    with psycopg.connect(
        urlunsplit(parts._replace(scheme="postgresql")),
        options="-c default_transaction_read_only=on -c statement_timeout=300000",
        connect_timeout=5,
    ) as conn:
        if conn.execute("SHOW transaction_read_only").fetchone() != ("on",):
            raise ValueError("not_read_only")
        reads = PlanningReads(conn)
        assert_read_role(reads)
        result = reads.execute("SELECT count(*) FROM core.providers").fetchone()
        count = result[0] if result else 0
        windows = exact_windows(data["needs"], stamp, reads)
    if not count:
        raise ValueError("providers_missing")
    data["windows"] = list(windows)
    write_json(ROOT / "daily-inputs.json", data)
    groups = {
        "ordinary": [w for w in windows if w.split(":")[0] not in MEMBERS],
        "alerts": [w for w in windows if w.split(":")[0] in MEMBERS],
    }
    for name, selected in groups.items():
        if not selected:
            continue
        if shutil.disk_usage(ROOT).free < 20_000_000_000:
            raise ValueError("work_space: 20 GB start/stop rule")
        # No preceding copies share the alert invocation's deadline.
        deadline = (
            group_deadline(count) if name == "alerts" else datetime.now(UTC) + timedelta(hours=1)
        )
        if (deadline - datetime.now(UTC)).total_seconds() > 9000:
            raise ValueError("not_after: group exceeds bounded step allowance")
        args = [
            "lake",
            "migrate",
            "--execute",
            "--include-open",
            "--work-dir",
            str(ROOT / "export" / name),
            "--copied-by",
            data["code_commit"],
            "--statement-timeout-s",
            "300",
            "--plan-budget-s",
            "300",
            "--not-after",
            deadline.isoformat(),
        ]
        for window in selected:
            args += ["--window", window]
        if name == "alerts":
            assert_group_deadline(deadline, count)
        invoke(args, ROOT / f"export-{name}.log")
        data["export_not_after"] = deadline.isoformat()
    data["export_finished_at"] = datetime.now(UTC).isoformat()
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


def run_row(
    row: dict[str, Any], index: int, stamp: str, commit: str, *, stage: str = "all"
) -> None:
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
    if stage in {"all", "fetch"}:
        inputs.mkdir(parents=True, exist_ok=False)
        invoke(
            ["batch", "fetch-inputs", *common, "--bodies", "--timezone", row["timezone"]],
            area / "fetch-receipts.json",
        )
    if stage == "fetch":
        return
    if stage in {"all", "replay"}:
        invoke(
            ["batch", "replay-day", *common, "--workdir", str(work), "--bodies"],
            area / "replay-command.log",
            env=replay_environment(),
        )
    path = work / f"report-{row['provider']}-{row['day']}.json"
    report = json.loads(path.read_bytes())
    gate(report, row, stamp, commit)
    write_json(ROOT / "public" / str(index) / "report.json", safe_evidence(report))
    if stage == "replay":
        return
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
    write_json(
        ROOT / "public" / str(index) / "complete.json",
        safe_evidence(json.loads((area / "complete.json").read_bytes())),
    )


def main(stage: str) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    receipt = ROOT / "daily-inputs.json"
    if stage == "plan":
        require_configuration(storage=False)
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
        elif stage in {"fetch", "replay", "shadow"}:
            require_configuration(storage=stage != "replay")
            manual = os.environ.get("AS_OF", "")
            stamp = (
                datetime.fromisoformat(data["as_of_utc"])
                if stage != "fetch"
                else (datetime.fromisoformat(manual) if manual else datetime.now(UTC))
            )
            if stamp.utcoffset() != timedelta(0) or stamp > datetime.now(UTC):
                raise ValueError("invalid_as_of: expected past aware UTC time")
            if stamp < datetime.fromisoformat(data.get("export_finished_at", data["planned_at"])):
                raise ValueError("invalid_as_of: precedes selected export cuts")
            if stage == "fetch":
                from transit_ops.batch.daily_inputs import require_window_support

                require_window_support(data["needs"], stamp, exact_selection=False)
            data["as_of_utc"] = stamp.isoformat()
            write_json(receipt, data)
            for index, row in enumerate(data["matrix"]):
                run_row(row, index, stamp.isoformat(), data["code_commit"], stage=stage)
            data["complete"] = stage == "shadow"
        else:
            raise ValueError("unknown_stage")
    write_json(receipt, data)
    write_json(ROOT / "public/daily-inputs.json", safe_evidence(data))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as error:
        # Preserve named failures without dumping connection diagnostics/secrets.
        reason = refusal_name(str(error))
        write_json(ROOT / "public/refusal.json", {"refusal": reason})
        print(reason, file=sys.stderr)
        sys.exit(1)
