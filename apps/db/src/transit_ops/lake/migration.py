"""Read-only history planning and sequential, resumable archive copies."""

from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from time import monotonic
from typing import Any, Literal, cast

from psycopg import Connection, sql
from psycopg.pq import TransactionStatus
from sqlalchemy import Connection as CatalogConnection
from sqlalchemy.dialects.postgresql import dialect

from transit_ops.history.datasets import TableSource, get_dataset, utc_day_closes_at
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import validate_provider_id
from transit_ops.lake.catalog import CatalogTable, read_catalog
from transit_ops.lake.inventory import Inventory, take_inventory
from transit_ops.lake.table_copy import copy_table_window
from transit_ops.lake.table_export import WindowSpec, validate_timeout
from transit_ops.settings import get_settings


class MigrationRefused(ValueError):
    def __init__(self, reason: str, detail: object = "") -> None:
        self.reason = reason
        super().__init__(f"{reason}: {detail}")


@dataclass(frozen=True)
class PlannedWindow:
    spec: WindowSpec
    reason: Literal["closed", "open_included", "whole_state"]


@dataclass(frozen=True)
class MigrationPlan:
    inventory: Inventory
    windows: tuple[PlannedWindow, ...]
    skipped_open: tuple[WindowSpec, ...]


@dataclass(frozen=True)
class MigrationSummary:
    outcomes: dict[str, dict[str, int]]
    failure: dict[str, object] | None


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
    ids = connection.execute(
        sql.SQL("SELECT DISTINCT {} FROM {}{}").format(
            sql.Identifier(cast(str, source.window_column)), table, where
        ),
        values,
    ).fetchall()
    keys = []
    for (edition,) in ids:
        matches = connection.execute(
            "SELECT COALESCE(checksum_sha256, content_hash) FROM core.dataset_versions "
            "WHERE dataset_version_id=%s AND provider_id=%s",
            (edition, provider),
        ).fetchall()
        if len(matches) != 1 or not isinstance(matches[0][0], str):
            raise MigrationRefused("edition_identity", (source.table, provider, edition))
        checksum = matches[0][0]
        count = connection.execute(
            "SELECT count(*) FROM core.dataset_versions WHERE provider_id=%s "
            "AND COALESCE(checksum_sha256, content_hash)=%s",
            (provider, checksum),
        ).fetchone()
        if count != (1,):
            raise MigrationRefused("edition_identity", (source.table, provider, edition))
        keys.append(checksum)
    return sorted(keys)


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
    table = sql.Identifier(*source.table.split("."))
    has_provider = any(c.name == "provider_id" for c in catalog.columns)
    provider_expr = sql.Identifier("provider_id") if has_provider else sql.Literal("_shared")
    revision_expr = (
        sql.Identifier(source.revision_column)
        if source.revision_column
        else sql.Literal(source.fixed_revision)
    )
    groups = (
        connection.execute(
            sql.SQL("SELECT DISTINCT {}, {} FROM {}").format(provider_expr, revision_expr, table)
        ).fetchall()
        if has_provider or source.revision_column
        else [("_shared", source.fixed_revision)]
    )
    windows, skipped = [], []
    for provider, revision in sorted(groups):
        validate_provider_id(provider)
        if providers is not None and provider not in providers:
            continue
        if type(revision) is not int or revision < 0:
            raise MigrationRefused("revision", (source.table, revision))
        where = sql.SQL(" WHERE {}=%s AND {}=%s").format(provider_expr, revision_expr)
        values = (provider, revision)
        if source.window_column is None:
            windows.append(
                PlannedWindow(
                    WindowSpec(catalog.name, provider, today.strftime("%Y-%m"), revision),
                    "whole_state",
                )
            )
        elif dataset.archive_grain == "edition":
            windows.extend(
                PlannedWindow(WindowSpec(catalog.name, provider, key, revision), "closed")
                for key in _editions(connection, table, where, values, source, provider)
            )
        else:
            row = connection.execute(
                sql.SQL(
                    "SELECT min({}), max({}), count(*) FILTER (WHERE {} IS NULL) FROM {}{}"
                ).format(
                    sql.Identifier(source.window_column),
                    sql.Identifier(source.window_column),
                    sql.Identifier(source.window_column),
                    table,
                    where,
                ),
                values,
            ).fetchone()
            assert row is not None
            first, last, missing = row
            if missing:
                raise MigrationRefused("missing_window", catalog.name)
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
) -> MigrationPlan:
    """Pin to midnight UTC unless an explicit instant on today_utc is supplied."""
    validate_timeout(statement_timeout_s)
    if not connection.autocommit or connection.info.transaction_status != TransactionStatus.IDLE:
        raise MigrationRefused("not_read_only")
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
            connection.execute("SELECT set_config(%s, %s, true)", (key, value))
        catalog = read_catalog(cast(CatalogConnection, _CatalogAdapter(connection)))
        inventory = take_inventory(catalog)
        if not inventory.complete:
            raise MigrationRefused("inventory_incomplete", asdict(inventory))
        if datasets is not None and set(datasets) - set(inventory.copied):
            raise MigrationRefused("datasets", sorted(set(datasets) - set(inventory.copied)))
        windows, skipped = [], []
        for table in catalog:
            if table.name not in inventory.copied or (
                datasets is not None and table.name not in datasets
            ):
                continue
            planned, opened = _table_windows(
                connection,
                table,
                today_utc,
                now,
                include_open,
                providers,
                get_settings().GOLD_REPORTING_OPEN_WINDOW_DAYS,
            )
            windows.extend(planned)
            skipped.extend(opened)
    return MigrationPlan(inventory, tuple(sorted(windows, key=_order)), tuple(skipped))


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
) -> MigrationSummary:
    validate_timeout(statement_timeout_s)
    if not_after.utcoffset() != timedelta(0):
        raise MigrationRefused("not_after_utc")
    if not plan.inventory.complete:
        raise MigrationRefused("inventory_incomplete")
    outcomes: dict[str, dict[str, int]] = {}
    for window in plan.windows:
        record: dict[str, object] = {"spec": asdict(window.spec)}
        started = monotonic()
        try:
            if datetime.now(UTC) >= not_after:
                raise MigrationRefused("not_after")
            from tempfile import mkdtemp

            directory = Path(mkdtemp(prefix="window-", dir=work_dir))
            with connect() as connection:
                if datetime.now(UTC) >= not_after:
                    raise MigrationRefused("not_after")
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
            return MigrationSummary(outcomes, record)
        record["seconds"] = monotonic() - started
        log(record)
        group = (
            "whole_state"
            if window.reason == "whole_state"
            else get_dataset(window.spec.dataset_id).archive_grain
        )
        counts = outcomes.setdefault(group, {})
        counts[result.outcome] = counts.get(result.outcome, 0) + 1
    return MigrationSummary(outcomes, None)
