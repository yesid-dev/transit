"""Create-only local checkpoints and exact replay acceptance."""

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path

from transit_ops.batch.build import FamilyOutput, TableRows
from transit_ops.batch.compare import (
    _DERIVED_FLAGS,
    _identity,
    _project,
    _warm_flag,
    compare_tables,
)
from transit_ops.batch.manifest import BuildManifest, ManifestInput
from transit_ops.batch.private_area import PrivateArea
from transit_ops.batch.replay_report import FamilyReplay, _value, family_payload
from transit_ops.batch.run import BuildResult, key_matches
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.objects import ObjectKeyTaken, put_create_only


class CheckpointConflict(ValueError):
    pass


class NotAccepted(ValueError):
    pass


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def _encoded(value: object) -> object:
    if isinstance(value, type):
        return {"type": f"{value.__module__}.{value.__qualname__}"}
    if isinstance(value, frozenset):
        return sorted((_encoded(v) for v in value), key=lambda v: canonical(v))
    if isinstance(value, tuple):
        return [_encoded(v) for v in value]
    return _value(value)


def table_digest(rows: TableRows) -> str:
    """Hash the comparator's shape, typed values, runtime masks and readiness flag."""
    if compare_tables(rows, rows):
        raise ValueError(f"{rows.relation}: invalid comparison shape")
    columns, projected = _project(rows)
    digest = hashlib.sha256(canonical([rows.relation, columns, rows.key]))
    for original, row in zip(rows.rows, projected, strict=True):
        flags = []
        for _, (built, period) in _DERIVED_FLAGS.get(rows.relation, ()):
            flags.append(
                _warm_flag(
                    original[columns.index(built)],
                    original[columns.index(period)],
                )
            )
        digest.update(canonical([_encoded(_identity(row)), flags]) + b"\n")
    return digest.hexdigest()


def safe_component(value: str, *, digest: bool = False) -> str:
    pattern = r"[0-9a-f]{64}" if digest else r"[a-z0-9_-]+"
    if not re.fullmatch(pattern, value):
        raise ValueError(f"invalid checkpoint identifier: {value!r}")
    return value


def output_digests(output: FamilyOutput) -> dict[str, object]:
    """Bind replay and checkpoint evidence to the same typed output and table shape."""
    return {
        "tables": {
            name: {
                "rows": len(t.rows),
                "sha256": table_digest(t),
                "columns": list(t.columns),
                "key": list(t.key),
            }
            for name, t in output.tables.items()
        },
        "bodies": {key: hashlib.sha256(body).hexdigest() for key, body in output.bodies.items()},
    }


def _write(path: Path, body: bytes, *, root: Path | None = None) -> None:
    root = path.parent if root is None else root
    if path.exists():
        if path.read_bytes() != body:
            raise CheckpointConflict(f"checkpoint holds different bytes: {path}")
        return
    with PrivateArea(root) as area:
        source = area / "object"
        source.write_bytes(body)
        try:
            put_create_only(
                LocalBronzeStorage("local", root), source, path.relative_to(root).as_posix()
            )
        except ObjectKeyTaken as error:
            raise CheckpointConflict(str(error)) from error


@dataclass(frozen=True)
class Checkpoint:
    path: Path
    manifest: BuildManifest
    local_date: date

    @property
    def build_id(self) -> str:
        return self.manifest.build_id


class CheckpointStore:
    def __init__(self, root: Path):
        self.root = root
        # Provision the local store; its adapter owns durability strictly below this root.
        root.mkdir(parents=True, exist_ok=True)

    def _path(self, family: str, provider: str, day: date, build_id: str) -> Path:
        return (
            self.root
            / safe_component(family)
            / safe_component(provider)
            / day.isoformat()
            / safe_component(build_id, digest=True)
        )

    def record(self, result: BuildResult, local_date: date) -> Checkpoint:
        manifest = result.manifest
        if manifest.local_dates != (local_date,):
            raise ValueError("checkpoint requires exactly its one local_date")
        path = self._path(manifest.family_id, manifest.provider_id, local_date, manifest.build_id)
        files = {"manifest.json": manifest.canonical_json()}
        outputs = output_digests(result.output)
        for key, body in result.output.bodies.items():
            key_matches(key, ())
            if ":" in key:
                raise ValueError(f"invalid body key: {key}")
            files[f"bodies/{key}"] = body
        files["outputs.json"] = canonical(outputs)
        # Check all occupied files before adding anything to an existing checkpoint.
        for name, body in files.items():
            target = path / name
            if target.exists() and target.read_bytes() != body:
                raise CheckpointConflict(f"checkpoint holds different bytes: {target}")
        for name, body in files.items():
            _write(path / name, body, root=self.root)
        return Checkpoint(path, manifest, local_date)

    def find(
        self, family_id: str, provider_id: str, local_date: date, build_id: str
    ) -> Checkpoint | None:
        path = self._path(family_id, provider_id, local_date, build_id)
        if not (path / "manifest.json").exists():
            return None
        data = json.loads((path / "manifest.json").read_bytes())
        provenance = {name: data.pop(name) for name in ("engine", "engine_version", "revision")}
        data["as_of_utc"] = datetime.fromisoformat(data["as_of_utc"])
        data["local_dates"] = tuple(date.fromisoformat(d) for d in data["local_dates"])
        data["inputs"] = tuple(ManifestInput(**item) for item in data["inputs"])
        manifest = BuildManifest(**data)
        for name, value in provenance.items():
            object.__setattr__(manifest, name, value)
        if (
            manifest.build_id != build_id
            or manifest.local_dates != (local_date,)
            or manifest.family_id != family_id
            or manifest.provider_id != provider_id
        ):
            raise CheckpointConflict(f"invalid checkpoint manifest: {path}")
        if not (path / "outputs.json").is_file():
            return None
        return Checkpoint(path, manifest, local_date)


@dataclass(frozen=True)
class AcceptedBuild:
    build_id: str
    family_id: str
    provider_id: str
    local_date: date
    engine: str
    revision: int
    output_digests: dict[str, object]
    report_sha256: str


def accept(checkpoint: Checkpoint, replay: FamilyReplay) -> AcceptedBuild:
    manifest = checkpoint.manifest
    if (
        replay.status not in {"identical", "identical_after_normalization"}
        or replay.build_id != checkpoint.build_id
        or replay.family_id != manifest.family_id
        or any(d.difference_class != "representation" for d in replay.differences)
        or replay.difference_counts.get("value", 0)
        or replay.difference_count != replay.difference_counts.get("representation", 0)
        or (replay.status == "identical" and replay.difference_count != 0)
        or (replay.status == "identical_after_normalization" and replay.difference_count == 0)
        or replay.code_commit != manifest.code_commit
        or replay.engine_version != manifest.engine_version
    ):
        raise NotAccepted("requires an identical replay of this same family build")
    outputs = json.loads((checkpoint.path / "outputs.json").read_bytes())
    if replay.output_digests is None or replay.output_digests != outputs:
        raise NotAccepted("replayed output digests differ from checkpoint")
    if (
        replay.duckdb_rows != {n: v["rows"] for n, v in outputs["tables"].items()}
        or replay.postgres_rows != replay.duckdb_rows
    ):
        raise NotAccepted("replay row counts differ from checkpoint")
    accepted = AcceptedBuild(
        checkpoint.build_id,
        manifest.family_id,
        manifest.provider_id,
        checkpoint.local_date,
        manifest.engine,
        manifest.revision,
        outputs,
        hashlib.sha256(canonical(family_payload(replay))).hexdigest(),
    )
    data = asdict(accepted)
    data["local_date"] = accepted.local_date.isoformat()
    _write(checkpoint.path / "accepted.json", canonical(data))
    return accepted
