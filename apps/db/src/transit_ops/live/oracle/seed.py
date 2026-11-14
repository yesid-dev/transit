"""Seed the old live path with the recorded provider and schedule edition."""

from dataclasses import asdict
from datetime import datetime

from sqlalchemy import Connection, Engine, bindparam, text
from sqlalchemy.dialects.postgresql import JSONB

from transit_ops.gold.marts import refresh_gold_static
from transit_ops.gold.realtime import initialize_realtime_serving
from transit_ops.history.poll_record import CaptureEntry, PollRecord
from transit_ops.history.reader_bytes import object_payload
from transit_ops.ingestion.i3 import extract_i3_metadata, extract_service_alerts_metadata
from transit_ops.ingestion.storage import BronzeStorageResolver
from transit_ops.live.oracle.database import OracleDatabase, OracleDatabaseRefused
from transit_ops.live.oracle.window import ReplayWindow
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings
from transit_ops.silver.static_gtfs import BronzeStaticArchive, load_static_zip_to_silver


class SeedRefused(RuntimeError):
    pass


def _owned_engine(oracle: OracleDatabase) -> Engine:
    if type(oracle) is not OracleDatabase:
        raise SeedRefused("active owned oracle required")
    try:
        return oracle.engine
    except OracleDatabaseRefused as exc:
        raise SeedRefused(str(exc)) from exc


def seed_static(
    oracle: OracleDatabase,
    window: ReplayWindow,
    *,
    settings: Settings,
    registry: ProviderRegistry,
    bronze: BronzeStorageResolver,
) -> None:
    """The caller pins the database clock to the window's serving initialization time."""
    from transit_ops.cli import _seed_provider

    engine = _owned_engine(oracle)
    manifest = registry.get_provider(window.provider_id)
    strict = manifest.provider.strict_gtfs
    endpoints = {seed.endpoint_key: seed for seed in manifest.to_feed_endpoint_seeds(settings)}
    for key in window.feed_endpoints:
        if key not in endpoints:
            raise SeedRefused(f"endpoint {key} is not declared by the provider manifest")
    static = manifest.static_feed().endpoint_key
    if window.feed_endpoints.get(static) != window.edition.feed_endpoint_id:
        raise SeedRefused(f"edition feed_endpoint_id does not match endpoint {static}")
    with engine.begin() as connection:
        _seed_provider(connection, manifest)
        for key, endpoint_id in window.feed_endpoints.items():
            params = endpoints[key].as_params() | {"feed_endpoint_id": endpoint_id}
            columns = ", ".join(params)
            values = ", ".join(f":{column}" for column in params)
            connection.execute(
                text(f"INSERT INTO core.feed_endpoints ({columns}) VALUES ({values})"), params
            )
        _seed_edition(connection, window)
        archive = _archive(window, bronze)
        load_static_zip_to_silver(
            connection,
            archive=archive,
            bronze_storage=bronze(window.edition.storage_backend),
            strict_gtfs=strict if strict is not None else settings.STRICT_GTFS,
        )
    refresh_gold_static(window.provider_id, settings=settings, registry=registry, engine=engine)
    realtime = sorted(window.feed_endpoints.keys() & {"trip_updates", "vehicle_positions"})
    initialize_realtime_serving(window.provider_id, realtime, engine=engine, settings=settings)
    with engine.begin() as connection:
        _advance_sequences(connection)


def _seed_edition(connection: Connection, window: ReplayWindow) -> None:
    params = asdict(window.edition) | {"provider_id": window.provider_id}
    connection.execute(
        text("""
        INSERT INTO raw.ingestion_runs
            (ingestion_run_id, provider_id, feed_endpoint_id, run_kind, status,
             requested_at_utc, started_at_utc, completed_at_utc)
        VALUES (:ingestion_run_id, :provider_id, :feed_endpoint_id, 'static_schedule',
                'succeeded', :requested_at_utc, :started_at_utc, :completed_at_utc)
    """),
        params,
    )
    connection.execute(
        text("""
        INSERT INTO raw.ingestion_objects
            (ingestion_object_id, ingestion_run_id, provider_id, object_kind,
             storage_backend, storage_path, source_url, checksum_sha256, byte_size, created_at_utc)
        VALUES (:ingestion_object_id, :ingestion_run_id, :provider_id, 'gtfs_schedule_zip',
                :storage_backend, :storage_path, :source_url, :checksum_sha256, :byte_size,
                :object_created_at_utc)
    """),
        params,
    )


def _archive(window: ReplayWindow, bronze: BronzeStorageResolver) -> BronzeStaticArchive:
    edition = window.edition
    return BronzeStaticArchive(
        provider_id=window.provider_id,
        storage_backend=edition.storage_backend,
        feed_endpoint_id=edition.feed_endpoint_id,
        source_ingestion_run_id=edition.ingestion_run_id,
        source_ingestion_object_id=edition.ingestion_object_id,
        storage_path=edition.storage_path,
        archive_full_path=bronze(edition.storage_backend).describe_location(edition.storage_path),
        source_url=edition.source_url,
        checksum_sha256=edition.checksum_sha256,
        byte_size=edition.byte_size,
        source_completed_at_utc=edition.completed_at_utc,
    )


def _advance_sequences(connection: Connection) -> None:
    for table, column in (
        ("core.feed_endpoints", "feed_endpoint_id"),
        ("raw.ingestion_runs", "ingestion_run_id"),
        ("raw.ingestion_objects", "ingestion_object_id"),
        ("raw.realtime_snapshot_index", "realtime_snapshot_id"),
        ("raw.i3_alert_snapshots", "i3_alert_snapshot_id"),
    ):
        connection.execute(
            text(f"""
            SELECT setval(pg_get_serial_sequence(:table, :column),
                          GREATEST((SELECT max({column}) FROM {table}),
                                   nextval(pg_get_serial_sequence(:table, :column))))
        """),
            {"table": table, "column": column},
        )


def admit_polls(
    oracle: OracleDatabase,
    window: ReplayWindow,
    *,
    until_utc: datetime,
    bronze: BronzeStorageResolver,
) -> int:
    """Admit recorded raw rows once their poll has started; return inserted raw rows."""
    engine = _owned_engine(oracle)
    if until_utc.utcoffset() is None:
        raise SeedRefused("until_utc must be aware")
    polls = sorted(
        ((p, r) for r in window.poll_records for p in r.polls if p.started_at_utc <= until_utc),
        key=lambda pair: (pair[0].started_at_utc, pair[0].ingestion_run_id),
    )
    for poll, _ in polls:
        if poll.run_status is None:
            raise SeedRefused(f"poll {poll.ingestion_run_id}: missing run_status")
    inserted = 0
    with engine.begin() as connection:
        for poll, record in polls:
            fields = (
                "ingestion_run_id run_kind requested_at_utc started_at_utc completed_at_utc "
                "feed_timestamp_utc http_status_code entity_count error_message"
            ).split()
            params = {field: getattr(poll, field) for field in fields}
            params.update(
                provider_id=window.provider_id,
                status=poll.run_status,
                feed_endpoint_id=window.feed_endpoints[record.feed_day.endpoint_key],
            )
            added = _insert_raw(connection, "ingestion_runs", params, conflict="ingestion_run_id")
            inserted += added
            if added and poll.status == "stored":
                if poll.capture_row_id is None:
                    raise SeedRefused(f"poll {poll.ingestion_run_id}: stored capture missing")
                _, capture = window.capture(poll.index_family, poll.capture_row_id)
                if capture.ingestion_run_id != poll.ingestion_run_id:
                    raise SeedRefused(
                        f"poll {poll.ingestion_run_id}: capture belongs to another poll"
                    )
                inserted += _admit_capture(connection, record, capture, params, bronze)
        if inserted:
            _advance_sequences(connection)
    return inserted


def _insert_raw(
    connection: Connection, table: str, params: dict[str, object], *, conflict: str | None = None
) -> int:
    columns = ", ".join(params)
    values = ", ".join(f":{column}" for column in params)
    suffix = f" ON CONFLICT ({conflict}) DO NOTHING" if conflict else ""
    query = text(f"INSERT INTO raw.{table} ({columns}) VALUES ({values}){suffix}")
    if "raw_payload_json" in params:
        query = query.bindparams(bindparam("raw_payload_json", type_=JSONB))
    return connection.execute(query, params).rowcount


def _admit_capture(
    connection: Connection,
    record: PollRecord,
    capture: CaptureEntry,
    run: dict[str, object],
    bronze: BronzeStorageResolver,
) -> int:
    common = {key: run[key] for key in ("provider_id", "feed_endpoint_id", "ingestion_run_id")}
    fields = "ingestion_object_id object_kind storage_backend storage_path source_url byte_size"
    obj = {field: getattr(capture, field) for field in fields.split()}
    obj.update(
        ingestion_run_id=capture.ingestion_run_id,
        provider_id=run["provider_id"],
        checksum_sha256=capture.sha256,
        created_at_utc=capture.object_created_at_utc,
    )
    _insert_raw(connection, "ingestion_objects", obj)
    common.update(
        ingestion_object_id=capture.ingestion_object_id, captured_at_utc=capture.captured_at_utc
    )
    if capture.index_family == "realtime_snapshot":
        common.update(
            realtime_snapshot_id=capture.capture_row_id,
            feed_timestamp_utc=capture.feed_timestamp_utc,
            entity_count=capture.entity_count,
        )
        _insert_raw(connection, "realtime_snapshot_index", common)
    elif capture.index_family == "alert_snapshot":
        fields = "storage_backend storage_path source_url checksum_sha256 byte_size"
        common.update({key: obj[key] for key in fields.split()})
        common.update(
            i3_alert_snapshot_id=capture.capture_row_id,
            http_status_code=capture.http_status_code,
            api_version=capture.api_version,
            alert_count=capture.alert_count,
            raw_payload_json=_alert_payload(record, capture, bronze),
        )
        _insert_raw(connection, "i3_alert_snapshots", common)
    else:
        raise SeedRefused(f"capture {capture.capture_row_id}: unknown index family")
    return 2


def _alert_payload(
    record: PollRecord, capture: CaptureEntry, bronze: BronzeStorageResolver
) -> object:
    extract = {"i3_alerts": extract_i3_metadata, "service_alerts": extract_service_alerts_metadata}
    endpoint = record.feed_day.endpoint_key
    if endpoint not in extract:
        raise SeedRefused(f"alert endpoint {endpoint} has no payload extractor")
    payload, reason = object_payload(bronze, capture)
    if payload is None:
        raise SeedRefused(f"capture {capture.capture_row_id}: {reason}")
    return extract[endpoint](payload, provider_id=record.feed_day.provider_id).raw_payload_json
