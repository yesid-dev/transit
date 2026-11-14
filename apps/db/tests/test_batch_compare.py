import struct
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from transit_ops.batch.build import TableRows
from transit_ops.batch.compare import (
    RUNTIME_ONLY_COLUMNS,
    BodyDifference,
    RowDifference,
    compare_bodies,
    compare_tables,
)


def table(value, *, key=1):
    return TableRows("gold.toy", ("id", "value"), ("id",), ((key, value),))


def test_identical_bodies_have_no_difference():
    assert compare_bodies({"a": b'{"a":null}'}, {"a": b'{"a":null}'}) == []


def test_a_one_byte_change_is_located():
    expected, actual = b'{"a":[1,{"b":2.5}]}', b'{"a":[1,{"b":2.50}]}'
    assert compare_bodies({"body": expected}, {"body": actual}) == [
        BodyDifference("body", "bytes", "$.a[1].b", expected.decode(), actual.decode())
    ]


@pytest.mark.parametrize(
    "left,right,path",
    [
        (b'{"a":null}', b'{"a":""}', "$.a"),
        (b"[1]", b"[1,2]", "$[1]"),
        (b'{"a":1}', b"{}", "$.a"),
        (b'{"a":1}', b'{ "a":1}', "$"),
        (b"bad", b"null", None),
        (b'{"a":1e0}', b'{"a":1}', "$.a"),
        (b'{"a":NaN}', b'{"a":null}', None),
        (b"\xff", b"\xfe", None),
    ],
)
def test_body_diagnostics_never_override_bytes(left, right, path):
    (difference,) = compare_bodies({"body": left}, {"body": right})
    assert difference.kind == "bytes" and difference.path == path
    assert difference.expected != difference.actual


def test_missing_and_extra_keys_are_reported_sorted():
    assert compare_bodies({"z": b"null"}, {"a": b"null"}) == [
        BodyDifference("a", "extra", None, None, "null"),
        BodyDifference("z", "missing", None, "null", None),
    ]


@pytest.mark.parametrize("left,right", [(0.1 + 0.2, 0.3), (0.0, -0.0)])
def test_float_comparison_is_bitwise(left, right):
    assert compare_tables(table(left), table(right)) == [
        RowDifference("gold.toy", (1,), "value", "value", left, right)
    ]


def test_nan_payloads_are_compared():
    first = struct.unpack("<d", bytes.fromhex("010000000000f87f"))[0]
    second = struct.unpack("<d", bytes.fromhex("020000000000f87f"))[0]
    assert compare_tables(table(first), table(first)) == []
    (difference,) = compare_tables(table(first), table(second))
    assert difference.kind == "value" and difference.column == "value"


def test_decimal_scale_is_compared():
    assert compare_tables(table(Decimal("1.50")), table(Decimal("1.5"))) == [
        RowDifference("gold.toy", (1,), "value", "value", Decimal("1.50"), Decimal("1.5"))
    ]
    assert compare_tables(table(Decimal("1.5")), table(1.5))[0].kind == "type"


def test_null_is_not_empty_and_timestamps_compare_by_instant_and_offset():
    assert compare_tables(table(None), table(""))[0].kind == "type"
    stamp = datetime(2026, 11, 1, tzinfo=UTC)
    assert compare_tables(table(stamp), table(stamp)) == []
    for other in [
        stamp + timedelta(seconds=1),
        stamp.astimezone(timezone(timedelta(hours=1))),
        stamp.replace(tzinfo=None),
    ]:
        assert compare_tables(table(stamp), table(other))[0].column == "value"


@pytest.mark.parametrize(
    "left,right",
    [
        ([None], [""]),
        ([0.0], [-0.0]),
        ([1], [True]),
        ([[Decimal("1.0")]], [[Decimal("1.00")]]),
        ([1], [1, 1]),
        ({"a": [1]}, {"a": [True]}),
    ],
)
def test_lists_compare_elementwise(left, right):
    assert compare_tables(table(left), table(right))[0].column == "value"
    assert compare_tables(table(left), table(left)) == []


@pytest.mark.parametrize(
    "left,right", [("1.00", "1.0"), ("{1,NULL}", '{1,""}'), ('{"n": 1.0}', '{"n": 1.00}')]
)
def test_postgres_exact_text_is_never_parsed(left, right):
    assert compare_tables(table(left), table(right))[0].kind == "value"


def test_table_shape_must_match_before_rows():
    expected = table(1)
    for actual in [
        replace(expected, relation="gold.other"),
        TableRows("gold.toy", ("value", "id"), ("id",), ((1, 1),)),
        replace(expected, key=("value",)),
    ]:
        (difference,) = compare_tables(expected, actual)
        assert difference.relation == "gold.toy" and difference.kind == "columns"


def test_keys_keep_types_and_every_row_is_counted():
    expected = replace(table("same"), rows=((1, "same"), (2, "same")))
    assert compare_tables(expected, table("same")) == [
        RowDifference("gold.toy", (2,), "missing", None, (2, "same"), None)
    ]
    assert compare_tables(table("same"), expected)[0].kind == "extra"
    assert {d.kind for d in compare_tables(table(1), table(1, key=True))} == {"missing", "extra"}
    assert {d.kind for d in compare_tables(table(1, key=0.0), table(1, key=-0.0))} == {
        "missing",
        "extra",
    }


def test_runtime_only_columns_are_exactly_the_declared_ones():
    assert RUNTIME_ONLY_COLUMNS == {
        "gold.route_delay_hourly": frozenset({"built_at_utc"}),
        "gold.warm_rollup_periods": frozenset({"built_at_utc", "invalidated_at_utc"}),
    }
    for relation in RUNTIME_ONLY_COLUMNS:
        left = runtime_table(relation)
        period = left.rows[0][left.columns.index("period_start_utc")]
        right = runtime_table(relation, built_at_utc=period + timedelta(minutes=6))
        assert compare_tables(left, right) == []
        left = replace(left, key=("provider_id",))
        right = replace(
            runtime_table(relation, period_start_utc=period - timedelta(seconds=1)),
            key=left.key,
        )
        assert compare_tables(left, right)[0].column == "period_start_utc"


def runtime_table(relation="gold.warm_rollup_periods", **changes):
    stamp = datetime(2026, 11, 1, tzinfo=UTC)
    built = stamp + timedelta(minutes=5)
    # Migration 0093:1044-1059 and 1395-1401, in DDL order.
    columns = (
        "provider_id period_start_utc route_id trip_count observation_count avg_delay_seconds "
        "max_delay_seconds delayed_trip_count severe_delay_count built_at_utc "
        "delay_observation_count on_time_observation_count usable_delay_observation_count "
        "usable_delay_sum_seconds"
    ).split()
    row = ("network", stamp, "r", 7, 7, None, 0, 0, 0, built, 0, 0, 0, 0)
    key = ("provider_id", "period_start_utc", "route_id")
    if relation == "gold.warm_rollup_periods":
        columns = "provider_id rollup_kind period_start_utc built_at_utc invalidated_at_utc".split()
        row = ("network", "hour", stamp, built, None)
        key = ("provider_id", "rollup_kind", "period_start_utc")
    values = dict(zip(columns, row, strict=True)) | changes
    return TableRows(relation, tuple(columns), key, (tuple(values[c] for c in columns),))


@pytest.mark.parametrize("column", ["invalidated_at_utc", "built_at_utc"])
def test_warm_state_survives_runtime_masking(column):
    left = runtime_table()
    right = runtime_table(**{column: left.rows[0][2]})
    (difference,) = compare_tables(left, right)
    assert difference.key == ("network", "hour", left.rows[0][2])
    assert difference.column == (column if column == "invalidated_at_utc" else "built_after_period")


@pytest.mark.parametrize("column", ["built_at_utc", "invalidated_at_utc"])
def test_missing_runtime_column_is_a_shape_difference(column):
    left = runtime_table()
    i = left.columns.index(column)
    missing = replace(
        left,
        columns=left.columns[:i] + left.columns[i + 1 :],
        rows=(left.rows[0][:i] + left.rows[0][i + 1 :],),
    )
    for a, b in [(left, missing), (missing, left), (missing, missing)]:
        (difference,) = compare_tables(a, b)
        assert difference.kind == "columns"


def test_warm_runtime_kind_is_independent_of_host_timezone():
    class EasternClock(datetime):
        def astimezone(self, tz=None):
            # Pin naive conversion to UTC-05 even when the test host is UTC.
            local = self.replace(tzinfo=self.tzinfo or timezone(timedelta(hours=-5)))
            return datetime.astimezone(local, tz)

    mature = EasternClock(2026, 11, 1, 0, 6, tzinfo=UTC)
    premature = mature.replace(minute=1, tzinfo=None)
    left, right = runtime_table(built_at_utc=mature), runtime_table(built_at_utc=premature)
    (difference,) = compare_tables(left, right)
    assert difference.column == "built_at_utc"


@pytest.mark.parametrize("value", [datetime(2026, 11, 1), "<runtime>", 42])
def test_route_hour_runtime_mask_keeps_kind(value):
    left = runtime_table("gold.route_delay_hourly")
    right = runtime_table("gold.route_delay_hourly", built_at_utc=value)
    (difference,) = compare_tables(left, right)
    assert difference.column == "built_at_utc"


@pytest.mark.parametrize("column", ["built_at_utc", "period_start_utc"])
def test_warm_flag_refuses_naive_clock_by_name(column):
    table = runtime_table(**{column: datetime(2026, 11, 1)})
    with pytest.raises(ValueError, match=column):
        compare_tables(table, table)
