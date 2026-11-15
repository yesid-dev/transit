"""Local entry point for the guarded live oracle."""

import os
from pathlib import Path
from typing import Annotated

import typer
from sqlalchemy.exc import SQLAlchemyError

from transit_ops.live.oracle.database import OracleDatabaseRefused
from transit_ops.live.oracle.report import write_replay_report
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings

app = typer.Typer(help="Replay recorded local inputs in a disposable live oracle.")


def _reason_chain(error: BaseException) -> str:
    reasons = []
    cause: BaseException | None = error
    while cause is not None:
        if isinstance(cause, OracleDatabaseRefused):
            reasons.append("OracleDatabaseRefused: foreign_target or disposable guard refused")
            break  # The guard's cause includes connection identity.
        if isinstance(cause, SQLAlchemyError) or type(cause).__module__.startswith("psycopg"):
            reasons.append(f"{type(cause).__name__}: database operation failed")
        else:
            reasons.append(f"{type(cause).__name__}: {cause}")
        cause = cause.__cause__
    return " -> ".join(reasons)


@app.command()
def replay(
    window: Annotated[Path, typer.Option(help="Recorded ReplayWindow JSON.")],
    output: Annotated[Path, typer.Option(help="New evidence directory; must not exist.")],
    prior_manifest: Annotated[Path | None, typer.Option()] = None,
) -> None:
    """Uses TRANSIT_TEST_DATABASE_URL and the existing disposable guard environment."""
    try:
        settings = Settings(_env_file=None)  # type: ignore[call-arg]
        write_replay_report(
            window,
            output,
            prior_manifest=prior_manifest,
            admin_url=os.environ.get("TRANSIT_TEST_DATABASE_URL", ""),
            environment=os.environ,
            settings=settings,
            registry=ProviderRegistry.from_project_root(settings=settings),
        )
    except Exception as exc:
        typer.echo(_reason_chain(exc), err=True)
        raise typer.Exit(1) from None
    typer.echo("completed: evidence in output/completed")
