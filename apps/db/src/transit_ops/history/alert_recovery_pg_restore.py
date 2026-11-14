"""Extract selected backup data to a caller-owned local file, never a database."""

import subprocess
from pathlib import Path


def extract_alert_archive_copy(dump_path: Path, output_path: Path) -> None:
    if output_path.exists():
        raise ValueError("pg_restore_output_exists")
    try:
        subprocess.run(
            [
                "pg_restore",
                "--format=custom",
                "--data-only",
                "--schema=gold",
                "--table=alert_archive_entry",
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
