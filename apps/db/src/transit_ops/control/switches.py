"""Owner-controlled switches with PostgreSQL as the default store."""

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import Connection

from transit_ops import pipeline_switches as pg
from transit_ops.control.objects import (
    ConditionalObjects,
    ObjectCollision,
    ObjectConflict,
    control_objects,
    key_part,
)
from transit_ops.pipeline_switches import GuardResult, PipelineSwitch
from transit_ops.settings import Settings


class SwitchStore(Protocol):
    def enabled(self) -> frozenset[str]: ...
    def list_switches(self) -> list[PipelineSwitch]: ...
    def show_switch(self, switch_key: str) -> PipelineSwitch | None: ...
    def set_switch(self, switch_key: str, *, on: bool, updated_by: str, reason: str) -> None: ...


class PostgresSwitches:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection

    def enabled(self) -> frozenset[str]:
        return pg.enabled(self.connection)

    def list_switches(self) -> list[PipelineSwitch]:
        return pg.list_switches(self.connection)

    def show_switch(self, switch_key: str) -> PipelineSwitch | None:
        return pg.show_switch(self.connection, switch_key)

    def set_switch(self, switch_key: str, *, on: bool, updated_by: str, reason: str) -> None:
        pg.set_switch(self.connection, switch_key, on=on, updated_by=updated_by, reason=reason)


def _payload(row: PipelineSwitch) -> dict[str, object]:
    return {**asdict(row), "updated_at_utc": row.updated_at_utc.astimezone(UTC).isoformat()}


class R2Switches:
    def __init__(
        self,
        objects: ConditionalObjects,
        *,
        clock: Callable[[], datetime],
        guards: Mapping[str, Callable[[str], GuardResult]],
    ) -> None:
        self.objects, self.clock, self.guards = objects, clock, guards

    @staticmethod
    def _key(key: str) -> str:
        return f"switches/{key_part(key)}.json"

    def _read(self, key: str) -> tuple[PipelineSwitch | None, str | None]:
        obj = self.objects.read(self._key(key))
        if obj is None:
            return None, None
        body = json.loads(obj.body)
        body["updated_at_utc"] = datetime.fromisoformat(body["updated_at_utc"])
        row = PipelineSwitch(**body)
        if row.switch_key != key or type(row.enabled) is not bool:
            raise ValueError("invalid switch document")
        return row, obj.token

    def show_switch(self, switch_key: str) -> PipelineSwitch | None:
        return self._read(switch_key)[0]

    def list_switches(self) -> list[PipelineSwitch]:
        from urllib.parse import unquote

        rows = (
            self.show_switch(unquote(k[len("switches/") : -5]))
            for k in self.objects.list_keys("switches/")
            if k.endswith(".json")
        )
        return sorted((r for r in rows if r is not None), key=lambda r: r.switch_key)

    def enabled(self) -> frozenset[str]:
        return frozenset(r.switch_key for r in self.list_switches() if r.enabled)

    def set_switch(self, switch_key: str, *, on: bool, updated_by: str, reason: str) -> None:
        for name, value in (("switch key", switch_key), ("actor", updated_by), ("reason", reason)):
            pg.validate_text(value, name)
        if switch_key.startswith("stop_time_diet:"):
            raise pg.ReservedSwitch("use set-stop-time-diet for this key")
        for attempt in range(2):
            try:
                previous, token = self._read(switch_key)
                if on:
                    prefixes = [p for p in self.guards if switch_key.startswith(p)]
                    if not prefixes:
                        raise pg.GuardRefused("no guard registered for this switch")
                    result = self.guards[max(prefixes, key=len)](switch_key)
                    if not result.allowed:
                        raise pg.GuardRefused(result.reason or "switch guard refused enablement")
                if previous is not None and previous.enabled == on:
                    return
                row = PipelineSwitch(switch_key, on, self.clock(), updated_by, reason)
                self.objects.replace(self._key(switch_key), _payload(row), expected=token)
                return
            except ObjectConflict:
                if attempt:
                    raise


def switches_for(connection: Connection | None, settings: Settings) -> SwitchStore:
    if settings.LIGHTER_STORAGE.control.switch_backend == "postgres":
        if connection is None:
            raise ValueError("PostgreSQL switches require a connection")
        return PostgresSwitches(connection)
    return R2Switches(
        control_objects(settings),
        clock=lambda: datetime.now(UTC),
        guards={"history_daily": lambda key: GuardResult(False, "history ledger is not ready")},
    )


def copy_switches(source: SwitchStore, target: R2Switches) -> None:
    for row in source.list_switches():
        try:
            target.objects.replace(target._key(row.switch_key), _payload(row), expected=None)
        except ObjectConflict as exc:
            if target.show_switch(row.switch_key) != row:
                raise ObjectCollision(row.switch_key) from exc
