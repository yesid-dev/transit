import json
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from transit_ops.batch.build import FamilyOutput, TableRows
from transit_ops.batch.manifest import BuildManifest
from transit_ops.batch.replay_report import ReplayReport, compare_family
from transit_ops.batch.run import BuildResult

STAMP = datetime(2026, 11, 2, 7, tzinfo=UTC)
DAY = date(2026, 11, 1)


class Builder:
    family_id = "test"
    tables = ("gold.test",)
    published_keys = ()
    variants = {}

    def inputs(self, request):
        return ()

    def build(self, session, request):
        raise NotImplementedError


def output(value=Decimal("1.00"), bodies=None):
    table = TableRows("gold.test", ("id", "value"), ("id",), ((1, value),))
    return FamilyOutput({table.relation: table}, bodies or {})


def result(value=None):
    manifest = BuildManifest("test", (DAY,), STAMP, 35, 7, "UTC", "test", "a" * 40, ())
    return BuildResult(manifest, value if value is not None else output())


def test_identical():
    built = result()
    replay = compare_family("test", Builder(), output(), built, bodies_loaded=False)
    assert replay.status == "identical"
    assert replay.build_id == built.manifest.build_id
    assert replay.postgres_rows == replay.duckdb_rows == {"gold.test": 1}
    assert replay.differences == ()


def test_not_implemented():
    replay = compare_family("test", None, output(), None, bodies_loaded=False)
    assert replay.status == "not_implemented"
    assert replay.build_id is None
    assert replay.postgres_rows == {"gold.test": 1}
    assert replay.duckdb_rows is None


def test_not_compared():
    builder = Builder()
    builder.published_keys = ("test/*.json",)
    replay = compare_family("test", builder, output(), result(), bodies_loaded=False)
    assert replay.status == "not_compared"
    assert replay.reason == "rollup history not loaded"
    assert replay.differences == ()
    missing = compare_family("test", Builder(), output(), None, bodies_loaded=True)
    assert missing.status == "not_compared"
    assert missing.reason
    assert missing.duckdb_rows is None


def test_different():
    replay = compare_family(
        "test", Builder(), output(), result(output(Decimal("2.00"))), bodies_loaded=True
    )
    assert replay.status == "different"
    diff = replay.differences[0]
    assert (diff.relation, diff.key, diff.column) == ("gold.test", (1,), "value")
    assert (diff.expected, diff.actual) == (Decimal("1.00"), Decimal("2.00"))


def test_body_bytes_and_difference_limit():
    left = FamilyOutput({}, {f"test/{i:02}.json": b'{"v":1}' for i in range(60)})
    right = FamilyOutput({}, {f"test/{i:02}.json": b'{"v":1.0}' for i in range(60)})
    replay = compare_family("test", Builder(), left, result(right), bodies_loaded=True)
    assert replay.status == "different"
    assert len(replay.differences) == 50
    assert (replay.differences[0].key, replay.differences[-1].key) == (
        "test/00.json",
        "test/49.json",
    )
    assert replay.differences[0].path == "$.v"


def report(families=()):
    return ReplayReport("test", DAY, STAMP, "a" * 40, "test-version", (), families, None, 2.5)


def test_report_bytes_are_stable_without_timings():
    family = compare_family("test", Builder(), output(), result(output(None)), bodies_loaded=True)
    first = report((family,))
    second = replace(first, postgres_seconds=9.0, duckdb_seconds=100.0)
    assert first.to_json(timings=False) == second.to_json(timings=False)
    body = json.loads(first.to_json(timings=False))
    assert "postgres_seconds" not in body and "duckdb_seconds" not in body
    assert body["families"][0]["differences"][0]["expected"] == "1.00"
    assert body["families"][0]["differences"][0]["actual"] is None
    assert json.loads(first.to_json(timings=True))["postgres_seconds"] is None
    assert first.to_json() == first.to_json(timings=False)
    assert first.to_json(timings=False).startswith(b'{"as_of_utc":')


def test_exit_codes():
    same = compare_family("test", Builder(), output(), result(), bodies_loaded=True)
    absent = compare_family("test", None, output(), None, bodies_loaded=False)
    different = compare_family("test", Builder(), output(), result(output(2)), bodies_loaded=True)
    assert report().exit_code() == report((same, absent)).exit_code() == 0
    assert report((same, different, absent)).exit_code() == 2


def test_input_hashes_stay_paired_and_paths_are_portable():
    files = (("facts/z.parquet", "b" * 64), ("facts/a.parquet", "c" * 64))
    first = replace(report(), input_files=files)
    second = replace(first, input_files=tuple(reversed(files)))
    assert first.to_json(timings=False) == second.to_json(timings=False)
    assert json.loads(first.to_json())["input_files"] == [list(files[1]), list(files[0])]
    for path in ("C:/host/file", "/host/file", "../file", "facts\\file"):
        with pytest.raises(ValueError, match="relative"):
            replace(first, input_files=((path, "b" * 64),))


def test_absent_empty_table_is_different():
    empty = TableRows("gold.test", ("id",), ("id",), ())
    replay = compare_family(
        "test",
        Builder(),
        FamilyOutput({"gold.test": empty}, {}),
        result(FamilyOutput({}, {})),
        bodies_loaded=True,
    )
    assert replay.status == "different"
    assert replay.postgres_rows == {"gold.test": 0} and replay.duckdb_rows == {}
    assert replay.differences[0].kind == "missing"
