import os
import subprocess
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Annotated

import typer

from transit_ops.batch import switch as switch

app = typer.Typer(help="Replay and compare batch builds.")



@app.callback(invoke_without_command=True)
def main(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


def _code_commit() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parent, text=True
    ).strip()


@app.command("fetch-inputs")
def fetch_command(
    provider: Annotated[str, typer.Option("--provider")],
    day: Annotated[str, typer.Option("--date")],
    inputs: Annotated[Path, typer.Option("--inputs")],
    family: Annotated[list[str] | None, typer.Option("--family")] = None,
    bodies: Annotated[bool, typer.Option("--bodies")] = False,
    as_of: Annotated[str | None, typer.Option("--as-of")] = None,
) -> None:
    """Fetch proven inputs using the guarded disposable database's FK catalog."""
    import json

    from transit_ops.batch.input_sources import fetch_from_catalog, replay_request
    from transit_ops.batch.replay import family_input_needs, replay_builders
    from transit_ops.history.storage import history_storage
    from transit_ops.settings import get_settings

    scope = None
    try:
        settings = get_settings()
        request = replay_request(provider, day, as_of, settings)
        builders = tuple(replay_builders(family or []).values())
        family_input_needs(builders, request)
        scope = history_storage(settings)
        result = fetch_from_catalog(
            scope.resolve(settings.BRONZE_STORAGE_BACKEND),
            inputs,
            request,
            builders,
        )
        typer.echo(json.dumps(result, sort_keys=True, separators=(",", ":")))
    except Exception as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error
    finally:
        if scope is not None:
            scope.close()


@app.command("replay-day")
def replay_command(
    provider: Annotated[str, typer.Option("--provider")],
    day: Annotated[str, typer.Option("--date")],
    inputs: Annotated[Path, typer.Option("--inputs")],
    workdir: Annotated[Path, typer.Option("--workdir")],
    as_of: Annotated[str | None, typer.Option("--as-of")] = None,
    family: Annotated[list[str] | None, typer.Option("--family")] = None,
    bodies: Annotated[bool, typer.Option("--bodies")] = False,
) -> None:
    """Compare a past day using an already migrated disposable replay database."""
    from transit_ops.batch.pg_load import prepare_replay_database
    from transit_ops.batch.replay import replay_day

    database = None
    try:
        if (
            not provider
            or Path(provider).name != provider
            or any(c in provider for c in "\\/:\x00")
        ):
            raise ValueError("provider must be a safe report filename component")
        local_date = date.fromisoformat(day)
        stamp = (
            datetime.fromisoformat(as_of)
            if as_of
            else datetime.combine(local_date + timedelta(days=1), time(7), UTC)
        )
        url = os.environ.get("TRANSIT_REPLAY_DATABASE_URL")
        if not url:
            raise ValueError("TRANSIT_REPLAY_DATABASE_URL is required")
        database = prepare_replay_database(url, os.environ)
        workdir.mkdir(parents=True, exist_ok=True)
        report = replay_day(
            engine=database,
            provider_id=provider,
            local_date=local_date,
            as_of_utc=stamp,
            inputs_root=inputs,
            workdir=workdir,
            families=family or [],
            code_commit=_code_commit(),
            publish_bodies=bodies,
        )
        (workdir / f"report-{provider}-{local_date}.json").write_bytes(report.to_json(timings=True))
    except Exception as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error
    finally:
        if database is not None:
            database.engine.dispose()
    raise typer.Exit(report.exit_code())
