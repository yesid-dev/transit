from dataclasses import replace

import pytest

from transit_ops.batch.build import FamilyOutput, TableRows
from transit_ops.batch.sanity import Invariant, check_output


def output(values):
    table = TableRows("gold.toy", ("id", "n", "d", "rate", "p50", "p90"), ("id",), ((1, *values),))
    return FamilyOutput({"gold.toy": table}, {})


@pytest.mark.parametrize(
    "value,name",
    [
        (float("nan"), "finite"),
        (float("inf"), "finite"),
        (-0.0, "negative_zero"),
        ("a\x00b", "nul"),
    ],
)
def test_universal(value, name):
    with pytest.raises(ValueError, match=rf"gold.toy.*1.*{name}"):
        check_output(output((value, 4, 0.5, 1, 2)))


@pytest.mark.parametrize(
    "kind,columns,bad",
    [
        ("count", ("n",), (-1, 4, 0.5, 1, 2)),
        ("rate", ("rate", "n", "d"), (2, 4, 0.6, 1, 2)),
        ("sum", ("d", "n", "n"), (2, 5, 0.5, 1, 2)),
        ("percentiles", ("p50", "p90"), (2, 4, 0.5, 3, 2)),
        ("duration", ("p50",), (2, 4, 0.5, -1, 2)),
    ],
)
def test_declared(kind, columns, bad):
    rules = (Invariant("gold.toy", kind, columns, name="math"),)
    check_output(output((2, 4, 0.5, 1, 2)), rules)
    with pytest.raises(ValueError, match="gold.toy.*1.*math"):
        check_output(output(bad), rules)


def test_grouped_parts_and_missing_total():
    total = TableRows("gold.total", ("id", "n"), ("id",), ((1, 3),))
    parts = TableRows("gold.parts", ("id", "hour", "n"), ("id", "hour"), ((1, 0, 1), (1, 1, 2)))
    rule = Invariant(
        "gold.parts",
        "sum",
        ("n",),
        total_table="gold.total",
        total_column="n",
        group_by=("id",),
        name="daily",
    )
    good = FamilyOutput({"gold.total": total, "gold.parts": parts}, {})
    check_output(good, (rule,))
    for rows in [((1, 0, 1),), ()]:
        with pytest.raises(ValueError, match="gold.parts.*1.*daily"):
            check_output(
                replace(good, tables=good.tables | {"gold.parts": replace(parts, rows=rows)}),
                (rule,),
            )
