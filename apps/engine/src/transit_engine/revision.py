import sys
from hashlib import sha256
from pathlib import Path

import duckdb


def compute_answer_revision(package: Path, declarations: Path) -> str:
    """Fingerprint the installed engine source, declarations and query runtime."""
    digest = sha256()
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    digest.update(f"python/{python_version}\0duckdb/{duckdb.__version__}\0".encode())
    groups = {
        "transit_engine": (package, list(package.rglob("*.py"))),
        "providers": (
            declarations,
            [*declarations.glob("*.yaml"), *declarations.glob("default-city.txt")],
        ),
    }
    for prefix, (root, files) in groups.items():
        for path in sorted(files, key=Path.as_posix):
            name = path.relative_to(root).as_posix()
            digest.update(f"{prefix}/{name}\0".encode())
            digest.update(sha256(path.read_bytes().replace(b"\r\n", b"\n")).digest())
    return digest.hexdigest()[:16]
