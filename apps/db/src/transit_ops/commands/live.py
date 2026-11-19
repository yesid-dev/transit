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


def _document(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise typer.BadParameter(f"{path.name}: readable JSON required") from exc


def _cadence(provider_id: str, providers: Path) -> int | None:
    from transit_ops.live.admission import declared_cadence
    from transit_ops.providers.registry import load_provider_manifest

    for path in sorted(providers.glob("*.yaml")):
        manifest = load_provider_manifest(path)
        if manifest.provider.provider_id == provider_id:
            return declared_cadence(manifest)
    return None  # An undeclared provider has no cadence: that gate is unavailable.


@app.command()
def admission(
    provider: Annotated[str, typer.Option(help="Provider whose worker wrote the logs.")],
    log: Annotated[list[Path], typer.Option(help="Worker log file(s) with paired_shadow lines.")],
    start: Annotated[str, typer.Option(help="Window start, ISO 8601 with offset (inclusive).")],
    end: Annotated[str, typer.Option(help="Window end, ISO 8601 with offset (exclusive).")],
    output: Annotated[Path, typer.Option(help="New verdict JSON file; must not exist.")],
    restarts: Annotated[
        Path | None, typer.Option(help="Restart observations, one JSON object per line.")
    ] = None,
    resources: Annotated[
        Path | None, typer.Option(help="The admitted plan's measured evidence (#901 shape).")
    ] = None,
    worker_service: Annotated[
        str | None, typer.Option(help="The provider's worker service in --resources.")
    ] = None,
    adjudications: Annotated[
        Path | None, typer.Option(help='{"<counts key>": {"class": "a"|"b", "math": "..."}}')
    ] = None,
    providers: Annotated[Path, typer.Option(help="Provider declaration directory.")] = _CONFIG,
) -> None:
    """Judge the local engine's pilot eligibility from recorded evidence only.

    Exit 0 when eligible, 1 when not eligible, 2 on invalid or unreadable evidence.
    Eligibility never starts the shadow, deploys or flips a role: the owner approves those.
    """
    from transit_ops.live.admission import (
        Adjudication,
        EvidenceBundle,
        EvidenceInvalid,
        ResourceEvidence,
        RestartObservation,
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
        cycles: tuple[Any, ...] = ()
        for path in log:
            with path.open(encoding="utf-8") as lines:
                cycles += read_worker_log(
                    lines, provider_id=provider, start=window[0], end=window[1]
                )
        observed: tuple[RestartObservation, ...] = ()
        if restarts is not None:
            observed = tuple(
                RestartObservation.from_dict(json.loads(line))
                for line in restarts.read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
        plan = None
        if resources is not None and worker_service is not None:
            peaks, disk = parse_evidence(_document(resources))
            plan = ResourceEvidence(peaks, disk, worker_service)
        rulings = {}
        if adjudications is not None:
            document = _document(adjudications)
            if not isinstance(document, dict):
                raise EvidenceInvalid("adjudications_invalid")
            rulings = {key: Adjudication.from_dict(key, value) for key, value in document.items()}
        verdict = evaluate(
            EvidenceBundle(
                provider_id=provider,
                window_start=window[0],
                window_end=window[1],
                cycles=cycles,
                restarts=observed,
                cadence_seconds=_cadence(provider, providers),
                resources=plan,
                adjudications=rulings,
            )
        )
    except (OSError, ValueError, ComposeLimitsRefused, EvidenceInvalid) as exc:
        raise typer.BadParameter(f"evidence refused: {exc}") from exc
    text = json.dumps(verdict.display_dict(), indent=2, sort_keys=True, default=str) + "\n"
    with output.open("x", encoding="utf-8", newline="\n") as target:
        target.write(text)
    typer.echo(text, nl=False)
    if not verdict.eligible:
        raise typer.Exit(1)
