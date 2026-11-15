"""Bootstrap replay identity from the same proven archive used by the full fetch."""

from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from transit_ops.batch.build import BuildRequest, InputNeed
from transit_ops.batch.input_sources import fetch_replay_inputs
from transit_ops.batch.private_area import PrivateArea
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.alert_bundle import bounded_connection
from transit_ops.lake.archive_keys import validate_provider_id
from transit_ops.settings import Settings


def replay_identity(provider: str, day: str, as_of: str | None) -> tuple[date, datetime]:
    validate_provider_id(provider)
    local_day = date.fromisoformat(day)
    if day != local_day.isoformat():
        raise ValueError("date must be YYYY-MM-DD")
    stamp = (
        datetime.fromisoformat(as_of)
        if as_of is not None
        else datetime.combine(local_day + timedelta(days=1), time(7), UTC)
    )
    if stamp.utcoffset() is None:
        raise ValueError("as_of_utc must be timezone-aware")
    return local_day, stamp.astimezone(UTC)


def provider_timezone(root: Path, provider: str, workdir: Path) -> str:
    """Read at most two matching rows; callers own digest verification of the file."""
    with bounded_connection(workdir) as conn:
        rows = conn.execute(
            "SELECT timezone FROM read_parquet(?, hive_partitioning=false) "
            "WHERE provider_id=? LIMIT 2",
            [str(root / "core.providers/all.parquet"), provider],
        ).fetchall()
    if not rows:
        raise ValueError(f"provider_unknown: core.providers {provider}")
    if len(rows) != 1:
        raise ValueError(f"provider_duplicate: core.providers {provider}")
    zone = rows[0][0]
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError, TypeError) as error:
        raise ValueError(
            f"provider_timezone_invalid: core.providers {provider}: {zone!r}"
        ) from error
    return str(zone)


def archived_request(
    storage: BronzeStorage,
    root: Path,
    provider: str,
    local_day: date,
    stamp: datetime,
    settings: Settings,
) -> BuildRequest:
    if not root.is_dir() or any(root.iterdir()) or root.is_symlink() or root.is_junction():
        raise ValueError("inputs directory must exist, be empty and not redirected")
    with PrivateArea(root) as area:
        metadata = area / "metadata"
        metadata.mkdir()
        fetch_replay_inputs(
            storage,
            metadata,
            provider,
            stamp,
            lambda _: (InputNeed("core.providers", "all"),),
            bootstrap_editions=False,
        )
        zone = provider_timezone(metadata, provider, area)
    return BuildRequest(
        provider,
        (local_day,),
        stamp,
        settings.GOLD_FACT_RETENTION_DAYS,
        settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
        zone,
    )


def assert_final_provider(root: Path, request: BuildRequest) -> None:
    # Full fetch may select a newer proof. Bind planning to its verified metadata,
    # which is covered by the final fetch receipts rather than bootstrap scratch.
    with PrivateArea(root) as area:
        zone = provider_timezone(root, request.provider_id, area)
    if zone != request.timezone:
        raise ValueError(f"timezone_mismatch: core.providers {request.provider_id}")
