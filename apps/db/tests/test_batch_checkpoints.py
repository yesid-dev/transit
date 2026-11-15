from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from transit_ops.batch.build import FamilyOutput, TableRows
from transit_ops.batch.checkpoints import (
    CheckpointConflict,
    CheckpointStore,
    NotAccepted,
    accept,
    table_digest,
)
from transit_ops.batch.manifest import BuildManifest
from transit_ops.batch.replay_report import compare_family
from transit_ops.batch.run import BuildResult

DAY = date(2026, 11, 12)


def test_checkpoint_accepts_canonical_hyphenated_provider_id(tmp_path):
    build = result()
    build = replace(build, manifest=replace(build.manifest, provider_id="rescue-a1b2"))
    store = CheckpointStore(tmp_path)
    checkpoint = store.record(build, DAY)
    accept(checkpoint, replay(build))
    assert store.find("sample_family", "rescue-a1b2", DAY, build.manifest.build_id) == checkpoint
    assert (checkpoint.path / "accepted.json").is_file()


def result(value=Decimal("1.50")):
    manifest = BuildManifest(
        "sample",
        (DAY,),
        datetime(2026, 11, 13, 7, tzinfo=UTC),
        30,
        7,
        "UTC",
        "sample_family",
        "a" * 40,
        (),
    )
    table = TableRows("gold.sample", ("id", "value"), ("id",), ((1, value),))
    return BuildResult(manifest, FamilyOutput({table.relation: table}, {"v2/body.json": b"{}"}))


def replay(build, status="identical"):
    class Builder:
        family_id = build.manifest.family_id
        published_keys = ("v2/*",)
        tables = ("gold.sample",)
        variants = {}

    evidence = compare_family(Builder.family_id, Builder(), build.output, build, bodies_loaded=True)
    return replace(evidence, status=status)


@pytest.mark.parametrize(
    "left,right",
    [(Decimal("1.5"), Decimal("1.50")), (0.0, -0.0), (None, ""), (True, 1), ([1], (1,))],
)
def test_digest_strict(left, right):
    a, b = result(left).output.tables["gold.sample"], result(right).output.tables["gold.sample"]
    assert table_digest(a) == table_digest(a)
    assert table_digest(a) != table_digest(b)


def test_checkpoint_resume_conflict_and_accept(tmp_path):
    build = result()
    store = CheckpointStore(tmp_path)
    checkpoint = store.record(build, DAY)
    before = {p: p.stat().st_mtime_ns for p in tmp_path.rglob("*")}
    assert store.record(build, DAY) == checkpoint
    assert {p: p.stat().st_mtime_ns for p in tmp_path.rglob("*")} == before
    assert store.find("sample_family", "sample", DAY, build.manifest.build_id) == checkpoint
    assert store.find("sample_family", "sample", DAY, "b" * 64) is None
    with pytest.raises(CheckpointConflict):
        store.record(result(Decimal("9")), DAY)
    for bad in [
        replay(build, "different"),
        replay(build, "not_compared"),
        replace(replay(build), build_id="b" * 64),
    ]:
        with pytest.raises(NotAccepted):
            accept(checkpoint, bad)
    accepted = accept(checkpoint, replay(build))
    assert (accepted.engine, accepted.revision) == ("duckdb", 2)
    assert (checkpoint.path / "accepted.json").is_file()
    assert accept(checkpoint, replay(build)) == accepted


def test_digest_masks_runtime_values_but_keeps_nullness_and_readiness():
    base = TableRows(
        "gold.warm_rollup_periods",
        ("id", "period_start_utc", "built_at_utc", "invalidated_at_utc"),
        ("id",),
        ((1, datetime(2026, 11, 12, tzinfo=UTC), datetime(2026, 11, 12, 0, 5, tzinfo=UTC), None),),
    )
    later = replace(
        base, rows=((1, base.rows[0][1], datetime(2026, 11, 12, 0, 6, tzinfo=UTC), None),)
    )
    premature = replace(
        base, rows=((1, base.rows[0][1], datetime(2026, 11, 12, 0, 4, tzinfo=UTC), None),)
    )
    invalidated = replace(base, rows=((1, base.rows[0][1], base.rows[0][2], base.rows[0][2]),))
    assert table_digest(base) == table_digest(later)
    assert table_digest(base) != table_digest(premature)
    assert table_digest(base) != table_digest(invalidated)


@pytest.mark.parametrize("damage", ["table", "body", "both"])
def test_acceptance_must_bind_the_replayed_output(tmp_path, damage):
    from transit_ops.batch.replay_report import compare_family

    class Builder:
        family_id = "sample_family"
        tables = ("gold.sample",)
        published_keys = ("v2/*",)
        variants = {}

    proved = result()
    evidence = compare_family(
        Builder.family_id, Builder(), proved.output, proved, bodies_loaded=True
    )
    tables = result(Decimal("9.99")).output.tables if damage != "body" else proved.output.tables
    bodies = {"v2/body.json": b'{"value":9}'} if damage != "table" else proved.output.bodies
    drifted = replace(proved, output=FamilyOutput(tables, bodies))
    assert proved.manifest.build_id == drifted.manifest.build_id
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(drifted, DAY)
    with pytest.raises(NotAccepted):
        accept(checkpoint, evidence)
    assert not (checkpoint.path / "accepted.json").exists()


@pytest.mark.parametrize(
    "left,right,status", [(0.0, -0.0, "identical_after_normalization"), (0.3, 0.31, "different")]
)
def test_acceptance_classes(tmp_path, left, right, status):
    from transit_ops.batch.compare import compare_tables

    build = result(right)
    checkpoint = CheckpointStore(tmp_path).record(build, DAY)
    differences = tuple(
        compare_tables(
            result(left).output.tables["gold.sample"], build.output.tables["gold.sample"]
        )
    )
    evidence = replace(
        replay(build),
        status=status,
        differences=differences,
        difference_count=1,
        difference_counts={
            "representation": int(status != "different"),
            "value": int(status == "different"),
        },
    )
    if status == "different":
        with pytest.raises(NotAccepted):
            accept(checkpoint, evidence)
    else:
        assert accept(checkpoint, evidence).build_id == build.manifest.build_id
