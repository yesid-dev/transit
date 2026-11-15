"""Family engine selection; operating approval remains with the owner."""

from typing import Literal

from sqlalchemy import Connection, text

from transit_ops import pipeline_switches
from transit_ops.control.switches import register_r2_guard, switches_for
from transit_ops.pipeline_switches import GuardResult
from transit_ops.settings import Settings, get_settings


def switch_key(family_id: str) -> str:
    from transit_ops.batch.families import registry

    if family_id not in registry.FAMILIES:
        raise registry.UnknownFamilyError(f"Unknown family: {family_id}")
    return f"batch_engine:{family_id}"


def engine_for(
    connection: Connection, family_id: str, *, settings: Settings | None = None
) -> Literal["postgres", "duckdb"]:
    key = switch_key(family_id)
    return (
        "duckdb"
        if key in switches_for(connection, settings or get_settings()).enabled()
        else "postgres"
    )


def _builder_guard(key: str) -> GuardResult:
    from transit_ops.batch.families import registry

    family_id = key.removeprefix("batch_engine:")
    try:
        switch_key(family_id)
        builder = registry.resolve_builder(family_id)
    except registry.UnknownFamilyError as error:
        return GuardResult(False, str(error))
    if builder is None:
        return GuardResult(False, f"{family_id}: builder is not implemented")
    return GuardResult(True)


def _guard(connection: Connection, key: str) -> GuardResult:
    if (
        connection.execute(text("SELECT to_regclass('core.pipeline_switches')")).scalar_one()
        is None
    ):
        return GuardResult(False, "pipeline switch schema is not ready")
    return _builder_guard(key)


pipeline_switches.register_guard("batch_engine:", _guard)
register_r2_guard("batch_engine:", _builder_guard)
