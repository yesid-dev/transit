"""Verify both typed Parquet tables before publishing a create-only local version."""

import csv
import json
import subprocess
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

from transit_ops.clean_day import CLEANING_VERSION, CleanDay, Row
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import object_digest, put_create_only
from transit_ops.lake.parquet_codec import write_window
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
    ),
    _TRIP_KEY,
)
STOP_EVENTS = TableSchema.from_columns(
    (
        *_IDENTITY,
        ("stop_id", "text", True),
        ("stop_sequence", "bigint", True),
        ("scheduled_arrival_utc", _TIME, False),
        ("scheduled_departure_utc", _TIME, False),
        ("observed_at_utc", _TIME, False),
        ("delay_seconds", "bigint", False),
        ("basis", "text", True),
        ("observed_event", "text", False),
        ("vehicle_id", "text", False),
    ),
    (*_TRIP_KEY, "stop_sequence"),
)


def version_key(provider: str, day: date) -> str:
    return f"{provider}/{day.isoformat()}/v{CLEANING_VERSION}"


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
    tables: tuple[tuple[str, TableSchema, Iterable[Row], str], ...] = (
        ("trip_days", TRIP_DAYS, day.trip_rows(), "state"),
        ("stop_events", STOP_EVENTS, day.stop_rows(), "basis"),
    )
    for name, schema, rows, category in tables:
        columns = [column.name for column in schema.columns]
        index = columns.index(category)
        source = temporary / f"{name}.csv"
        target = staged / f"{name}.parquet"
        with source.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(columns)
            for row in rows:
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
    manifest = {
        **metadata,
        "files": entries,
        "row_counts_by_state": counts["state"],
        "row_counts_by_basis": counts["basis"],
        "built_at_utc": datetime.now(UTC).isoformat(),
        "builder_git_commit": _builder_git_commit(),
    }
    (staged / "manifest.json").write_text(json.dumps(manifest, sort_keys=True) + "\n", "utf-8")
    return staged, files
