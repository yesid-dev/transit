"""systemd-run must not expand variables inside inline ops scripts.

systemd-run substitutes ``$VAR``/``${VAR}`` in the command line before the
command runs. Inline ``bash -c``/``bash -ec`` scripts rely on those variables
reaching bash untouched (positional parameters, ``$STATE_DIRECTORY``, indirect
expansions), so every such call must pass ``--expand-environment=no``.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OPS_DIRS = (
    REPO_ROOT / "apps" / "db" / "ops",
    REPO_ROOT / "apps" / "engine" / "ops",
)
INLINE_BASH = re.compile(r"\bbash\s+-e?c\b")
EXPAND_ENVIRONMENT = "--expand-environment=no"
PRIVATE_CLEAN_DAY = Path("apps/db/ops/linux/private-clean-day.sh")
DUCKDB_HOME = '"$release/duckdb-home"'
UNIT_HOME = '--setenv="HOME=$release/duckdb-home"'


def _logical_lines(script: Path) -> list[str]:
    """Return script lines with backslash continuations joined."""
    lines: list[str] = []
    for line in script.read_text(encoding="utf-8").splitlines():
        if lines and lines[-1].rstrip().endswith("\\"):
            lines[-1] = f"{lines[-1].rstrip()[:-1]} {line.strip()}"
        else:
            lines.append(line)
    return lines


def _systemd_run_invocations(script: Path) -> list[str]:
    """Return each systemd-run invocation joined across line continuations."""
    invocations: list[str] = []
    current: list[str] = []
    for line in script.read_text(encoding="utf-8").splitlines():
        if not current and not line.lstrip().startswith("systemd-run"):
            continue
        current.append(line)
        if not line.rstrip().endswith("\\"):
            invocations.append(" ".join(current))
            current = []
    return invocations


def _ops_shell_scripts() -> list[Path]:
    scripts = [script for ops_dir in OPS_DIRS for script in sorted(ops_dir.rglob("*.sh"))]
    assert scripts, "ops shell scripts not found; repository layout changed"
    return scripts


def _inline_bash_invocations(script: Path) -> list[str]:
    return [
        invocation
        for invocation in _systemd_run_invocations(script)
        if INLINE_BASH.search(invocation)
    ]


def test_ops_inline_bash_systemd_run_calls_disable_environment_expansion() -> None:
    offenders = [
        f"{script.relative_to(REPO_ROOT)}: {invocation}"
        for script in _ops_shell_scripts()
        for invocation in _inline_bash_invocations(script)
        if EXPAND_ENVIRONMENT not in invocation
    ]
    assert not offenders, (
        "systemd-run calls with inline bash scripts must pass "
        f"--expand-environment=no so systemd does not expand the script's variables: {offenders}"
    )


def test_ops_inline_bash_systemd_run_calls_exist() -> None:
    invocations = [
        (script, invocation)
        for script in _ops_shell_scripts()
        for invocation in _inline_bash_invocations(script)
    ]
    assert invocations, "no inline-bash systemd-run call left in the ops scripts; narrow this guard"


def test_private_clean_day_keeps_inline_script_variables() -> None:
    script = REPO_ROOT / PRIVATE_CLEAN_DAY
    invocations = _inline_bash_invocations(script)
    assert invocations, "private-clean-day.sh no longer runs an inline bash script via systemd-run"
    assert all(EXPAND_ENVIRONMENT in invocation for invocation in invocations), (
        "private-clean-day.sh must stop systemd-run from expanding $STATE_DIRECTORY, "
        "positional parameters and ${!CLEAN_DEST_S3_*} inside its inline script"
    )


def test_private_clean_day_installs_duckdb_icu_into_the_release() -> None:
    """The unit cannot download ICU, so release preparation installs it for DuckDB.

    The unit runs with DynamicUser and ProtectSystem=strict, so DuckDB's ICU
    extension must already sit in the extension directory under the HOME the
    unit gets: DuckDB stores extensions in ``$HOME/.duckdb/extensions`` and
    autoloads them from there without network access.
    """
    script = REPO_ROOT / PRIVATE_CLEAN_DAY
    lines = _logical_lines(script)
    install = [
        line
        for line in lines
        if 'install_extension("icu")' in line and f"HOME={DUCKDB_HOME}" in line
    ]
    assert install, (
        "private-clean-day.sh must install DuckDB's ICU extension during release "
        f"preparation with HOME={DUCKDB_HOME} so it lands in the release extension directory"
    )
    assert any('chmod -R a+rX "$release/duckdb-home"' in line for line in lines), (
        "private-clean-day.sh must make the installed ICU extension readable for the DynamicUser"
    )


def test_private_clean_day_unit_home_points_at_the_release_duckdb_home() -> None:
    script = REPO_ROOT / PRIVATE_CLEAN_DAY
    invocations = _systemd_run_invocations(script)
    assert invocations, "private-clean-day.sh no longer runs a systemd-run unit"
    assert all(UNIT_HOME in invocation for invocation in invocations), (
        "every systemd-run unit of private-clean-day.sh must get "
        f"{UNIT_HOME} so DuckDB autoloads ICU from the release"
    )
