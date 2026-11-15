"""Replace a family's PostgreSQL rows, preserving the manifest's provenance."""

from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from time import perf_counter
from typing import cast as typing_cast
from zoneinfo import ZoneInfo

from sqlalchemy import (
    ARRAY,
    Connection,
    Date,
    Engine,
    MetaData,
    Table,
    Text,
    bindparam,
    cast,
    func,
    text,
)
from sqlalchemy.sql.elements import ColumnElement

from transit_ops.batch.build import FamilyBuilder, FamilyOutput, InputNeed, TableRows
from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families import registry
from transit_ops.batch.families.ownership import TABLE_OWNERS
from transit_ops.batch.families.registry import FAMILIES, UnknownFamilyError
from transit_ops.batch.manifest import BuildManifest
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.gold.delay_days import _DAY_LOCK, DAY_COORDINATION_KIND, day_key
from transit_ops.gold.delay_periods import UPSERT_WARM_ROLLUP_PERIOD
from transit_ops.gold.rollups import (
    REBUILDABLE_KINDS,
    WarmRollupStageReceipt,
)


def _source_days(manifest: BuildManifest, needs: tuple[InputNeed, ...]) -> tuple[date, ...]:
    days = set(manifest.local_dates)
    zone = ZoneInfo(manifest.timezone)
    for need in needs:
        if not need.relation.startswith("gold.fact_"):
            continue
        if need.window.startswith("local:"):
            days.add(date.fromisoformat(need.window.removeprefix("local:")))
            continue
        start = datetime.combine(date.fromisoformat(need.window), time(), UTC)
        first = start.astimezone(zone).date()
        last = (start + timedelta(days=1, microseconds=-1)).astimezone(zone).date()
        days.update(first + timedelta(days=i) for i in range((last - first).days + 1))
    return tuple(sorted(days))


def _lock_fresh_days(conn: Connection, manifest: BuildManifest, days: tuple[date, ...]) -> None:
    for day in days:
        # Share lock_delay_day's lock and coordination row, including first builds.
        conn.execute(_DAY_LOCK, {"lock_key": f"transit.delay_day|{manifest.provider_id}|{day}"})
        params = dict(
            p=manifest.provider_id,
            day=day_key(day),
            stamp=manifest.as_of_utc,
            kind=DAY_COORDINATION_KIND,
        )
        # Touch the row for stale RR snapshots without advancing its source-change clock.
        # Preserving that clock lets an unchanged manifest be loaded idempotently.
        changed = conn.execute(
            text("""
            INSERT INTO gold.warm_rollup_periods
                (provider_id,rollup_kind,period_start_utc,built_at_utc)
            VALUES (:p,:kind,:day,:stamp)
            ON CONFLICT (provider_id,rollup_kind,period_start_utc) DO UPDATE
                SET built_at_utc=gold.warm_rollup_periods.built_at_utc
            RETURNING built_at_utc
        """),
            params,
        ).scalar_one()
        invalidated = conn.execute(
            text("""
            SELECT max(invalidated_at_utc) FROM gold.warm_rollup_periods
            WHERE provider_id=:p AND period_start_utc=:day
        """),
            params,
        ).scalar_one()
        if changed > manifest.as_of_utc or (
            invalidated is not None and invalidated > manifest.as_of_utc
        ):
            raise ValueError(f"stale load-back: {manifest.provider_id} day {day}")


def _insert_rows(conn: Connection, table: Table, rows: TableRows) -> None:
    arrays = {
        c.name: cast(bindparam(c.name, type_=Text), c.type)
        for c in table.c
        if isinstance(c.type, ARRAY)
    }
    for name in arrays:
        if any(
            row[rows.columns.index(name)] is not None
            and not isinstance(row[rows.columns.index(name)], str)
            for row in rows.rows
        ):
            raise ValueError(f"{rows.relation}.{name}: canonical array text required")
    conn.execute(
        table.insert().values(arrays),
        [dict(zip(rows.columns, row, strict=True)) for row in rows.rows],
    )


def _scope(table: Table, manifest: BuildManifest) -> ColumnElement[bool]:
    predicate = table.c.provider_id == manifest.provider_id
    if "provider_local_date" in table.c:
        predicate &= table.c.provider_local_date.in_(manifest.local_dates)
    elif "period_start_utc" in table.c:
        predicate &= cast(func.timezone(manifest.timezone, table.c.period_start_utc), Date).in_(
            manifest.local_dates
        )
    # Rolling aggregates have no day column: their PostgreSQL refresh replaces the provider.
    return predicate


def _load_table(conn: Connection, rows: TableRows, manifest: BuildManifest) -> str:
    schema, name = rows.relation.split(".")
    table = Table(name, MetaData(), schema=schema, autoload_with=conn)
    if set(rows.columns) != set(table.c.keys()):
        raise ValueError(f"{rows.relation}: destination columns differ")
    conn.execute(table.delete().where(_scope(table, manifest)))
    if rows.rows:
        _insert_rows(conn, table, rows)
    # Read back within the transaction: a lossy destination cast must roll back the delete too.
    actual = read_table_rows(
        conn, rows.relation, rows.key, provider_id=manifest.provider_id, local_dates=None
    )
    indexes = tuple(actual.columns.index(column) for column in rows.columns)
    scoped = conn.execute(table.select().where(_scope(table, manifest))).all()
    selected_keys = {tuple(row._mapping[k] for k in rows.key) for row in scoped}
    key_indexes = tuple(actual.columns.index(k) for k in rows.key)
    actual = TableRows(
        rows.relation,
        rows.columns,
        rows.key,
        tuple(
            tuple(row[i] for i in indexes)
            for row in actual.rows
            if tuple(row[i] for i in key_indexes) in selected_keys
        ),
    )
    if compare_tables(rows, actual):
        raise ValueError(f"{rows.relation}: loaded rows differ from DuckDB output")
    kind = next((k for k in REBUILDABLE_KINDS.values() if k.table == name), None)
    if kind is not None:
        for day in manifest.local_dates:
            run_day = day + timedelta(days=kind.service_day_offset)
            conn.execute(
                UPSERT_WARM_ROLLUP_PERIOD,
                dict(
                    provider_id=manifest.provider_id,
                    rollup_kind=kind.rollup_kind,
                    period_start_utc=datetime.combine(run_day, time(), UTC),
                    built_at_utc=manifest.as_of_utc,
                ),
            )
    return kind.rollup_kind if kind is not None else name


def load_back(
    engine: Engine,
    provider_id: str,
    local_dates: Sequence[date],
    output: FamilyOutput,
    *,
    manifest: BuildManifest,
) -> list[WarmRollupStageReceipt]:
    """One atomic replacement per table; use run_family's manifest, without changing revision."""
    if provider_id != manifest.provider_id or tuple(local_dates) != manifest.local_dates:
        raise ValueError("provider/local_dates differ from build manifest")
    if manifest.family_id not in FAMILIES:
        raise UnknownFamilyError(f"Unknown family: {manifest.family_id}")
    for relation in output.tables:
        if TABLE_OWNERS.get(relation) != manifest.family_id:
            raise ValueError(f"{relation}: not owned by {manifest.family_id}")
    if "gold.trip_delay_summary_5m" in output.tables:
        raise ValueError(
            "trip_delay_summary_5m load-back unsupported until coordination is supported"
        )
    family = typing_cast(FamilyBuilder | None, registry.resolve_builder(manifest.family_id))
    if family is None:
        raise ValueError(f"{manifest.family_id}: builder is not implemented")
    # The owning family enforces retention and source-day rules before any write transaction.
    days = _source_days(manifest, family.inputs(manifest))
    receipts = []
    for relation, rows in output.tables.items():
        if "provider_id" not in rows.columns:
            raise ValueError(f"{relation}: provider_id missing")
        if any(row[rows.columns.index("provider_id")] != provider_id for row in rows.rows):
            raise ValueError(f"{relation}: output provider differs from manifest")
        if "provider_local_date" in rows.columns and any(
            row[rows.columns.index("provider_local_date")] not in manifest.local_dates
            for row in rows.rows
        ):
            raise ValueError(f"{relation}: output day differs from manifest")
        started = perf_counter()
        with engine.begin() as conn:
            _lock_fresh_days(conn, manifest, days)
            kind = _load_table(conn, rows, manifest)
        receipts.append(
            WarmRollupStageReceipt(
                provider_id,
                "load_back",
                kind,
                relation.removeprefix("gold."),
                round(perf_counter() - started, 3),
                len(rows.rows),
                engine="duckdb",
                build_id=manifest.build_id,
            )
        )
    return receipts
