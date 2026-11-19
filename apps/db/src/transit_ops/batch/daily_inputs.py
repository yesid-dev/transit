"""Daily shadow selection: declared needs, exact archive windows and source-role guard.

This module plans identities only. Lake owns every payload read, copy and proof.
"""

from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, time, timedelta
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from transit_ops.batch.build import InputNeed
from transit_ops.history.datasets import TableSource, get_dataset, utc_day_closes_at
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.alert_bundle import MEMBERS
from transit_ops.lake.edition_assignments import archive_assignments
from transit_ops.lake.edition_identity import edition_keys

EDITION_METADATA = "core.dataset_versions"
# Windowed FK parents of the whole-state edition metadata (migration 0093).
EDITION_PARENTS = ("raw.ingestion_objects", "raw.ingestion_runs")
# Months holding the parent rows the provider's edition metadata rows reference.
EDITION_REFERENCES = "edition_refs"

# Row-aware closure (R27b.2): every edition metadata row the replay loads, then
# its parent rows by primary key. The provider predicate uses the leading column
# of ix_dataset_versions_provider_endpoint_loaded; no aggregate or range scan.
EDITION_REFERENCE_MONTHS = """
WITH versions AS MATERIALIZED (
 SELECT v.source_ingestion_object_id, v.source_ingestion_run_id
 FROM core.dataset_versions v WHERE v.provider_id = %s),
objects AS MATERIALIZED (
 SELECT o.provider_id, o.ingestion_run_id, o.created_at_utc
 FROM versions v JOIN raw.ingestion_objects o
   ON o.ingestion_object_id = v.source_ingestion_object_id),
run_ids AS (
 SELECT source_ingestion_run_id AS ingestion_run_id FROM versions
 UNION SELECT ingestion_run_id FROM objects)
SELECT 'raw.ingestion_objects', provider_id,
       to_char(created_at_utc AT TIME ZONE 'UTC', 'YYYY-MM') FROM objects
UNION
SELECT 'raw.ingestion_runs', r.provider_id,
       to_char(r.started_at_utc AT TIME ZONE 'UTC', 'YYYY-MM')
FROM run_ids i JOIN raw.ingestion_runs r ON r.ingestion_run_id = i.ingestion_run_id
ORDER BY 1, 2, 3
"""


def bound_edition_parents(needs: Sequence[InputNeed]) -> tuple[tuple[str, str], ...]:
    """Logical (relation, window) needs with whole-history edition FK parents bounded.

    Only parents reached from the whole-state edition metadata qualify; any other
    unbounded need keeps its ``all`` window and is refused by require_bounded_needs.
    In the 0093 catalog no other ``all`` child reaches these parents; if one ever
    does, the fetch row-closure check and replay's FK load refuse instead.
    """
    edition = InputNeed(EDITION_METADATA, "all") in needs
    return tuple(
        sorted(
            {
                (n.relation, EDITION_REFERENCES)
                if edition and n.relation in EDITION_PARENTS and n.window == "all"
                else (n.relation, n.window)
                for n in needs
            }
        )
    )


def edition_reference_windows(
    needs: Sequence[Mapping[str, str]], connection: Any
) -> dict[str, list[str]]:
    """Exact parent windows per edition-reading provider, by primary-key joins."""
    providers = sorted({item["provider"] for item in needs if item["window"] == EDITION_REFERENCES})
    result = {}
    for provider in providers:
        rows = connection.execute(EDITION_REFERENCE_MONTHS, (provider,)).fetchall()
        result[provider] = sorted(f"{relation}:{owner}:{month}" for relation, owner, month in rows)
    return result


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


def current_edition_key(connection: Any, provider: str, storage: BronzeStorage | None) -> str:
    """The lake's archive name for the provider's current schedule edition.

    Lake names an edition digest.vID unless the archive proves a legacy bare-digest
    name for that ID; a bare checksum alone never selects a newly named edition.
    """
    rows = connection.execute(
        "SELECT dataset_version_id, COALESCE(checksum_sha256,content_hash) "
        "FROM core.dataset_versions "
        "WHERE provider_id=%s AND dataset_kind='static_schedule' AND is_current",
        (provider,),
    ).fetchall()
    if len(rows) != 1 or not rows[0][1]:
        raise ValueError(f"edition_unresolved: {provider}")
    ident, digest = rows[0]
    assigned = archive_assignments(storage, provider, [digest])
    return edition_keys([(ident, digest, None)], assignments=assigned)[ident]


def exact_windows(
    needs: Sequence[Mapping[str, str]],
    stamp: datetime,
    connection: Any,
    references: Mapping[str, Sequence[str]] | None = None,
    storage: BronzeStorage | None = None,
) -> tuple[str, ...]:
    """Map the declared grain, preserving provider scope and the alert exception.

    Edition ids are resolved to the lake's current edition names, never guessed;
    the archive supplies legacy names (none without storage).
    Unbounded ranged needs refuse before any source query. The fetch resolver
    remains the proof authority; parent closure is never silently narrowed:
    edition FK parents select exactly the months their referenced rows occupy.
    """
    windows: set[str] = set()
    editions: dict[str, str] = {}
    require_bounded_needs(needs)
    if references is None:
        references = edition_reference_windows(needs, connection)
    for item in needs:
        relation, provider, window = item["relation"], item["provider"], item["window"]
        dataset = get_dataset(relation)
        source = dataset.source
        if not isinstance(source, TableSource):
            raise ValueError(f"input_not_archived: {relation}")
        if window == EDITION_REFERENCES:
            windows.update(w for w in references.get(provider, ()) if w.split(":")[0] == relation)
        elif relation in MEMBERS:
            providers = connection.execute("SELECT provider_id FROM core.providers").fetchall()
            for row in providers:
                owner = "_shared" if relation == "silver.i3_alert_active_periods" else row[0]
                windows.add(f"{relation}:{owner}:{stamp:%Y-%m}")
        elif source.window_column is None:
            windows.add(f"{relation}:{provider}:{stamp:%Y-%m}")
        elif dataset.archive_grain == "edition":
            if provider not in editions:
                editions[provider] = current_edition_key(connection, provider, storage)
            windows.add(f"{relation}:{provider}:{editions[provider]}")
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
        if item["window"] == EDITION_REFERENCES:
            if item["relation"] not in EDITION_PARENTS:
                raise ValueError(f"unbounded_window_need: {item['relation']}")
            continue
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


def _complete_shadow_capabilities(cuts: bool, options: set[str]) -> bool:
    return cuts and {"--window", "--group-reserve-s"} <= options


def require_group_reserve_support() -> None:
    cuts, options = lake_capabilities()
    if not _complete_shadow_capabilities(cuts, options):
        raise ValueError("group_reserve_unsupported")


def require_window_support(
    needs: Sequence[Mapping[str, str]], stamp: datetime, *, exact_selection: bool = True
) -> None:
    """LS1.9e ships --window and fixed-cut copies together; refuse on older code."""
    from transit_ops.settings import Settings

    cuts, options = lake_capabilities()
    if _complete_shadow_capabilities(cuts, options):
        return
    for item in needs:
        dataset = get_dataset(item["relation"])
        if isinstance(dataset.source, TableSource) and dataset.source.window_column:
            window = item["window"].removeprefix("local:")
            if dataset.archive_grain == "edition":
                continue
            if window in {"all", EDITION_REFERENCES}:
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
