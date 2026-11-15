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
    not_after: str | None = typer.Option(None, help="UTC deadline for database reads; "
        "window starts reserve two statement timeouts plus 300 seconds."),
    include_open: bool = typer.Option(False, "--include-open"),
    dataset: Annotated[list[str] | None, typer.Option("--dataset")] = None,
    provider: Annotated[list[str] | None, typer.Option("--provider")] = None,
    today: str | None = typer.Option(None),
    plan_budget_s: int = typer.Option(300, min=1, max=1800,
        help="Total planning budget; also bounded by --not-after."),
    storage: str | None = typer.Option(None,
        help="Storage backend override; local execution requires explicit --storage local."),
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
    from transit_ops.ingestion.common import project_root
    from transit_ops.lake.migration import (
        migration_lock,
        plan_migration,
        require_read_reserve,
        run_migration,
    )
    from transit_ops.settings import get_settings

    scope = None
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", copied_by):
            raise ValueError("copied_by must be a 40-hex commit")
        instant = datetime.now(UTC)
        deadline = datetime.fromisoformat(not_after) if not_after else None
        if execute and (deadline is None or deadline.utcoffset() != timedelta(0)):
            raise ValueError("--execute requires --not-after as an aware UTC ISO time")
        if execute and deadline <= instant:
            raise ValueError("--not-after has already passed")
        settings = get_settings()
        if not settings.DATABASE_URL:
            raise ValueError("database_not_configured")
        if storage not in {None, "local", "s3"}:
            raise ValueError("--storage must be s3 or local")
        backend = storage or settings.BRONZE_STORAGE_BACKEND
        if execute and backend != "s3" and storage != "local":
            raise ValueError("--execute requires s3; use --storage local to explicitly opt in")
        location = settings.BRONZE_S3_BUCKET if backend == "s3" else str(
            (project_root() / settings.BRONZE_LOCAL_ROOT).resolve())
        if backend == "s3" and not location:
            raise ValueError("s3 bucket is not configured")
        target = {"storage_backend": backend, "storage_location": location}
        parts = urlsplit(settings.DATABASE_URL)

        def connect():
            return psycopg.connect(
                urlunsplit(parts._replace(scheme="postgresql")), autocommit=True,
                connect_timeout=5, application_name="transit-lake-migrate-" + uuid4().hex,
                keepalives=1, keepalives_idle=60,
                options="-c statement_timeout=1000 -c lock_timeout=1000 "
                "-c client_connection_check_interval=1000",
            )

        with connect() as connection, migration_lock(connection):
            def still_locked():
                return connection.execute("SELECT 1").fetchone() == (1,)

            plan = plan_migration(connection,
                today_utc=date.fromisoformat(today) if today else instant.date(),
                now_utc=None if today else instant,
                include_open=include_open, datasets=dataset, providers=provider,
                statement_timeout_s=statement_timeout_s, plan_budget_s=plan_budget_s,
                not_after=deadline)
            typer.echo(json.dumps({"kind": "plan_header", **target,
                "database_url": settings.redacted_database_url, **plan.database_target},
                sort_keys=True))
            for window in plan.windows:
                typer.echo(json.dumps(asdict(window), sort_keys=True))
            typer.echo(json.dumps({"planned": len(plan.windows), **target,
                "skipped_open": [asdict(w) for w in plan.skipped_open]}, sort_keys=True))
            if not execute:
                return
            require_read_reserve(deadline, statement_timeout_s)
            directory = Path(work_dir)
            if any(c in str(directory) for c in "*?[]{}"):
                raise ValueError("Glob characters in work_dir")
            directory.mkdir(parents=True, exist_ok=True)
            with (directory / "migration-log.jsonl").open("x", encoding="utf8") as stream:
                def log(record):
                    stream.write(json.dumps(record | target, sort_keys=True) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())

                scope = history_storage(settings)
                result = run_migration(plan, connect, scope.resolve(backend),
                    work_dir=directory, copied_by=copied_by,
                    statement_timeout_s=statement_timeout_s,
                    not_after=deadline, log=log, storage_target=target,
                    still_locked=still_locked)
            typer.echo(json.dumps(asdict(result) | target, sort_keys=True))
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
