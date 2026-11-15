"""Daily shadow selection: declared needs, exact archive windows and source-role guard.

This module plans identities only. Lake owns every payload read, copy and proof.
"""

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from psycopg import sql

from transit_ops.history.datasets import TableSource, get_dataset, utc_day_closes_at
from transit_ops.lake.alert_bundle import MEMBERS

ROLE_CAN_WRITE = """
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR EXISTS (
   SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname = ANY(%s) AND c.relkind IN ('r','p','v','m','f')
   AND (pg_has_role(c.relowner, 'USAGE')
        OR has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')))
 OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = ANY(%s)
            AND has_schema_privilege(n.oid, 'CREATE'))
"""


class PlanningReads:
    """One five-minute budget for metadata planning, including all relation keys."""

    def __init__(self, connection: Any) -> None:
        self.connection = connection
        self.deadline = monotonic() + 300

    def execute(self, query: Any, parameters: Any = None) -> Any:
        remaining = int((self.deadline - monotonic()) * 1000)
        if remaining <= 0:
            raise ValueError("not_after: metadata planning budget")
        self.connection.execute(
            "SELECT set_config('statement_timeout', %s, true)", (str(remaining),)
        )
        return self.connection.execute(query, parameters)


def assert_read_role(connection: Any) -> None:
    schemas = ["core", "raw", "silver", "gold"]
    if connection.execute(ROLE_CAN_WRITE, (schemas, schemas)).fetchone() != (False,):
        raise ValueError("role_can_write")


def window_is_open(dataset_id: str, window: str, stamp: datetime, open_days: int) -> bool:
    dataset = get_dataset(dataset_id)
    if not isinstance(dataset.source, TableSource) or dataset.source.window_column is None:
        return False
    if dataset.archive_grain == "edition":
        return False
    if dataset.archive_grain == "month":
        first = date.fromisoformat(window + "-01")
        end = date(first.year + (first.month == 12), first.month % 12 + 1, 1)
        return end - timedelta(days=1) + timedelta(days=open_days) >= stamp.date()
    return utc_day_closes_at(date.fromisoformat(window)) > stamp


def exact_windows(
    needs: Sequence[Mapping[str, str]], stamp: datetime, connection: Any
) -> tuple[str, ...]:
    """Map the declared grain, preserving provider scope and the alert exception.

    Edition ids are resolved to current source checksums, never guessed. A ranged
    `all` really requests all prior source windows; only its scoped window keys
    are read here, not payloads. The fetch resolver remains the proof authority.
    """
    windows: set[str] = set()
    for item in needs:
        relation, provider, window = item["relation"], item["provider"], item["window"]
        dataset = get_dataset(relation)
        source = dataset.source
        if not isinstance(source, TableSource):
            raise ValueError(f"input_not_archived: {relation}")
        if relation in MEMBERS:
            providers = connection.execute("SELECT provider_id FROM core.providers").fetchall()
            for row in providers:
                owner = "_shared" if relation == "silver.i3_alert_active_periods" else row[0]
                windows.add(f"{relation}:{owner}:{stamp:%Y-%m}")
        elif source.window_column is None:
            windows.add(f"{relation}:{provider}:{stamp:%Y-%m}")
        elif dataset.archive_grain == "edition":
            rows = connection.execute(
                "SELECT COALESCE(checksum_sha256,content_hash) FROM core.dataset_versions "
                "WHERE provider_id=%s AND dataset_kind='static_schedule' AND is_current",
                (provider,),
            ).fetchall()
            if len(rows) != 1 or not rows[0][0]:
                raise ValueError(f"edition_unresolved: {provider}")
            windows.add(f"{relation}:{provider}:{rows[0][0]}")
        elif window == "all":
            query = sql.SQL("SELECT min({c}) FROM {t} WHERE provider_id=%s AND {c}<%s").format(
                c=sql.Identifier(source.window_column), t=sql.Identifier(*relation.split("."))
            )
            first = connection.execute(query, (provider, stamp)).fetchone()[0]
            if first is None:
                first = stamp.date()  # Proven empty current window is still an input.
            first = first.date() if isinstance(first, datetime) else first
            current = first.replace(day=1) if dataset.archive_grain == "month" else first
            while current <= stamp.date():
                key = (
                    current.strftime("%Y-%m") if dataset.archive_grain == "month" else str(current)
                )
                windows.add(f"{relation}:{provider}:{key}")
                current = (
                    date(current.year + (current.month == 12), current.month % 12 + 1, 1)
                    if dataset.archive_grain == "month"
                    else current + timedelta(days=1)
                )
        else:
            days = [window.removeprefix("local:")]
            if (
                window.startswith("local:")
                and dataset.archive_grain != "service_day"
                and not source.window_column.endswith("local_date")
            ):
                zone = ZoneInfo(item["timezone"])
                day = date.fromisoformat(days[0])
                first = datetime.combine(day, time(), zone).astimezone(UTC).date()
                end = (
                    datetime.combine(day + timedelta(days=1), time(), zone).astimezone(UTC)
                    - timedelta(microseconds=1)
                ).date()
                days = [str(first + timedelta(days=i)) for i in range((end - first).days + 1)]
            for day_key in days:
                key = day_key[:7] if dataset.archive_grain == "month" else day_key
                windows.add(f"{relation}:{provider}:{key}")
    return tuple(sorted(windows))


def require_window_support(
    needs: Sequence[Mapping[str, str]], stamp: datetime, *, exact_selection: bool = True
) -> None:
    """LS1.9e ships --window and fixed-cut copies together; refuse on older code."""
    from inspect import signature

    from transit_ops.commands.lake import migrate
    from transit_ops.settings import Settings

    if "window" in signature(migrate).parameters:
        return
    for item in needs:
        dataset = get_dataset(item["relation"])
        if isinstance(dataset.source, TableSource) and dataset.source.window_column:
            window = item["window"].removeprefix("local:")
            if dataset.archive_grain == "edition":
                continue
            if window == "all":
                window = (
                    stamp.strftime("%Y-%m")
                    if dataset.archive_grain == "month"
                    else str(stamp.date())
                )
            elif dataset.archive_grain == "month":
                window = window[:7]
            if window_is_open(
                item["relation"], window, stamp, Settings().GOLD_REPORTING_OPEN_WINDOW_DAYS
            ):
                raise ValueError("open_window_unsupported: requires LS1.9e")
    if exact_selection:
        raise ValueError("window_selection_unsupported: requires LS1.9e")


def assert_timezone(root: Any, provider: str, expected: str) -> None:
    import duckdb

    with duckdb.connect() as conn:
        rows = conn.execute(
            "SELECT timezone FROM read_parquet(?, hive_partitioning=false) WHERE provider_id=?",
            [str(root / "core.providers/all.parquet"), provider],
        ).fetchall()
    if rows != [(expected,)]:
        raise ValueError("timezone_mismatch")


def group_deadline(providers: int, *, now: datetime | None = None) -> datetime:
    # A separate group invocation: 300s planning + 60s connection/startup reserve.
    return (now or datetime.now(UTC)) + timedelta(seconds=(2 * providers + 7) * 300 + 600 + 360)


def assert_group_deadline(deadline: datetime, providers: int) -> None:
    if datetime.now(UTC) + timedelta(seconds=(2 * providers + 7) * 300 + 600) >= deadline:
        raise ValueError("not_after")
