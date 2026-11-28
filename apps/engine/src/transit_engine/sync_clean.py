"""Mirror completed, immutable clean days from R2 on a Linux engine host."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from hashlib import file_digest
from pathlib import Path
from typing import BinaryIO

from transit_engine.clean_manifest import file_identities
from transit_engine.store import CITY, Store, env_int
from transit_engine.stretches import STRETCH_VERSION, receipt_tables

REMOTE = "clean:transit-clean"
DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
MIB = 1024**2
SCHEDULE_FILE_PREFIXES = ("search/v1", "maps/v1", "corridors/v1")
SCHEDULE_FILE_PATTERN = re.compile(
    rf"(?:{'|'.join(map(re.escape, SCHEDULE_FILE_PREFIXES))})/{CITY.pattern}/{DATE}/v[0-9]+\.json"
)
# Stretch timing is kept whole in R2. The engine host keeps the latest 30 days.
STRETCH_LOCAL_DAYS = 30
STRETCH_PREFIX = f"stretch/v{STRETCH_VERSION}"


class R2:
    def __init__(self) -> None:
        endpoint = os.environ.get("TRANSIT1_R2_ENDPOINT", "").removeprefix("https://").rstrip("/")
        if not re.fullmatch(r"[a-z0-9-]+\.r2\.cloudflarestorage\.com", endpoint):
            raise ValueError("Expected a Cloudflare R2 S3 endpoint")
        access_key = os.environ["TRANSIT1_R2_READ_ACCESS_KEY_ID"]
        secret_key = os.environ["TRANSIT1_R2_READ_SECRET_ACCESS_KEY"]
        self.env = {
            "RCLONE_CONFIG_CLEAN_TYPE": "s3",
            "RCLONE_CONFIG_CLEAN_PROVIDER": "Cloudflare",
            "RCLONE_CONFIG_CLEAN_ENDPOINT": f"https://{endpoint}",
            "RCLONE_CONFIG_CLEAN_ACCESS_KEY_ID": access_key,
            "RCLONE_CONFIG_CLEAN_SECRET_ACCESS_KEY": secret_key,
        }
        if not all(self.env.values()):
            raise ValueError("Missing R2 read credentials")

    def run(self, *args: str, output: BinaryIO | int = subprocess.PIPE) -> bytes:
        result = subprocess.run(
            ["/usr/local/bin/rclone", "--config", "/dev/null", *args],
            env=self.env,
            stdout=output,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"R2 {args[0]} failed (rclone exit {result.returncode})")
        return result.stdout or b""

    def inventory(self, version: int) -> dict[str, int]:
        includes = ["--include", f"/*/*/v{version}/**"]
        for prefix in SCHEDULE_FILE_PREFIXES:
            includes.extend(("--include", f"/{prefix}/**"))
        result = self.run(
            "lsjson",
            REMOTE,
            "--recursive",
            "--files-only",
            "--no-modtime",
            "--no-mimetype",
            *includes,
        )
        return {entry["Path"]: entry["Size"] for entry in json.loads(result)}

    def listing(self, include: str) -> dict[str, int]:
        result = self.run(
            "lsjson",
            REMOTE,
            "--recursive",
            "--files-only",
            "--no-modtime",
            "--no-mimetype",
            "--include",
            include,
        )
        return {entry["Path"]: entry["Size"] for entry in json.loads(result)}

    def download(self, key: str, stream: BinaryIO) -> None:
        self.run("cat", f"{REMOTE}/{key}", "--bwlimit", "24M", output=stream)


def file_matches(path: Path, size: int) -> bool:
    return path.is_file() and path.stat().st_size == size


def require_space(root: Path, reserve: int, needed: int) -> None:
    free = shutil.disk_usage(root).free
    if free < reserve + needed:
        raise RuntimeError(
            f"Insufficient space: {free} bytes free, {needed} needed plus {reserve} reserved"
        )


def publish_manifest(partial: Path, marker: Path) -> None:
    if sys.platform != "linux":
        # Keep the file publication logic testable in the portable engine suite.
        partial.replace(marker)
        return
    directory_fd = os.open(marker.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
        partial.replace(marker)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def copy_object(
    remote: R2, key: str, root: Path, size: int, reserve: int, digest: str | None = None
) -> None:
    target = root / key
    require_space(root, reserve, size)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    try:
        with partial.open("wb+") as stream:
            remote.download(key, stream)
            stream.flush()
            if os.fstat(stream.fileno()).st_size != size:
                raise RuntimeError(f"Size mismatch for {key}")
            if digest is not None:
                stream.seek(0)
                if file_digest(stream, "sha256").hexdigest() != digest:
                    raise RuntimeError(f"Digest mismatch for {key}")
            os.fsync(stream.fileno())
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


def sync(remote: R2, root: Path, version: int, reserve: int, *, check: bool = False) -> None:
    inventory = remote.inventory(version)
    manifest_pattern = re.compile(rf"({CITY.pattern})/({DATE})/v{version}/manifest\.json")
    days = {}
    for key in sorted(inventory):
        if match := manifest_pattern.fullmatch(key):
            days[key] = match.groups()
    if not days:
        raise RuntimeError(f"No clean manifests in R2 for v{version}")
    schedule_files = [key for key in sorted(inventory) if SCHEDULE_FILE_PATTERN.fullmatch(key)]
    # The cleaner publishes days and schedule files create-only. A local manifest
    # means this mirror verified the complete day before committing it.
    pending = {key: identity for key, identity in days.items() if not (root / key).is_file()}
    missing_schedules = [
        key for key in schedule_files if not file_matches(root / key, inventory[key])
    ]
    pending_dirs = {key.rsplit("/", 1)[0] for key in pending}
    needed = sum(inventory[key] for key in missing_schedules) + sum(
        size for key, size in inventory.items() if key.rsplit("/", 1)[0] in pending_dirs
    )
    total = sum(inventory[key] for key in schedule_files) + sum(
        size for key, size in inventory.items() if key.rsplit("/", 1)[0] + "/manifest.json" in days
    )
    print(
        f"v{version}: {len(days)} published days, {len(pending)} to copy, "
        f"{len(schedule_files)} schedule files, {total} bytes total, up to {needed} bytes to copy, "
        f"{shutil.disk_usage(root).free} bytes free, {reserve} bytes reserved",
        flush=True,
    )
    require_space(root, reserve, needed)
    if check:
        return

    for key in missing_schedules:
        copy_object(remote, key, root, inventory[key], reserve)
    stamp = Store(str(root), version).mirror_stamp()
    for key, (city, day) in pending.items():
        directory = key.rsplit("/", 1)[0]
        payload = remote.run("cat", f"{REMOTE}/{key}")
        files = file_identities(payload, city, day, str(version))
        if files is None or len(payload) != inventory[key]:
            raise RuntimeError(f"Invalid manifest: {key}")
        for name, (digest, size) in files.items():
            path = f"{directory}/{name}"
            if path not in inventory:
                # Publication may have completed between listing pages. Re-list next run.
                raise RuntimeError(f"Published file missing from inventory: {path}")
            copy_object(remote, path, root, size, reserve, digest)
        marker = root / key
        require_space(root, reserve, len(payload))
        marker.parent.mkdir(parents=True, exist_ok=True)
        partial = marker.with_suffix(".json.part")
        with partial.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        publish_manifest(partial, marker)
        stamp.touch()
    print(
        f"Published {len(pending)} clean days and {len(missing_schedules)} schedule files",
        flush=True,
    )


def _write_receipt(root: Path, key: str, payload: bytes, reserve: int) -> None:
    marker = root / key
    require_space(root, reserve, len(payload))
    marker.parent.mkdir(parents=True, exist_ok=True)
    partial = marker.with_suffix(".json.part")
    with partial.open("wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    publish_manifest(partial, marker)


def _digests(payload: bytes) -> dict[str, str]:
    files = json.loads(payload)["files"]
    return {name: entry["sha256"] for name, entry in files.items()}


def sync_stretches(
    remote: R2,
    root: Path,
    reserve: int,
    today: date,
    *,
    keep_days: int = STRETCH_LOCAL_DAYS,
    check: bool = False,
) -> None:
    """Copy the latest stretch timing days, and drop older local copies R2 still holds."""
    inventory = remote.listing(f"/{STRETCH_PREFIX}/**")
    pattern = re.compile(rf"{STRETCH_PREFIX}/({CITY.pattern})/({DATE})/manifest\.json")
    oldest = today - timedelta(days=keep_days - 1)
    published = {
        key: (match[1], date.fromisoformat(match[2]))
        for key in sorted(inventory)
        if (match := pattern.fullmatch(key))
    }
    wanted = {key: day for key, day in published.items() if day[1] >= oldest}
    pending = {key: day for key, day in wanted.items() if not (root / key).is_file()}
    folders = {key.rsplit("/", 1)[0] for key in pending}
    needed = sum(size for key, size in inventory.items() if key.rsplit("/", 1)[0] in folders)
    print(
        f"stretch v{STRETCH_VERSION}: {len(published)} published days, {len(wanted)} in the "
        f"last {keep_days} days, {len(pending)} to copy, up to {needed} bytes to copy",
        flush=True,
    )
    require_space(root, reserve, needed)
    if check:
        return
    for key, (city, day) in pending.items():
        payload = remote.run("cat", f"{REMOTE}/{key}")
        tables = receipt_tables(payload, city, day)
        if tables is None or len(payload) != inventory[key]:
            raise RuntimeError(f"Invalid stretch receipt: {key}")
        digests = _digests(payload)
        folder = key.rsplit("/", 1)[0]
        for name, size in tables.values():
            path = f"{folder}/{name}"
            if inventory.get(path) != size:
                raise RuntimeError(f"Stretch file missing from inventory: {path}")
            copy_object(remote, path, root, size, reserve, digests[name])
        _write_receipt(root, key, payload, reserve)
    removed = kept = 0
    for marker in sorted(root.glob(f"{STRETCH_PREFIX}/*/*/manifest.json")):
        city, day_text = marker.parts[-3], marker.parts[-2]
        try:
            day = date.fromisoformat(day_text)
        except ValueError:
            continue
        if day >= oldest:
            continue
        key = marker.relative_to(root).as_posix()
        local = marker.read_bytes()
        tables = receipt_tables(local, city, day)
        # Only a day R2 holds byte for byte leaves this host.
        if (
            tables is None
            or inventory.get(key) != len(local)
            or remote.run("cat", f"{REMOTE}/{key}") != local
        ):
            kept += 1
            continue
        digests = _digests(local)
        local_folder = marker.parent
        verified = True
        for name, size in tables.values():
            local_file = local_folder / name
            if inventory.get(f"{key.rsplit('/', 1)[0]}/{name}") != size:
                verified = False
            elif local_file.is_file():
                with local_file.open("rb") as stream:
                    verified &= file_digest(stream, "sha256").hexdigest() == digests[name]
        if not verified:
            kept += 1
            continue
        for name, _ in tables.values():
            (local_folder / name).unlink(missing_ok=True)
        marker.unlink()
        local_folder.rmdir()
        removed += 1
    print(
        f"Published {len(pending)} stretch days; removed {removed} local days older than "
        f"{keep_days} days, kept {kept} not yet verified in R2",
        flush=True,
    )


def main() -> None:
    if sys.platform != "linux":
        raise SystemExit("The clean mirror requires Linux and rclone")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Inventory and check disk space only")
    args = parser.parse_args()
    try:
        remote, root = R2(), Path(os.environ["ENGINE_CLEAN_ROOT"])
        reserve = env_int("ENGINE_DISK_RESERVE_MIB", 32768) * MIB
        sync(remote, root, env_int("ENGINE_CLEANING_VERSION", 10), reserve, check=args.check)
        sync_stretches(remote, root, reserve, datetime.now(UTC).date(), check=args.check)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
