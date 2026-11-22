"""Verify both typed Parquet tables before publishing a create-only local version."""

import csv
from collections.abc import Iterable
from pathlib import Path
from tempfile import TemporaryDirectory

from transit_ops.clean_day import CLEANING_VERSION, CleanDay, Row
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


def write_clean_day(day: CleanDay, root: Path) -> Path:
    parent = root / day.provider / day.date.isoformat()
    destination = parent / f"v{CLEANING_VERSION}"
    parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError(f"Clean day already exists: {destination}")
    metadata = {
        "cleaning_version": CLEANING_VERSION,
        "provider": day.provider,
        "service_date": day.date.isoformat(),
        "schedule_sha256": day.edition_sha256,
    }
    with TemporaryDirectory(prefix=".clean-day-", dir=parent) as directory:
        temporary = Path(directory)
        staged = temporary / "version"
        staged.mkdir()
        tables: tuple[tuple[str, TableSchema, Iterable[Row]], ...] = (
            ("trip_days", TRIP_DAYS, day.trip_rows()),
            ("stop_events", STOP_EVENTS, day.stop_rows()),
        )
        for name, schema, rows in tables:
            source = temporary / f"{name}.csv"
            target = staged / f"{name}.parquet"
            with source.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream, lineterminator="\n")
                writer.writerow(column.name for column in schema.columns)
                writer.writerows(rows)
            # The CSV is generated here from typed rows. DuckDB's strict typed
            # COPY and the Parquet readback still check the resulting values and schema.
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
        # Both files become visible together. A competing successful writer
        # leaves a nonempty destination directory, which rename cannot replace.
        staged.rename(destination)
    return destination
