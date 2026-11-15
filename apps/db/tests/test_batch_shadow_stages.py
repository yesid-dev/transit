"""Actual controller stage order and shadow CLI over row-specific frozen inputs."""

import hashlib
import json
import runpy
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pytest
from typer.testing import CliRunner

from transit_ops.batch.build import FamilyOutput, InputNeed
from transit_ops.batch.editions import snapshot_rows, with_editions
from transit_ops.batch.families import registry
from transit_ops.batch.replay_report import ReplayReport, compare_family
from transit_ops.batch.run import run_family
from transit_ops.commands import batch


@pytest.mark.parametrize("changed", [False, True])
def test_all_replays_then_all_shadows_keep_each_rows_edition(tmp_path, monkeypatch, changed):
    from transit_ops.db import connection

    script = Path(__file__).resolve().parents[3] / ".github/scripts/batch-shadow.py"
    controller = runpy.run_path(str(script))["main"].__globals__
    root, objects = tmp_path / "daily", tmp_path / "objects"
    root.mkdir()
    objects.mkdir()
    monkeypatch.setitem(controller, "ROOT", root)
    monkeypatch.setattr(
        controller["shutil"], "disk_usage", lambda path: SimpleNamespace(free=25_000_000_000)
    )
    for key, value in {
        "BATCH_SHADOW_PROVISIONED": "true",
        "BRONZE_S3_ACCESS_KEY": "test",
        "BRONZE_S3_SECRET_KEY": "test",
        "BRONZE_STORAGE_BACKEND": "local",
        "BRONZE_LOCAL_ROOT": str(objects),
        "GOLD_FACT_RETENTION_DAYS": "30",
        "GOLD_REPORTING_OPEN_WINDOW_DAYS": "7",
        "TRANSIT_REPLAY_DATABASE_URL": "postgresql://disposable/db",
    }.items():
        monkeypatch.setenv(key, value)
    observed, stages = [], []

    class Builder:
        tables = ()
        published_keys = ()
        variants = {}

        def __init__(self, family):
            self.family_id = family

        def inputs(self, request):
            return (InputNeed("core.providers", "all"),) + (
                (InputNeed("core.dataset_versions", "all"),)
                if self.family_id == "cancellations_service_states"
                else ()
            )

        def build(self, session, request):
            edition = {"octranspo": 101, "stm": 202}[request.provider_id]
            if self.family_id == "cancellations_service_states":
                assert request.edition_by_day == {request.local_dates[0]: edition}
            else:
                assert request.edition_by_day is None
            observed.append((self.family_id, request.provider_id, request.edition_by_day))
            return FamilyOutput({}, {})

    monkeypatch.setattr(registry, "resolve_builder", lambda family: Builder(family))
    monkeypatch.setattr(batch, "_code_commit", lambda: "a" * 40)

    def no_shared_database(*args):
        raise AssertionError("the final receipts replay cleared the shared edition table")

    monkeypatch.setattr(connection, "make_engine", no_shared_database)
    stamp = datetime(2026, 11, 3, 12, tzinfo=UTC)
    rows = [
        {"provider": provider, "day": day, "families": [family], "timezone": "UTC"}
        for provider, day, family in [
            ("octranspo", "2026-11-02", "cancellations_service_states"),
            ("stm", "2026-11-02", "cancellations_service_states"),
            ("stm", "2026-11-01", "receipts"),
        ]
    ]
    for index, row in enumerate(rows):
        inputs = root / str(index) / "inputs"
        (inputs / "core.providers").mkdir(parents=True)
        with duckdb.connect() as conn:
            conn.execute(
                "COPY (SELECT ? provider_id, 'UTC' timezone) TO ? (FORMAT parquet)",
                [row["provider"], str(inputs / "core.providers/all.parquet")],
            )
            if row["families"] == ["cancellations_service_states"]:
                (inputs / "core.dataset_versions").mkdir()
                conn.execute(
                    "COPY (SELECT ? provider_id, ?::BIGINT dataset_version_id, "
                    "'static_schedule' dataset_kind, true is_current) "
                    "TO ? (FORMAT parquet)",
                    [
                        row["provider"],
                        101 if row["provider"] == "octranspo" else 202,
                        str(inputs / "core.dataset_versions/all.parquet"),
                    ],
                )
    controller["write_json"](
        root / "daily-inputs.json",
        {
            "matrix": rows,
            "code_commit": "a" * 40,
            "planned_at": stamp.isoformat(),
            "as_of_utc": stamp.isoformat(),
        },
    )

    def invoke(args, receipt, *, env=None):
        provider = args[args.index("--provider") + 1]
        day = date.fromisoformat(args[args.index("--date") + 1])
        stages.append((args[1], provider, str(day)))
        if args[1] == "replay-day":
            inputs = Path(args[args.index("--inputs") + 1])
            work = Path(args[args.index("--workdir") + 1])
            work.mkdir(parents=True, exist_ok=True)
            family = args[args.index("--family") + 1]
            builder = Builder(family)
            request = batch._shadow_request(provider, day, stamp, inputs, work)
            if family == "cancellations_service_states":
                request = with_editions(
                    request,
                    [family],
                    snapshot_rows(inputs / "core.dataset_versions/all.parquet", provider),
                )
            build = run_family(
                builder, request, inputs_root=inputs, workdir=work, code_commit="a" * 40
            )
            hashes = tuple(
                (p.relative_to(inputs).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest())
                for p in inputs.rglob("*.parquet")
            )
            report = ReplayReport(
                provider,
                day,
                stamp,
                "a" * 40,
                input_files=hashes,
                families=(
                    compare_family(family, builder, build.output, build, bodies_loaded=True),
                ),
            )
            (work / f"report-{provider}-{day}.json").write_bytes(report.to_json())
        else:
            response = CliRunner().invoke(batch.app, args[1:], env=env)
            if response.exit_code:
                raise ValueError(response.output + str(response.exception))

    monkeypatch.setitem(controller, "invoke", invoke)
    controller["main"]("replay")
    if changed:
        path = root / "0/inputs/core.dataset_versions/all.parquet"
        path.write_bytes(path.read_bytes() + b"changed after replay")
        with pytest.raises(ValueError, match="edition_input_changed"):
            controller["main"]("shadow")
        assert not list(objects.rglob("accepted.json"))
        return
    controller["main"]("shadow")
    assert stages == [
        (stage, row["provider"], row["day"])
        for stage in ("replay-day", "shadow-build")
        for row in rows
    ]
    assert len(observed) == 6
    assert len(list(objects.rglob("accepted.json"))) == 3
    assert json.loads((root / "daily-inputs.json").read_bytes())["complete"] is True
