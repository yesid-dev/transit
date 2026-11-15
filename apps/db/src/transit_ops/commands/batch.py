import os
import subprocess
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from transit_ops.batch import switch as switch

if TYPE_CHECKING:
    from transit_ops.batch.build import BuildRequest
    from transit_ops.batch.checkpoints import Checkpoint

app = typer.Typer(help="Replay and compare batch builds.")



@app.callback(invoke_without_command=True)
def main(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


def _code_commit() -> str:
    return subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=Path(__file__).resolve().parent, text=True
    ).strip()


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


def _shadow_request(
    provider: str, local_date: date, stamp: datetime, inputs: Path, workdir: Path
) -> "BuildRequest":
    from transit_ops.batch.build import BuildRequest, InputNeed
    from transit_ops.batch.engine import open_batch_session
    from transit_ops.batch.inputs import resolve_inputs
    from transit_ops.batch.private_area import PrivateArea
    from transit_ops.settings import Settings
    from transit_ops.sql_registry import named_query

    settings = Settings()
    sources = resolve_inputs((InputNeed("core.providers", "all"),), inputs)
    with PrivateArea(workdir) as area, open_batch_session(sources, workdir=area) as session:
        timezone = session.execute(
            named_query(
                "batch.shadow.provider_timezone",
                "SELECT timezone FROM core.providers WHERE provider_id=:provider",
            ),
            {"provider": provider},
        ).scalar_one()
    return BuildRequest(
        provider,
        (local_date,),
        stamp,
        settings.GOLD_FACT_RETENTION_DAYS,
        settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
        str(timezone),
    )


def _accept_shadow_report(checkpoint: "Checkpoint", path: Path) -> None:
    import json

    from transit_ops.batch.checkpoints import NotAccepted, accept
    from transit_ops.batch.replay_report import family_from_payload

    data = json.loads(path.read_bytes())
    manifest = checkpoint.manifest
    if (
        data["provider_id"] != manifest.provider_id
        or data["local_date"] != checkpoint.local_date.isoformat()
        or datetime.fromisoformat(data["as_of_utc"]) != manifest.as_of_utc
        or data["code_commit"] != manifest.code_commit
        or data["duckdb_version"] != manifest.engine_version
    ):
        raise NotAccepted("replay report provenance differs from checkpoint")
    matches = [f for f in data["families"] if f["family_id"] == manifest.family_id]
    if len(matches) != 1:
        raise NotAccepted("requires exactly one identical family replay")
    accept(checkpoint, family_from_payload(matches[0]))


@app.command("shadow-build")
def shadow_command(
    provider: Annotated[str, typer.Option("--provider")],
    day: Annotated[str, typer.Option("--date")],
    inputs: Annotated[Path, typer.Option("--inputs")],
    workdir: Annotated[Path, typer.Option("--workdir")],
    family: Annotated[list[str], typer.Option("--family")],
    as_of: Annotated[str | None, typer.Option("--as-of")] = None,
    accept_from: Annotated[Path | None, typer.Option("--accept-from")] = None,
) -> None:
    """Build closed-day families and publish create-only shadow objects."""
    from transit_ops.batch.build import FamilyBuilder
    from transit_ops.batch.checkpoints import CheckpointStore, safe_component
    from transit_ops.batch.engine import BatchEngineError
    from transit_ops.batch.families.registry import resolve_builder
    from transit_ops.batch.private_area import PrivateArea
    from transit_ops.batch.run import run_family
    from transit_ops.batch.shadow import ShadowBuilder, ShadowRefused, write_shadow
    from transit_ops.ingestion.storage import get_bronze_storage
    from transit_ops.settings import Settings

    try:
        safe_component(provider)
        local_date = date.fromisoformat(day)
        stamp = (
            datetime.fromisoformat(as_of)
            if as_of
            else datetime.combine(local_date + timedelta(days=1), time(7), UTC)
        )
        if len(set(family)) != len(family):
            raise ValueError("duplicate family_id")
        builders = [resolve_builder(safe_component(name)) for name in family]
        if any(not isinstance(builder, FamilyBuilder) for builder in builders):
            raise ValueError("family builder is not implemented")
        workdir.mkdir(parents=True, exist_ok=True)
        request = _shadow_request(provider, local_date, stamp, inputs, workdir)
        storage = get_bronze_storage(Settings(), project_root=Path(__file__).resolve().parents[3])
        store = CheckpointStore(workdir / "checkpoints")
        commit = _code_commit()
        for builder in builders:
            assert isinstance(builder, FamilyBuilder)
            with PrivateArea(workdir) as area:
                tables = area / "tables"
                tables.mkdir()
                exporter = ShadowBuilder(builder, tables)
                try:
                    result = run_family(
                        exporter, request, inputs_root=inputs, workdir=area, code_commit=commit
                    )
                except (BatchEngineError, ShadowRefused):
                    raise
                except Exception as error:
                    typer.echo(str(error), err=True)
                    raise typer.Exit(2) from error
                checkpoint = store.record(result, local_date)
                if accept_from is not None:
                    _accept_shadow_report(checkpoint, accept_from)
                receipt = write_shadow(checkpoint, storage, tables_dir=tables)
                typer.echo(
                    f"{builder.family_id}: {checkpoint.build_id}, "
                    f"{len(receipt.objects)} shadow objects"
                )
    except typer.Exit:
        raise
    except Exception as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error
