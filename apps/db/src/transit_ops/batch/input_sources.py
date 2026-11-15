"""Resolve replay windows from recorded proofs, then materialize their exact rows.

Downloads use PrivateArea's R22c cleanup boundary, including its documented
Windows nested-junction residual; same-user writers control the private area.
"""

import json
import re
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

import duckdb

from transit_ops.batch.build import BuildRequest, InputNeed
from transit_ops.batch.fetch_inputs import fetch_inputs
from transit_ops.batch.private_area import PrivateArea
from transit_ops.history.datasets import HistoryDataset, TableSource, get_dataset
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import parse_proof_key, table_copy_key, validate_provider_id
from transit_ops.settings import Settings


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


def resolve_sources(
    needs: Sequence[InputNeed],
    storage: BronzeStorage,
    provider: str,
    as_of: datetime,
    editions: Mapping[int, str],
) -> tuple[Source, ...]:
    """Preflight every need before payload reads; select only current proven revisions."""
    validate_provider_id(provider)
    if as_of.utcoffset() is None:
        raise ValueError("as_of must be timezone-aware")
    as_of = as_of.astimezone(UTC)
    inventories, selected, missing = {}, {}, []
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
            inventories[need.relation] = _archive(storage, need.relation, provider)
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


def edition_mapping(path: Path, provider: str) -> dict[int, str]:
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
    return mapping


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
) -> tuple[dict[str, object], dict[InputNeed, Path]]:
    column = _window_column(conn, source.needs[0].relation)
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
    parts = {}
    for offset, (need, (sql, values)) in enumerate(zip(source.needs, predicates, strict=True)):
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
    with duckdb.connect(config={"threads": 1}) as conn:
        conn.execute("SET TimeZone='UTC'")
        for index, source in enumerate(sources):
            path = paths[source.key]
            conn.from_parquet(str(path), hive_partitioning=False).create_view("input", replace=True)
            relation = source.needs[0].relation
            schema = conn.execute("DESCRIBE input").fetchall()
            if relation in schemas and schema != schemas[relation]:
                raise ValueError(f"Parquet schema differs: {relation} {path}")
            schemas[relation] = schema
            receipt, parts = _filter_window(conn, source, path, index, as_of)
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
    needs_for: Callable[[Mapping[int, str]], Sequence[InputNeed]],
) -> dict[str, object]:
    """Bootstrap exactly one proven metadata object, then preflight all payloads."""
    if not root.is_dir() or any(root.iterdir()) or root.is_symlink() or root.is_junction():
        raise ValueError("inputs directory must exist, be empty and not redirected")
    if any(c in str(root.resolve()) for c in "*?[]{}"):
        raise ValueError("glob path refused")
    bootstrap_need = InputNeed("core.dataset_versions", "all")
    bootstrap = resolve_sources([bootstrap_need], storage, provider, as_of, {})[0]
    with PrivateArea(root) as area:
        first = _download(bootstrap, storage, area / "bootstrap")
        mapping = edition_mapping(first, provider)
        needs = tuple(needs_for(mapping))
        sources = resolve_sources(needs, storage, provider, as_of, mapping)
        paths = {bootstrap.key: first}
        for index, source in enumerate(sources):
            if source.key not in paths:
                paths[source.key] = _download(source, storage, area / str(index))
        receipts = materialize(sources, paths, root, as_of)
    return dict(
        needs=[dict(relation=n.relation, window=n.window) for n in needs],
        receipts=receipts,
        bytes=sum(int(source.receipt["object_bytes"]) for source in sources),
    )
