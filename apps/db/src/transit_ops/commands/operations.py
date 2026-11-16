"""Operations renderers. They read explicit inputs and write only stdout."""

from pathlib import Path
from typing import Annotated

import typer

from transit_ops.operations.compose_limits import (
    ComposeLimitsRefused,
    parse_compose_yaml,
    parse_evidence,
    parse_json_document,
    parse_worker_bindings,
    render_compose_limits,
    render_json,
)
from transit_ops.operations.resource_plan import ResourceEvidenceMissing, TenantCapacityExceeded

app = typer.Typer(help="Operations renderers; no deployment side effects.")


@app.callback(invoke_without_command=True)
def main(ctx: typer.Context) -> None:
    # Help belongs to the bare lane only: a command's stdout is one artifact.
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@app.command("render-compose-limits")
def render_compose_limits_command(
    compose: Annotated[Path, typer.Option("--compose", help="Base Compose YAML file.")],
    evidence: Annotated[Path, typer.Option("--evidence", help="Measured evidence JSON file.")],
    worker_bindings: Annotated[
        Path, typer.Option("--worker-bindings", help="Worker service to provider id JSON file.")
    ],
) -> None:
    """Render an opt-in Compose override from measured evidence; writes only stdout."""
    try:
        peaks, disk = parse_evidence(parse_json_document(_read(evidence), "evidence"))
        bindings = parse_worker_bindings(
            parse_json_document(_read(worker_bindings), "worker bindings")
        )
        document = render_compose_limits(
            parse_compose_yaml(_read(compose)),
            peaks=peaks,
            disk=disk,
            worker_bindings=bindings,
        )
    except (
        ComposeLimitsRefused,
        ResourceEvidenceMissing,
        TenantCapacityExceeded,
        OSError,
        UnicodeDecodeError,
    ) as exc:
        typer.echo(f"refused: {exc}", err=True)
        raise typer.Exit(1) from None
    typer.echo(render_json(document), nl=False)
