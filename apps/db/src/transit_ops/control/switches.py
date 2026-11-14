"""Owner-controlled switches with PostgreSQL as the default store."""

import json
from collections.abc import Callable, Mapping
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Protocol
from urllib.parse import unquote

from sqlalchemy import Connection, text

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

_r2_guards: dict[str, Callable[[str], GuardResult]] = {}


def register_r2_guard(prefix: str, fn: Callable[[str], GuardResult]) -> None:
    pg.validate_text(prefix, "prefix")
    if prefix in _r2_guards:
        raise ValueError("guard prefix already registered")
    _r2_guards[prefix] = fn


register_r2_guard("history_daily", lambda key: GuardResult(False, "history ledger is not ready"))


def _validate_row(row: PipelineSwitch) -> None:
    try:
        for name in ("switch_key", "updated_by", "reason"):
            value = getattr(row, name)
            if not isinstance(value, str):
                raise ValueError
            pg.validate_text(value, name)
        if (
            type(row.enabled) is not bool
            or not isinstance(row.updated_at_utc, datetime)
            or row.updated_at_utc.utcoffset() is None
        ):
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid switch document") from exc


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

    def show_switch(self, switch_key: str, *, strict: bool = False) -> PipelineSwitch | None:
        if not strict:
            return pg.show_switch(self.connection, switch_key)
        row = (
            self.connection.execute(
                text(
                    "SELECT switch_key, enabled, updated_at_utc, updated_by, reason "
                    "FROM core.pipeline_switches WHERE switch_key=:key"
                ),
                {"key": switch_key},
            )
            .mappings()
            .one_or_none()
        )
        return PipelineSwitch(**row) if row is not None else None

    def set_switch(self, switch_key: str, *, on: bool, updated_by: str, reason: str) -> None:
        pg.set_switch(self.connection, switch_key, on=on, updated_by=updated_by, reason=reason)


def _payload(row: PipelineSwitch) -> dict[str, object]:
    _validate_row(row)
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
        try:
            body = json.loads(obj.body)
            body["updated_at_utc"] = datetime.fromisoformat(body["updated_at_utc"])
            row = PipelineSwitch(**body)
            _validate_row(row)
            if row.switch_key != key:
                raise ValueError
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("invalid switch document") from exc
        return row, obj.token

    def show_switch(self, switch_key: str) -> PipelineSwitch | None:
        return self._read(switch_key)[0]

    def list_switches(self) -> list[PipelineSwitch]:
        rows = (
            self.show_switch(unquote(k[len("switches/") : -5]))
            for k in self.objects.list_keys("switches/")
            if k.endswith(".json")
        )
        return sorted((r for r in rows if r is not None), key=lambda r: r.switch_key)

    def enabled(self) -> frozenset[str]:
        return frozenset(r.switch_key for r in self.list_switches() if r.enabled)

    def copy_in(self, row: PipelineSwitch) -> None:
        try:
            self.objects.replace(self._key(row.switch_key), _payload(row), expected=None)
        except ObjectConflict as exc:
            if self.show_switch(row.switch_key) != row:
                raise ObjectCollision(row.switch_key) from exc

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
        guards=_r2_guards,
    )


def copy_switches(source: SwitchStore, target: R2Switches) -> None:
    for row in source.list_switches():
        target.copy_in(row)
