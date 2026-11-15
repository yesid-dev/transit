"""Build, shadow and replay contracts for exact checked values."""

import math
import sys
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal, localcontext
from hashlib import sha256

import duckdb
import pytest
from typer.testing import CliRunner

from transit_ops.batch.build import BuildRequest, FamilyOutput, TableRows
from transit_ops.batch.checkpoints import CheckpointStore, accept
from transit_ops.batch.compare import compare_tables
from transit_ops.batch.families import registry
from transit_ops.batch.replay_report import ReplayReport, compare_family
from transit_ops.batch.run import run_family
from transit_ops.batch.sanity import Invariant, check_output
from transit_ops.batch.shadow import ShadowBuilder, write_shadow
from transit_ops.commands import batch
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.sql_registry import named_query

DAY = date(2026, 11, 12)
REQUEST = BuildRequest("sample", (DAY,), datetime(2026, 11, 13, 7, tzinfo=UTC), 30, 7, "UTC")
COMMIT = "a" * 40


class Builder:
    family_id = "sample_family"
    tables = ("gold.sample",)
    published_keys = ()
    variants = {}
    invariants = ()

    def __init__(self, sql="SELECT 1 id, 0.3::DOUBLE value", invariants=()):
        self.sql = sql
        self.invariants = invariants

    def inputs(self, request):
        return ()

    def build(self, session, request):
        session.execute(named_query("review.create_schema", "CREATE SCHEMA gold"))
        query_name = "review.create_table_" + sha256(self.sql.encode()).hexdigest()[:12]
        session.execute(named_query(query_name, "CREATE TABLE gold.sample AS " + self.sql))
        result = session.execute(
            named_query("review.read", "SELECT * FROM gold.sample ORDER BY id")
        )
        table = TableRows(self.tables[0], result.columns, ("id",), tuple(map(tuple, result)))
        return FamilyOutput({table.relation: table}, {})


def run(builder, root):
    return run_family(
        builder, REQUEST, inputs_root=root / "inputs", workdir=root / "work", code_commit=COMMIT
    )


def output(columns, values):
    table = TableRows("gold.sample", ("id", *columns), ("id",), ((1, *values),))
    return FamilyOutput({table.relation: table}, {})


def test_shadow_forwards_declared_invariants(tmp_path):
    builder = Builder("SELECT 1 id, -1 n", (Invariant("gold.sample", "count", ("n",)),))
    with pytest.raises(ValueError, match="invariant=count"):
        run(builder, tmp_path / "direct")
    tables = tmp_path / "tables"
    tables.mkdir()
    with pytest.raises(ValueError, match="invariant=count"):
        run(ShadowBuilder(builder, tables), tmp_path / "shadow")


def test_shadow_writes_the_canonical_values_it_checkpoints(tmp_path):
    tables = tmp_path / "tables"
    tables.mkdir()
    builder = Builder("SELECT 1 id, 0.30000000000000004::DOUBLE value")
    build = run(ShadowBuilder(builder, tables), tmp_path)
    assert build.output.tables["gold.sample"].rows == ((1, 0.30000000000000004),)
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    objects = tmp_path / "objects"
    objects.mkdir()
    write_shadow(checkpoint, LocalBronzeStorage("local", objects), tables_dir=tables)


@pytest.mark.parametrize("key_sql", ["1", "DATE '2026-11-12'", "TIMESTAMP '2026-11-12 00:00:00'"])
def test_shadow_cli_accepts_a_normalized_replay(tmp_path, monkeypatch, key_sql):
    builder = Builder(f"SELECT {key_sql} id, 0.3::DOUBLE value")
    build = run(builder, tmp_path / "reference")
    table = build.output.tables["gold.sample"]
    expected = FamilyOutput(
        {table.relation: replace(table, rows=((table.rows[0][0], 0.30000000000000004),))}, {}
    )
    evidence = compare_family(builder.family_id, builder, expected, build, bodies_loaded=False)
    assert evidence.status == "identical_after_normalization"
    checkpoint = CheckpointStore(tmp_path / "direct-checkpoint").record(build, DAY)
    assert accept(checkpoint, evidence).build_id == build.manifest.build_id
    report = ReplayReport("sample", DAY, REQUEST.as_of_utc, COMMIT, families=(evidence,))
    report_path = tmp_path / "report.json"
    report_path.write_bytes(report.to_json())
    inputs = tmp_path / "inputs/core.providers"
    inputs.mkdir(parents=True)
    with duckdb.connect() as conn:
        conn.sql("SELECT 'sample' provider_id, 'UTC' timezone").write_parquet(
            str(inputs / "all.parquet")
        )
    objects = tmp_path / "objects"
    objects.mkdir()
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(objects))
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", "30")
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", "7")
    monkeypatch.setattr(registry, "resolve_builder", lambda name: builder)
    monkeypatch.setattr(batch, "_code_commit", lambda: COMMIT)
    response = CliRunner().invoke(
        batch.app,
        [
            "shadow-build",
            "--provider",
            "sample",
            "--date",
            str(DAY),
            "--as-of",
            REQUEST.as_of_utc.isoformat(),
            "--inputs",
            str(inputs.parent),
            "--workdir",
            str(tmp_path / "command"),
            "--family",
            builder.family_id,
            "--accept-from",
            str(report_path),
        ],
    )
    assert response.exit_code == 0, response.output + str(response.exception)
    assert list(objects.rglob("accepted.json"))


def test_finite_builder_value_remains_finite(tmp_path):
    build = run(Builder(f"SELECT 1 id, {sys.float_info.max!r}::DOUBLE value"), tmp_path)
    assert math.isfinite(build.output.tables["gold.sample"].rows[0][1])


@pytest.mark.parametrize("key_sql", ["DATE '2026-11-12'", "TIMESTAMPTZ '2026-11-12 00:00:00+00'"])
def test_normalized_acceptance_keeps_typed_date_keys(tmp_path, key_sql):
    builder = Builder(f"SELECT {key_sql} id, 0.3::DOUBLE value")
    build = run(builder, tmp_path)
    table = build.output.tables["gold.sample"]
    expected = FamilyOutput(
        {table.relation: replace(table, rows=((table.rows[0][0], 0.30000000000000004),))}, {}
    )
    evidence = compare_family(builder.family_id, builder, expected, build, bodies_loaded=False)
    assert evidence.status == "identical_after_normalization"
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    assert accept(checkpoint, evidence).build_id == build.manifest.build_id


def test_returned_output_still_satisfies_its_declared_sum(tmp_path):
    rule = Invariant("gold.sample", "sum", ("total", "a", "b"))
    build = run(
        Builder(
            "SELECT 1 id, 2.469135780248::DOUBLE total, "
            "1.234567890124::DOUBLE a, 1.234567890124::DOUBLE b",
            (rule,),
        ),
        tmp_path,
    )
    check_output(build.output, (rule,))


def test_decimal_sum_never_rounds_an_incorrect_exact_total():
    with localcontext() as context:
        context.prec = 28
        bad = output(("total", "a", "b"), (Decimal(10**28), Decimal(10**28), Decimal(1)))
        with pytest.raises(ValueError, match="invariant=sum"):
            check_output(bad, (Invariant("gold.sample", "sum", ("total", "a", "b")),))


def test_exact_numeric_text_sums_are_supported():
    good = output(("total", "a", "b"), ("3.00", "1.00", "2.00"))
    check_output(good, (Invariant("gold.sample", "sum", ("total", "a", "b")),))


def test_rate_rejects_a_wrong_exact_decimal():
    bad = output(("rate", "n", "d"), (Decimal("0.5000000000004"), 1, 2))
    with pytest.raises(ValueError, match="invariant=rate"):
        check_output(bad, (Invariant("gold.sample", "rate", ("rate", "n", "d")),))


def test_count_declaration_cannot_be_silently_rewritten(tmp_path):
    rule = Invariant("gold.sample", "count", ("n",))
    build = run(Builder("SELECT 1 id, 1000000000001::DOUBLE n", (rule,)), tmp_path)
    assert build.output.tables["gold.sample"].rows[0][1] == 1000000000001


def test_float_key_collisions_cannot_hide_changed_rows(tmp_path):
    # Same row counts: this also gets past the checkpoint's row-count guard.
    a = TableRows(
        "gold.sample",
        ("id", "value"),
        ("id",),
        ((1.0000000000001, "lost"), (1.0000000000002, "same")),
    )
    b = replace(a, rows=((1.0000000000001, "changed"), (1.0000000000002, "same")))
    with pytest.raises(ValueError, match="gold.sample.*key.*collision"):
        compare_tables(a, b)


def test_numeric_precision_integer_timestamp_text_remain_exact():
    pairs = [
        (10**28, 10**28 + 1),
        (Decimal("1.0000000000001"), Decimal("1.0000000000002")),
        ("1.0000000000001", "1.0000000000002"),
        (
            datetime(2026, 11, 12, microsecond=1, tzinfo=UTC),
            datetime(2026, 11, 12, microsecond=2, tzinfo=UTC),
        ),
        ("a", "a "),
    ]
    for left, right in pairs:
        differences = compare_tables(
            output(("v",), (left,)).tables["gold.sample"],
            output(("v",), (right,)).tables["gold.sample"],
        )
        assert len(differences) == 1 and differences[0].difference_class == "value"


@pytest.mark.parametrize("value", [1.5, float(2**53 + 2)])
def test_double_counts_refuse_fractional_or_unsafe_values(value):
    with pytest.raises(ValueError, match="invariant=count"):
        check_output(output(("n",), (value,)), (Invariant("gold.sample", "count", ("n",)),))


def test_grouped_numeric_text_sum_is_context_independent():
    total = TableRows("gold.total", ("id", "n"), ("id",), ((1, str(10**28 + 1)),))
    parts = TableRows(
        "gold.parts", ("id", "hour", "n"), ("id", "hour"), ((1, 0, str(10**28)), (1, 1, "1"))
    )
    rule = Invariant(
        "gold.parts", "sum", ("n",), total_table="gold.total", total_column="n", group_by=("id",)
    )
    with localcontext() as context:
        context.prec = 3
        check_output(FamilyOutput({"gold.total": total, "gold.parts": parts}, {}), (rule,))


@pytest.mark.parametrize("rate", [Decimal("0.33"), "0.33", 0.33000000000000002])
def test_rate_checks_supplied_value_at_declared_scale(rate):
    rule = Invariant("gold.sample", "rate", ("r", "n", "d"), precision=2)
    good = output(("r", "n", "d"), (rate, 1, 3))
    with localcontext() as context:
        context.prec = 2
        check_output(good, (rule,))


def test_shadow_normalizes_only_signed_zero(tmp_path):
    tables = tmp_path / "tables"
    tables.mkdir()
    build = run(ShadowBuilder(Builder("SELECT 1 id, -0.0::DOUBLE value"), tables), tmp_path)
    value = build.output.tables["gold.sample"].rows[0][1]
    assert math.copysign(1, value) == 1
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    objects = tmp_path / "objects"
    objects.mkdir()
    write_shadow(checkpoint, LocalBronzeStorage("local", objects), tables_dir=tables)


@pytest.mark.parametrize("shadow", [False, True])
def test_declared_double_count_difference_refuses_acceptance(tmp_path, shadow):
    from transit_ops.batch.checkpoints import NotAccepted

    builder = Builder(
        "SELECT 1 id, 1000000000001::DOUBLE n",
        (Invariant("gold.sample", "count", ("n",)),),
    )
    if shadow:
        tables = tmp_path / "tables"
        tables.mkdir()
        builder = ShadowBuilder(builder, tables)
    build = run(builder, tmp_path)
    table = build.output.tables["gold.sample"]
    expected = FamilyOutput({table.relation: replace(table, rows=((1, 1000000000000.0),))}, {})
    evidence = compare_family(builder.family_id, builder, expected, build, bodies_loaded=False)
    assert evidence.status == "different"
    assert evidence.difference_counts == {"representation": 0, "value": 1}
    (difference,) = evidence.differences
    assert difference.difference_class == "value"
    assert (difference.expected, difference.actual) == (1000000000000.0, 1000000000001.0)
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    with pytest.raises(NotAccepted):
        accept(checkpoint, evidence)
    assert not (checkpoint.path / "accepted.json").exists()


@pytest.mark.parametrize("grouped", [False, True])
def test_declared_double_count_sums_are_exact(grouped):
    if grouped:
        total = TableRows("gold.total", ("id", "n"), ("id",), ((1, 1000000000000.0),))
        parts = TableRows(
            "gold.parts",
            ("id", "hour", "n"),
            ("id", "hour"),
            ((1, 0, 1000000000000.0), (1, 1, 1.0)),
        )
        result = FamilyOutput({"gold.total": total, "gold.parts": parts}, {})
        rules = (
            Invariant(
                "gold.parts",
                "sum",
                ("n",),
                name="count_sum",
                total_table="gold.total",
                total_column="n",
                group_by=("id",),
            ),
            Invariant("gold.total", "count", ("n",)),
            Invariant("gold.parts", "count", ("n",)),
        )
    else:
        result = output(("total", "a", "b"), (1000000000000.0, 1000000000000.0, 1.0))
        rules = (
            Invariant("gold.sample", "sum", ("total", "a", "b"), name="count_sum"),
            Invariant("gold.sample", "count", ("total", "a", "b")),
        )
    with pytest.raises(ValueError, match="gold.*1.*invariant=count_sum"):
        check_output(result, rules)

    if grouped:
        corrected = replace(total, rows=((1, 1000000000001.0),))
        good = replace(result, tables=result.tables | {total.relation: corrected})
    else:
        good = output(("total", "a", "b"), (1000000000001.0, 1000000000000.0, 1.0))
    check_output(good, rules)


@pytest.mark.parametrize("shadow", [False, True])
def test_declared_count_signed_zero_classification_and_acceptance(tmp_path, shadow):
    builder = Builder("SELECT 1 id, 0.0::DOUBLE n", (Invariant("gold.sample", "count", ("n",)),))
    if shadow:
        tables = tmp_path / "tables"
        tables.mkdir()
        builder = ShadowBuilder(builder, tables)
    build = run(builder, tmp_path)
    table = build.output.tables["gold.sample"]
    expected = FamilyOutput({table.relation: replace(table, rows=((1, -0.0),))}, {})
    evidence = compare_family(builder.family_id, builder, expected, build, bodies_loaded=False)
    assert evidence.status == "identical_after_normalization"
    assert evidence.difference_counts == {"representation": 1, "value": 0}
    assert evidence.differences[0].difference_class == "representation"
    checkpoint = CheckpointStore(tmp_path / "checkpoints").record(build, DAY)
    assert accept(checkpoint, evidence).build_id == build.manifest.build_id
    assert (checkpoint.path / "accepted.json").is_file()
