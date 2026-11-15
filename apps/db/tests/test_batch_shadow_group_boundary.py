"""The controller delegates the strict reserve to the agreed lake CLI boundary."""

import runpy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_batch_daily_inputs import fake_lake_cli
from typer.testing import CliRunner


@pytest.mark.parametrize("delay,refuses", [(0, False), (400, True)])
def test_elapsed_startup_is_judged_where_fake_lake_starts_the_group(
    tmp_path, monkeypatch, delay, refuses
):
    import psycopg

    from transit_ops.batch import daily_inputs

    script = Path(__file__).resolve().parents[3] / ".github/scripts/batch-shadow.py"
    controller = runpy.run_path(str(script))["main"].__globals__
    monkeypatch.setitem(controller, "ROOT", tmp_path)
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=25_000_000_000)
    )
    for name in ("BRONZE_S3_ACCESS_KEY", "BRONZE_S3_SECRET_KEY"):
        monkeypatch.setenv(name, "test")
    monkeypatch.setenv("DATABASE_URL", "postgresql://readonly@example/db")
    monkeypatch.setenv("BATCH_SHADOW_PROVISIONED", "true")
    clock = [datetime.now(UTC)]

    class Clock:
        @staticmethod
        def now(zone):
            return clock[0]

    monkeypatch.setattr(daily_inputs, "datetime", Clock)
    observed = []

    def group_start(not_after, group_reserve_s, **kwargs):
        clock[0] += timedelta(seconds=delay)
        remaining = (datetime.fromisoformat(not_after) - clock[0]).total_seconds()
        observed.append((remaining, group_reserve_s))
        # This is the additive #1107 contract, evaluated after startup/planning.
        if clock[0] + timedelta(seconds=group_reserve_s) >= datetime.fromisoformat(not_after):
            raise ValueError("not_after")

    command = fake_lake_cli(monkeypatch, callback=group_start)

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def execute(self, query, parameters=None):
            return SimpleNamespace(
                fetchone=lambda: (
                    ("on",) if query.startswith("SHOW") else (False,) if parameters else (3,)
                )
            )

    monkeypatch.setattr(psycopg, "connect", lambda *a, **kw: Connection())
    monkeypatch.setattr(
        daily_inputs,
        "exact_windows",
        lambda *a: ("core.providers:stm:2026-11", "silver.i3_alerts:stm:2026-11"),
    )

    def invoke(args, receipt):
        if "--group-reserve-s" in args:
            result = CliRunner().invoke(command, ["migrate", *args[2:]])
            if result.exception:
                raise result.exception
        else:
            # Prior ordinary work spends none of the next group's reserve.
            clock[0] += timedelta(seconds=3750)

    monkeypatch.setitem(controller, "invoke", invoke)
    data = {"code_commit": "a" * 40, "needs": [], "planned_at": "2026-11-15T12:00:00Z"}
    if refuses:
        with pytest.raises(ValueError, match="not_after"):
            controller["export_inputs"](data)
        assert observed == [(4460, 4500)]
    else:
        controller["export_inputs"](data)
        assert observed == [(4860, 4500)]
