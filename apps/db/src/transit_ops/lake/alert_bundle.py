"""One activation proof for the declared Silver alert whole-state copy group."""

import hashlib
import json
import re
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
from psycopg import Connection, sql

from transit_ops.history.datasets import HISTORY_DATASETS, TableSource, get_dataset
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import put_create_only
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_copy import TableCopy, _archive, _json_file, _prove
from transit_ops.lake.table_export import WindowSpec, export_group

GROUP = "silver_alert_state"
PREFIX = "archive/v1/bundles/silver_alert_state/"
MEMBERS = tuple(d.dataset_id for d in HISTORY_DATASETS.values() if d.copy_group == GROUP)
CLOSURE_RELATIONS = (
    "raw.i3_alert_snapshots",
    "raw.ingestion_runs",
    "raw.ingestion_objects",
    "core.feed_endpoints",
    "core.providers",
)


class BundleRefused(ValueError):
    def __init__(self, reason: str, detail: object):
        self.reason = reason
        super().__init__(f"{reason}: {detail}")


def validate_coverage(
    stamp: datetime, floor: datetime, days: Sequence[date], timezone: str, as_of: datetime
) -> None:
    if stamp.utcoffset() is None or floor.utcoffset() is None or stamp > as_of:
        raise BundleRefused("bundle_coverage", "invalid snapshot time")
    zone = ZoneInfo(timezone)
    for day in days:
        start = datetime.combine(day, time(), zone).astimezone(UTC)
        end = datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
        if start < floor or end + timedelta(hours=6) > stamp:
            raise BundleRefused("bundle_coverage", f"{day} [{start}, {end}) T={stamp}")


def closure_statements(
    connection: Connection[Any],
    specs: Sequence[WindowSpec],
    foreign_keys: list[dict[str, Any]] | None = None,
) -> dict[str, sql.Composed]:
    """Select the catalog FK closure without temp tables or writes."""
    relations = (*MEMBERS, *CLOSURE_RELATIONS)
    aliases = {r: sql.Identifier(f"bundle_{i}") for i, r in enumerate(relations)}
    fks = []
    for relation in relations:
        rows = connection.execute(
            """
            SELECT pn.nspname || '.' || p.relname,
                   array_agg(ca.attname ORDER BY k.n), array_agg(pa.attname ORDER BY k.n)
            FROM pg_constraint f JOIN pg_class p ON p.oid=f.confrelid
            JOIN pg_namespace pn ON pn.oid=p.relnamespace
            CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY k(c,p,n)
            JOIN pg_attribute ca ON ca.attrelid=f.conrelid AND ca.attnum=k.c
            JOIN pg_attribute pa ON pa.attrelid=f.confrelid AND pa.attnum=k.p
            WHERE f.conrelid=%s::regclass AND f.contype='f'
            GROUP BY f.oid, pn.nspname, p.relname ORDER BY f.oid
        """,
            (relation,),
        ).fetchall()
        for parent, child_columns, parent_columns in rows:
            if parent not in relations:
                raise BundleRefused("bundle_parent_missing", f"unsupported parent {parent}")
            fks.append((relation, parent, tuple(child_columns), tuple(parent_columns)))
            if foreign_keys is not None:
                foreign_keys.append(
                    dict(
                        child=relation,
                        parent=parent,
                        child_columns=list(child_columns),
                        parent_columns=list(parent_columns),
                    )
                )
    providers = sorted({s.provider_id for s in specs if s.provider_id != "_shared"})
    provider_filter = sql.SQL("provider_id IN ({})").format(
        sql.SQL(",").join(sql.Literal(p) for p in providers)
    )
    required: dict[str, set[str]] = {r: set() for r in relations}
    for child, parent, cc, pc in fks:
        required[child].update(cc)
        required[parent].update(pc)
    for relation in relations:
        source = get_dataset(relation).source
        assert isinstance(source, TableSource)
        required[relation].update(source.key_columns)
    definitions = []
    for relation in MEMBERS:
        where: sql.Composable = provider_filter
        if relation.endswith("active_periods"):
            where = sql.SQL(
                "EXISTS (SELECT 1 FROM {} a "
                "WHERE a.i3_alert_snapshot_id=t.i3_alert_snapshot_id "
                "AND a.alert_index=t.alert_index)"
            ).format(aliases["silver.i3_alerts"])
        definitions.append(
            sql.SQL("{} AS (SELECT {} FROM {} t WHERE {})").format(
                aliases[relation],
                sql.SQL(", ").join(sql.Identifier("t", c) for c in sorted(required[relation])),
                sql.Identifier(*relation.split(".")),
                where,
            )
        )
    ready, pending = set(MEMBERS), set(CLOSURE_RELATIONS)
    while pending:
        following = sorted(
            r for r in pending if all(child in ready for child, parent, _, _ in fks if parent == r)
        )
        if not following:
            raise BundleRefused("bundle_parent_missing", f"FK cycle {sorted(pending)}")
        for relation in following:
            references = [(child, cc, pc) for child, parent, cc, pc in fks if parent == relation]
            shapes = {pc for _, _, pc in references}
            if len(shapes) > 1:
                raise BundleRefused(
                    "bundle_parent_missing", f"incompatible referenced keys: {relation}"
                )
            where = sql.SQL("false")
            if references:
                parent_columns = references[0][2]
                selections = [
                    sql.SQL("SELECT {} FROM {} c").format(
                        sql.SQL(", ").join(sql.Identifier("c", c) for c in cc), aliases[child]
                    )
                    for child, cc, _ in references
                ]
                where = sql.SQL("{} = ANY (ARRAY({}))").format(
                    sql.SQL(", ").join(sql.Identifier("p", c) for c in parent_columns),
                    sql.SQL(" UNION ").join(selections),
                )
            definitions.append(
                sql.SQL("{} AS (SELECT {} FROM {} p WHERE {})").format(
                    aliases[relation],
                    sql.SQL(", ").join(sql.Identifier("p", c) for c in sorted(required[relation])),
                    sql.Identifier(*relation.split(".")),
                    where,
                )
            )
            ready.add(relation)
            pending.remove(relation)
    prefix = sql.SQL("WITH ") + sql.SQL(", ").join(definitions)
    statements = {}
    for relation in CLOSURE_RELATIONS:
        source = get_dataset(relation).source
        assert isinstance(source, TableSource)
        if len(source.key_columns) != 1:
            raise BundleRefused("bundle_parent_missing", f"unsupported parent key {relation}")
        key = sql.Identifier(source.key_columns[0])
        statements[relation] = prefix + sql.SQL(
            " SELECT p.* FROM {} p WHERE p.{} = ANY (ARRAY(SELECT {} FROM {}))"
        ).format(sql.Identifier(*relation.split(".")), key, key, aliases[relation])
    return statements


@contextmanager
def bounded_connection(
    work_dir: Path, *, memory_limit_mb: int = 256, temp_max_mb: int = 1024
) -> Iterator[duckdb.DuckDBPyConnection]:
    if any(type(v) is not int or v <= 0 for v in (memory_limit_mb, temp_max_mb)):
        raise ValueError("positive memory and temp limits required")
    work_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".proof-", dir=work_dir) as temporary:
        with duckdb.connect(
            config={
                "threads": 1,
                "memory_limit": f"{memory_limit_mb}MB",
                "temp_directory": temporary,
                "max_temp_directory_size": f"{temp_max_mb}MB",
                "preserve_insertion_order": False,
            }
        ) as conn:
            conn.execute("SET TimeZone='UTC'")
            yield conn


def prove_parent_keys(
    files: dict[str, list[Path]],
    foreign_keys: Sequence[dict[str, Any]],
    *,
    work_dir: Path,
    memory_limit_mb: int = 256,
    temp_max_mb: int = 1024,
) -> None:
    """Join projected keys only; payload bytes never enter the orphan proof."""
    with bounded_connection(
        work_dir, memory_limit_mb=memory_limit_mb, temp_max_mb=temp_max_mb
    ) as conn:
        views = {}
        for index, (relation, paths) in enumerate(files.items()):
            views[relation] = f"bundle_{index}"
            conn.read_parquet([str(p) for p in paths], hive_partitioning=False).create_view(
                views[relation]
            )

        def quoted(c: str) -> str:
            return '"' + c.replace('"', '""') + '"'

        for fk in foreign_keys:
            child, parent = fk["child"], fk["parent"]
            cc, pc = fk["child_columns"], fk["parent_columns"]
            child_keys = ", ".join(quoted(c) for c in cc)
            parent_keys = ", ".join(quoted(c) for c in pc)
            nonnull = " AND ".join(f"c.{quoted(c)} IS NOT NULL" for c in cc)
            join = " AND ".join(f"c.{quoted(c)}=p.{quoted(p)}" for c, p in zip(cc, pc, strict=True))
            missing = conn.execute(
                f"SELECT count(*) FROM (SELECT {child_keys} FROM {views[child]}) c "
                f"ANTI JOIN (SELECT {parent_keys} FROM {views[parent]}) p ON {join} WHERE {nonnull}"
            ).fetchone()
            if missing and missing[0]:
                raise BundleRefused("bundle_parent_missing", f"{parent} referenced by {child}")


def validate_members(specs: Sequence[WindowSpec]) -> None:
    identities = {(s.dataset_id, s.provider_id) for s in specs}
    providers = {s.provider_id for s in specs if s.dataset_id != "silver.i3_alert_active_periods"}
    expected = {
        (r, p)
        for r in MEMBERS
        for p in (("_shared",) if r == "silver.i3_alert_active_periods" else sorted(providers))
    }
    missing = expected - identities
    missing_relations = set(MEMBERS) - {s.dataset_id for s in specs}
    if (
        not providers
        or missing
        or missing_relations
        or identities != expected
        or len(identities) != len(specs)
        or len({s.window_key for s in specs}) != 1
    ):
        raise ValueError(f"incomplete {GROUP}: {sorted(missing_relations)} {sorted(missing)}")


@dataclass(frozen=True)
class BundleCopy:
    version: str
    snapshot_at_utc: str
    members: tuple[TableCopy, ...]


def copy_group(
    connection: Connection[Any],
    storage: BronzeStorage,
    specs: Sequence[WindowSpec],
    *,
    work_dir: Path,
    copied_by: str,
    statement_timeout_s: int,
    not_after: datetime | None = None,
) -> BundleCopy:
    """Only the last create-only write activates members; partial copies are inert."""
    validate_members(specs)
    if not re.fullmatch("[0-9a-f]{40}", copied_by):
        raise ValueError("copied_by must be a 40-hex commit")
    if (
        not work_dir.is_dir()
        or any(work_dir.iterdir())
        or any(c in str(work_dir) for c in "*?[]{}")
    ):
        raise ValueError("work_dir must be empty and contain no glob characters")
    directories = tuple(work_dir / str(i) for i in range(len(specs)))
    for directory in directories:
        directory.mkdir()
    foreign_keys: list[dict[str, Any]] = []
    with export_group(
        connection,
        tuple(specs),
        tuple(d / "window.csv" for d in directories),
        statement_timeout_s=statement_timeout_s,
        not_after=not_after,
        foreign_keys=foreign_keys,
    ) as exported:
        pass  # Release the source snapshot before CPU, upload and readback work.
    from transit_ops.lake.table_export import require_member_space

    prepared = []
    files: dict[str, list[Path]] = {}
    for item in exported:
        require_member_space(work_dir)
        directory = item.csv_path.parent
        temporary = directory / "temporary"
        temporary.mkdir()
        written = write_window(
            item.csv_path,
            item.schema,
            directory / "window.parquet",
            metadata={k: str(v) for k, v in asdict(item.spec).items()},
            temp_dir=temporary,
        )
        proof = _prove(item, written.path, written, temporary)
        _json_file(directory / "proof.json", asdict(proof))
        prepared.append((item, written, directory, temporary))
        files.setdefault(item.spec.dataset_id, []).append(written.path)
    prove_parent_keys(files, foreign_keys, work_dir=work_dir)
    results, records, closure = [], [], []
    for item, written, directory, temporary in prepared:
        if item.spec.dataset_id in MEMBERS:
            result = _archive(storage, item, written, directory, temporary, copied_by)
            results.append(result)
            records.append(json.loads(storage.read_bytes(str(result.proof_key))))
        else:
            from transit_ops.lake.parquet_verify import read_back

            key = f"archive/v1/bundle-closure/{item.spec.dataset_id}/{written.sha256}.parquet"
            put_create_only(
                storage, written.path, key, expected=(written.sha256, written.byte_size)
            )
            downloaded = temporary / "readback.parquet"
            read_back(storage, key, downloaded)
            checked = _prove(item, downloaded, written, temporary)
            closure.append(
                dict(
                    dataset_id=item.spec.dataset_id,
                    provider_id="_shared",
                    key=key,
                    object_sha256=written.sha256,
                    object_bytes=written.byte_size,
                    rows=checked.rows,
                    proof=asdict(checked),
                )
            )
    at = exported[0].snapshot_at_utc
    document = dict(
        format_version=2,
        kind=GROUP,
        snapshot_at_utc=at.isoformat(),
        coverage_from_utc=(at - timedelta(days=30)).isoformat(),
        members=records,
        closure=closure,
        foreign_keys=foreign_keys,
    )
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    version = hashlib.sha256(payload).hexdigest()
    path = work_dir / "bundle.json"
    path.write_bytes(payload)
    put_create_only(storage, path, PREFIX + version + ".json", expected=(version, len(payload)))
    return BundleCopy(version, at.isoformat(), tuple(results))
