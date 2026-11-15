"""Verified immutable cuts of committed local live records.

Keys: live/v1/segments/{URL-quoted provider}/{first}-{last}/{content SHA256}/.
Ranges are inclusive local record/application sequences. Content identity binds provider,
range, version, ordered table schemas, row counts and canonical row digests.
Pending identity commits before upload; completion follows every readback.
"""

import hashlib
import json
import re
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import quote

import duckdb

from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import ObjectKeyTaken, object_digest, put_create_only
from transit_ops.live import facts
from transit_ops.live.captures import Frame
from transit_ops.live.compare import canonical_row
from transit_ops.live.local_file import LocalFile

# Add the public trip-delay reader here when LS3.5b2 lands.
FACT_TABLES: tuple[tuple[str, str, Callable[[LocalFile], Frame]], ...] = (
    ("fact_vehicle_snapshot", "vehicle_positions", facts.read_vehicle_facts),
)
RECORD_TABLES = ("polls", "captures", "processing")


class SegmentInvalid(RuntimeError):
    """Segment identity, schema, rows or object bytes disagree."""


@dataclass(frozen=True)
class Segment:
    provider_id: str
    first_seq: int
    last_seq: int
    content_sha256: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.provider_id, str)
            or not self.provider_id
            or self.provider_id in (".", "..")
            or type(self.first_seq) is not int
            or type(self.last_seq) is not int
            or not 0 < self.first_seq <= self.last_seq < 2**63
            or not isinstance(self.content_sha256, str)
            or re.fullmatch("[0-9a-f]{64}", self.content_sha256) is None
        ):
            raise SegmentInvalid("segment_identity_invalid")

    @property
    def prefix(self) -> str:
        return (
            f"live/v1/segments/{quote(self.provider_id, safe='')}/"
            f"{self.first_seq}-{self.last_seq}/{self.content_sha256}"
        )


def _json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _hash(path: Path) -> tuple[str, int]:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest(), path.stat().st_size


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _proof(conn: duckdb.DuckDBPyConnection, query: str) -> tuple[int, str]:
    schema = conn.execute("DESCRIBE " + query).fetchall()
    columns = ", ".join(
        f"CAST({_q(r[0])} AS TIMESTAMP) AS {_q(r[0])}"
        if r[1] == "TIMESTAMP WITH TIME ZONE"
        else _q(r[0])
        for r in schema
    )
    cursor = conn.execute(f"SELECT {columns} FROM ({query})")
    digest, count = hashlib.sha256(), 0
    while rows := cursor.fetchmany(1024):
        for row in rows:
            values = tuple(
                v.replace(tzinfo=UTC) if isinstance(v, datetime) and v.tzinfo is None else v
                for v in row
            )
            digest.update(canonical_row(values).encode("utf-8") + b"\n")
            count += 1
    return count, digest.hexdigest()


def _prepare_facts(local: LocalFile) -> None:
    conn = local.connection
    for table, _, reader in FACT_TABLES:
        frame = reader(local)
        conn.execute(
            f"CREATE OR REPLACE TEMP TABLE _segment_{table} AS SELECT * FROM {table} WHERE false"
        )
        if frame.rows:
            columns = ", ".join(_q(n) for n in frame.columns)
            placeholders = ", ".join("?" for _ in frame.columns)
            conn.executemany(
                f"INSERT INTO _segment_{table} ({columns}) VALUES ({placeholders})", frame.rows
            )
    for provider, endpoint, capture, digest in conn.execute(
        "SELECT provider_id, endpoint_key, capture_row_id, application_sha256 "
        "FROM fact_processing ORDER BY provider_id, endpoint_key, capture_row_id"
    ).fetchall():
        if conn.execute("SELECT provider_id FROM meta").fetchone() != (provider,):
            raise SegmentInvalid("fact_provider_mismatch")
        previous = conn.execute(
            "SELECT application_sha256 FROM segment_fact_members "
            "WHERE provider_id=? AND endpoint_key=? AND capture_row_id=?",
            [provider, endpoint, capture],
        ).fetchone()
        if previous and previous != (digest,):
            raise SegmentInvalid("fact_identity_changed")
        if previous is None:
            conn.execute(
                "INSERT INTO segment_fact_members VALUES (?, ?, ?, ?, ?)",
                [provider, endpoint, capture, digest, local.next_segment_sequence()],
            )


def _queries(first: int, last: int) -> dict[str, str]:
    span = f"segment_seq BETWEEN {first} AND {last}"
    result = {table: f"SELECT * FROM {table} WHERE {span}" for table in RECORD_TABLES}
    result["fact_processing"] = (
        "SELECT f.* FROM fact_processing f JOIN segment_fact_members m "
        "USING(provider_id, endpoint_key, capture_row_id, application_sha256) "
        f"WHERE m.{span}"
    )
    for table, endpoint, _ in FACT_TABLES:
        result[table] = (
            f"SELECT f.* FROM _segment_{table} f JOIN segment_fact_members m "
            "ON f.provider_id=m.provider_id "
            "AND f.realtime_snapshot_id=m.capture_row_id "
            f"WHERE m.endpoint_key='{endpoint}' AND m.{span}"
        )
    return result


def _copy(local: LocalFile, directory: Path, first: int, last: int) -> list[dict[str, Any]]:
    conn = local.connection
    proofs = []
    for table, query in _queries(first, last).items():
        schema = [
            (r[0], "TIMESTAMP WITH TIME ZONE" if r[1] == "TIMESTAMP" else r[1])
            for r in conn.execute("DESCRIBE " + query).fetchall()
        ]
        columns = ", ".join(f"CAST({_q(n)} AS {t}) AS {_q(n)}" for n, t in schema)
        ordered = f"SELECT {columns} FROM ({query}) ORDER BY ALL"
        count, digest = _proof(conn, ordered)
        path = directory / f"{table}.parquet"
        conn.execute(
            f"COPY ({ordered}) TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 2048)",
            [str(path)],
        )
        proof = dict(
            table=table,
            schema=schema,
            rows=count,
            row_sha256=digest,
            object_sha256=_hash(path)[0],
            byte_size=path.stat().st_size,
        )
        _verify(conn, path, proof)
        proofs.append(proof)
    return proofs


def _verify(conn: duckdb.DuckDBPyConnection, path: Path, proof: dict[str, Any]) -> None:
    if _hash(path) != (proof["object_sha256"], proof["byte_size"]):
        raise SegmentInvalid("object_digest_mismatch")
    schema = conn.execute("DESCRIBE SELECT * FROM read_parquet(?)", [str(path)]).fetchall()
    if [(r[0], r[1]) for r in schema] != [tuple(r) for r in proof["schema"]]:
        raise SegmentInvalid("schema_mismatch")
    literal = "'" + str(path).replace("'", "''") + "'"
    columns = ", ".join(f"CAST({_q(n)} AS {t}) AS {_q(n)}" for n, t in proof["schema"])
    if _proof(conn, f"SELECT {columns} FROM read_parquet({literal}) ORDER BY ALL") != (
        proof["rows"],
        proof["row_sha256"],
    ):
        raise SegmentInvalid("row_fingerprint_mismatch")


def _identity(provider: str, first: int, last: int, proofs: list[dict[str, Any]]) -> Segment:
    content = [{k: p[k] for k in ("table", "schema", "rows", "row_sha256")} for p in proofs]
    digest = hashlib.sha256(
        _json(dict(provider=provider, first=first, last=last, tables=content, version=1))
    ).hexdigest()
    return Segment(provider, first, last, digest)


def export_segment(local: LocalFile, storage: BronzeStorage) -> Segment | None:
    """Export oldest pending cut, otherwise all committed unexported records.

    Requires the single owner's idle connection. Newer commits cannot change a
    pending cut. Earlier LocalFile versions require rebuild from retained evidence.
    """
    local.require_committed()
    with TemporaryDirectory(prefix="transit-segment-") as temporary:
        directory = Path(temporary)
        with local.transaction() as conn:
            _prepare_facts(local)
            pending = conn.execute(
                "SELECT first_seq, last_seq, manifest FROM segment_exports "
                "WHERE NOT completed ORDER BY first_seq"
            ).fetchone()
            first = int(
                conn.execute(
                    "SELECT coalesce(max(last_seq), 0)+1 FROM segment_exports WHERE completed"
                ).fetchall()[0][0]
            )
            last = int(conn.execute("SELECT next_seq-1 FROM segment_clock").fetchall()[0][0])
            if pending:
                first, last = pending[:2]
            if first > last:
                return None
            proofs = _copy(local, directory, first, last)
            provider = str(conn.execute("SELECT provider_id FROM meta").fetchall()[0][0])
            segment = _identity(provider, first, last, proofs)
            manifest = _json(
                dict(
                    version=1,
                    provider=provider,
                    first=first,
                    last=last,
                    content_sha256=segment.content_sha256,
                    tables=proofs,
                )
            )
            if pending and pending[2] != manifest.decode("utf-8"):
                raise SegmentInvalid("pending_segment_identity_changed")
            if not pending:
                conn.execute(
                    "INSERT INTO segment_exports VALUES (?, ?, ?, false)",
                    [first, last, manifest.decode("utf-8")],
                )
        for proof in proofs:
            _put(
                storage,
                directory / f"{proof['table']}.parquet",
                f"{segment.prefix}/{proof['table']}.parquet",
            )
        path = directory / "manifest.json"
        path.write_bytes(manifest)
        _put(storage, path, f"{segment.prefix}/manifest.json")
        _read_segment(local, storage, segment, collect=False)
        with local.transaction() as conn:
            conn.execute("UPDATE segment_exports SET completed=true WHERE first_seq=?", [first])
        return segment


def _put(storage: BronzeStorage, path: Path, key: str) -> None:
    expected = _hash(path)
    try:
        put_create_only(storage, path, key, expected=expected)
    except ObjectKeyTaken as exc:
        raise SegmentInvalid(f"object_identity_conflict: {key}") from exc
    if object_digest(storage, key) != expected:
        raise SegmentInvalid(f"object_readback_mismatch: {key}")


def read_segment(local: LocalFile, storage: BronzeStorage, segment: Segment) -> dict[str, Frame]:
    """Read verified typed frames; this convenience read materializes the result.

    Export readback streams rows instead. Fact input uses the existing public
    fact readers, which currently materialize their frames before bounded COPY.
    """
    return _read_segment(local, storage, segment, collect=True)


def _read_segment(
    local: LocalFile, storage: BronzeStorage, segment: Segment, *, collect: bool
) -> dict[str, Frame]:
    local.require_committed()
    conn = local.connection
    if conn.execute("SELECT provider_id FROM meta").fetchone() != (segment.provider_id,):
        raise SegmentInvalid("segment_provider_mismatch")
    try:
        manifest = json.loads(storage.read_bytes(f"{segment.prefix}/manifest.json"))
        proofs = manifest["tables"]
        valid = (
            manifest["version"] == 1
            and manifest["content_sha256"] == segment.content_sha256
            and _identity(manifest["provider"], manifest["first"], manifest["last"], proofs)
            == segment
            and [p["table"] for p in proofs] == list(_queries(1, 1))
        )
    except (ValueError, TypeError, KeyError) as exc:
        raise SegmentInvalid("segment_manifest_invalid") from exc
    if not valid:
        raise SegmentInvalid("segment_identity_mismatch")
    frames = {}
    with TemporaryDirectory(prefix="transit-segment-read-") as temporary:
        for proof in proofs:
            table = proof["table"]
            path = Path(temporary) / f"{table}.parquet"
            with storage.open_stream(f"{segment.prefix}/{table}.parquet") as source:
                with path.open("wb") as target:
                    shutil.copyfileobj(source, target, length=64 * 1024)
            _verify(conn, path, proof)
            if collect:
                columns = ", ".join(
                    f"CAST({_q(n)} AS TIMESTAMP) AS {_q(n)}"
                    if t == "TIMESTAMP WITH TIME ZONE"
                    else _q(n)
                    for n, t in proof["schema"]
                )
                rows = conn.execute(
                    f"SELECT {columns} FROM read_parquet(?) ORDER BY ALL", [str(path)]
                ).fetchall()
                frames[table] = Frame(
                    table,
                    tuple(n for n, _ in proof["schema"]),
                    tuple(
                        tuple(v.replace(tzinfo=UTC) if isinstance(v, datetime) else v for v in row)
                        for row in rows
                    ),
                )
    return frames
