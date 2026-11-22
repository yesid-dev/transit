"""Verify the typed Parquet tables before publishing a create-only day version."""

import csv
import json
import subprocess
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, date, datetime
from hashlib import file_digest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from transit_ops.clean_day import CLEANING_VERSION, CleanDay, Row
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import object_digest, put_create_only
from transit_ops.lake.parquet_codec import connect, write_window
from transit_ops.lake.parquet_verify import Expected, check_window_files
from transit_ops.lake.table_schema import TableSchema

_TIME = "timestamp with time zone"
_IDENTITY = (
    ("provider", "text", True),
    ("service_date", "date", True),
    ("trip_id", "text", True),
    ("route_id", "text", False),
    ("direction_id", "integer", False),
    ("cleaning_version", "text", True),
)
_TRIP_KEY = ("provider", "service_date", "trip_id")
TRIP_DAYS = TableSchema.from_columns(
    (
        *_IDENTITY,
        ("scheduled_start_utc", _TIME, False),
        ("state", "text", True),
        ("state_reason", "text", False),
        ("vehicle_id", "text", False),
        ("route_has_live_data", "boolean", True),
        ("first_capture_utc", _TIME, False),
        ("last_capture_utc", _TIME, False),
        ("cancellation_notice_utc", _TIME, False),
        ("route_type", "integer", False),
        ("wheelchair_accessible", "integer", False),
    ),
    _TRIP_KEY,
)
_SCHEDULED_FIELDS = (
    *_IDENTITY,
    ("stop_id", "text", True),
    ("stop_sequence", "bigint", True),
    ("scheduled_arrival_utc", _TIME, False),
    ("scheduled_departure_utc", _TIME, False),
)
_STOP_KEY = (*_TRIP_KEY, "stop_sequence")
STOP_EVENTS = TableSchema.from_columns(
    (
        *_SCHEDULED_FIELDS,
        ("observed_at_utc", _TIME, False),
        ("delay_seconds", "bigint", False),
        ("basis", "text", True),
        ("observed_event", "text", False),
        ("vehicle_id", "text", False),
    ),
    _STOP_KEY,
)
PREDICTION_SAMPLES = TableSchema.from_columns(
    (
        *_IDENTITY,
        ("stop_id", "text", True),
        ("stop_sequence", "bigint", True),
        ("basis", "text", True),
        ("observed_event", "text", True),
        ("horizon_minutes", "integer", True),
        ("published_at_utc", _TIME, True),
        ("predicted_at_utc", _TIME, True),
        ("error_seconds", "bigint", True),
        ("actual_lead_seconds", "bigint", True),
    ),
    (*_STOP_KEY, "horizon_minutes"),
)
SCHEDULED_STOP_TIMES = TableSchema.from_columns(
    (
        *_SCHEDULED_FIELDS,
        ("scheduled_arrival_seconds", "bigint", False),
        ("scheduled_departure_seconds", "bigint", False),
        ("schedule_sha256", "text", True),
        ("wheelchair_boarding", "integer", False),
    ),
    _STOP_KEY,
)
VEHICLE_POSITIONS = TableSchema.from_columns(
    (
        ("provider", "text", True),
        ("cleaning_version", "text", True),
        ("vehicle_id", "text", True),
        ("captured_at_utc", _TIME, True),
        ("last_seen_at_utc", _TIME, True),
        ("readings", "bigint", True),
        ("feed_timestamp_utc", _TIME, False),
        ("observed_at_utc", _TIME, True),
        ("service_date", "date", False),
        ("trip_id", "text", False),
        ("route_id", "text", False),
        ("stop_id", "text", False),
        ("stop_sequence", "bigint", False),
        ("current_status", "integer", False),
        ("occupancy_status", "integer", False),
        ("occupancy_percentage", "bigint", False),
        ("latitude", "double precision", False),
        ("longitude", "double precision", False),
    ),
    ("provider", "vehicle_id", "captured_at_utc"),
)
FEED_POLLS = TableSchema.from_columns(
    (
        ("provider", "text", True),
        ("service_date", "date", True),
        ("cleaning_version", "text", True),
        ("feed", "text", True),
        ("captured_at_utc", _TIME, True),
        ("attempt_id", "text", True),
        ("result", "text", True),
        ("feed_timestamp_utc", _TIME, False),
        ("payload_bytes", "bigint", False),
        ("entity_count", "bigint", False),
    ),
    ("provider", "service_date", "feed", "captured_at_utc", "attempt_id"),
)


type UnmeasuredReason = Literal["no_raw_captures", "no_schedule_edition"]


def version_key(provider: str, day: date) -> str:
    return f"{provider}/{day.isoformat()}/v{CLEANING_VERSION}"


def _stage_unmeasured_day(
    provider: str, day: date, reason: UnmeasuredReason, staged: Path
) -> Path:
    receipt = {
        "status": reason,
        "provider": provider,
        "service_date": day.isoformat(),
        "cleaning_version": CLEANING_VERSION,
        "built_at_utc": datetime.now(UTC).isoformat(),
        "builder_git_commit": _builder_git_commit(),
    }
    manifest = staged / "manifest.json"
    manifest.write_text(json.dumps(receipt, sort_keys=True) + "\n", "utf-8")
    return manifest


def write_unmeasured_day(provider: str, day: date, root: Path, reason: UnmeasuredReason) -> Path:
    destination = root / version_key(provider, day)
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(f"Clean day already exists: {destination}")
    with TemporaryDirectory(prefix=".clean-day-", dir=parent) as directory:
        staged = Path(directory) / "version"
        staged.mkdir()
        _stage_unmeasured_day(provider, day, reason, staged)
        staged.rename(destination)
    return destination


def publish_unmeasured_day(
    provider: str, day: date, storage: BronzeStorage, prefix: str, reason: UnmeasuredReason
) -> None:
    directory = prefix + version_key(provider, day)
    with TemporaryDirectory(prefix="clean-day-") as temporary:
        staged = Path(temporary) / "version"
        staged.mkdir()
        manifest = _stage_unmeasured_day(provider, day, reason, staged)
        marker = f"{directory}/manifest.json"
        expected = manifest.read_bytes()
        put_create_only(storage, manifest, marker)
        if storage.read_bytes(marker) != expected:
            raise ValueError(f"Published clean-day manifest differs: {marker}")


def write_clean_day(day: CleanDay, root: Path) -> Path:
    destination = root / version_key(day.provider, day.date)
    parent = destination.parent
    parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(f"Clean day already exists: {destination}")
    with TemporaryDirectory(prefix=".clean-day-", dir=parent) as directory:
        staged, _ = _stage(day, Path(directory))
        # A competing successful writer leaves a nonempty destination directory.
        staged.rename(destination)
    return destination


def publish_clean_day(day: CleanDay, storage: BronzeStorage, prefix: str) -> None:
    directory = prefix + version_key(day.provider, day.date)
    with TemporaryDirectory(prefix="clean-day-") as temporary:
        staged, files = _stage(day, Path(temporary))
        for name, identity in files.items():
            key = f"{directory}/{name}"
            put_create_only(storage, staged / name, key, expected=identity)
            if object_digest(storage, key) != identity:
                raise ValueError(f"Published clean-day checksum or size differs: {key}")
        manifest = staged / "manifest.json"
        marker = f"{directory}/manifest.json"
        expected = manifest.read_bytes()
        put_create_only(storage, manifest, marker)
        if storage.read_bytes(marker) != expected:
            raise ValueError(f"Published clean-day manifest differs: {marker}")


def _builder_git_commit() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).parent,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def _write_alerts(
    day: CleanDay, target: Path, metadata: dict[str, str], temp_dir: Path
) -> tuple[str, int, int]:
    assert day.alerts is not None
    # Use a typed table so lists and period bounds survive as native Parquet columns.
    with connect(temp_dir) as connection:
        connection.execute("""
            CREATE TABLE alerts (
                provider VARCHAR NOT NULL, service_date DATE NOT NULL,
                cleaning_version VARCHAR NOT NULL, alert_id VARCHAR NOT NULL,
                version VARCHAR NOT NULL, first_seen_at_utc TIMESTAMPTZ NOT NULL,
                last_seen_at_utc TIMESTAMPTZ NOT NULL, header_en VARCHAR, header_fr VARCHAR,
                description_en VARCHAR, description_fr VARCHAR,
                active_periods STRUCT(start_utc TIMESTAMPTZ, end_utc TIMESTAMPTZ)[] NOT NULL,
                route_ids VARCHAR[] NOT NULL, stop_ids VARCHAR[] NOT NULL,
                cause VARCHAR, effect VARCHAR, source VARCHAR NOT NULL,
                PRIMARY KEY (provider, service_date, alert_id, version, source)
            )
            """)
        rows = [
            alert.row(day.provider, day.date, CLEANING_VERSION, alert_id, version)
            for (alert_id, version, _), alert in sorted(day.alerts.items())
        ]
        if rows:
            placeholders = ", ".join("?" for _ in rows[0])
            connection.executemany(f"INSERT INTO alerts VALUES ({placeholders})", rows)
        connection.execute(
            "COPY (SELECT * FROM alerts ORDER BY alert_id, version, source) TO ? "
            "(FORMAT PARQUET, COMPRESSION zstd, KV_METADATA ?)",
            [str(target), metadata],
        )
        expected = connection.table("alerts")
        actual = connection.read_parquet(str(target), hive_partitioning=False)
        actual.create_view("alert_copy")
        readback = dict(
            connection.execute(
                "SELECT key, value FROM parquet_kv_metadata(?)", [str(target)]
            ).fetchall()
        )
        if (
            actual.columns != expected.columns
            or actual.types != expected.types
            or actual.aggregate("count(*)").fetchall() != [(len(rows),)]
            or connection.execute(
                "SELECT EXISTS (SELECT * FROM alert_copy EXCEPT ALL SELECT * FROM alerts)"
            ).fetchone()
            != (False,)
            or readback != {key.encode(): value.encode() for key, value in metadata.items()}
        ):
            raise ValueError("Alerts Parquet differs from the clean-day rows or metadata")
    with target.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest(), target.stat().st_size, len(rows)


def _stage(day: CleanDay, temporary: Path) -> tuple[Path, dict[str, tuple[str, int]]]:
    metadata = {
        "cleaning_version": CLEANING_VERSION,
        "provider": day.provider,
        "service_date": day.date.isoformat(),
        "schedule_sha256": day.edition_sha256,
    }
    staged = temporary / "version"
    staged.mkdir()
    files: dict[str, tuple[str, int]] = {}
    entries: dict[str, dict[str, int | str]] = {}
    counts: dict[str, Counter[str]] = {
        "state": Counter(
            dict.fromkeys(
                ("ran", "cancelled", "missing", "unconfirmed", "not_measured", "added"), 0
            )
        ),
        "basis": Counter(
            dict.fromkeys(
                ("vehicle_stopped", "trip_update_reported", "trip_update_passed", "not_observed"), 0
            )
        ),
    }
    tables: tuple[tuple[str, TableSchema, Iterable[Row], str | None], ...] = (
        ("trip_days", TRIP_DAYS, day.trip_rows(), "state"),
        ("stop_events", STOP_EVENTS, day.stop_rows(), "basis"),
        ("scheduled_stop_times", SCHEDULED_STOP_TIMES, day.scheduled_stop_rows(), None),
        ("vehicle_positions", VEHICLE_POSITIONS, day.vehicle_rows(), None),
        ("feed_polls", FEED_POLLS, day.poll_rows(), None),
        ("prediction_samples", PREDICTION_SAMPLES, day.prediction_rows(), None),
    )
    for name, schema, rows, category in tables:
        columns = [column.name for column in schema.columns]
        index = columns.index(category) if category is not None else None
        source = temporary / f"{name}.csv"
        target = staged / f"{name}.parquet"
        with source.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(columns)
            for row in rows:
                if index is not None and category is not None:
                    counts[category][str(row[index])] += 1
                writer.writerow(row)
        # The generated CSV has typed rows. Check strict conversion and Parquet readback.
        window = write_window(
            source,
            schema,
            target,
            metadata=metadata,
            temp_dir=temporary,
            validate_csv_input=False,
        )
        check_window_files(
            source,
            target,
            schema,
            expect=Expected(window.content_sha256, window.rows, window.sha256),
            temp_dir=temporary,
            validate_csv_input=False,
        )
        size = target.stat().st_size
        files[target.name] = (window.sha256, size)
        entries[target.name] = {"sha256": window.sha256, "byte_size": size, "rows": window.rows}
    manifest: dict[str, object] = {
        **metadata,
        "files": entries,
        "row_counts_by_state": counts["state"],
        "row_counts_by_basis": counts["basis"],
        "built_at_utc": datetime.now(UTC).isoformat(),
        "builder_git_commit": _builder_git_commit(),
    }
    if day.scorecard_declaration is not None:
        manifest["scorecard_declaration"] = day.scorecard_declaration
    if day.alerts is None:
        manifest["alerts"] = "not_tracked"
    else:
        target = staged / "alerts.parquet"
        digest, size, rows_count = _write_alerts(day, target, metadata, temporary)
        files[target.name] = (digest, size)
        entries[target.name] = {"sha256": digest, "byte_size": size, "rows": rows_count}
    (staged / "manifest.json").write_text(json.dumps(manifest, sort_keys=True) + "\n", "utf-8")
    return staged, files
