"""Resolve replay windows from recorded proofs, then materialize their exact rows.

Downloads use PrivateArea's R22c cleanup boundary, including its documented
Windows nested-junction residual; same-user writers control the private area.
"""

import hashlib
import json
import os
import re
from collections import defaultdict
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from functools import cache
from pathlib import Path
from types import MappingProxyType
from typing import Any

import duckdb
from sqlalchemy.engine.reflection import Inspector

from transit_ops.batch.build import BuildRequest, FamilyBuilder, InputNeed
from transit_ops.batch.editions import EditionRow, reads_editions, snapshot_rows, with_editions
from transit_ops.batch.fetch_inputs import fetch_inputs, needs_for_replay
from transit_ops.batch.private_area import PrivateArea
from transit_ops.history.datasets import HistoryDataset, TableSource, get_dataset
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.alert_bundle import (
    CLOSURE_RELATIONS,
    GROUP,
    MEMBERS,
    PREFIX,
    BundleRefused,
    validate_coverage,
    validate_members,
)
from transit_ops.lake.archive_keys import (
    parse_proof_key,
    proof_key,
    table_copy_key,
    validate_provider_id,
)
from transit_ops.lake.table_export import WindowSpec
from transit_ops.settings import Settings


def layout_needs(needs: Sequence[InputNeed]) -> tuple[InputNeed, ...]:
    """One file kind per relation; an all file contains the union of its explicit ranges."""
    whole = {n.relation for n in needs if n.window == "all"}
    return tuple(
        sorted(
            {InputNeed(n.relation, "all") if n.relation in whole else n for n in needs},
            key=lambda n: (n.relation, n.window),
        )
    )


@contextmanager
def replay_catalog() -> Iterator[Inspector]:
    from sqlalchemy import inspect

    from transit_ops.batch.pg_load import prepare_replay_database

    url = os.environ.get("TRANSIT_REPLAY_DATABASE_URL")
    if not url:
        raise ValueError("TRANSIT_REPLAY_DATABASE_URL is required for the disposable FK catalog")
    database = prepare_replay_database(url, os.environ)
    try:
        yield inspect(database.engine)
    finally:
        database.engine.dispose()


def fetch_from_catalog(
    storage: BronzeStorage,
    root: Path,
    request: BuildRequest,
    builders: Sequence[FamilyBuilder],
) -> dict[str, object]:
    from transit_ops.batch.replay import postgres_input_needs

    uses_editions = reads_editions(b.family_id for b in builders if hasattr(b, "family_id"))
    with replay_catalog() as catalog:
        return fetch_replay_inputs(
            storage,
            root,
            request.provider_id,
            request.as_of_utc,
            lambda editions: archive_input_needs(
                needs_for_replay(
                    builders,
                    with_editions(
                        request,
                        (b.family_id for b in builders if hasattr(b, "family_id")),
                        editions.rows,
                    ),
                    postgres_needs=postgres_input_needs(
                        request, editions.schedule_ids if uses_editions else ()
                    ),
                ),
                storage,
                request.provider_id,
                request.as_of_utc,
                editions,
                catalog,
            ),
            bootstrap_editions=uses_editions,
            request=request,
        )


def archive_input_needs(
    needs: Sequence[InputNeed],
    storage: BronzeStorage,
    provider: str,
    as_of: datetime,
    editions: Mapping[int, str],
    catalog: Inspector,
) -> tuple[InputNeed, ...]:
    """Only verified zero-row copies can eliminate an archive FK prerequisite."""
    from transit_ops.batch.replay import parent_input_needs

    @cache
    def populated(child: InputNeed) -> bool:
        if child.window.startswith("edition:") and int(child.window.split(":")[1]) not in editions:
            return True  # Keep the FK closure until the bootstrap can resolve this edition.
        try:
            sources = resolve_sources([child], storage, provider, as_of, editions)
        except SourcesMissing:
            return True  # Full preflight reports this child and all unknown prerequisites.
        return not all(
            type(s.receipt["proof"].get("rows")) is int
            and s.receipt["proof"]["rows"] == 0
            and type(s.receipt.get("rows")) is int
            and s.receipt["rows"] == 0
            for s in sources
            if any(n.relation == child.relation for n in s.needs)
        )

    return parent_input_needs(bundle_needs(needs), catalog, lambda child, _fk: populated(child))


def replay_request(provider: str, day: str, as_of: str | None, settings: Settings) -> BuildRequest:
    from transit_ops.providers import load_providers

    local_day = date.fromisoformat(day)
    if day != local_day.isoformat():
        raise ValueError("date must be YYYY-MM-DD")
    stamp = (
        datetime.fromisoformat(as_of)
        if as_of
        else datetime.combine(local_day + timedelta(days=1), time(7), UTC)
    )
    return BuildRequest(
        provider,
        (local_day,),
        stamp,
        settings.GOLD_FACT_RETENTION_DAYS,
        settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
        load_providers()[provider].timezone,
    )


@dataclass(frozen=True)
class Source:
    key: str
    receipt: Mapping[str, Any]
    needs: tuple[InputNeed, ...]


@dataclass(frozen=True, eq=False)
class EditionMapping(Mapping[int, str]):
    checksums: Mapping[int, str]
    schedule_ids: tuple[int, ...]
    bootstrap: Source | None = None
    rows: tuple[EditionRow, ...] = ()

    def __getitem__(self, key: int) -> str:
        return self.checksums[key]

    def __iter__(self) -> Iterator[int]:
        return iter(self.checksums)

    def __len__(self) -> int:
        return len(self.checksums)


class SourcesMissing(ValueError):
    def __init__(self, needs: Sequence[InputNeed]) -> None:
        self.needs = tuple(sorted(set(needs), key=lambda n: (n.relation, n.window)))
        super().__init__(
            "missing proven sources: "
            + ", ".join(f"({n.relation}, {n.window})" for n in self.needs)
        )


def _document(storage: BronzeStorage, key: str) -> dict[str, Any]:
    value = json.loads(storage.read_bytes(key))
    if not isinstance(value, dict):
        raise ValueError(f"invalid receipt: {key}")
    return value


def _verified(value: Mapping[str, Any], key: str) -> None:
    proof = value.get("proof")
    digest, size = value.get("object_sha256"), value.get("object_bytes")
    if (
        value.get("key") != key
        or not isinstance(digest, str)
        or not re.fullmatch("[0-9a-f]{64}", digest)
        or type(size) is not int
        or size < 0
        or not isinstance(proof, dict)
        or proof.get("verified") is not True
        or proof.get("object_sha256") != digest
        or type(proof.get("object_bytes")) is not int
        or proof.get("object_bytes") != size
    ):
        raise ValueError(f"invalid key or object proof: {key}")


def _archive(storage: BronzeStorage, relation: str, provider: str) -> dict[str, Source]:
    candidates: dict[str, list[tuple[tuple[int, int, int], Source]]] = defaultdict(list)
    for key in storage.list_keys(f"archive/v1/tables/{relation}/"):
        parts = parse_proof_key(key)
        if parts is None or parts.provider_id not in (provider, "_shared"):
            continue
        value = _document(storage, key)
        identity = dict(
            dataset_id=relation,
            provider_id=parts.provider_id,
            revision=parts.revision,
            window_key=parts.window_key,
            content_version=parts.version,
            schema_version=parts.schema_version,
        )
        if (
            value.get("format_version") != 1
            or value.get("kind") != "table_copy"
            or any(
                type(value.get(k)) is not type(v) or value.get(k) != v for k, v in identity.items()
            )
        ):
            raise ValueError(f"archive receipt identity differs: {key}")
        object_key = table_copy_key(
            relation,
            parts.provider_id,
            parts.revision,
            parts.grain,
            parts.window_key,
            parts.version,
            parts.schema_version,
        )
        _verified(value, object_key)
        candidates[parts.window_key].append(
            ((parts.revision, parts.version, parts.schema_version), Source(object_key, value, ()))
        )
    result = {}
    for window, items in candidates.items():
        rank = max(rank for rank, _ in items)
        winners = [source for order, source in items if order == rank]
        if len(winners) != 1:
            raise ValueError(f"ambiguous current archive copy: {relation} {window}")
        result[window] = winners[0]
    return result


def _months(first: str, last: str) -> tuple[str, ...]:
    year, month = map(int, first.split("-"))
    result = []
    while (window := f"{year:04d}-{month:02d}") <= last:
        result.append(window)
        year, month = year + (month == 12), month % 12 + 1
    return tuple(result)


def _rescue(need: InputNeed, storage: BronzeStorage, provider: str) -> Source | None:
    if need.relation not in ("gold.fact_trip_delay_snapshot", "gold.fact_vehicle_snapshot"):
        return None
    prefix = f"rescue/v1/parquet/{provider}/{need.window}/"
    if not storage.exists(prefix + "receipt.json"):
        return None
    value = _document(storage, prefix + "receipt.json")
    table = need.relation.split(".")[1]
    if (
        value.get("format_version") != 1
        or value.get("kind") != "rescue_parquet"
        or value.get("provider") != provider
        or value.get("day") != need.window
        or not isinstance(value.get("tables"), dict)
        or table not in value["tables"]
    ):
        raise ValueError(f"rescue receipt identity differs: {need.relation} {need.window}")
    record = value["tables"][table]
    key = prefix + table + ".parquet"
    if not isinstance(record, dict):
        raise ValueError(f"invalid rescue table: {table}")
    _verified(record, key)
    return Source(key, record, (need,))


def _windows_for(
    need: InputNeed,
    dataset: HistoryDataset,
    copies: Mapping[str, Source],
    as_of: datetime,
    editions: Mapping[int, str],
) -> Sequence[str]:
    assert isinstance(dataset.source, TableSource)
    if dataset.source.window_column is None:
        windows = [w for w in copies if w <= as_of.strftime("%Y-%m")]
        return [max(windows)] if windows else []
    if dataset.archive_grain == "edition":
        ident = int(need.window.removeprefix("edition:"))
        if ident not in editions:
            raise ValueError(f"unknown edition id: {need.relation} {need.window}")
        return [editions[ident]]
    if dataset.archive_grain == "month":
        if need.window == "all":
            return _months(min(copies), as_of.strftime("%Y-%m")) if copies else ()
        return (need.window[:7],)
    return (need.window,)


def _source_inventory(
    relation: str,
    storage: BronzeStorage,
    provider: str,
    editions: Mapping[int, str],
) -> dict[str, Source]:
    pinned = editions.bootstrap if isinstance(editions, EditionMapping) else None
    if pinned is not None and relation == "core.dataset_versions":
        return {pinned.receipt["window_key"]: pinned}
    return _archive(storage, relation, provider)


def bundle_needs(needs: Sequence[InputNeed]) -> tuple[InputNeed, ...]:
    if any(n.relation in MEMBERS for n in needs):
        return layout_needs(tuple(needs) + tuple(InputNeed(r, "all") for r in MEMBERS))
    return tuple(needs)


def _bundle_sources(storage: BronzeStorage, provider: str, as_of: datetime) -> tuple[Source, ...]:
    candidates = []
    for key in storage.list_keys(PREFIX):
        payload = storage.read_bytes(key)
        version = hashlib.sha256(payload).hexdigest()
        if key != PREFIX + version + ".json":
            raise ValueError(f"invalid bundle digest: {key}")
        value = json.loads(payload)
        if value.get("format_version") != 2 or value.get("kind") != GROUP:
            raise ValueError(f"invalid bundle: {key}")
        stamp = datetime.fromisoformat(value["snapshot_at_utc"])
        if stamp.utcoffset() is None:
            raise ValueError(f"invalid snapshot time: {key}")
        if stamp <= as_of and any(m.get("provider_id") == provider for m in value["members"]):
            candidates.append((stamp, version, value))
    if not candidates:
        raise SourcesMissing([InputNeed(r, "all") for r in MEMBERS])
    stamp, version, value = max(candidates, key=lambda c: (c[0], c[1]))
    records = [m for m in value["members"] if m["provider_id"] in (provider, "_shared")]
    validate_members(
        [
            WindowSpec(m["dataset_id"], m["provider_id"], m["window_key"], m["revision"])
            for m in records
        ]
    )
    closure = value.get("closure", [])
    if len(closure) != len(CLOSURE_RELATIONS) or {m["dataset_id"] for m in closure} != set(
        CLOSURE_RELATIONS
    ):
        missing = set(CLOSURE_RELATIONS) - {m["dataset_id"] for m in closure}
        raise BundleRefused("bundle_parent_missing", sorted(missing))
    result = []
    for m in records + closure:
        key = m["key"]
        is_closure = m["dataset_id"] in CLOSURE_RELATIONS
        if is_closure:
            expected = f"archive/v1/bundle-closure/{m['dataset_id']}/{m['object_sha256']}.parquet"
            if key != expected or not storage.exists(key):
                raise BundleRefused("bundle_parent_missing", m["dataset_id"])
        else:
            expected = table_copy_key(
                m["dataset_id"],
                m["provider_id"],
                m["revision"],
                "month",
                m["window_key"],
                m["content_version"],
                m["schema_version"],
            )
            if key != expected:
                raise ValueError(f"bundle member identity: {m['dataset_id']}")
            if not storage.exists(proof_key(key)) or not storage.exists(key):
                raise SourcesMissing([InputNeed(m["dataset_id"], "all")])
            if _document(storage, proof_key(key)) != m:
                raise ValueError(f"bundle member proof differs: {m['dataset_id']}")
        _verified(m, key)
        receipt = dict(
            m,
            bundle_version=version,
            bundle_snapshot_at_utc=stamp.isoformat(),
            bundle_coverage_from_utc=value["coverage_from_utc"],
            replay_provider=provider,
            bundle_closure=is_closure,
        )
        result.append(Source(key, receipt, (InputNeed(m["dataset_id"], "all"),)))
    return tuple(result)


def resolve_sources(
    needs: Sequence[InputNeed],
    storage: BronzeStorage,
    provider: str,
    as_of: datetime,
    editions: Mapping[int, str],
    *,
    request: BuildRequest | None = None,
) -> tuple[Source, ...]:
    """Preflight every need before payload reads; select only current proven revisions."""
    validate_provider_id(provider)
    if as_of.utcoffset() is None:
        raise ValueError("as_of must be timezone-aware")
    as_of = as_of.astimezone(UTC)
    inventories, selected, missing = {}, {}, []
    if any(n.relation in MEMBERS for n in needs):
        for source in _bundle_sources(storage, provider, as_of):
            selected[source.key] = source
        pinned = {s.needs[0].relation for s in selected.values()}
        if request is not None:
            receipt = next(iter(selected.values())).receipt
            validate_coverage(
                datetime.fromisoformat(receipt["bundle_snapshot_at_utc"]),
                datetime.fromisoformat(receipt["bundle_coverage_from_utc"]),
                request.local_dates,
                request.timezone,
                request.as_of_utc,
            )
        needs = tuple(n for n in needs if n.relation not in pinned)
    for need in needs:
        rescued = _rescue(need, storage, provider)
        if rescued:
            selected[rescued.key] = rescued
            continue
        try:
            dataset = get_dataset(need.relation)
        except LookupError:
            missing.append(need)
            continue
        if not isinstance(dataset.source, TableSource):
            missing.append(need)
            continue
        if need.relation not in inventories:
            inventories[need.relation] = _source_inventory(
                need.relation, storage, provider, editions
            )
        copies = inventories[need.relation]
        windows = _windows_for(need, dataset, copies, as_of, editions)
        if not windows or any(w not in copies for w in windows):
            missing.append(need)
            continue
        for window in windows:
            source = copies[window]
            previous = selected.get(source.key)
            selected[source.key] = replace(
                source,
                needs=tuple(
                    sorted(
                        set((previous.needs if previous else ()) + (need,)),
                        key=lambda n: (n.relation, n.window),
                    )
                ),
            )
    if missing:
        raise SourcesMissing(missing)
    return tuple(selected[k] for k in sorted(selected))


def _download(source: Source, storage: BronzeStorage, root: Path) -> Path:
    need = InputNeed(source.needs[0].relation, "all")
    return fetch_inputs(
        [need],
        storage,
        root,
        key_for=lambda _: source.key,
        expected_sha256=lambda _: source.receipt["object_sha256"],
        receipt_for=lambda _: source.receipt,
    )[0].path


def edition_mapping(
    path: Path,
    provider: str,
    *,
    bootstrap: Source | None = None,
) -> EditionMapping:
    with duckdb.connect() as conn:
        rows = conn.execute(
            "SELECT dataset_version_id, COALESCE(checksum_sha256, content_hash) "
            "FROM read_parquet(?, hive_partitioning=false) WHERE provider_id=?",
            [str(path), provider],
        ).fetchall()
    mapping: dict[int, str] = {}
    for ident, checksum in rows:
        if (
            type(ident) is not int
            or ident <= 0
            or not isinstance(checksum, str)
            or not re.fullmatch("[0-9a-f]{64}", checksum)
        ):
            raise ValueError(f"invalid edition mapping: {ident}")
        if ident in mapping and mapping[ident] != checksum:
            raise ValueError(f"ambiguous edition id: {ident}")
        if checksum in mapping.values() and mapping.get(ident) != checksum:
            raise ValueError(f"ambiguous edition checksum: {checksum}")
        mapping[ident] = checksum
    with duckdb.connect() as conn:
        selected = conn.execute(
            "SELECT dataset_version_id FROM read_parquet(?, hive_partitioning=false) "
            "WHERE provider_id=? AND dataset_kind='static_schedule' AND is_current=true "
            "ORDER BY loaded_at_utc DESC NULLS FIRST, dataset_version_id DESC LIMIT 1",
            [str(path), provider],
        ).fetchall()
    return EditionMapping(
        MappingProxyType(mapping),
        tuple(row[0] for row in selected),
        bootstrap,
        snapshot_rows(path, provider),
    )


def _check_bootstrap_current(
    bootstrap: Source,
    storage: BronzeStorage,
    provider: str,
    as_of: datetime,
) -> None:
    try:
        current = resolve_sources(bootstrap.needs, storage, provider, as_of, {})
    except SourcesMissing as error:
        raise ValueError(
            "bootstrap_source_changed: core.dataset_versions has no current proof"
        ) from error
    if current != (bootstrap,):
        raise ValueError(f"bootstrap_source_changed: core.dataset_versions {bootstrap.key}")


def _predicate(need: InputNeed, column: str | None, as_of: datetime) -> tuple[str, list[object]]:
    if column is None:
        return "true", []
    quoted = '"' + column.replace('"', '""') + '"'
    if need.window.startswith("edition:"):
        return f"{quoted} = ?", [int(need.window.split(":")[1])]
    if need.window == "all":
        return f"{quoted} < ?", [as_of]
    start = datetime.fromisoformat(need.window).replace(tzinfo=UTC)
    return f"{quoted} >= ? AND {quoted} < ?", [start, start + timedelta(days=1)]


def _window_column(conn: duckdb.DuckDBPyConnection, relation: str) -> str | None:
    declaration = get_dataset(relation).source
    assert isinstance(declaration, TableSource)
    column = declaration.window_column
    if column:
        columns = [r[0] for r in conn.execute("DESCRIBE input").fetchall()]
        if column not in columns:
            raise ValueError(f"missing window column: {relation}.{column}")
        quoted = '"' + column.replace('"', '""') + '"'
        nulls = conn.execute(f"SELECT count(*) FROM input WHERE {quoted} IS NULL").fetchone()
        assert nulls is not None
        if nulls[0]:
            raise ValueError(f"NULL window column: {relation}.{column}")
    return column


def _filter_window(
    conn: duckdb.DuckDBPyConnection,
    source: Source,
    path: Path,
    index: int,
    as_of: datetime,
    whole: set[str],
) -> tuple[dict[str, object], dict[InputNeed, Path]]:
    column = (
        None
        if source.receipt.get("bundle_closure")
        else _window_column(conn, source.needs[0].relation)
    )
    predicates = [_predicate(n, column, as_of) for n in source.needs]
    union = " OR ".join(f"({sql})" for sql, _ in predicates)
    params = [p for _, values in predicates for p in values]
    counts = conn.execute(
        f"SELECT count(*), count(*) FILTER (WHERE {union}) FROM input", params
    ).fetchone()
    assert counts is not None
    total, kept = counts
    receipt = dict(
        key=source.key,
        object_sha256=source.receipt["object_sha256"],
        bytes=source.receipt["object_bytes"],
        rows_kept=kept,
        rows_dropped=total - kept,
    )
    groups: dict[InputNeed, list[tuple[str, list[object]]]] = defaultdict(list)
    for need, predicate in zip(source.needs, predicates, strict=True):
        target = InputNeed(need.relation, "all") if need.relation in whole else need
        groups[target].append(predicate)
    parts = {}
    for offset, (need, selections) in enumerate(groups.items()):
        sql = " OR ".join(f"({sql})" for sql, _ in selections)
        values = [p for _, params in selections for p in params]
        part = path.parent / f"part-{index}-{offset}.parquet"
        conn.execute(
            f"COPY (SELECT * FROM input WHERE {sql}) TO ? (FORMAT parquet)", values + [str(part)]
        )
        parts[need] = part
    return receipt, parts


def materialize(
    sources: Sequence[Source],
    paths: Mapping[str, Path],
    root: Path,
    as_of: datetime,
) -> list[dict[str, object]]:
    """Filter archive ranges before either engine reads; retain per-window row accounting."""
    targets: dict[InputNeed, list[Path]] = defaultdict(list)
    receipts = []
    schemas: dict[str, list[tuple[Any, ...]]] = {}
    whole = {n.relation for s in sources for n in s.needs if n.window == "all"}
    with duckdb.connect(config={"threads": 1}) as conn:
        conn.execute("SET TimeZone='UTC'")
        for index, source in enumerate(sources):
            path = paths[source.key]
            conn.execute("DROP VIEW IF EXISTS input")
            conn.from_parquet(str(path), hive_partitioning=False).create_view("input", replace=True)
            relation = source.needs[0].relation
            if "bundle_version" in source.receipt:
                provider = source.receipt["replay_provider"]
                if relation == "silver.i3_alert_active_periods":
                    parent = next(s for s in sources if s.needs[0].relation == "silver.i3_alerts")
                    conn.from_parquet(str(paths[parent.key]), hive_partitioning=False).create_view(
                        "alert_parents", replace=True
                    )
                    conn.execute(
                        f"CREATE OR REPLACE TEMP TABLE scoped_rows_{index} AS "
                        "SELECT c.* FROM input c WHERE EXISTS (SELECT 1 FROM alert_parents p "
                        "WHERE p.provider_id=? AND p.i3_alert_snapshot_id=c.i3_alert_snapshot_id "
                        "AND p.alert_index=c.alert_index)",
                        [provider],
                    )
                else:
                    conn.execute(
                        f"CREATE OR REPLACE TEMP TABLE scoped_rows_{index} AS "
                        "SELECT * FROM input WHERE provider_id=?",
                        [provider],
                    )
                total = conn.execute("SELECT count(*) FROM input").fetchone()[0]
                # Materialize before replacing the input view to avoid a recursive view.
                conn.execute(
                    f"CREATE OR REPLACE TEMP VIEW input AS SELECT * FROM scoped_rows_{index}"
                )
            schema = conn.execute("DESCRIBE input").fetchall()
            if relation in schemas and schema != schemas[relation]:
                raise ValueError(f"Parquet schema differs: {relation} {path}")
            schemas[relation] = schema
            receipt, parts = _filter_window(conn, source, path, index, as_of, whole)
            if "bundle_version" in source.receipt:
                receipt.update(
                    rows_dropped=total - int(receipt["rows_kept"]),
                    bundle_version=source.receipt["bundle_version"],
                    snapshot_at_utc=source.receipt["bundle_snapshot_at_utc"],
                )
            receipts.append(receipt)
            for need, part in parts.items():
                targets[need].append(part)
        for need, files in targets.items():
            destination = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                raise ValueError(f"input already exists: {destination}")
            conn.execute(
                "COPY (SELECT * FROM read_parquet(?, hive_partitioning=false)) "
                "TO ? (FORMAT parquet)",
                [[str(p) for p in files], str(destination)],
            )
    return receipts


def fetch_replay_inputs(
    storage: BronzeStorage,
    root: Path,
    provider: str,
    as_of: datetime,
    needs_for: Callable[[EditionMapping], Sequence[InputNeed]],
    *,
    bootstrap_editions: bool = True,
    request: BuildRequest | None = None,
) -> dict[str, object]:
    """Bootstrap only edition readers/FK needs, then preflight all payloads."""
    from transit_ops.batch.replay import absent_unread

    if not root.is_dir() or any(root.iterdir()) or root.is_symlink() or root.is_junction():
        raise ValueError("inputs directory must exist, be empty and not redirected")
    if any(c in str(root.resolve()) for c in "*?[]{}"):
        raise ValueError("glob path refused")
    with PrivateArea(root) as area:
        mapping = EditionMapping({}, ())
        paths = {}
        needs = () if bootstrap_editions else tuple(needs_for(mapping))
        if bootstrap_editions or any(n.window.startswith("edition:") for n in needs):
            bootstrap_need = InputNeed("core.dataset_versions", "all")
            bootstrap = resolve_sources([bootstrap_need], storage, provider, as_of, {})[0]
            first = _download(bootstrap, storage, area / "bootstrap")
            mapping = edition_mapping(first, provider, bootstrap=bootstrap)
            paths[bootstrap.key] = first
            needs = tuple(needs_for(mapping))
        sources = resolve_sources(needs, storage, provider, as_of, mapping, request=request)
        if mapping.bootstrap is not None:
            _check_bootstrap_current(mapping.bootstrap, storage, provider, as_of)
        for index, source in enumerate(sources):
            if source.key not in paths:
                paths[source.key] = _download(source, storage, area / str(index))
        receipts = materialize(sources, paths, root, as_of)
        bundles = {
            s.receipt["bundle_version"]: dict(
                version=s.receipt["bundle_version"],
                snapshot_at_utc=s.receipt["bundle_snapshot_at_utc"],
                coverage_from_utc=s.receipt["bundle_coverage_from_utc"],
                members=[
                    dict(key=m.key, object_sha256=m.receipt["object_sha256"])
                    for m in sources
                    if "bundle_version" in m.receipt
                ],
                files={
                    r: hashlib.sha256((root / r / "all.parquet").read_bytes()).hexdigest()
                    for r in (*MEMBERS, *CLOSURE_RELATIONS)
                },
            )
            for s in sources
            if s.needs[0].relation in MEMBERS
        }
        if bundles:
            (root / "alert-bundle.json").write_text(
                json.dumps(list(bundles.values()), sort_keys=True), encoding="utf8"
            )
    return dict(
        needs=[
            dict(relation=n.relation, window=n.window)
            for n in layout_needs(tuple(n for s in sources for n in s.needs))
        ],
        absent_unread=absent_unread(needs),
        receipts=receipts,
        bytes=sum(int(source.receipt["object_bytes"]) for source in sources),
    )
