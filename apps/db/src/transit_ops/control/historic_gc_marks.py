"""Derived GC marks. PostgreSQL writes share the caller's transaction; R2 writes do not."""

import json
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from hashlib import sha256
from typing import Protocol
from uuid import UUID, uuid4

from sqlalchemy import Connection, text

from transit_ops.control.objects import (
    ConditionalObjects,
    ObjectConflict,
    control_objects,
    key_part,
)
from transit_ops.settings import Settings
from transit_ops.snapshots.historic_gc import HistoricGcMark
from transit_ops.snapshots.publication_lane import acquire_publication_lane
from transit_ops.snapshots.storage import StoredObjectVersion
from transit_ops.sql_registry import named_query

type MarksVersion = str | None


class GcMarkStore(Protocol):
    def load(self, provider_id: str) -> dict[str, HistoricGcMark]: ...
    def version(self, provider_id: str) -> MarksVersion: ...
    def replace(
        self, provider_id: str, marks: Mapping[str, HistoricGcMark], *, expected: MarksVersion
    ) -> None: ...
    def clear(self, provider_id: str, object_keys: Sequence[str]) -> None: ...


_LOAD = text("""SELECT m.object_key, m.etag, m.content_length, m.object_last_modified_utc,
    m.first_unreachable_utc, m.last_confirmed_unreachable_utc, m.last_scan_id,
    m.xmin::text, m.cmin::text, p.xmin::text AS provider_xmin, p.cmin::text AS provider_cmin
    FROM core.providers p LEFT JOIN core.snapshot_historic_gc_marks m USING (provider_id)
    WHERE p.provider_id = :provider_id ORDER BY m.object_key""")
_PROVIDER_LOCK = text(
    "SELECT provider_id FROM core.providers WHERE provider_id = :provider_id FOR NO KEY UPDATE"
)
# Keep a revision even when no marks remain, without changing any provider value.
_BUMP = "UPDATE core.providers SET display_name = display_name WHERE provider_id = :provider_id"
_DELETE = text("DELETE FROM core.snapshot_historic_gc_marks WHERE provider_id = :provider_id")
_INSERT = text("""INSERT INTO core.snapshot_historic_gc_marks (
    provider_id, object_key, etag, content_length, object_last_modified_utc,
    first_unreachable_utc, last_confirmed_unreachable_utc, last_scan_id) VALUES (
    :provider_id, :object_key, :etag, :content_length, :object_last_modified_utc,
    :first_unreachable_utc, :last_confirmed_unreachable_utc, CAST(:last_scan_id AS uuid))""")
_CLEAR = named_query(
    "publish.historic_gc.clear_referenced",
    "WITH bumped AS (" + _BUMP + " RETURNING provider_id) "
    "DELETE FROM core.snapshot_historic_gc_marks "
    "WHERE provider_id IN (SELECT provider_id FROM bumped) "
    "AND object_key = ANY(CAST(:object_keys AS text[]))",
)


def _time(value: datetime) -> str:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError("invalid GC marks document: naive time")
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def _rows(marks: Mapping[str, HistoricGcMark]) -> list[dict[str, object]]:
    try:
        for key, mark in marks.items():
            if (
                not isinstance(key, str)
                or key != mark.version.rel_key
                or re.match(r"^historic/.+/generations/", key, re.S) is None
                or not isinstance(mark.version.etag, str)
                or any("\x00" in v for v in (key, mark.version.etag, mark.last_scan_id))
                or type(mark.version.size) is not int
                or not 0 <= mark.version.size < 2**63
                or not isinstance(mark.last_scan_id, str)
            ):
                raise ValueError
            UUID(mark.last_scan_id)
            for value in (
                mark.version.last_modified_utc,
                mark.first_unreachable_utc,
                mark.last_confirmed_unreachable_utc,
            ):
                _time(value)
            if mark.last_confirmed_unreachable_utc < mark.first_unreachable_utc:
                raise ValueError
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("invalid GC marks document") from exc
    return [
        dict(
            object_key=k,
            etag=m.version.etag,
            content_length=m.version.size,
            object_last_modified_utc=_time(m.version.last_modified_utc),
            first_unreachable_utc=_time(m.first_unreachable_utc),
            last_confirmed_unreachable_utc=_time(m.last_confirmed_unreachable_utc),
            last_scan_id=m.last_scan_id,
        )
        for k, m in sorted(marks.items())
    ]


def _mark(row: Mapping[str, object]) -> HistoricGcMark:
    return HistoricGcMark(
        StoredObjectVersion(
            str(row["object_key"]),
            str(row["etag"]),
            datetime.fromisoformat(str(row["object_last_modified_utc"])),
            int(str(row["content_length"])),
        ),
        datetime.fromisoformat(str(row["first_unreachable_utc"])),
        datetime.fromisoformat(str(row["last_confirmed_unreachable_utc"])),
        str(row["last_scan_id"]),
    )


class PostgresGcMarks:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self.versions: dict[str, MarksVersion] = {}

    def load(self, provider_id: str) -> dict[str, HistoricGcMark]:
        rows = self.connection.execute(_LOAD, {"provider_id": provider_id}).mappings().all()
        marks = {str(r["object_key"]): _mark(dict(r)) for r in rows if r["object_key"] is not None}
        self.versions[provider_id] = sha256(
            repr(
                [
                    (r["object_key"], r["xmin"], r["cmin"], r["provider_xmin"], r["provider_cmin"])
                    for r in rows
                ]
            ).encode()
        ).hexdigest()
        return marks

    def version(self, provider_id: str) -> MarksVersion:
        return self.versions[provider_id]

    def replace(
        self, provider_id: str, marks: Mapping[str, HistoricGcMark], *, expected: MarksVersion
    ) -> None:
        rows = [{**r, "provider_id": provider_id} for r in _rows(marks)]
        acquire_publication_lane(self.connection, provider_id=provider_id, tier="historic")
        if (
            self.connection.execute(
                _PROVIDER_LOCK, {"provider_id": provider_id}
            ).scalar_one_or_none()
            is None
        ):
            raise ValueError("unknown GC marks provider")
        self.load(provider_id)
        if self.version(provider_id) != expected:
            raise ObjectConflict(provider_id)
        self.connection.execute(text(_BUMP), {"provider_id": provider_id})
        self.connection.execute(_DELETE, {"provider_id": provider_id})
        if rows:
            self.connection.execute(_INSERT, rows)

    def clear(self, provider_id: str, object_keys: Sequence[str]) -> None:
        if object_keys:
            self.connection.execute(
                _CLEAR, {"provider_id": provider_id, "object_keys": sorted(set(object_keys))}
            )


class R2GcMarks:
    def __init__(self, objects: ConditionalObjects) -> None:
        self.objects = objects
        self.versions: dict[str, MarksVersion] = {}

    def _key(self, provider_id: str) -> str:
        return f"historic-gc/{key_part(provider_id)}/marks.json"

    def load(self, provider_id: str) -> dict[str, HistoricGcMark]:
        obj = self.objects.read(self._key(provider_id))
        marks: dict[str, HistoricGcMark] = {}
        if obj is not None:
            try:
                body = json.loads(obj.body)
                if set(body) != {"provider_id", "mutation_id", "marks"}:
                    raise ValueError
                if (
                    body["provider_id"] != provider_id
                    or str(UUID(body["mutation_id"])) != body["mutation_id"]
                ):
                    raise ValueError
                if not isinstance(body["marks"], list):
                    raise ValueError
                for row in body["marks"]:
                    if set(row) != _FIELDS:
                        raise ValueError
                    if type(row["content_length"]) is not int or row["content_length"] < 0:
                        raise ValueError
                    if any(not isinstance(v, str) for k, v in row.items() if k != "content_length"):
                        raise ValueError
                    mark = _mark(row)
                    if (
                        _rows({mark.version.rel_key: mark})[0] != row
                        or mark.version.rel_key in marks
                    ):
                        raise ValueError
                    UUID(mark.last_scan_id)
                    marks[mark.version.rel_key] = mark
            except (KeyError, TypeError, ValueError, AttributeError) as exc:
                raise ValueError("invalid GC marks document") from exc
        self.versions[provider_id] = obj.token if obj else None
        return marks

    def version(self, provider_id: str) -> MarksVersion:
        return self.versions[provider_id]

    def replace(
        self, provider_id: str, marks: Mapping[str, HistoricGcMark], *, expected: MarksVersion
    ) -> None:
        if any(k != m.version.rel_key for k, m in marks.items()):
            raise ValueError("invalid GC marks document")
        self.objects.replace(
            self._key(provider_id),
            dict(provider_id=provider_id, mutation_id=str(uuid4()), marks=_rows(marks)),
            expected=expected,
        )

    def clear(self, provider_id: str, object_keys: Sequence[str]) -> None:
        if not object_keys:
            return
        for attempt in range(2):
            try:
                marks = self.load(provider_id)
                for key in object_keys:
                    marks.pop(key, None)
                self.replace(provider_id, marks, expected=self.version(provider_id))
                return
            except ObjectConflict:
                if attempt:
                    raise


_FIELDS = frozenset(
    (
        "object_key etag content_length object_last_modified_utc "
        "first_unreachable_utc last_confirmed_unreachable_utc last_scan_id"
    ).split()
)


def gc_marks_for(connection: Connection | None, settings: Settings) -> GcMarkStore:
    if settings.LIGHTER_STORAGE.control.gc_marks_backend == "postgres":
        if connection is None:
            raise ValueError("PostgreSQL GC marks require a connection")
        return PostgresGcMarks(connection)
    return R2GcMarks(control_objects(settings))
