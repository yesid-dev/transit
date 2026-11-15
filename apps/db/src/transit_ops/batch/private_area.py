"""Own build directories; bind POSIX cleanup to verified descriptors.

POSIX areas are owner-only; same-user writers already control their contents.
On Windows the root pin does not stop a nested-folder junction swap redirecting
path-based recursion outside the area: R22c accepts this contributor-host residual.
"""

import os
import shutil
import stat
from pathlib import Path
from tempfile import mkdtemp, mkstemp

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


def _remove_posix(area: Path, parent: Path, identities: dict[Path, Identity]) -> None:
    try:
        flags = os.O_RDONLY
        for name in ("O_DIRECTORY", "O_NOFOLLOW"):
            flags |= getattr(os, name)
        fd = os.open(parent, flags)
    except (OSError, AttributeError) as error:
        raise RuntimeError(f"private area descriptor unavailable: {parent}") from error
    try:
        status = os.fstat(fd)
        if (status.st_dev, status.st_ino) != identities[parent][1:]:
            raise RuntimeError(f"private area parent changed: {parent}")
        area_fd = os.open(area.name, flags, dir_fd=fd)
        try:
            child = os.fstat(area_fd)
            if (child.st_dev, child.st_ino) != identities[area][1:]:
                raise RuntimeError(f"private area ownership changed: {area}")
            for name in os.listdir(area_fd):
                kind = os.stat(name, dir_fd=area_fd, follow_symlinks=False).st_mode
                if stat.S_ISDIR(kind):
                    shutil.rmtree(name, dir_fd=area_fd)
                else:
                    os.unlink(name, dir_fd=area_fd)
        finally:
            os.close(area_fd)
        os.rmdir(area.name, dir_fd=fd)
    except OSError as error:
        raise RuntimeError(f"private area removal failed: {area}: {error}") from error
    finally:
        os.close(fd)


def _remove_windows(area: Path, marker: Path, identities: dict[Path, Identity]) -> None:
    try:
        pin = marker.open("rb")
    except OSError as error:
        raise RuntimeError(f"private area pin unavailable: {area}") from error
    with pin:
        status = os.fstat(pin.fileno())
        if (status.st_dev, status.st_ino) != identities[marker][1:] or status.st_nlink != 1:
            raise RuntimeError(f"private area pin changed: {area}")
        _verify(identities)
        for entry in area.iterdir():
            if entry != marker:
                if entry.is_junction():
                    entry.rmdir()
                elif entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
    marker.unlink()
    area.rmdir()


class PrivateArea:
    def __init__(self, workdir: Path) -> None:
        self.parent = workdir.resolve()
        self.parent.mkdir(parents=True, exist_ok=True)
        self.identities = {self.parent: _identity(self.parent)}
        self.area = Path(mkdtemp(prefix="build-", dir=self.parent))
        self.identities[self.area] = _identity(self.area)
        self.marker: Path | None = None
        if os.name == "nt":
            try:
                fd, name = mkstemp(prefix=".pin-", dir=self.area)
                os.close(fd)
                self.marker = Path(name)
                self.identities[self.marker] = _identity(self.marker)
            except OSError as error:
                raise RuntimeError(f"private area pin unavailable: {self.area}") from error

    def __enter__(self) -> Path:
        _verify(self.identities)
        return self.area

    def __exit__(self, kind: object, primary: BaseException | None, tb: object) -> None:
        try:
            if shutil.rmtree.avoids_symlink_attacks:
                _verify(self.identities)
                _remove_posix(self.area, self.parent, self.identities)
            elif self.marker is not None:
                _remove_windows(self.area, self.marker, self.identities)
            else:
                raise RuntimeError(f"private area cleanup requires no-follow support: {self.area}")
        except Exception as cleanup:
            if primary is None:
                raise
            primary.add_note(f"private area cleanup failed; left {self.area}: {cleanup}")
