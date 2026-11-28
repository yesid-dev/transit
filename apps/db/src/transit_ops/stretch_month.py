"""Add up a closed month's daily stretch summaries into one rollup in R2.

A whole-network question over months reads one rollup per month instead of every
day. The rollup counts passes per stretch, vehicle type, day type, local hour,
whole pass seconds and whole km/h, so any quantile from it equals the quantile
over its days.

Each rollup is published under ``stretch/v13/<provider>/months/<YYYY-MM>-<key>/``
where ``<key>`` names the exact set of day receipts it adds up. When a month gains
or changes a day (a rebuild), a new rollup is published next to the old one; the
engine reads the one with the most days. Files are create-only, content-named and
checked in place, with the receipt written last.
"""

import hashlib
import json
from collections.abc import Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

import duckdb

from transit_ops.clean_day_output import _builder_git_commit
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.objects import object_digest, put_create_only
from transit_ops.stretch_passes import STRETCH_VERSION

TABLES = ("stretch_summary", "stretches")


def month_prefix(provider: str) -> str:
    return f"stretch/v{STRETCH_VERSION}/{provider}"


def day_receipts(
    storage: BronzeStorage, prefix: str, provider: str, month: str
) -> dict[date, bytes]:
    """The published stretch day receipts of one month."""
    base = f"{prefix}{month_prefix(provider)}/"
    receipts = {}
    for key in storage.list_keys(f"{base}{month}-"):
        name = key.removeprefix(base)
        parts = name.split("/")
        if len(parts) == 2 and parts[1] == "manifest.json":
            day = date.fromisoformat(parts[0])
            receipts[day] = storage.read_bytes(key)
    return receipts


def rollup_key(receipts: dict[date, bytes]) -> str:
    """A short name for an exact set of day receipts."""
    text = "\n".join(
        f"{day.isoformat()}:{hashlib.sha256(payload).hexdigest()}"
        for day, payload in sorted(receipts.items())
    )
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _day_tables(payload: bytes, provider: str, day: date) -> dict[str, tuple[str, str, int]]:
    receipt = json.loads(payload)
    if (receipt.get("provider"), receipt.get("service_date"), receipt.get("cleaning_version")) != (
        provider,
        day.isoformat(),
        STRETCH_VERSION,
    ):
        raise ValueError(f"Stretch receipt names another day: {provider} {day}")
    tables, files = receipt["tables"], receipt["files"]
    return {
        table: (tables[table], files[tables[table]]["sha256"], files[tables[table]]["byte_size"])
        for table in TABLES
    }


def publish_month_rollup(
    storage: BronzeStorage,
    prefix: str,
    provider: str,
    month: str,
    receipts: dict[date, bytes],
) -> str | None:
    """Publish the rollup of these day receipts unless it exists; return its folder."""
    if not receipts:
        return None
    folder = f"{prefix}{month_prefix(provider)}/months/{month}-{rollup_key(receipts)}"
    marker = f"{folder}/manifest.json"
    if storage.exists(marker):
        return None
    with TemporaryDirectory(prefix="stretch-month-") as temporary:
        work = Path(temporary)
        inputs: dict[str, list[str]] = {table: [] for table in TABLES}
        for day, payload in sorted(receipts.items()):
            for table, (name, digest, size) in _day_tables(payload, provider, day).items():
                data = storage.read_bytes(f"{prefix}{month_prefix(provider)}/{day}/{name}")
                if (hashlib.sha256(data).hexdigest(), len(data)) != (digest, size):
                    raise ValueError(f"Stretch file differs from its receipt: {day} {name}")
                path = work / f"{day}-{name}"
                path.write_bytes(data)
                inputs[table].append(path.as_posix())
        staged = work / "rollup"
        staged.mkdir()
        spill = work / "spill"
        spill.mkdir()
        with duckdb.connect(
            config={"threads": 2, "memory_limit": "2GB", "temp_directory": spill.as_posix()}
        ) as conn:
            conn.execute(
                """COPY (
                    SELECT provider, ? AS month, cleaning_version, stretch_key, route_type,
                        CASE isodow(service_date) WHEN 6 THEN 'saturday'
                            WHEN 7 THEN 'sunday' ELSE 'weekday' END AS day_type,
                        hour, pass_seconds, speed_kmh, sum(passes)::BIGINT AS passes,
                        sum(stopped_at_stop_seconds)::BIGINT AS stopped_at_stop_seconds,
                        sum(stopped_between_stops_seconds)::BIGINT
                            AS stopped_between_stops_seconds
                    FROM read_parquet(?, hive_partitioning = false)
                    GROUP BY ALL
                    ORDER BY stretch_key, route_type, day_type, hour, pass_seconds, speed_kmh
                ) TO ? (FORMAT parquet, COMPRESSION zstd)""",
                [month, inputs["stretch_summary"], (staged / "stretch_summary").as_posix()],
            )
            conn.execute(
                """COPY (
                    SELECT * EXCLUDE (rank) FROM (
                        SELECT *, row_number() OVER (
                            PARTITION BY stretch_key ORDER BY service_date DESC) AS rank
                        FROM read_parquet(?, hive_partitioning = false)
                    ) WHERE rank = 1 ORDER BY stretch_key
                ) TO ? (FORMAT parquet, COMPRESSION zstd)""",
                [inputs["stretches"], (staged / "stretches").as_posix()],
            )
        files: dict[str, dict[str, int | str]] = {}
        tables: dict[str, str] = {}
        for table in TABLES:
            source = staged / table
            data = source.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            name = f"{table}-{digest[:16]}.parquet"
            identity = (digest, len(data))
            key = f"{folder}/{name}"
            put_create_only(storage, source, key, expected=identity)
            if object_digest(storage, key) != identity:
                raise ValueError(f"Published month file checksum or size differs: {key}")
            files[name] = {"sha256": digest, "byte_size": len(data)}
            tables[table] = name
        receipt = {
            "provider": provider,
            "month": month,
            "cleaning_version": STRETCH_VERSION,
            "days": {
                day.isoformat(): hashlib.sha256(payload).hexdigest()
                for day, payload in sorted(receipts.items())
            },
            "tables": tables,
            "files": files,
            "built_at_utc": datetime.now(UTC).isoformat(),
            "builder_git_commit": _builder_git_commit(),
        }
        manifest = work / "manifest.json"
        manifest.write_text(json.dumps(receipt, sort_keys=True) + "\n", "utf-8")
        expected = manifest.read_bytes()
        put_create_only(storage, manifest, marker)
        if storage.read_bytes(marker) != expected:
            raise ValueError(f"Published month receipt differs: {marker}")
    return folder


def closed_months(days: Iterable[date], today: date) -> list[str]:
    """The months of these days that ended before today's month began."""
    current = today.strftime("%Y-%m")
    return sorted({day.strftime("%Y-%m") for day in days if day.strftime("%Y-%m") < current})
