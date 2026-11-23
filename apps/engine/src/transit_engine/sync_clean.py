"""Mirror completed, immutable clean days from R2 on a Linux engine host."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from hashlib import file_digest
from pathlib import Path
from typing import BinaryIO

from transit_engine.clean_manifest import file_identities
from transit_engine.store import CITY, env_int

REMOTE = "clean:transit-clean"
DATE = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
MIB = 1024**2


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
            env=self.env, stdout=output, stderr=subprocess.DEVNULL, check=False,
        )
        if result.returncode:
            raise RuntimeError(f"R2 {args[0]} failed (rclone exit {result.returncode})")
        return result.stdout or b""

    def inventory(self, version: int) -> dict[str, int]:
        result = self.run(
            "lsjson", REMOTE, "--recursive", "--files-only", "--no-modtime", "--no-mimetype",
            "--include", f"/*/*/v{version}/**",
            "--include", "/search/v1/**",
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
    search_pattern = re.compile(rf"search/v1/{CITY.pattern}/{DATE}/v[0-9]+\.json")
    days = {}
    for key in sorted(inventory):
        if match := manifest_pattern.fullmatch(key):
            days[key] = match.groups()
    if not days:
        raise RuntimeError(f"No clean manifests in R2 for v{version}")
    search = [key for key in sorted(inventory) if search_pattern.fullmatch(key)]
    # The cleaner publishes days and search schedules create-only. A local manifest
    # means this mirror verified the complete day before committing it.
    pending = {key: identity for key, identity in days.items() if not (root / key).is_file()}
    missing_search = [key for key in search if not file_matches(root / key, inventory[key])]
    pending_dirs = {key.rsplit("/", 1)[0] for key in pending}
    needed = sum(inventory[key] for key in missing_search) + sum(
        size for key, size in inventory.items() if key.rsplit("/", 1)[0] in pending_dirs
    )
    total = sum(inventory[key] for key in search) + sum(
        size for key, size in inventory.items() if key.rsplit("/", 1)[0] + "/manifest.json" in days
    )
    print(
        f"v{version}: {len(days)} published days, {len(pending)} to copy, "
        f"{len(search)} search files, {total} bytes total, up to {needed} bytes to copy, "
        f"{shutil.disk_usage(root).free} bytes free, {reserve} bytes reserved",
        flush=True,
    )
    require_space(root, reserve, needed)
    if check:
        return

    for key in missing_search:
        copy_object(remote, key, root, inventory[key], reserve)
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
    print(f"Published {len(pending)} clean days and {len(missing_search)} search files", flush=True)


def main() -> None:
    if sys.platform != "linux":
        raise SystemExit("The clean mirror requires Linux and rclone")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Inventory and check disk space only")
    args = parser.parse_args()
    try:
        sync(
            R2(),
            Path(os.environ["ENGINE_CLEAN_ROOT"]),
            env_int("ENGINE_CLEANING_VERSION", 10),
            env_int("ENGINE_DISK_RESERVE_MIB", 32768) * MIB,
            check=args.check,
        )
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
