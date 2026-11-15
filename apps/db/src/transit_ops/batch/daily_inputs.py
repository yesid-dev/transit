"""Daily shadow selection: declared needs, exact archive windows and source-role guard.

This module plans identities only. Lake owns every payload read, copy and proof.
"""

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.history.datasets import TableSource, get_dataset, utc_day_closes_at
from transit_ops.lake.alert_bundle import MEMBERS

ROLE_CAN_WRITE = """
WITH reachable AS (
 SELECT oid, rolsuper FROM pg_roles
 WHERE rolname=current_user OR pg_has_role(current_user, oid, 'MEMBER'))
SELECT EXISTS (SELECT 1 FROM reachable WHERE rolsuper)
 OR EXISTS (
   SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN reachable r WHERE n.nspname = ANY(%s) AND CASE
     WHEN c.relkind IN ('r','p','v','m','f') THEN (
       pg_has_role(r.oid, c.relowner, 'MEMBER')
       OR has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
       OR has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE'))
     WHEN c.relkind='S' THEN (pg_has_role(r.oid, c.relowner, 'MEMBER')
                            OR has_sequence_privilege(r.oid, c.oid, 'USAGE,UPDATE'))
     ELSE false END)
 OR EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN reachable r
            WHERE n.nspname = ANY(%s) AND has_schema_privilege(r.oid, n.oid, 'CREATE'))
 OR EXISTS (SELECT 1 FROM reachable r
            WHERE has_database_privilege(r.oid, current_database(), 'CREATE'))
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

    Edition ids are resolved to current source checksums, never guessed.
    Unbounded ranged needs refuse before any source query. The fetch resolver
    remains the proof authority; parent closure is never silently narrowed.
    """
    windows: set[str] = set()
    require_bounded_needs(needs)
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
            raise ValueError(f"unbounded_window_need: {relation}")
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


def require_bounded_needs(needs: Sequence[Mapping[str, str]]) -> None:
    for item in needs:
        source = get_dataset(item["relation"]).source
        if (
            item["relation"] not in MEMBERS
            and item["window"] == "all"
            and isinstance(source, TableSource)
            and source.window_column is not None
        ):
            raise ValueError(f"unbounded_window_need: {item['relation']}")


def lake_capabilities() -> tuple[bool, set[str]]:
    from dataclasses import fields

    from typer.main import get_command

    from transit_ops.commands import lake
    from transit_ops.lake.table_export import WindowSpec

    command = getattr(get_command(lake.app), "commands", {}).get("migrate")
    options = {
        option for param in getattr(command, "params", ()) for option in getattr(param, "opts", ())
    }
    return "cut_utc" in {field.name for field in fields(WindowSpec)}, options


def require_group_reserve_support() -> None:
    cuts, options = lake_capabilities()
    if not cuts or not {"--window", "--group-reserve-s"} <= options:
        raise ValueError("group_reserve_unsupported")


def require_window_support(
    needs: Sequence[Mapping[str, str]], stamp: datetime, *, exact_selection: bool = True
) -> None:
    """LS1.9e ships --window and fixed-cut copies together; refuse on older code."""
    from transit_ops.settings import Settings

    cuts, options = lake_capabilities()
    if cuts and "--window" in options:
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
        reason = (
            "window_selection_unsupported"
            if "--window" not in options
            else "open_window_unsupported"
        )
        raise ValueError(f"{reason}: requires LS1.9e fixed cuts")


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
