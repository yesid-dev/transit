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
