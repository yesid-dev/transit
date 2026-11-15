"""Atomic local publication evidence over the existing guarded replay runner."""

import hashlib
import json
import subprocess
import tempfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath, PureWindowsPath

from transit_ops.history.poll_record import canonical_json
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.oracle.runner import replay_window
from transit_ops.live.oracle.window import ReplayWindow
from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings


def _local_path(root: Path, key: str) -> Path:
    posix, windows = PurePosixPath(key), PureWindowsPath(key)
    if not key or posix.anchor or windows.anchor or ".." in posix.parts + windows.parts:
        raise ValueError("local_capture_path: must stay inside declared storage")
    path = (root / key).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("local_capture_path: must stay inside declared storage")
    return path


def _inputs(window: ReplayWindow, root: Path) -> LocalBronzeStorage:
    if not window.cycles:
        raise ValueError("malformed_window: no cycles")
    alerts = {k for k in window.feed_endpoints if k in {"i3_alerts", "service_alerts"}}
    if not alerts or any(
        not any(
            r.feed_day.endpoint_key == endpoint
            and any(
                c.index_family == "alert_snapshot"
                and ("alert_snapshot", c.capture_row_id) in cycle.captures
                for c in r.captures
                for cycle in window.cycles
            )
            for r in window.poll_records
        )
        for endpoint in alerts
    ):
        raise ValueError("missing_alert_evidence: complete window requires alert captures")
    edition = window.edition
    entries = [
        (edition.storage_backend, edition.storage_path, edition.byte_size, edition.checksum_sha256)
    ]
    entries.extend(
        (c.storage_backend, c.storage_path, c.byte_size, c.sha256)
        for r in window.poll_records
        for c in r.captures
    )
    for backend, key, size, digest in entries:
        if backend != "local":
            raise ValueError("local_capture_storage: only declared local storage is allowed")
        payload = _local_path(root, key).read_bytes()
        if len(payload) != size or hashlib.sha256(payload).hexdigest() != digest:
            raise ValueError(f"corrupt_bytes: capture {key}")
    return LocalBronzeStorage("local", root)


def _commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).resolve().parent,
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip()
    if len(value) != 40 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("code_commit_unavailable")
    return value


def write_replay_report(
    window_path: Path,
    output: Path,
    *,
    admin_url: str,
    environment: Mapping[str, str],
    settings: Settings,
    registry: ProviderRegistry,
    prior_manifest: Path | None = None,
) -> None:
    """Commit output/completed only after replay and database cleanup both finish.

    A failed run leaves an owned output directory without a completed receipt.
    Object filenames are digests, never publication keys. Maps retain key identity.
    """
    source = window_path.read_bytes()
    try:
        window = ReplayWindow.from_json(source)
    except Exception as exc:
        raise ValueError("malformed_window") from exc
    bronze = _inputs(window, Path(settings.BRONZE_LOCAL_ROOT).resolve())
    prior = prior_manifest.read_bytes() if prior_manifest is not None else None
    if prior is not None and not isinstance(json.loads(prior), dict):
        raise ValueError("prior_manifest: expected JSON object")
    if not admin_url:
        raise ValueError("disposable_admin_target: TRANSIT_TEST_DATABASE_URL required")
    commit = _commit()
    try:
        output.mkdir(parents=True, exist_ok=False)
    except FileExistsError as exc:
        raise ValueError("output_path_conflict: output already exists") from exc
    with tempfile.TemporaryDirectory(prefix=".partial-", dir=output) as temporary:
        staging = Path(temporary) / "completed"
        objects = staging / "objects"
        objects.mkdir(parents=True)
        cycles = []
        for cycle in replay_window(
            window,
            admin_url=admin_url,
            environment=environment,
            settings=settings,
            registry=registry,
            bronze=lambda _: bronze,
            prior_manifest=prior,
        ):
            publications = {}
            for key, body in cycle.public.items():
                digest = hashlib.sha256(body).hexdigest()
                (objects / digest).write_bytes(body)
                publications[key] = digest
            cycles.append({"generated_utc": cycle.generated_utc, "publications": publications})
        receipt = {
            "status": "completed",
            "source_window_sha256": hashlib.sha256(source).hexdigest(),
            "code_commit": commit,
            "cycle_count": len(cycles),
            "cycles": cycles,
        }
        (staging / "receipt.json").write_bytes(canonical_json(receipt))
        staging.rename(output / "completed")
