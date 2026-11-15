import json
from dataclasses import asdict

import duckdb
import pytest
from test_batch_checkpoints import replay, result
from test_batch_shadow import write_tables
from typer.testing import CliRunner

from transit_ops.batch import run
from transit_ops.batch.build import FamilyBuilder
from transit_ops.batch.families import registry
from transit_ops.commands import batch
from transit_ops.commands.batch import app
from transit_ops.ingestion import storage


def invoke(tmp_path, monkeypatch, *, status=None, failure=False):
    build = result()
    inputs = tmp_path / "inputs" / "core.providers"
    inputs.mkdir(parents=True)
    with duckdb.connect() as conn:
        conn.sql("SELECT 'sample' provider_id, 'UTC' timezone").write_parquet(
            str(inputs / "all.parquet")
        )
    objects = tmp_path / "objects"
    objects.mkdir()
    monkeypatch.setattr(
        storage, "get_bronze_storage", lambda *a, **k: storage.LocalBronzeStorage("local", objects)
    )

    class Builder:
        family_id = "sample_family"
        tables = ("gold.sample",)
        published_keys = ("v2/*",)
        variants = {}

        def inputs(self, request):
            return ()

        def build(self, session, request):
            return build.output

    assert isinstance(Builder(), FamilyBuilder)
    monkeypatch.setattr(registry, "resolve_builder", lambda name: Builder())
    monkeypatch.setattr(batch, "_code_commit", lambda: "a" * 40)

    def build_family(builder, request, **kwargs):
        assert request == build.manifest
        assert kwargs["inputs_root"] == tmp_path / "inputs"
        assert kwargs["code_commit"] == "a" * 40
        if failure:
            raise failure
        write_tables(builder.tables_dir)
        return build

    # BuildManifest extends BuildRequest: compare the request fields explicitly.
    from dataclasses import fields

    from transit_ops.batch.build import BuildRequest

    def checked(builder, request, **kwargs):
        assert all(
            getattr(request, f.name) == getattr(build.manifest, f.name)
            for f in fields(BuildRequest)
        )
        return build_family(builder, build.manifest, **kwargs)

    monkeypatch.setattr(run, "run_family", checked)
    args = [
        "shadow-build",
        "--provider",
        "sample",
        "--date",
        "2026-11-12",
        "--as-of",
        "2026-11-13T07:00:00Z",
        "--inputs",
        str(tmp_path / "inputs"),
        "--workdir",
        str(tmp_path / "work"),
        "--family",
        "sample_family",
    ]
    if status:
        report = tmp_path / "report.json"
        report.write_text(
            json.dumps(
                {
                    "provider_id": "sample",
                    "local_date": "2026-11-12",
                    "as_of_utc": "2026-11-13T07:00:00Z",
                    "code_commit": "a" * 40,
                    "duckdb_version": build.manifest.engine_version,
                    "families": [asdict(replay(build, status))],
                }
            )
        )
        args += ["--accept-from", str(report)]
    return CliRunner().invoke(app, args), objects


@pytest.mark.parametrize("status,expected", [(None, 0), ("identical", 0), ("different", 1)])
def test_shadow_command_acceptance(tmp_path, monkeypatch, status, expected):
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", "30")
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", "7")
    response, objects = invoke(tmp_path, monkeypatch, status=status)
    assert response.exit_code == expected, response.output + str(response.exception)
    assert bool(list(objects.rglob("accepted.json"))) == (status == "identical")


@pytest.mark.parametrize("error", [RuntimeError("build failed"), ValueError("build failed")])
def test_shadow_command_build_failure(tmp_path, monkeypatch, error):
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", "30")
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", "7")
    response, objects = invoke(tmp_path, monkeypatch, failure=error)
    assert response.exit_code == 2, response.output
    assert not list(objects.rglob("manifest.json"))


@pytest.mark.parametrize("damage", ["missing", "invalid", "output"])
def test_command_classifies_named_refusals(tmp_path, monkeypatch, damage):
    from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed
    from transit_ops.batch.engine import BatchSession
    from transit_ops.batch.families.registry import resolve_builder

    source = tmp_path / "inputs/core.providers"
    source.mkdir(parents=True)
    with duckdb.connect() as conn:
        conn.sql("SELECT 'sample' provider_id, 'UTC' timezone").write_parquet(
            str(source / "all.parquet")
        )
    root = tmp_path / "objects"
    root.mkdir()
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(root))
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", "30")
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", "7")
    if damage == "invalid":
        builder = resolve_builder("occupancy_crowding")
        for need in builder.inputs(result().manifest):
            if need.relation == "core.providers":
                continue
            target = source.parent / need.relation / f"{need.window}.parquet"
            target.parent.mkdir(exist_ok=True)
            with duckdb.connect() as conn:
                conn.sql("SELECT 1 unused").write_parquet(str(target))
        path = source.parent / "gold.fact_trip_delay_snapshot/2026-11-12.parquet"
        path.write_bytes(b"invalid parquet")
    if damage == "output":

        class Builder:
            family_id = "occupancy_crowding"
            tables = ("gold.sample",)
            published_keys = ()
            variants = {}

            def inputs(self, request: BuildRequest) -> tuple[InputNeed, ...]:
                return ()

            def build(self, session: BatchSession, request: BuildRequest) -> FamilyOutput:
                return FamilyOutput({}, {})

        monkeypatch.setattr(registry, "resolve_builder", lambda name: Builder())
    else:
        assert resolve_builder("occupancy_crowding") is not None
    response = CliRunner().invoke(
        app,
        [
            "shadow-build",
            "--provider",
            "sample",
            "--date",
            "2026-11-12",
            "--as-of",
            "2026-11-13T07:00:00Z",
            "--inputs",
            str(source.parent),
            "--workdir",
            str(tmp_path / "work"),
            "--family",
            "occupancy_crowding",
        ],
    )
    assert response.exit_code == 1, response.output
    if damage == "invalid":
        assert "gold.fact_trip_delay_snapshot window 2026-11-12:" in response.output
        assert "missing input" not in response.output
    assert (
        "undeclared" in response.output or "declared tables" in response.output
        if damage == "output"
        else "input" in response.output
    )
    assert not list(root.rglob("accepted.json"))


def test_real_family_shadow_command_rerun_preserves_verified_objects(tmp_path, monkeypatch):
    from dataclasses import replace

    from test_family_occupancy_crowding import DAY, REQUEST, write_inputs

    request = replace(REQUEST, local_dates=(DAY,), provider_id="shadow_command_seed")
    write_inputs(tmp_path / "inputs", request, provider_id=request.provider_id)
    root = tmp_path / "objects"
    root.mkdir()
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(root))
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", str(request.fact_retention_days))
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", str(request.open_window_days))
    args = [
        "shadow-build",
        "--provider",
        request.provider_id,
        "--date",
        DAY.isoformat(),
        "--as-of",
        request.as_of_utc.isoformat(),
        "--inputs",
        str(tmp_path / "inputs"),
        "--workdir",
        str(tmp_path / "work"),
        "--family",
        "occupancy_crowding",
    ]
    first = CliRunner().invoke(app, args)
    assert first.exit_code == 0, first.output
    before = {
        p.relative_to(root): (p.read_bytes(), p.stat().st_mtime_ns)
        for p in root.rglob("*")
        if p.is_file()
    }
    assert {p.name for p in before} == {
        "manifest.json",
        "outputs.json",
        "gold.route_occupancy_band_daily.parquet",
        "gold.route_occupancy_band_hourly.parquet",
        "gold.stop_occupancy_band_daily.parquet",
        "gold.route_delay_by_crowding_daily.parquet",
    }
    second = CliRunner().invoke(app, args)
    assert second.exit_code == 0, second.output
    assert {
        p.relative_to(root): (p.read_bytes(), p.stat().st_mtime_ns)
        for p in root.rglob("*")
        if p.is_file()
    } == before
