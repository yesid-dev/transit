import subprocess
import sys
from pathlib import Path

import duckdb
import pytest

from transit_engine.revision import compute_answer_revision


def test_answer_revision_tracks_duckdb_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = compute_answer_revision(tmp_path, tmp_path)
    monkeypatch.setattr(duckdb, "__version__", "0.0.0-test")
    assert compute_answer_revision(tmp_path, tmp_path) != original


def test_answer_revision_is_stable_across_runs_and_tracks_query_sources(tmp_path: Path) -> None:
    source = tmp_path / "transit_engine"
    declarations = tmp_path / "providers"
    source.mkdir()
    declarations.mkdir()
    measure = source / "measures.py"
    measure.write_bytes(b"HEADWAY = 30\n")
    provider = declarations / "demo.yaml"
    provider.write_bytes(b"live_source_lag_seconds: 20\n")

    def revision() -> bytes:
        return subprocess.check_output(
            [
                sys.executable,
                "-c",
                "import sys; from pathlib import Path; "
                "from transit_engine.revision import compute_answer_revision; "
                "print(compute_answer_revision(Path(sys.argv[1]), Path(sys.argv[2])))",
                str(source),
                str(declarations),
            ]
        ).strip()

    original = revision()
    measure.write_bytes(b"HEADWAY = 30\r\n")
    assert revision() == original
    measure.write_bytes(b"HEADWAY = 60\n")
    changed = revision()
    assert changed != original
    provider.write_bytes(b"live_source_lag_seconds: 40\n")
    assert revision() != changed
