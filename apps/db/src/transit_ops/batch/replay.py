"""Replay declared local files in a guarded disposable database and DuckDB."""

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from datetime import date, datetime
from pathlib import Path
from time import perf_counter
from typing import Any, cast
from zoneinfo import ZoneInfo

import duckdb
from psycopg.errors import ForeignKeyViolation
from sqlalchemy import Connection, inspect, text
from sqlalchemy.engine.reflection import Inspector
from sqlalchemy.exc import IntegrityError

from transit_ops.batch.build import BuildRequest, FamilyBuilder, FamilyOutput, InputNeed
from transit_ops.batch.editions import reads_editions, with_editions
from transit_ops.batch.engine import open_batch_session
from transit_ops.batch.families.registry import FAMILIES, resolve_builder
from transit_ops.batch.input_sources import edition_mapping, layout_needs
from transit_ops.batch.inputs import resolve_inputs
from transit_ops.batch.pg_load import (
    ReplayDatabase,
    ReplayDatabaseRefused,
    load_inputs,
    pinned_replay_engine,
    reset_replay_tables,
)
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.private_area import PrivateArea
from transit_ops.batch.replay_report import ReplayReport, compare_family
from transit_ops.batch.run import InputChanged, key_matches, run_family
from transit_ops.gold import rollups
from transit_ops.history.datasets import TableSource, get_dataset
from transit_ops.settings import Settings
from transit_ops.snapshots import gate, historic_tier
from transit_ops.snapshots.historic_streams import (
    HistoricParentComposer,
    HistoricPlans,
    consume_history_children,
    consume_point_days,
)
from transit_ops.snapshots.protocols import SnapshotPayload
from transit_ops.snapshots.serialization import snapshot_json_bytes
from transit_ops.sql_registry import named_query

# Reserved slots also have PostgreSQL outputs before their DuckDB builder exists.
_TABLES = {
    "route_spine_hours": ("trip_delay_summary_5m", "route_delay_hourly", "route_delay_spine"),
    "stop_spine_hours": ("stop_delay_spine", "stop_delay_shift_daily", "stop_delay_hourly"),
    "percentiles_histograms": ("route_delay_percentile_daily", "stop_delay_percentile_daily"),
    "cancellations_service_states": ("route_scheduled_trips_daily", "route_cancellation_daily"),
    "headways": (
        "route_headway_by_shift",
        "route_headway_by_direction_shift",
        "route_headway_shift_daily",
    ),
    "span_skipped_stops": ("route_service_span_daily", "route_skipped_stop_daily"),
    "occupancy_crowding": (
        "route_occupancy_band_daily",
        "route_occupancy_band_hourly",
        "stop_occupancy_band_daily",
        "route_delay_by_crowding_daily",
    ),
    "repeat_offenders": (
        "repeat_offender_daily_spine",
        "repeat_offender",
        "repeated_problem_route_stop",
    ),
    "receipts": ("citizen_accountability_daily",),
}
_FACTS = (
    "gold.fact_trip_delay_snapshot",
    "gold.fact_vehicle_snapshot",
    "raw.realtime_snapshot_index",
)
_STATE = (
    "core.providers",
    "core.dataset_versions",
    "core.feed_endpoints",
    "raw.ingestion_runs",
    "raw.ingestion_objects",
    "gold.dim_route_history",
    "gold.dim_stop_history",
    "raw.i3_alert_snapshots",
    "silver.i3_alerts",
    "silver.i3_alert_active_periods",
    "silver.i3_alert_informed_entities",
)
_EDITIONS = (
    "silver.trips",
    "silver.calendar",
    "silver.calendar_dates",
    "silver.stop_times",
)


def postgres_input_needs(request: BuildRequest, editions: Sequence[int]) -> tuple[InputNeed, ...]:
    """Replay metadata and selected schedule editions; family declarations are added separately."""
    metadata = (InputNeed("core.dataset_versions", "all"),) if editions else ()
    return (
        (InputNeed("core.providers", "all"),)
        + metadata
        + tuple(InputNeed(r, f"edition:{ident}") for r in _EDITIONS for ident in editions)
    )


def replay_builders(families: Sequence[str]) -> dict[str, FamilyBuilder]:
    selected = tuple(families) if families else tuple(FAMILIES)
    if len(set(selected)) != len(selected):
        raise ValueError("duplicate family_id")
    builders = {}
    for family in selected:
        builder = resolve_builder(family)
        if builder is None:
            raise ValueError(f"family_not_replayable: {family}")
        if not isinstance(builder, FamilyBuilder):
            raise ValueError(f"{family}: invalid builder")
        builders[family] = builder
    return builders


def family_input_needs(
    builders: Sequence[FamilyBuilder],
    request: BuildRequest,
) -> tuple[InputNeed, ...]:
    needs = set()
    for builder in builders:
        for need in builder.inputs(request):
            try:
                declaration = get_dataset(need.relation)
            except LookupError:
                raise ValueError(
                    f"input_not_archived: {builder.family_id} {need.relation}"
                ) from None
            if not isinstance(declaration.source, TableSource):
                raise ValueError(f"input_not_archived: {builder.family_id} {need.relation}")
            needs.add(need)
    return tuple(sorted(needs, key=lambda n: (n.relation, n.window)))


def parent_input_needs(
    needs: Sequence[InputNeed],
    catalog: Inspector,
    requires_parent: Callable[[InputNeed, Mapping[str, Any]], bool] | None = None,
) -> tuple[InputNeed, ...]:
    """Use the migrated disposable catalog, preserving children's requested ranges."""
    found, pending, parents = set(needs), list(needs), {}
    while pending:
        child = pending.pop()
        if child.relation not in parents:
            schema, table = child.relation.split(".")
            parents[child.relation] = catalog.get_foreign_keys(table, schema=schema)
        for fk in parents[child.relation]:
            if requires_parent is not None and not requires_parent(child, fk):
                continue
            relation = (
                f"{fk['referred_schema'] or child.relation.split('.')[0]}.{fk['referred_table']}"
            )
            try:
                source = get_dataset(relation).source
            except LookupError:
                raise ValueError(f"input_not_archived: FK parent {relation}") from None
            if not isinstance(source, TableSource):
                raise ValueError(f"input_not_archived: FK parent {relation}")
            parent = InputNeed(relation, child.window if source.window_column else "all")
            if parent not in found:
                found.add(parent)
                pending.append(parent)
    return tuple(sorted(found, key=lambda n: (n.relation, n.window)))


def local_parent_references(
    child: InputNeed,
    fk: Mapping[str, Any],
    root: Path,
    workdir: Path,
) -> bool:
    """Apply actual FK null semantics to the declared local child rows."""
    if child.relation in _STATE and (root / child.relation / "all.parquet").is_file():
        child = InputNeed(child.relation, "all")  # The merged local metadata snapshot contract.
    columns = fk.get("constrained_columns")
    if (
        not isinstance(columns, (list, tuple))
        or not columns
        or any(not isinstance(c, str) or not c for c in columns)
    ):
        raise ValueError(f"invalid FK columns: {child.relation}")
    predicate = " AND ".join('"' + c.replace('"', '""') + '" IS NOT NULL' for c in columns)
    sql = f"SELECT EXISTS (SELECT 1 FROM {child.relation} WHERE {predicate})"
    # The registry is global; different relations/FK shapes need different stable names.
    name = "batch.replay.parent_references.q_" + hashlib.sha256(sql.encode()).hexdigest()
    inputs = resolve_inputs((child,), root)
    with PrivateArea(workdir) as area, open_batch_session(inputs, workdir=area) as session:
        return bool(session.execute(named_query(name, sql)).scalar_one())


def _legacy_state_needs(root: Path) -> tuple[InputNeed, ...]:
    """Keep existing declared metadata snapshots; unread working-only tables stay empty."""
    from transit_ops.lake.alert_bundle import MEMBERS

    result = []
    for relation in _STATE:
        if relation in MEMBERS and not (root / "alert-bundle.json").is_file():
            continue  # Unread legacy alert files are not archived bundle inputs.
        try:
            source = get_dataset(relation).source
        except LookupError:
            continue
        if isinstance(source, TableSource) and (root / relation / "all.parquet").is_file():
            result.append(InputNeed(relation, "all"))
    return tuple(result)


def absent_unread(needs: Sequence[InputNeed]) -> tuple[dict[str, str], ...]:
    required = {n.relation for n in needs}
    absent = []
    for relation in sorted(set(_STATE + _FACTS + _EDITIONS) - required):
        try:
            get_dataset(relation)
        except LookupError:
            absent.append(
                dict(
                    relation=relation,
                    status="absent_unread",
                    reason="unread relation has no archive declaration",
                )
            )
    return tuple(absent)


def _hashes(root: Path, needs: Sequence[InputNeed]) -> tuple[tuple[str, str], ...]:
    result = []
    for item in resolve_inputs(needs, root):
        for path in item.files:
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            result.append((path.relative_to(root.resolve()).as_posix(), digest))
    return tuple(sorted(result))


def _postgres_output(
    conn: Connection, provider: str, day: date, tables: Sequence[str], timezone: str
) -> FamilyOutput:
    catalog = inspect(conn)
    result = {}
    for relation in tables:
        schema, table = relation.split(".")
        columns = {c["name"] for c in catalog.get_columns(table, schema=schema)}
        key = catalog.get_pk_constraint(table, schema=schema)["constrained_columns"]
        date_column = "provider_local_date" if "provider_local_date" in columns else None
        result[relation] = read_table_rows(
            conn, relation, key, provider_id=provider, local_dates=(day,) if date_column else None
        )
        if "period_start_utc" in columns:
            table_rows = result[relation]
            index = table_rows.columns.index("period_start_utc")
            result[relation] = replace(
                table_rows,
                rows=tuple(
                    row
                    for row in table_rows.rows
                    if cast(datetime, row[index]).astimezone(ZoneInfo(timezone)).date() == day
                ),
            )
    return FamilyOutput(result, {})


def _collect_bodies(
    conn: Connection, provider: str, settings: Settings, stamp: datetime
) -> dict[str, bytes]:
    collected = historic_tier.collect(
        conn,
        provider_id=provider,
        settings=settings,
        as_of_utc=stamp,
        include=("archive", "network", "lines", "stops", "points"),
    )
    items = cast(
        list[tuple[str, SnapshotPayload]], list(collected.all_items + collected.route_items)
    )
    report = gate.new_report(provider, "historic", collected.stamp)
    parents = HistoricParentComposer(provider, collected.stamp, report)

    def capture(batch: Sequence[tuple[str, SnapshotPayload]]) -> list[str]:
        items.extend(batch)
        return [key for key, _ in batch]

    children = consume_history_children(
        HistoricPlans(collected.network_history, collected.line_history, collected.stop_history),
        report,
        batch_size=32,
        write_batch=capture,
        force=True,
    )
    if collected.network_history:
        items.append(parents.network_index(collected.network_history, children.network))
    if collected.line_history:
        indexes = parents.line_indexes(children.lines, children.line_gate)
        items.extend(indexes.items)
        items.append(parents.line_directory(indexes, children.lines))
    if collected.stop_history:
        stops = parents.stop_indexes(
            children.stops.iter_indexes(fallback_generated_utc=collected.stamp), children.stop_gate
        )
        items.extend((item.path, item.payload) for item in stops.items)
        items.append(parents.stop_directory(stops))
    if collected.point_plans:

        class MemorySink:
            def put_json(self, rel_key: str, payload: SnapshotPayload, *, tier: str) -> str:
                items.append((rel_key, payload))
                return rel_key

            def put_immutable_json(self, rel_key: str, payload: SnapshotPayload) -> str:
                items.append((rel_key, payload))
                return rel_key

        for family, plan in (
            ("hotspots", collected.point_plans.hotspots),
            ("repeat_offenders", collected.point_plans.repeat_offenders),
        ):
            summary, _ = consume_point_days(
                plan, family=family, report=report, storage=MemorySink(), force=True
            )
            items.append(parents.point_index(summary))
    if collected.alert_archive:
        items.extend(collected.alert_archive.page_items)
    return {k: snapshot_json_bytes(p) for k, p in items}


def validate_alert_bundle(root: Path, request: BuildRequest) -> tuple[tuple[str, str], ...]:
    """Pin the local replay manifest, including transformed-file identity and coverage."""
    from transit_ops.lake.alert_bundle import MEMBERS

    path = root / "alert-bundle.json"
    if not path.is_file():
        raise ValueError("missing alert-bundle.json: silver.i3_alerts")
    body = path.read_bytes()
    bundles = json.loads(body)
    if not isinstance(bundles, list) or len(bundles) != 1:
        raise ValueError("one alert bundle version is required")
    bundle = bundles[0]
    stamp = datetime.fromisoformat(bundle["snapshot_at_utc"])
    coverage = datetime.fromisoformat(bundle["coverage_from_utc"])
    from transit_ops.lake.alert_bundle import CLOSURE_RELATIONS, validate_coverage

    validate_coverage(stamp, coverage, request.local_dates, request.timezone, request.as_of_utc)
    for relation in (*MEMBERS, *CLOSURE_RELATIONS):
        file = root / relation / "all.parquet"
        if not file.is_file():
            raise ValueError(f"missing bundle member: {relation}")
        if hashlib.sha256(file.read_bytes()).hexdigest() != bundle["files"].get(relation):
            raise ValueError(f"bundle member changed: {relation}")
    return (("alert-bundle.json", hashlib.sha256(body).hexdigest()),)


def validate_parent_rows(inputs: Sequence[Any], catalog: Inspector) -> None:
    """Refuse missing FK keys by parent name before resetting or loading PostgreSQL."""
    with duckdb.connect(config={"threads": 1}) as conn:
        views = {}
        for i, item in enumerate(inputs):
            view = f"input_{i}"
            conn.read_parquet([str(p) for p in item.files], hive_partitioning=False).create_view(
                view
            )
            views[item.relation] = view
        for item in inputs:
            schema, table = item.relation.split(".")
            for fk in catalog.get_foreign_keys(table, schema=schema):
                parent = f"{fk['referred_schema'] or schema}.{fk['referred_table']}"
                columns = fk["constrained_columns"]

                def quoted(c: str) -> str:
                    return '"' + c.replace('"', '""') + '"'

                present = " AND ".join(f"c.{quoted(c)} IS NOT NULL" for c in columns)
                predicate = present
                if parent in views:
                    join = " AND ".join(
                        f"c.{quoted(c)}=p.{quoted(p)}"
                        for c, p in zip(columns, fk["referred_columns"], strict=True)
                    )
                    predicate += f" AND NOT EXISTS (SELECT 1 FROM {views[parent]} p WHERE {join})"
                missing = conn.execute(
                    f"SELECT EXISTS (SELECT 1 FROM {views[item.relation]} c WHERE {predicate})"
                ).fetchone()
                if missing == (True,):
                    raise ValueError(
                        f"fk_parent_outside_range: {parent} referenced by {item.relation}"
                    )


def replay_day(
    *,
    engine: ReplayDatabase,
    provider_id: str,
    local_date: date,
    as_of_utc: datetime,
    inputs_root: Path,
    workdir: Path,
    families: Sequence[str],
    code_commit: str,
    publish_bodies: bool,
) -> ReplayReport:
    """Compare available families; exit zero alone does not establish completeness.

    ``engine`` is the opaque capability returned by prepare_replay_database.
    The database is reset, including foreign-key dependents of loaded relations.
    """
    if not isinstance(engine, ReplayDatabase):
        raise ReplayDatabaseRefused("Use prepare_replay_database")
    ReplayReport(provider_id, local_date, as_of_utc, code_commit)
    builders = replay_builders(families)
    provider_input = resolve_inputs((InputNeed("core.providers", "all"),), inputs_root)
    provider_hash = _hashes(inputs_root, (InputNeed("core.providers", "all"),))
    with PrivateArea(workdir) as area, open_batch_session(provider_input, workdir=area) as session:
        timezone = session.execute(
            named_query(
                "batch.replay.provider_timezone",
                "SELECT timezone FROM core.providers WHERE provider_id=:p",
            ),
            {"p": provider_id},
        ).scalar_one()
    settings = Settings()
    request = BuildRequest(
        provider_id,
        (local_date,),
        as_of_utc,
        settings.GOLD_FACT_RETENTION_DAYS,
        settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
        str(timezone),
    )
    metadata_hash: tuple[tuple[str, str], ...] = ()
    requests = dict.fromkeys(builders, request)
    schedule_ids: tuple[int, ...] = ()
    if reads_editions(builders):
        metadata_need = (InputNeed("core.dataset_versions", "all"),)
        metadata_file = resolve_inputs(metadata_need, inputs_root)[0].files[0]
        metadata_hash = _hashes(inputs_root, metadata_need)
        editions = edition_mapping(metadata_file, provider_id)
        requests = {family: with_editions(request, (family,), editions.rows) for family in builders}
        schedule_ids = editions.schedule_ids
    needs = set(postgres_input_needs(request, schedule_ids))
    for family, builder in builders.items():
        needs.update(family_input_needs((builder,), requests[family]))
    from transit_ops.batch.input_sources import bundle_needs

    needs.update(bundle_needs(tuple(needs)))
    needs.update(_legacy_state_needs(inputs_root))
    needed = parent_input_needs(
        tuple(needs),
        inspect(engine.engine),
        lambda child, fk: local_parent_references(child, fk, inputs_root, workdir),
    )
    ordered_needs = layout_needs(needed)
    before = _hashes(inputs_root, ordered_needs)
    if not set(provider_hash) <= set(before):
        raise InputChanged("core.providers: replay input changed while reading timezone")
    if not set(metadata_hash) <= set(before):
        raise InputChanged("core.dataset_versions: replay input changed while reading editions")
    inputs = resolve_inputs(ordered_needs, inputs_root, provider_id=provider_id)
    from transit_ops.lake.alert_bundle import MEMBERS

    bundle_hashes = (
        validate_alert_bundle(inputs_root, request)
        if any(n.relation in MEMBERS for n in needed)
        else ()
    )
    if bundle_hashes:
        validate_parent_rows(inputs, inspect(engine.engine))
    started = perf_counter()
    with pinned_replay_engine(engine, as_of_utc) as pinned, PrivateArea(workdir) as area:
        catalog = inspect(pinned)
        load_order = [
            f"{schema}.{name}"
            for schema in ("core", "raw", "silver", "gold")
            for name in catalog.get_table_names(schema=schema)
        ]
        # PostgreSQL chooses dependency order; include FK descendants explicitly, never CASCADE.
        with pinned.connect() as conn:
            resets = (
                conn.execute(
                    text("""WITH RECURSIVE targets(oid) AS (
                SELECT unnest(CAST(:names AS regclass[]))::oid UNION
                SELECT c.conrelid FROM pg_constraint c JOIN targets t ON c.confrelid=t.oid
                WHERE c.contype='f') SELECT oid::regclass::text FROM targets"""),
                    {
                        "names": [i.relation for i in inputs]
                        + list(_STATE + _FACTS + _EDITIONS)
                        + ["gold." + t for ts in _TABLES.values() for t in ts]
                        + ["gold.warm_rollup_periods"]
                    },
                )
                .scalars()
                .all()
            )
        reset_replay_tables(engine, resets)
        # A topological order across schemas, including the raw/core edition cycle's parents.
        pending = {item.relation: item for item in inputs}
        while pending:
            ready = [
                r
                for r in load_order
                if r in pending
                and not any(
                    f"{fk['referred_schema'] or r.split('.')[0]}.{fk['referred_table']}" in pending
                    for fk in catalog.get_foreign_keys(r.split(".")[1], schema=r.split(".")[0])
                )
            ]
            if not ready:
                raise ValueError(f"replay inputs: foreign-key cycle {sorted(pending)}")
            for relation in ready:
                try:
                    load_inputs(engine, (pending.pop(relation),), area)
                except (IntegrityError, ForeignKeyViolation) as error:
                    if getattr(getattr(error, "orig", error), "sqlstate", None) != "23503":
                        raise
                    windows = sorted(n.window for n in needed if n.relation == relation)
                    raise ValueError(f"fk_parent_outside_range: {relation} {windows}") from error
        rollups.build_warm_rollups(
            provider_id,
            engine=pinned,
            settings=settings,
            as_of_utc=as_of_utc,
            wall_clock_utc=as_of_utc,
        )
        outputs = {}
        with pinned.connect() as conn:
            for family, builder in builders.items():
                tables = (
                    builder.tables
                    if builder
                    else tuple("gold." + t for t in _TABLES.get(family, ()))
                )
                outputs[family] = _postgres_output(
                    conn, provider_id, local_date, tables, request.timezone
                )
            if publish_bodies:
                bodies = _collect_bodies(conn, provider_id, settings, as_of_utc)
                for family, builder in builders.items():
                    if builder:
                        outputs[family] = FamilyOutput(
                            outputs[family].tables,
                            {
                                k: v
                                for k, v in bodies.items()
                                if key_matches(k, builder.published_keys)
                            },
                        )
    postgres_seconds = perf_counter() - started
    started = perf_counter()
    comparisons = []
    for family, builder in builders.items():
        result = (
            run_family(
                builder,
                requests[family],
                inputs_root=inputs_root,
                workdir=workdir,
                code_commit=code_commit,
            )
            if builder and (publish_bodies or not builder.published_keys)
            else None
        )
        comparisons.append(
            compare_family(family, builder, outputs[family], result, bodies_loaded=publish_bodies)
        )
    if _hashes(inputs_root, ordered_needs) != before:
        raise InputChanged("replay input files changed")
    if bundle_hashes and validate_alert_bundle(inputs_root, request) != bundle_hashes:
        raise InputChanged("alert-bundle.json changed")
    return ReplayReport(
        provider_id,
        local_date,
        as_of_utc,
        code_commit,
        input_files=tuple(sorted(before + bundle_hashes)),
        families=tuple(comparisons),
        postgres_seconds=postgres_seconds,
        duckdb_seconds=perf_counter() - started,
    )
