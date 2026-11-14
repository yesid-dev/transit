"""Extract selected backup data to a caller-owned local file, never a database."""

import os
import subprocess
from pathlib import Path


def _pg_restore_executable() -> str:
    extensions = [""]
    if os.name == "nt":
        extensions = os.environ.get("PATHEXT", ".COM;.EXE").lower().split(os.pathsep)
        extensions = [e for e in extensions if e in (".com", ".exe")]
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        directory = Path(entry)
        if not entry or not directory.is_absolute():
            continue
        for extension in extensions:
            candidate = directory / ("pg_restore" + extension)
            if candidate.is_file() and os.access(candidate, os.X_OK):
                # Wrappers dispatch using the selected command name, even through a symlink.
                return str(candidate)
    raise ValueError("pg_restore_unavailable")


def extract_alert_archive_copy(dump_path: Path, output_path: Path) -> None:
    if output_path.exists():
        raise ValueError("pg_restore_output_exists")
    try:
        selection = "--format=custom --data-only --schema=gold --table=alert_archive_entry"
        subprocess.run(
            [
                _pg_restore_executable(),
                *selection.split(),
                "--strict-names",
                "--file",
                str(output_path),
                str(dump_path),
            ],
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=120,
        )
    except FileNotFoundError:
        raise ValueError("pg_restore_unavailable") from None
    except subprocess.TimeoutExpired:
        raise ValueError("pg_restore_timeout") from None
    except subprocess.CalledProcessError:
        raise ValueError("pg_restore_failed") from None
    except OSError:
        raise ValueError("pg_restore_process_error") from None
    try:
        with output_path.open("rb") as output:
            output.read(1)
    except OSError:
        raise ValueError("pg_restore_output_unreadable") from None
