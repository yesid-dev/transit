from typing import Annotated

import typer

app = typer.Typer(help="Plan and copy declared table history to the archive.")


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


@app.command()
def migrate(
    statement_timeout_s: int = typer.Option(..., min=1, max=900),
    execute: bool = typer.Option(False, "--execute"),
    work_dir: str = typer.Option(...),
    copied_by: str = typer.Option(...),
    not_after: str | None = typer.Option(None),
    include_open: bool = typer.Option(False, "--include-open"),
    dataset: Annotated[list[str] | None, typer.Option("--dataset")] = None,
    provider: Annotated[list[str] | None, typer.Option("--provider")] = None,
    today: str | None = typer.Option(None),
) -> None:
    """Print a read-only plan; copy windows only with --execute."""
    import json
    import os
    import re
    from dataclasses import asdict
    from datetime import UTC, date, datetime, timedelta
    from pathlib import Path
    from urllib.parse import urlsplit, urlunsplit
    from uuid import uuid4

    import psycopg

    from transit_ops.history.storage import history_storage
    from transit_ops.lake.migration import plan_migration, run_migration
    from transit_ops.settings import get_settings

    scope = None
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", copied_by):
            raise ValueError("copied_by must be a 40-hex commit")
        deadline = datetime.fromisoformat(not_after) if not_after else None
        if execute and (deadline is None or deadline.utcoffset() != timedelta(0)):
            raise ValueError("--execute requires --not-after as an aware UTC ISO time")
        if execute and deadline <= datetime.now(UTC):
            raise ValueError("--not-after has already passed")
        settings = get_settings()
        if not settings.DATABASE_URL:
            raise ValueError("database_not_configured")
        parts = urlsplit(settings.DATABASE_URL)

        def connect():
            return psycopg.connect(
                urlunsplit(parts._replace(scheme="postgresql")), autocommit=True,
                connect_timeout=5, application_name="transit-lake-migrate-" + uuid4().hex,
                options="-c statement_timeout=1000 -c lock_timeout=1000 "
                "-c client_connection_check_interval=1000",
            )

        with connect() as connection:
            plan = plan_migration(connection,
                today_utc=date.fromisoformat(today) if today else datetime.now(UTC).date(),
                include_open=include_open, datasets=dataset, providers=provider,
                statement_timeout_s=statement_timeout_s)
        for window in plan.windows:
            typer.echo(json.dumps(asdict(window), sort_keys=True))
        typer.echo(json.dumps({"planned": len(plan.windows),
            "skipped_open": [asdict(w) for w in plan.skipped_open]}, sort_keys=True))
        if not execute:
            return
        directory = Path(work_dir)
        if any(c in str(directory) for c in "*?[]{}"):
            raise ValueError("Glob characters in work_dir")
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "migration-log.jsonl").open("x", encoding="utf8") as stream:
            def log(record):
                stream.write(json.dumps(record, sort_keys=True) + "\n")
                stream.flush()
                os.fsync(stream.fileno())

            scope = history_storage(settings)
            result = run_migration(plan, connect, scope.resolve(settings.BRONZE_STORAGE_BACKEND),
                work_dir=directory, copied_by=copied_by, statement_timeout_s=statement_timeout_s,
                not_after=deadline, log=log)
        typer.echo(json.dumps(asdict(result), sort_keys=True))
        if result.failure is not None:
            raise typer.Exit(1)
    except typer.Exit:
        raise
    except Exception as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(1) from error
    finally:
        if scope is not None:
            scope.close()
