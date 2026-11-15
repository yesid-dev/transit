"""One activation proof for the declared Silver alert whole-state copy group."""

import hashlib
import json
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from psycopg import Connection, sql

from transit_ops.history.datasets import HISTORY_DATASETS
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
        if start < floor or end > stamp:
            raise BundleRefused("bundle_coverage", f"{day} [{start}, {end}) T={stamp}")


def closure_statements(
    connection: Connection[Any], specs: Sequence[WindowSpec]
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
            join = sql.SQL(" AND ").join(
                sql.SQL("c.{} = p.{}").format(sql.Identifier(c), sql.Identifier(p))
                for c, p in zip(child_columns, parent_columns, strict=True)
            )
            nonnull = sql.SQL(" AND ").join(
                sql.SQL("c.{} IS NOT NULL").format(sql.Identifier(c)) for c in child_columns
            )
            fks.append((relation, parent, join, nonnull))
    providers = sorted({s.provider_id for s in specs if s.provider_id != "_shared"})
    provider_filter = sql.SQL("provider_id IN ({})").format(
        sql.SQL(",").join(sql.Literal(p) for p in providers)
    )
    definitions = []
    for relation in MEMBERS:
        where = provider_filter
        if relation.endswith("active_periods"):
            where = sql.SQL(
                "EXISTS (SELECT 1 FROM {} a "
                "WHERE a.i3_alert_snapshot_id=t.i3_alert_snapshot_id "
                "AND a.alert_index=t.alert_index)"
            ).format(aliases["silver.i3_alerts"])
        definitions.append(
            sql.SQL("{} AS (SELECT t.* FROM {} t WHERE {})").format(
                aliases[relation], sql.Identifier(*relation.split(".")), where
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
            selections = [
                sql.SQL("EXISTS (SELECT 1 FROM {} c WHERE {})").format(aliases[child], join)
                for child, parent, join, _ in fks
                if parent == relation
            ]
            definitions.append(
                sql.SQL("{} AS (SELECT p.* FROM {} p WHERE {})").format(
                    aliases[relation],
                    sql.Identifier(*relation.split(".")),
                    sql.SQL(" OR ").join(selections) if selections else sql.SQL("false"),
                )
            )
            ready.add(relation)
            pending.remove(relation)
    prefix = sql.SQL("WITH ") + sql.SQL(", ").join(definitions)
    for child, parent, join, nonnull in fks:
        # Periods are copied shared. Validate orphan keys globally even though only
        # requested parents contribute to the recursively selected closure.
        shared = child == "silver.i3_alert_active_periods"
        child_rows = sql.Identifier(*child.split(".")) if shared else aliases[child]
        parent_rows = sql.Identifier(*parent.split(".")) if shared else aliases[parent]
        missing = connection.execute(
            prefix
            + sql.SQL(
                " SELECT EXISTS (SELECT 1 FROM {} c WHERE {} "
                "AND NOT EXISTS (SELECT 1 FROM {} p WHERE {}))"
            ).format(child_rows, nonnull, parent_rows, join)
        ).fetchone()
        if missing == (True,):
            raise BundleRefused("bundle_parent_missing", f"{parent} referenced by {child}")
    return {r: prefix + sql.SQL(" SELECT * FROM {}").format(aliases[r]) for r in CLOSURE_RELATIONS}


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
    with export_group(
        connection,
        tuple(specs),
        tuple(d / "window.csv" for d in directories),
        statement_timeout_s=statement_timeout_s,
        not_after=not_after,
    ) as exported:
        pass  # Release the source snapshot before CPU, upload and readback work.
    results, records, closure = [], [], []
    for item in exported:
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
    )
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
    version = hashlib.sha256(payload).hexdigest()
    path = work_dir / "bundle.json"
    path.write_bytes(payload)
    put_create_only(storage, path, PREFIX + version + ".json", expected=(version, len(payload)))
    return BundleCopy(version, at.isoformat(), tuple(results))
