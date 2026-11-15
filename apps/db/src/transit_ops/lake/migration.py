"""Read-only history planning and sequential, resumable archive copies."""

import logging
import shutil
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from time import monotonic
from typing import Any, Literal, cast

from psycopg import Connection, sql
from psycopg.pq import TransactionStatus
from sqlalchemy import Connection as CatalogConnection
from sqlalchemy.dialects.postgresql import dialect

from transit_ops.history.datasets import (
    HISTORY_DATASETS,
    TableSource,
    get_dataset,
    utc_day_closes_at,
)
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import validate_provider_id
from transit_ops.lake.catalog import CatalogTable, read_catalog
from transit_ops.lake.inventory import Inventory, take_inventory
from transit_ops.lake.table_copy import copy_table_window
from transit_ops.lake.table_export import WindowSpec, validate_timeout
from transit_ops.settings import get_settings

READ_MARGIN_S = 300
WORK_SPACE_FLOOR = 10 * 1024**3
# "transit" / "lake": one session owns the complete plan and copy run.
MIGRATION_LOCK_KEY = (1953653102, 1818323813)


class MigrationRefused(ValueError):
    def __init__(self, reason: str, detail: object = "") -> None:
        self.reason = reason
        super().__init__(f"{reason}: {detail}")


@dataclass(frozen=True)
class PlannedWindow:
    spec: WindowSpec
    reason: Literal["closed", "open_included", "whole_state"]
    copy_group_members: tuple[WindowSpec, ...] = ()


@dataclass(frozen=True)
class MigrationPlan:
    inventory: Inventory
    windows: tuple[PlannedWindow, ...]
    skipped_open: tuple[WindowSpec, ...]
    database_target: dict[str, object] = field(default_factory=dict)

    @property
    def copy_groups(self) -> tuple[tuple[WindowSpec, ...], ...]:
        return tuple(w.copy_group_members for w in self.windows if w.copy_group_members)


@dataclass(frozen=True)
class MigrationSummary:
    outcomes: dict[str, dict[str, int]]
    failure: dict[str, object] | None
    storage_target: dict[str, object] = field(default_factory=dict)


@contextmanager
def migration_lock(connection: Connection[Any]) -> Iterator[None]:
    if not connection.autocommit or connection.info.transaction_status != TransactionStatus.IDLE:
        raise MigrationRefused("not_read_only")
    row = connection.execute("SELECT pg_try_advisory_lock(%s, %s)", MIGRATION_LOCK_KEY).fetchone()
    if row != (True,):
        raise MigrationRefused("migration_running", "transit lake migration session lock")
    try:
        yield
    finally:
        try:
            connection.execute("SELECT pg_advisory_unlock(%s, %s)", MIGRATION_LOCK_KEY)
        except Exception:
            if not connection.closed:
                raise
            logging.getLogger(__name__).warning(
                "Closed migration session: unlock failed", exc_info=True
            )


def require_read_reserve(not_after: datetime, timeout: int) -> None:
    if datetime.now(UTC) + timedelta(seconds=2 * timeout + READ_MARGIN_S) >= not_after:
        raise MigrationRefused("not_after", "insufficient reserve for export, recheck and margin")


class _PlanReads:
    def __init__(
        self, connection: Connection[Any], budget: int, timeout: int, not_after: datetime | None
    ) -> None:
        self.connection, self.timeout = connection, timeout
        self.end = monotonic() + budget
        self.not_after = not_after

    def remaining(self) -> float:
        left = self.end - monotonic()
        if self.not_after is not None:
            left = min(left, (self.not_after - datetime.now(UTC)).total_seconds())
        if left <= 0:
            raise MigrationRefused("plan_budget")
        return left

    def execute(self, statement: Any, values: Any = None) -> Any:
        milliseconds = max(1, int(min(self.remaining(), self.timeout) * 1000))
        self.connection.execute(
            "SELECT set_config('statement_timeout', %s, true)", (str(milliseconds),)
        )
        try:
            result = self.connection.execute(statement, values)
        except Exception:
            self.remaining()
            raise
        self.remaining()
        return result


class _CatalogResult:
    def __init__(self, cursor: Any) -> None:
        self.rows = cursor.fetchall()
        self.names = [column.name for column in cursor.description]

    def scalar_one(self) -> object:
        if len(self.rows) != 1:
            raise MigrationRefused("catalog_result")
        return self.rows[0][0]

    def mappings(self) -> "_CatalogResult":
        return self

    def all(self) -> list[dict[str, Any]]:
        return [dict(zip(self.names, row, strict=True)) for row in self.rows]

    def scalars(self) -> list[Any]:
        return [row[0] for row in self.rows]

    def __iter__(self) -> Any:
        return iter(self.rows)


class _CatalogAdapter:
    """Run the SQLAlchemy catalog queries on the same psycopg snapshot."""

    def __init__(self, connection: Connection[Any]) -> None:
        self.connection = connection

    def execute(self, statement: Any, parameters: Any = None) -> _CatalogResult:
        compiled = statement.compile(dialect=cast(Any, dialect)(paramstyle="pyformat"))
        return _CatalogResult(self.connection.execute(str(compiled), parameters or None))


def _next_month(day: date) -> date:
    return date(day.year + (day.month == 12), day.month % 12 + 1, 1)


def _dated_windows(
    dataset_id: str,
    provider: str,
    revision: int,
    first: date,
    last: date,
    now: datetime,
    include_open: bool,
    open_days: int,
) -> tuple[list[PlannedWindow], list[WindowSpec]]:
    grain = get_dataset(dataset_id).archive_grain
    month = grain == "month"
    start = first.replace(day=1) if month else first
    windows, skipped = [], []
    while start <= last:
        end = _next_month(start) if month else start + timedelta(days=1)
        closed = (
            (end - timedelta(days=1) + timedelta(days=open_days)) < now.date()
            if month
            else utc_day_closes_at(start) <= now
        )
        spec = WindowSpec(
            dataset_id, provider, start.strftime("%Y-%m") if month else start.isoformat(), revision
        )
        if closed or include_open:
            windows.append(PlannedWindow(spec, "closed" if closed else "open_included"))
        else:
            skipped.append(spec)
        start = end
    return windows, skipped


def _editions(
    connection: Connection[Any],
    table: sql.Identifier,
    where: sql.Composed,
    values: tuple[object, ...],
    source: TableSource,
    provider: str,
) -> list[str]:
    candidates = connection.execute(
        "SELECT dataset_version_id, COALESCE(checksum_sha256, content_hash) "
        "FROM core.dataset_versions WHERE provider_id=%s ORDER BY dataset_version_id",
        (provider,),
    ).fetchall()
    keys = []
    for edition, checksum in candidates:
        present = connection.execute(
            sql.SQL("SELECT EXISTS (SELECT 1 FROM {}{} AND {}=%s)").format(
                table, where, sql.Identifier(cast(str, source.window_column))
            ),
            (*values, edition),
        ).fetchone()
        if present != (True,):
            continue
        if not isinstance(checksum, str) or sum(c == checksum for _, c in candidates) != 1:
            raise MigrationRefused("edition_identity", (source.table, provider, edition))
        keys.append(checksum)
    return sorted(keys)


def _loose_keys(
    connection: Connection[Any], table: str, columns: tuple[str, ...]
) -> list[tuple[Any, ...]]:
    names = sql.SQL(", ").join(sql.Identifier(c) for c in columns)
    previous = sql.SQL(", ").join(sql.Identifier("keys", c) for c in columns)
    return connection.execute(
        sql.SQL(
            "WITH RECURSIVE keys AS ((SELECT {cols} FROM {table} ORDER BY {cols} LIMIT 1) "
            "UNION ALL SELECT following.* FROM keys CROSS JOIN LATERAL "
            "(SELECT {cols} FROM {table} WHERE ROW({cols}) > ROW({previous}) "
            "ORDER BY {cols} LIMIT 1) following) SELECT {cols} FROM keys"
        ).format(cols=names, table=sql.Identifier(*table.split(".")), previous=previous)
    ).fetchall()


def _provider_registry(connection: Connection[Any], catalog: CatalogTable) -> None:
    column = next((c for c in catalog.columns if c.name == "provider_id"), None)
    if column is None:
        return
    row = connection.execute(
        """
        SELECT EXISTS (
            SELECT 1 FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='provider_id'
            JOIN pg_attribute r ON r.attrelid=c.confrelid AND r.attname='provider_id'
            WHERE c.conrelid=%s::regclass AND c.contype='f' AND c.convalidated
              AND c.confrelid='core.providers'::regclass
              AND c.conkey=ARRAY[a.attnum] AND c.confkey=ARRAY[r.attnum]
        ), EXISTS (
            SELECT 1 FROM pg_index i
            JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am am ON am.oid=x.relam
            JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='provider_id'
            WHERE i.indrelid=%s::regclass AND i.indisvalid AND i.indisready
              AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
              AND i.indkey[0]=a.attnum
        )
    """,
        (catalog.name, catalog.name),
    ).fetchone()
    assert row is not None
    foreign_key, leading_index = row
    if foreign_key:
        return
    if leading_index and column.not_null:
        for (provider,) in _loose_keys(connection, catalog.name, ("provider_id",)):
            if (
                connection.execute(
                    "SELECT 1 FROM core.providers WHERE provider_id=%s", (provider,)
                ).fetchone()
                is None
            ):
                raise MigrationRefused("unknown_provider", (catalog.name, provider))
    else:
        unknown = connection.execute(
            sql.SQL(
                "SELECT t.provider_id FROM {} t WHERE NOT EXISTS "
                "(SELECT 1 FROM core.providers p WHERE p.provider_id=t.provider_id) LIMIT 1"
            ).format(sql.Identifier(*catalog.name.split(".")))
        ).fetchone()
        if unknown is not None:
            raise MigrationRefused("unknown_provider", (catalog.name, unknown[0]))


def _edition_registry(
    connection: Connection[Any], catalog: CatalogTable, source: TableSource
) -> None:
    edition = cast(str, source.window_column)
    # Primary-key prefixes enumerate identities without visiting every edition row.
    if edition not in catalog.primary_key:
        raise MigrationRefused("edition_identity", (catalog.name, "edition index prefix"))
    prefix = catalog.primary_key[: catalog.primary_key.index(edition) + 1]
    if prefix not in {(edition,), ("provider_id", edition)}:
        raise MigrationRefused("edition_identity", (catalog.name, "edition index prefix"))
    for key in _loose_keys(connection, catalog.name, prefix):
        if prefix[0] == "provider_id":
            provider, version = key
        else:
            version = key[0]
            row = connection.execute(
                sql.SQL("SELECT provider_id FROM {} WHERE {}=%s LIMIT 1").format(
                    sql.Identifier(*catalog.name.split(".")), sql.Identifier(edition)
                ),
                (version,),
            ).fetchone()
            assert row is not None
            provider = row[0]
        if (
            connection.execute(
                "SELECT 1 FROM core.dataset_versions "
                "WHERE dataset_version_id=%s AND provider_id=%s",
                (version, provider),
            ).fetchone()
            is None
        ):
            raise MigrationRefused("edition_identity", (catalog.name, provider, version))


def _groups(
    connection: Connection[Any],
    catalog: CatalogTable,
    source: TableSource,
    providers: Sequence[str] | None,
) -> list[tuple[str, int]]:
    has_provider = any(c.name == "provider_id" for c in catalog.columns)
    candidates = (
        connection.execute("SELECT provider_id FROM core.providers ORDER BY provider_id").fetchall()
        if has_provider
        else [("_shared",)]
    )
    table = sql.Identifier(*source.table.split("."))
    groups = []
    for (provider,) in candidates:
        validate_provider_id(provider)
        if has_provider and providers is not None and provider not in providers:
            continue
        predicate = sql.SQL("provider_id=%s") if has_provider else sql.SQL("true")
        values = (provider,) if has_provider else ()
        if source.revision_column:
            column = sql.Identifier(source.revision_column)
            # The declared revision tables have (provider_id, revision, ...) indexes.
            revisions = connection.execute(
                sql.SQL(
                    "WITH RECURSIVE revisions(r) AS (SELECT min({c}) FROM {t} WHERE {p} "
                    "UNION ALL SELECT (SELECT min({c}) FROM {t} WHERE {p} AND {c}>r) "
                    "FROM revisions WHERE r IS NOT NULL) "
                    "SELECT r FROM revisions WHERE r IS NOT NULL"
                ).format(c=column, t=table, p=predicate),
                values + values,
            ).fetchall()
        else:
            edition = get_dataset(catalog.name).archive_grain == "edition"
            present = (
                not has_provider
                or get_dataset(catalog.name).copy_group is not None
                or edition
                or connection.execute(
                    sql.SQL("SELECT EXISTS (SELECT 1 FROM {} WHERE {})").format(table, predicate),
                    values,
                ).fetchone()
                == (True,)
            )
            revisions = [(source.fixed_revision,)] if present else []
        for (revision,) in revisions:
            if type(revision) is not int or revision < 0:
                raise MigrationRefused("revision", (source.table, revision))
            groups.append((provider, revision))
    return groups


def _null_window(
    connection: Connection[Any],
    catalog: CatalogTable,
    source: TableSource,
    table: sql.Identifier,
    where: sql.Composed,
    values: tuple[object, ...],
) -> None:
    column = next(c for c in catalog.columns if c.name == source.window_column)
    if not column.not_null:
        missing = connection.execute(
            sql.SQL("SELECT EXISTS (SELECT 1 FROM {}{} AND {} IS NULL)").format(
                table, where, sql.Identifier(column.name)
            ),
            values,
        ).fetchone()
        if missing == (True,):
            raise MigrationRefused("missing_window", catalog.name)


def _table_windows(
    connection: Connection[Any],
    catalog: CatalogTable,
    today: date,
    now: datetime,
    include_open: bool,
    providers: Sequence[str] | None,
    open_days: int,
) -> tuple[list[PlannedWindow], list[WindowSpec]]:
    dataset = get_dataset(catalog.name)
    source = cast(TableSource, dataset.source)
    _provider_registry(connection, catalog)
    if dataset.archive_grain == "edition":
        _edition_registry(connection, catalog, source)
    table = sql.Identifier(*source.table.split("."))
    has_provider = any(c.name == "provider_id" for c in catalog.columns)
    windows, skipped = [], []
    for provider, revision in _groups(connection, catalog, source, providers):
        predicates: list[sql.Composable] = []
        values: list[object] = []
        if has_provider:
            predicates.append(sql.SQL("provider_id=%s"))
            values.append(provider)
        if source.revision_column:
            predicates.append(sql.SQL("{}=%s").format(sql.Identifier(source.revision_column)))
            values.append(revision)
        where = sql.SQL(" WHERE ") + sql.SQL(" AND ").join(predicates or [sql.SQL("true")])
        if source.window_column is None:
            windows.append(
                PlannedWindow(
                    WindowSpec(catalog.name, provider, today.strftime("%Y-%m"), revision),
                    "whole_state",
                )
            )
            continue
        _null_window(connection, catalog, source, table, where, tuple(values))
        if dataset.archive_grain == "edition":
            windows.extend(
                PlannedWindow(WindowSpec(catalog.name, provider, key, revision), "closed")
                for key in _editions(connection, table, where, tuple(values), source, provider)
            )
            continue
        row = connection.execute(
            sql.SQL("SELECT min({c}), max({c}) FROM {t}{w}").format(
                c=sql.Identifier(source.window_column), t=table, w=where
            ),
            tuple(values),
        ).fetchone()
        assert row is not None
        first, last = row
        if first is not None:
            first = first.date() if isinstance(first, datetime) else first
            last = last.date() if isinstance(last, datetime) else last
            planned, opened = _dated_windows(
                catalog.name, provider, revision, first, last, now, include_open, open_days
            )
            windows.extend(planned)
            skipped.extend(opened)
    return windows, skipped


def _order(window: PlannedWindow) -> tuple[object, ...]:
    grain = get_dataset(window.spec.dataset_id).archive_grain
    rank = 0 if window.reason == "whole_state" else {"month": 1, "edition": 2, "utc_day": 3}[grain]
    spec = window.spec
    return rank, spec.window_key, spec.dataset_id, spec.provider_id, spec.revision


def plan_migration(
    connection: Connection[Any],
    *,
    today_utc: date,
    include_open: bool,
    datasets: Sequence[str] | None,
    providers: Sequence[str] | None,
    statement_timeout_s: int,
    now_utc: datetime | None = None,
    plan_budget_s: int = 300,
    not_after: datetime | None = None,
) -> MigrationPlan:
    """Pin to midnight UTC unless an explicit instant on today_utc is supplied."""
    validate_timeout(statement_timeout_s)
    if not connection.autocommit or connection.info.transaction_status != TransactionStatus.IDLE:
        raise MigrationRefused("not_read_only")
    if type(plan_budget_s) is not int or not 1 <= plan_budget_s <= 1800:
        raise MigrationRefused("plan_budget")
    if not_after is not None and not_after.utcoffset() != timedelta(0):
        raise MigrationRefused("not_after_utc")
    if datasets is not None and any(get_dataset(n).copy_group for n in datasets):
        datasets = tuple(
            sorted(
                set(datasets)
                | {n for n, d in HISTORY_DATASETS.items() if d.copy_group == "silver_alert_state"}
            )
        )
    reads = _PlanReads(connection, plan_budget_s, statement_timeout_s, not_after)
    now = now_utc or datetime.combine(today_utc, time(), UTC)
    if now.utcoffset() != timedelta(0) or now.date() != today_utc:
        raise MigrationRefused("clock")
    with connection.transaction():
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        guards = dict(
            TimeZone="UTC",
            DateStyle="ISO, YMD",
            IntervalStyle="iso_8601",
            extra_float_digits="1",
            bytea_output="hex",
            client_encoding="UTF8",
            lock_timeout="1s",
            idle_in_transaction_session_timeout="15s",
            work_mem="16MB",
            max_parallel_workers_per_gather="0",
            statement_timeout=str(statement_timeout_s * 1000),
        )
        for key, value in guards.items():
            reads.execute("SELECT set_config(%s, %s, true)", (key, value))
        catalog = read_catalog(
            cast(CatalogConnection, _CatalogAdapter(cast(Connection[Any], reads)))
        )
        inventory = take_inventory(catalog)
        if not inventory.complete:
            raise MigrationRefused("inventory_incomplete", asdict(inventory))
        if datasets is not None and set(datasets) - set(inventory.copied):
            raise MigrationRefused("datasets", sorted(set(datasets) - set(inventory.copied)))
        identity = reads.execute(
            "SELECT current_database(), current_user, inet_server_addr()::text"
        ).fetchone()
        target = dict(zip(("database", "user", "server_addr"), identity, strict=True))
        windows, skipped = [], []
        for table in catalog:
            if table.name not in inventory.copied or (
                datasets is not None and table.name not in datasets
            ):
                continue
            planned, opened = _table_windows(
                cast(Connection[Any], reads),
                table,
                today_utc,
                now,
                include_open,
                providers,
                get_settings().GOLD_REPORTING_OPEN_WINDOW_DAYS,
            )
            windows.extend(planned)
            skipped.extend(opened)
    reads.remaining()
    grouped = tuple(w.spec for w in windows if get_dataset(w.spec.dataset_id).copy_group)
    singles = tuple(
        sorted((w for w in windows if not get_dataset(w.spec.dataset_id).copy_group), key=_order)
    )
    units = (PlannedWindow(grouped[0], "whole_state", grouped),) if grouped else ()
    return MigrationPlan(inventory, singles + units, tuple(skipped), target)


def run_migration(
    plan: MigrationPlan,
    connect: Callable[[], Connection[Any]],
    storage: BronzeStorage,
    *,
    work_dir: Path,
    copied_by: str,
    statement_timeout_s: int,
    not_after: datetime,
    log: Callable[[dict[str, object]], None],
    storage_target: dict[str, object] | None = None,
    still_locked: Callable[[], bool] | None = None,
) -> MigrationSummary:
    validate_timeout(statement_timeout_s)
    if not_after.utcoffset() != timedelta(0):
        raise MigrationRefused("not_after_utc")
    if not plan.inventory.complete:
        raise MigrationRefused("inventory_incomplete")
    target = storage_target or {
        "storage_backend": getattr(storage, "storage_backend", "unspecified"),
        "storage_location": str(
            getattr(storage, "bucket", getattr(storage, "root", "unspecified"))
        ),
    }
    outcomes: dict[str, dict[str, int]] = {}
    from transit_ops.lake.alert_bundle import copy_group

    for window in plan.windows:
        if window.copy_group_members:
            continue
        record = {"spec": asdict(window.spec), **target}
        started = monotonic()
        try:
            require_read_reserve(not_after, statement_timeout_s)
            if still_locked is not None:
                try:
                    if not still_locked():
                        raise MigrationRefused("migration_lock_lost")
                except Exception as error:
                    raise MigrationRefused("migration_lock_lost") from error
            if shutil.disk_usage(work_dir).free < WORK_SPACE_FLOOR:
                raise MigrationRefused(
                    "work_space", f"requires at least {WORK_SPACE_FLOOR} free bytes"
                )
            from tempfile import mkdtemp

            directory = Path(mkdtemp(prefix="window-", dir=work_dir))
            with connect() as connection:
                require_read_reserve(not_after, statement_timeout_s)
                result = copy_table_window(
                    connection,
                    storage,
                    window.spec,
                    work_dir=directory,
                    copied_by=copied_by,
                    statement_timeout_s=statement_timeout_s,
                )
            record.update(
                outcome=result.outcome,
                rows=result.rows,
                content_sha256=result.content_sha256,
                object_sha256=result.proof.object_sha256,
            )
        except Exception as error:
            record.update(
                outcome="failed",
                reason=getattr(error, "reason", type(error).__name__),
                error=str(error),
                seconds=monotonic() - started,
            )
            log(record)
            return MigrationSummary(outcomes, record, target)
        record["seconds"] = monotonic() - started
        log(record)
        group = (
            "whole_state"
            if window.reason == "whole_state"
            else get_dataset(window.spec.dataset_id).archive_grain
        )
        counts = outcomes.setdefault(group, {})
        counts[result.outcome] = counts.get(result.outcome, 0) + 1
    for specs in plan.copy_groups:
        record = {
            "copy_group": "silver_alert_state",
            "members": [asdict(s) for s in specs],
            **target,
        }
        try:
            require_read_reserve(not_after, statement_timeout_s)
            if still_locked is not None and not still_locked():
                raise MigrationRefused("migration_lock_lost")
            if shutil.disk_usage(work_dir).free < WORK_SPACE_FLOOR:
                raise MigrationRefused("work_space")
            from tempfile import mkdtemp

            directory = Path(mkdtemp(prefix="bundle-", dir=work_dir))
            with connect() as connection:
                bundle = copy_group(
                    connection,
                    storage,
                    specs,
                    work_dir=directory,
                    copied_by=copied_by,
                    statement_timeout_s=statement_timeout_s,
                )
            record.update(
                outcome="copied",
                bundle_version=bundle.version,
                snapshot_at_utc=bundle.snapshot_at_utc,
            )
            outcomes["silver_alert_state"] = {"copied": len(bundle.members)}
            log(record)
        except Exception as error:
            record.update(
                outcome="failed",
                reason=getattr(error, "reason", type(error).__name__),
                error=str(error),
            )
            log(record)
            return MigrationSummary(outcomes, record, target)
    return MigrationSummary(outcomes, None, target)
