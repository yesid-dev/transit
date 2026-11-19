import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import typer

app = typer.Typer(help="Local live engine checks; nothing here starts or changes a worker.")
_CONFIG = Path(__file__).resolve().parents[3] / "config" / "providers"


@app.callback(invoke_without_command=True)
def main(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


def _instant(value: str, name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise typer.BadParameter(f"{name}: ISO 8601 instant required") from exc
    if parsed.utcoffset() is None:
        raise typer.BadParameter(f"{name}: an explicit UTC offset is required")
    return parsed.astimezone(UTC)


def _document(path: Path, name: str) -> Any:
    from transit_ops.live.admission import EvidenceInvalid

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise EvidenceInvalid(f"{name}_json_invalid") from exc


def _schedule(
    provider_id: str, providers: Path, poll_seconds: int
) -> tuple[int | None, int | None]:
    """The provider's declared cadence and its worker's declared tick, from its manifest."""
    from transit_ops.live.admission import declared_cadence
    from transit_ops.providers.registry import load_provider_manifest
    from transit_ops.realtime_schedule import worker_tick_seconds

    for path in sorted(providers.glob("*.yaml")):
        manifest = load_provider_manifest(path)
        if manifest.provider.provider_id == provider_id:
            return declared_cadence(manifest), worker_tick_seconds(manifest, poll_seconds)
    return None, None  # An undeclared provider: those gates are unavailable.


def _default_poll_seconds() -> int:
    from transit_ops.settings import Settings

    return int(Settings.model_fields["REALTIME_POLL_SECONDS"].default)


@app.command()
def admission(
    provider: Annotated[str, typer.Option(help="Provider whose worker wrote the logs.")],
    log: Annotated[list[Path], typer.Option(help="Worker log file(s) with paired_shadow lines.")],
    start: Annotated[str, typer.Option(help="Window start, ISO 8601 with offset (inclusive).")],
    end: Annotated[str, typer.Option(help="Window end, ISO 8601 with offset (exclusive).")],
    output: Annotated[Path, typer.Option(help="New verdict JSON file; must not exist.")],
    restarts: Annotated[
        Path | None,
        typer.Option(help="Restart observations (provider_id, observed_at, ...), JSON lines."),
    ] = None,
    resources: Annotated[
        Path | None, typer.Option(help="The admitted plan's measured evidence (#901 shape).")
    ] = None,
    worker_service: Annotated[
        str | None, typer.Option(help="The provider's worker service in --resources.")
    ] = None,
    window_cpu: Annotated[
        Path | None,
        typer.Option(help="Worker peak CPU over the window: service, cpu_cores, start, end, sha."),
    ] = None,
    adjudications: Annotated[
        Path | None,
        typer.Option(help='{"<counts key>": {"class", "math", "valid_from", "valid_until"}}'),
    ] = None,
    poll_seconds: Annotated[
        int | None,
        typer.Option(help="The worker's REALTIME_POLL_SECONDS (default: the setting's default)."),
    ] = None,
    providers: Annotated[Path, typer.Option(help="Provider declaration directory.")] = _CONFIG,
) -> None:
    """Judge the local engine's pilot eligibility from recorded evidence only.

    Exit 0 when eligible, 1 when not eligible, 2 on malformed or unreadable evidence.
    Eligibility never starts the shadow, deploys or flips a role: the owner approves those.
    """
    from transit_ops.live.admission import (
        Adjudication,
        EvidenceBundle,
        EvidenceInvalid,
        ResourceEvidence,
        RestartObservation,
        WindowCpu,
        evaluate,
        read_worker_log,
    )
    from transit_ops.operations.compose_limits import ComposeLimitsRefused, parse_evidence

    window = _instant(start, "start"), _instant(end, "end")
    if window[0] >= window[1]:
        raise typer.BadParameter("start must be before end")
    if output.exists():
        raise typer.BadParameter(f"{output.name}: already exists")
    if (resources is None) != (worker_service is None):
        raise typer.BadParameter("--resources and --worker-service go together")
    try:
        if len({path.resolve() for path in log}) != len(log):
            raise EvidenceInvalid("log_listed_twice")
        cycles: tuple[Any, ...] = ()
        for path in log:
            with path.open(encoding="utf-8") as lines:
                cycles += read_worker_log(
                    lines, provider_id=provider, start=window[0], end=window[1]
                )
        observed: tuple[RestartObservation, ...] = ()
        if restarts is not None:
            records = []
            for number, line in enumerate(restarts.read_text(encoding="utf-8").splitlines(), 1):
                if line.strip():
                    try:
                        value = json.loads(line)
                    except ValueError as exc:
                        raise EvidenceInvalid(f"restart_record_json_invalid:line {number}") from exc
                    records.append(RestartObservation.from_dict(value))
            observed = tuple(records)
        plan = None
        if resources is not None and worker_service is not None:
            peaks, disk = parse_evidence(_document(resources, "resources"))
            plan = ResourceEvidence(peaks, disk, worker_service)
        cpu = None
        if window_cpu is not None:
            cpu = WindowCpu.from_dict(_document(window_cpu, "window_cpu"))
        rulings = {}
        if adjudications is not None:
            document = _document(adjudications, "adjudications")
            if not isinstance(document, dict):
                raise EvidenceInvalid("adjudications_invalid")
            rulings = {key: Adjudication.from_dict(key, value) for key, value in document.items()}
        poll = poll_seconds if poll_seconds is not None else _default_poll_seconds()
        cadence, tick = _schedule(provider, providers, poll)
    except (OSError, ComposeLimitsRefused, EvidenceInvalid) as exc:
        raise typer.BadParameter(f"evidence_malformed:{exc}") from exc
    verdict = evaluate(
        EvidenceBundle(
            provider_id=provider,
            window_start=window[0],
            window_end=window[1],
            cycles=cycles,
            restarts=observed,
            cadence_seconds=cadence,
            tick_seconds=tick,
            resources=plan,
            window_cpu=cpu,
            adjudications=rulings,
        )
    )
    text = json.dumps(verdict.display_dict(), indent=2, sort_keys=True, default=str) + "\n"
    with output.open("x", encoding="utf-8", newline="\n") as target:
        target.write(text)
    typer.echo(text, nl=False)
    if not verdict.eligible:
        raise typer.Exit(1)
