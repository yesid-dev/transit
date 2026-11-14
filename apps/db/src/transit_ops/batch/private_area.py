"""Own a build directory and refuse cleanup after its paths change identity."""

import os
import shutil
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import mkdtemp

Identity = tuple[Path, int, int]


def _identity(path: Path) -> Identity:
    status = path.lstat()
    return path.resolve(strict=True), status.st_dev, status.st_ino


def _verify(identities: dict[Path, Identity]) -> None:
    for path, identity in identities.items():
        try:
            if _identity(path) == identity:
                continue
        except OSError:
            pass
        raise RuntimeError(f"private area ownership changed: {path}")


def _remove(area: Path, parent: Path, identities: dict[Path, Identity]) -> None:
    _verify(identities)
    if shutil.rmtree.avoids_symlink_attacks:
        flags = os.O_RDONLY
        for name in ("O_DIRECTORY", "O_NOFOLLOW"):
            flags |= getattr(os, name)
        fd = os.open(parent, flags)
        try:
            status = os.fstat(fd)
            if (status.st_dev, status.st_ino) != identities[parent][1:]:
                raise RuntimeError(f"private area parent changed: {parent}")
            _verify(identities)
            shutil.rmtree(area.name, dir_fd=fd)
        finally:
            os.close(fd)
    elif os.name == "nt":
        # Windows rmtree refuses root reparse points and does not traverse junctions.
        shutil.rmtree(area)
    else:
        raise RuntimeError(f"private area cleanup requires no-follow support: {area}")


@contextmanager
def private_area(workdir: Path) -> Iterator[Path]:
    parent = workdir.resolve()
    parent.mkdir(parents=True, exist_ok=True)
    identities = {parent: _identity(parent)}
    area = Path(mkdtemp(prefix="build-", dir=parent))
    identities[area] = _identity(area)
    try:
        _verify(identities)
        yield area
    finally:
        primary = sys.exception()
        try:
            _remove(area, parent, identities)
        except Exception as cleanup:
            if primary is None:
                raise
            primary.add_note(f"private area cleanup failed; left {area}: {cleanup}")
