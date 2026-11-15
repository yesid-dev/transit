"""Shadow publication confined to create-only shadow/v1 objects."""

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from sqlalchemy import text

from transit_ops.batch.build import BuildRequest, FamilyBuilder, FamilyOutput, InputNeed, TableRows
from transit_ops.batch.checkpoints import AcceptedBuild, Checkpoint, safe_component, table_digest
from transit_ops.batch.engine import BatchInput, BatchSession, open_batch_session
from transit_ops.batch.private_area import PrivateArea
from transit_ops.batch.run import OutputRefused, key_matches
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import ObjectKeyTaken, object_digest, put_create_only
from transit_ops.sql_registry import named_query


class ShadowRefused(ValueError):
    pass


def shadow_key(family_id: str, provider_id: str, local_date: date, build_id: str, name: str) -> str:
    try:
        safe_component(family_id)
        safe_component(provider_id)
        safe_component(build_id, digest=True)
        key_matches(name, ())
        if ":" in name or not (
            name in {"manifest.json", "outputs.json", "accepted.json"}
            or name.startswith("bodies/")
            or re.fullmatch(r"tables/[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.parquet", name)
        ):
            raise ValueError(f"invalid shadow file: {name}")
    except (ValueError, OutputRefused) as error:
        raise ShadowRefused(str(error)) from error
    return f"shadow/v1/{family_id}/{provider_id}/{local_date}/{build_id}/{name}"


@dataclass(frozen=True)
class ShadowObject:
    key: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ShadowReceipt:
    objects: tuple[ShadowObject, ...]


def _validate_staged(checkpoint: Checkpoint, files: dict[str, Path], area: Path) -> None:
    manifest = checkpoint.manifest
    if files["manifest.json"].read_bytes() != manifest.canonical_json():
        raise ShadowRefused("staged manifest differs from checkpoint")
    outputs = json.loads(files["outputs.json"].read_bytes())
    for key, expected in outputs["bodies"].items():
        if hashlib.sha256(files[f"bodies/{key}"].read_bytes()).hexdigest() != expected:
            raise ShadowRefused(f"{key}: staged body differs from checkpoint")
    for relation, expected in outputs["tables"].items():
        _validate_table(files[f"tables/{relation}.parquet"], relation, expected, area)
    if "accepted.json" in files:
        data = json.loads(files["accepted.json"].read_bytes())
        accepted = AcceptedBuild(**{**data, "local_date": date.fromisoformat(data["local_date"])})
        if (
            accepted.build_id,
            accepted.family_id,
            accepted.provider_id,
            accepted.local_date,
            accepted.engine,
            accepted.revision,
            accepted.output_digests,
        ) != (
            checkpoint.build_id,
            manifest.family_id,
            manifest.provider_id,
            checkpoint.local_date,
            manifest.engine,
            manifest.revision,
            outputs,
        ) or not re.fullmatch(r"[a-f0-9]{64}", accepted.report_sha256):
            raise ShadowRefused("staged acceptance differs from checkpoint")


def _validate_table(path: Path, relation: str, expected: dict[str, Any], area: Path) -> None:
    try:
        key = tuple(expected["key"])
        order = ", ".join('"' + name.replace('"', '""') + '"' for name in key)
        with open_batch_session((BatchInput(relation, (path,)),), workdir=area) as session:
            result = session.execute(
                named_query(
                    f"batch.shadow.{relation}.verify", f"SELECT * FROM {relation} ORDER BY {order}"
                )
            )
            table = TableRows(relation, result.columns, key, tuple(map(tuple, result)))
        if (
            list(table.columns) != expected["columns"]
            or len(table.rows) != expected["rows"]
            or table_digest(table) != expected["sha256"]
        ):
            raise ShadowRefused(f"{relation}: staged table differs from checkpoint")
    except Exception as error:
        if isinstance(error, ShadowRefused):
            raise
        raise ShadowRefused(f"{relation}: invalid staged table: {error}") from error


def _stage(checkpoint: Checkpoint, tables_dir: Path, area: Path) -> dict[str, Path]:
    manifest = checkpoint.manifest
    outputs = json.loads((checkpoint.path / "outputs.json").read_bytes())
    files = {
        "manifest.json": checkpoint.path / "manifest.json",
        "outputs.json": checkpoint.path / "outputs.json",
    }
    for key in outputs["bodies"]:
        files[f"bodies/{key}"] = checkpoint.path / "bodies" / key
    for relation in outputs["tables"]:
        files[f"tables/{relation}.parquet"] = tables_dir / f"{relation}.parquet"
    if (checkpoint.path / "accepted.json").exists():
        files["accepted.json"] = checkpoint.path / "accepted.json"
    staged = {}
    for name, path in files.items():
        shadow_key(
            manifest.family_id,
            manifest.provider_id,
            checkpoint.local_date,
            checkpoint.build_id,
            name,
        )
        if not path.is_file() or path.is_symlink():
            raise ShadowRefused(f"missing or linked shadow file: {path}")
        destination = area / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with path.open("rb") as source, destination.open("xb") as target:
            shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
        staged[name] = destination
    return staged


def write_shadow(
    checkpoint: Checkpoint, storage: BronzeStorage, *, tables_dir: Path
) -> ShadowReceipt:
    manifest = checkpoint.manifest
    objects = []
    with PrivateArea(tables_dir.parent) as area:
        try:
            files = _stage(checkpoint, tables_dir, area)
            _validate_staged(checkpoint, files, area)
        except (ValueError, KeyError, TypeError) as error:
            raise ShadowRefused(f"invalid staged checkpoint: {error}") from error
        for name in sorted(files, key=lambda n: (n == "accepted.json", n)):
            key = shadow_key(
                manifest.family_id,
                manifest.provider_id,
                checkpoint.local_date,
                checkpoint.build_id,
                name,
            )
            source = files[name]
            with source.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            size = source.stat().st_size
            if storage.exists(key):
                if object_digest(storage, key) != (digest, size):
                    raise ObjectKeyTaken(f"Object key holds different bytes: {key}")
            else:
                put_create_only(storage, source, key, expected=(digest, size))
            objects.append(ShadowObject(key, size, digest))
    return ShadowReceipt(tuple(objects))


def _export_projection(table: TableRows) -> str:
    replacements = []
    for i, name in enumerate(table.columns):
        if any(isinstance(row[i], str) for row in table.rows):
            quoted = '"' + name.replace('"', '""') + '"'
            replacements.append(f"CAST({quoted} AS VARCHAR) AS {quoted}")
    return "* REPLACE (" + ", ".join(replacements) + ")" if replacements else "*"


class ShadowBuilder:
    """Export original session tables, including empty typed tables, before it closes."""

    def __init__(self, builder: FamilyBuilder, tables_dir: Path):
        self.builder = builder
        self.family_id = builder.family_id
        self.tables = builder.tables
        self.published_keys = builder.published_keys
        self.variants = builder.variants
        self.tables_dir = tables_dir

    def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
        return self.builder.inputs(request)

    def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
        output = self.builder.build(session, request)
        for relation, table in output.tables.items():
            if not re.fullmatch(r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*", relation):
                raise ShadowRefused(f"invalid table: {relation}")
            if any(not re.fullmatch(r"[a-z_][a-z0-9_]*", col) for col in table.key):
                raise ShadowRefused(f"invalid table key: {relation}")
            workdir = Path(
                str(
                    session.execute(
                        named_query(
                            "batch.shadow.workdir", "SELECT current_setting('temp_directory')"
                        )
                    ).scalar_one()
                )
            ).parent
            path = workdir / f"{relation}.parquet"
            # Some families expose PostgreSQL exact numeric/JSON text in TableRows.
            # Export that comparison representation instead of its native SQL value.
            projection = _export_projection(table)
            session.execute(
                text(
                    "-- q:batch.shadow.export\n"
                    + f"COPY (SELECT {projection} FROM {relation} ORDER BY {', '.join(table.key)}) "
                    "TO :path (FORMAT PARQUET)",
                ),
                {"path": str(path)},
            )
            shutil.copyfile(path, self.tables_dir / path.name)
        return output
