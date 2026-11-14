import json
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta, timezone
from decimal import Decimal, localcontext
from zoneinfo import ZoneInfo

import duckdb
import pytest

from transit_ops.batch.build import FamilyOutput, TableRows
from transit_ops.batch.compare import compare_bodies, compare_tables
from transit_ops.batch.manifest import BuildManifest
from transit_ops.batch.replay_report import ReplayReport, compare_family
from transit_ops.batch.run import BuildResult

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 2, 7, tzinfo=UTC)


class Builder:
    family_id = "test"
    published_keys = ()
    tables = ("gold.test",)
    variants = {}

    def inputs(self, request):
        return ()

    def build(self, session, request):
        raise NotImplementedError


def output(value=1):
    return FamilyOutput(
        {"gold.test": TableRows("gold.test", ("id", "v"), ("id",), ((1, value),))}, {}
    )


def result(value=1, **changes):
    manifest = BuildManifest("test", (DAY,), STAMP, 35, 7, "UTC", "test", "a" * 40, ())
    return BuildResult(replace(manifest, **changes), output(value))


def replay(left=1, right=1):
    return compare_family("test", Builder(), output(left), result(right), bodies_loaded=True)


def report(*families, **changes):
    return replace(
        ReplayReport("test", DAY, STAMP, "a" * 40, duckdb.__version__, (), families), **changes
    )


def test_statuses_and_exit_policy():
    same, different = replay(), replay(1, 2)
    absent = compare_family("test", None, output(), None, bodies_loaded=False)
    builder = Builder()
    builder.published_keys = ("historic/*.json",)
    for built in (None, result()):
        skipped = compare_family("test", builder, output(), built, bodies_loaded=False)
        assert skipped.status == "not_compared" and skipped.reason == "rollup history not loaded"
        assert report(skipped).exit_code() == 0
    assert same.status == "identical" and same.build_id == result().manifest.build_id
    assert same.code_commit == "a" * 40 and same.engine_version == duckdb.__version__
    assert same.postgres_rows == same.duckdb_rows == {"gold.test": 1}
    assert absent.status == "not_implemented" and absent.duckdb_rows is None
    assert report().exit_code() == report(same).exit_code() == report(absent).exit_code() == 0
    assert different.status == "different" and report(different).exit_code() == 2


@pytest.mark.parametrize(
    "builder,built,name",
    [
        (Builder(), None, "duckdb"),
        (None, result(), "builder"),
        (Builder(), result(), "builder.family_id"),
        (Builder(), result(family_id="other"), "manifest.family_id"),
    ],
)
def test_impossible_comparisons_refused(builder, built, name):
    family = "other" if name == "builder.family_id" else "test"
    with pytest.raises(ValueError, match=name):
        compare_family(family, builder, output(), built, bodies_loaded=True)


@pytest.mark.parametrize(
    "changes,name",
    [
        ({"code_commit": "HEAD"}, "code_commit"),
        ({"code_commit": "b" * 40}, "code_commit"),
        ({"duckdb_version": "wrong"}, "engine_version"),
        ({"as_of_utc": STAMP.replace(tzinfo=None)}, "as_of_utc"),
        ({"families": (replay(), replay())}, "family_id"),
        (
            {"families": (replay(), replace(replay(), family_id="other", code_commit="b" * 40))},
            "code_commit",
        ),
        (
            {"families": (replay(), replace(replay(), family_id="other", engine_version="wrong"))},
            "engine_version",
        ),
    ],
)
def test_report_refusals(changes, name):
    with pytest.raises(ValueError, match=name):
        report(replay(), **changes)


@pytest.mark.parametrize(
    "path", ["", ".", "C:/file", "/file", "../file", "a\\b", "a/./b", "a//b", "./a", "a/"]
)
def test_noncanonical_paths_refused(path):
    with pytest.raises(ValueError, match="input_files"):
        report(input_files=((path, "b" * 64),))


@pytest.mark.parametrize(
    "files", [(("a", "bad"),), (("a", "B" * 64),), (("a", "b" * 64), ("a", "c" * 64))]
)
def test_hashes_and_duplicate_paths_refused(files):
    with pytest.raises(ValueError, match="input_files"):
        report(input_files=files)


@pytest.mark.parametrize(
    "left,right",
    [
        (Decimal("1.00"), "1.00"),
        (DAY, DAY.isoformat()),
        (STAMP, STAMP.isoformat()),
        (datetime(2026, 1, 1), datetime(2026, 1, 1, fold=1)),
        (time(12, tzinfo=ZoneInfo("America/Toronto")), time(12)),
        (timedelta(microseconds=1), "0:00:00.000001"),
        (b"a", "61"),
        (float("nan"), None),
        (float("inf"), None),
        (float("-inf"), None),
        ((1,), [1]),
        (0.1 + 0.2, 0.3),
        (0.0, -0.0),
        (None, ""),
    ],
)
def test_typed_diagnostics_are_distinguishable_and_strict_json(left, right):
    family = replay(left, right)

    def invalid(value):
        raise ValueError(value)

    body = json.loads(report(family).to_json(), parse_constant=invalid)
    diagnostic = body["families"][0]["differences"][0]
    assert family.status == "different"
    assert json.dumps(diagnostic["expected"]) != json.dumps(diagnostic["actual"])


def test_decimal_context_and_stamp_and_timings():
    first = report(replay(Decimal("1e-12"), None))
    with localcontext() as context:
        context.capitals = 0
        lower = first.to_json()
        context.capitals = 1
        assert first.to_json() == lower
    shifted = STAMP.astimezone(timezone(timedelta(hours=-5)))
    assert replace(first, as_of_utc=shifted, duckdb_seconds=3).to_json() == lower
    assert json.loads(first.to_json(timings=True))["postgres_seconds"] is None
    assert json.loads(lower)["families"][0]["differences"][0]["expected"] == {
        "decimal": {"sign": 0, "digits": [1], "exponent": -12}
    }


def test_count_delegation_and_reordering():
    table = TableRows("gold.test", ("id", "v"), ("id",), tuple((i, 1) for i in range(25)))
    other = replace(table, rows=tuple((i, None) for i in range(25)))
    left = FamilyOutput({"gold.test": table}, {f"body/{i:02}": b'{"v":1}' for i in range(40)})
    right = FamilyOutput({"gold.test": other}, {f"body/{i:02}": b'{"v":1.0}' for i in range(40)})
    family = compare_family(
        "test", Builder(), left, replace(result(), output=right), bodies_loaded=True
    )
    assert family.differences == tuple(
        (compare_tables(table, other) + compare_bodies(left.bodies, right.bodies))[:50]
    )
    assert family.difference_count == 65
    another = replace(family, family_id="other")
    files = (("z", "b" * 64), ("a", "c" * 64))
    assert (
        report(family, another, input_files=files).to_json()
        == report(another, family, input_files=tuple(reversed(files))).to_json()
    )
    missing = compare_family("test", Builder(), FamilyOutput({}, {}), result(), bodies_loaded=True)
    assert missing.differences[0].kind == "columns"
    assert missing.differences[0].actual == ("gold.test", ("id", "v"), ("id",))


def test_golden_report_bytes():
    assert report(duckdb_version="fixture").to_json() == (
        b'{"as_of_utc":"2026-11-02T07:00:00.000000Z","code_commit":'
        b'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","duckdb_version":"fixture",'
        b'"families":[],"input_files":[],"local_date":"2026-11-01","provider_id":"test"}'
    )
