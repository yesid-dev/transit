"""Build one day's stretch passes from a measured v12 clean day and publish them.

The inputs are three files of the published v12 day, checked against its receipt,
and the schedule ZIP the receipt pins (stops, trips and shapes only). The output
goes to its own prefix, ``stretch/v13/<provider>/<date>/``, create-only, with a
receipt written last, so the v12 day folders and the engine's mirror of them never
change. Data files carry their checksum in their names and the receipt lists
them under ``tables``: the receipt alone says what the day's data is.

Everything is staged in a temporary folder that is removed when the day is
published, so nothing stays on the builder's disk.
"""

import csv
import hashlib
import json
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import asdict
from datetime import UTC, date, datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
from zoneinfo import ZoneInfo

from transit_ops.clean_day_output import _builder_git_commit, version_key
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import object_digest, put_create_only
from transit_ops.lake.parquet_codec import connect, write_window
from transit_ops.lake.parquet_verify import Expected, check_window_files
from transit_ops.lake.table_schema import TableSchema
from transit_ops.providers.schedule_archive import _shape_coordinates
from transit_ops.silver.static_rows import RowRejection, iter_member_rows
from transit_ops.stretch_passes import (
    STRETCH_PASSES,
    STRETCH_SUMMARY,
    STRETCH_VERSION,
    STRETCHES,
    PathStop,
    StretchDay,
    TripPath,
    VehicleInterval,
    build_stretch_day,
)

SOURCE_FILES = ("vehicle_positions.parquet", "scheduled_stop_times.parquet", "trip_days.parquet")
_SOURCE_VERSION = 12


class CleanDayNotMeasured(ValueError):
    """The v12 receipt settles the day without measured tables."""


def stretch_key_prefix(provider: str, day: date) -> str:
    return f"stretch/v{STRETCH_VERSION}/{provider}/{day.isoformat()}"


def source_receipt(payload: bytes, provider: str, day: date) -> dict[str, object]:
    """The measured v12 receipt for the day, or CleanDayNotMeasured."""
    manifest = json.loads(payload)
    if not isinstance(manifest, dict) or (
        manifest.get("provider"),
        manifest.get("service_date"),
        manifest.get("cleaning_version"),
    ) != (provider, day.isoformat(), str(_SOURCE_VERSION)):
        raise CleanDayNotMeasured("The clean-day receipt is not a measured v12 day")
    files = manifest.get("files")
    if "status" in manifest or not isinstance(files, dict):
        raise CleanDayNotMeasured("The clean day was settled without measured tables")
    if missing := [name for name in SOURCE_FILES if name not in files]:
        raise ValueError(f"The clean-day receipt lacks {', '.join(missing)}")
    if not isinstance(manifest.get("schedule_sha256"), str):
        raise ValueError("The clean-day receipt lacks its schedule checksum")
    return manifest


def fetch_clean_day(
    storage: BronzeStorage, prefix: str, provider: str, day: date, directory: Path
) -> bytes:
    """Copy the source files of a published v12 day, checked against its receipt."""
    base = f"{prefix}{version_key(provider, day)}"
    payload = storage.read_bytes(f"{base}/manifest.json")
    files = source_receipt(payload, provider, day)["files"]
    assert isinstance(files, dict)
    for name in SOURCE_FILES:
        data = storage.read_bytes(f"{base}/{name}")
        entry = files[name]
        if (hashlib.sha256(data).hexdigest(), len(data)) != (
            entry.get("sha256"),
            entry.get("byte_size"),
        ):
            raise ValueError(f"Clean-day file differs from its receipt: {base}/{name}")
        (directory / name).write_bytes(data)
    (directory / "manifest.json").write_bytes(payload)
    return payload


def _member(archive: ZipFile, member: str, provider: str) -> Iterator[dict[str, object]]:
    for row in iter_member_rows(archive, member, provider_id=provider, dataset_version_id=0):
        if isinstance(row, RowRejection):
            raise ValueError(f"Schedule {member} row {row.row_number}: {row.reason}")
        yield row


def day_paths(
    clean_dir: Path, archive: bytes, provider: str, temp_dir: Path
) -> dict[str, TripPath]:
    """The day's scheduled trips with their shapes, ordered stops and vehicle type."""
    with connect(temp_dir) as connection:
        times = connection.execute(
            """SELECT trip_id, route_id, direction_id, stop_sequence, stop_id
            FROM read_parquet(?, hive_partitioning = false)
            ORDER BY trip_id, stop_sequence""",
            [str(clean_dir / "scheduled_stop_times.parquet")],
        ).fetchall()
        kinds = dict(
            connection.execute(
                """SELECT trip_id, route_type FROM read_parquet(?, hive_partitioning = false)
                WHERE route_type IS NOT NULL""",
                [str(clean_dir / "trip_days.parquet")],
            ).fetchall()
        )
    with ZipFile(BytesIO(archive)) as zipped:
        shape_of = {
            str(row["trip_id"]): str(row["shape_id"])
            for row in _member(zipped, "trips.txt", provider)
            if row.get("shape_id")
        }
        points = {
            str(row["stop_id"]): (row["stop_lat"], row["stop_lon"])
            for row in _member(zipped, "stops.txt", provider)
        }
    trips = {str(row[0]) for row in times}
    shapes = _shape_coordinates(
        archive, provider, 0, {shape_of[trip] for trip in trips if trip in shape_of}
    )
    stops: dict[str, list[PathStop]] = {}
    lines: dict[str, tuple[object, object]] = {}
    for trip_id, route_id, direction_id, sequence, stop_id in times:
        lat, lon = points.get(stop_id, (None, None))
        stops.setdefault(trip_id, []).append(
            PathStop(
                int(sequence),
                str(stop_id),
                lat if isinstance(lat, float) else None,
                lon if isinstance(lon, float) else None,
            )
        )
        lines[trip_id] = (route_id, direction_id)
    paths = {}
    for trip_id, ordered in stops.items():
        route_id, direction_id = lines[trip_id]
        shape_id = shape_of.get(trip_id, "")
        paths[trip_id] = TripPath(
            route_id if isinstance(route_id, str) else None,
            direction_id if isinstance(direction_id, int) else None,
            shape_id,
            shapes.get(shape_id, []),
            ordered,
            kinds.get(trip_id),
        )
    return paths


_INTERVAL_SQL = """
    SELECT trip_id, vehicle_id, epoch(observed_at_utc), epoch(captured_at_utc),
        epoch(last_seen_at_utc), readings, latitude, longitude
    FROM read_parquet(?, hive_partitioning = false)
    WHERE service_date = ? AND trip_id IS NOT NULL
        AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY trip_id, vehicle_id, observed_at_utc, captured_at_utc
"""


def intervals_from_parquet(path: Path, day: date, temp_dir: Path) -> Iterator[VehicleInterval]:
    with connect(temp_dir) as connection:
        cursor = connection.execute(_INTERVAL_SQL, [str(path), day])
        while rows := cursor.fetchmany(50_000):
            for row in rows:
                yield VehicleInterval(*row)


def build_from_clean_dir(
    provider: str, day: date, clean_dir: Path, archive: bytes, temp_dir: Path
) -> StretchDay:
    """Stretch passes for one day from a local copy of its v12 files."""
    receipt = source_receipt((clean_dir / "manifest.json").read_bytes(), provider, day)
    if hashlib.sha256(archive).hexdigest() != receipt["schedule_sha256"]:
        raise ValueError("Schedule ZIP differs from the clean day's pinned edition")
    paths = day_paths(clean_dir, archive, provider, temp_dir)
    intervals = intervals_from_parquet(clean_dir / "vehicle_positions.parquet", day, temp_dir)
    return build_stretch_day(provider, day, paths, intervals)


def _write_table(
    name: str,
    schema: TableSchema,
    rows: Iterable[tuple[object, ...]],
    staged: Path,
    temporary: Path,
    metadata: Mapping[str, str],
) -> dict[str, int | str]:
    source = temporary / f"{name}.csv"
    with source.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(column.name for column in schema.columns)
        writer.writerows(rows)
    target = staged / f"{name}.parquet"
    window = write_window(
        source, schema, target, metadata=dict(metadata), temp_dir=temporary,
        validate_csv_input=False,
    )  # fmt: skip
    check_window_files(
        source, target, schema,
        expect=Expected(window.content_sha256, window.rows, window.sha256),
        temp_dir=temporary, validate_csv_input=False,
    )  # fmt: skip
    source.unlink()
    # Name the file by its bytes. A retry after a half-finished publish then never
    # meets a different file under the same create-only key. Readers take the names
    # from the receipt, so a file no receipt lists is not data.
    named = target.rename(staged / f"{name}-{window.sha256[:16]}.parquet")
    return {
        "name": named.name,
        "sha256": window.sha256,
        "byte_size": named.stat().st_size,
        "rows": window.rows,
    }


def stage_stretch_day(
    day: StretchDay, source_manifest: bytes, zone: ZoneInfo, temporary: Path
) -> tuple[Path, dict[str, dict[str, int | str]]]:
    """Write the three tables and the receipt into a staging folder."""
    source = source_receipt(source_manifest, day.provider, day.date)
    metadata = {
        "cleaning_version": STRETCH_VERSION,
        "provider": day.provider,
        "service_date": day.date.isoformat(),
        "schedule_sha256": str(source["schedule_sha256"]),
    }
    staged = temporary / "version"
    staged.mkdir()
    written = {
        "stretches": _write_table(
            "stretches", STRETCHES, day.stretch_rows(), staged, temporary, metadata
        ),
        "stretch_passes": _write_table(
            "stretch_passes", STRETCH_PASSES, day.pass_rows(), staged, temporary, metadata
        ),
        "stretch_summary": _write_table(
            "stretch_summary", STRETCH_SUMMARY, day.summary_rows(zone), staged, temporary,
            metadata,
        ),
    }  # fmt: skip
    files = {str(entry.pop("name")): entry for entry in written.values()}
    tables = {table: name for table, name in zip(written, files, strict=True)}
    receipt = {
        **metadata,
        "source_cleaning_version": str(_SOURCE_VERSION),
        "source_manifest_sha256": hashlib.sha256(source_manifest).hexdigest(),
        "tables": tables,
        "files": files,
        "facts": asdict(day.facts),
        "built_at_utc": datetime.now(UTC).isoformat(),
        "builder_git_commit": _builder_git_commit(),
    }
    (staged / "manifest.json").write_text(json.dumps(receipt, sort_keys=True) + "\n", "utf-8")
    return staged, files


def publish_stretch_day(
    day: StretchDay,
    source_manifest: bytes,
    zone: ZoneInfo,
    storage: BronzeStorage,
    prefix: str,
) -> dict[str, dict[str, int | str]]:
    """Publish create-only: each table is checked in place, then the receipt goes last."""
    directory = f"{prefix}{stretch_key_prefix(day.provider, day.date)}"
    with TemporaryDirectory(prefix="stretch-day-") as temporary:
        staged, files = stage_stretch_day(day, source_manifest, zone, Path(temporary))
        for name, entry in files.items():
            key = f"{directory}/{name}"
            identity = (str(entry["sha256"]), int(entry["byte_size"]))
            put_create_only(storage, staged / name, key, expected=identity)
            if object_digest(storage, key) != identity:
                raise ValueError(f"Published stretch file checksum or size differs: {key}")
        manifest = staged / "manifest.json"
        marker = f"{directory}/manifest.json"
        expected = manifest.read_bytes()
        put_create_only(storage, manifest, marker)
        if storage.read_bytes(marker) != expected:
            raise ValueError(f"Published stretch receipt differs: {marker}")
    return files
