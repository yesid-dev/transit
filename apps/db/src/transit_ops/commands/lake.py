import typer

app = typer.Typer(help="Reserved copy_out lane; not implemented.")


@app.callback(invoke_without_command=True)
def main(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        typer.echo(ctx.get_help())


@app.command()
def inventory() -> None:
    """Read the configured database catalog and report every table's declaration."""
    import json
    from dataclasses import asdict

    from sqlalchemy import text

    from transit_ops.db.connection import make_engine
    from transit_ops.lake.catalog import read_catalog
    from transit_ops.lake.inventory import take_inventory
    from transit_ops.settings import get_settings

    engine = make_engine(get_settings())
    try:
        with engine.connect() as connection, connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            result = take_inventory(read_catalog(connection))
            typer.echo(json.dumps(asdict(result) | {"complete": result.complete}, sort_keys=True))
        if not result.complete:
            raise typer.Exit(1)
    finally:
        engine.dispose()


@app.command("export-table")
def export_table(
    dataset: str = typer.Option(...),
    provider: str = typer.Option(...),
    window: str = typer.Option(...),
    work_dir: str = typer.Option(...),
    copied_by: str = typer.Option(...),
    statement_timeout_s: int = typer.Option(..., min=1, max=900),
    revision: int = typer.Option(0),
    upload: bool = typer.Option(False, "--upload/--local-only"),
) -> None:
    """Export and prove one table window; upload only when explicitly selected."""
    import json
    import re
    from dataclasses import asdict
    from pathlib import Path
    from urllib.parse import urlsplit, urlunsplit
    from uuid import uuid4

    import psycopg

    from transit_ops.history.storage import history_storage
    from transit_ops.lake.table_copy import copy_table_window
    from transit_ops.lake.table_export import WindowSpec
    from transit_ops.settings import get_settings

    scope = None
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", copied_by):
            raise ValueError("copied_by must be a 40-hex commit")
        settings = get_settings()
        if not settings.DATABASE_URL:
            raise ValueError("database_not_configured")
        parts = urlsplit(settings.DATABASE_URL)
        if upload:
            scope = history_storage(settings)
        with psycopg.connect(
            urlunsplit(parts._replace(scheme="postgresql")), autocommit=True,
            connect_timeout=5, application_name="transit-lake-export-" + uuid4().hex,
            options="-c statement_timeout=1000 -c lock_timeout=1000 "
            "-c client_connection_check_interval=1000",
        ) as connection:
            result = copy_table_window(
                connection, scope.resolve(settings.BRONZE_STORAGE_BACKEND) if scope else None,
                WindowSpec(dataset, provider, window, revision), work_dir=Path(work_dir),
                copied_by=copied_by, statement_timeout_s=statement_timeout_s,
            )
        typer.echo(json.dumps(asdict(result), sort_keys=True, separators=(",", ":")))
    except Exception as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error
    finally:
        if scope is not None:
            scope.close()
