import json
from copy import deepcopy
from dataclasses import asdict
from itertools import permutations

import pytest
from sqlalchemy import Engine, text

from transit_ops.gold.reader.delay_hist import (
    CANCEL_NOTICE_HIST_LAYOUT,
    DELAY_HIST_LAYOUTS,
    HistLayoutMismatch,
    QuantileBin,
    bin_index,
    hist_edges_sql,
    merge_hist,
    quantile_bin,
)
from transit_ops.gold.reader.rates import delay_bins

# Specification oracle: edge, bin one second before, on, and one second after.
CANCEL_BOUNDARIES = (
    (-3600, 0, 1, 1),
    (-1800, 1, 2, 2),
    (-600, 2, 3, 3),
    (0, 3, 4, 4),
    (300, 4, 5, 5),
    (600, 5, 6, 6),
    (1200, 6, 7, 7),
    (1800, 7, 8, 8),
    (3600, 8, 9, 9),
    (7200, 9, 10, 10),
    (14400, 10, 11, 11),
    (28800, 11, 12, 12),
    (86400, 12, 13, 13),
)

# Captured from the unchanged baseline before registration; never regenerated.
LEGACY_SQL = (
    b"ARRAY[-3600,-3300,-3000,-2700,-2400,-2100,-1800,-1680,-1560,-1440,-1320,-1200,"
    b"-1080,-960,-840,-720,-600,-570,-540,-510,-480,-450,-420,-390,-360,-330,-300,"
    b"-270,-240,-210,-180,-150,-120,-110,-100,-90,-80,-70,-60,-50,-40,-30,-20,-10,"
    b"0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200,"
    b"210,220,230,240,250,260,270,280,290,300,310,320,330,340,350,360,370,380,390,"
    b"400,410,420,430,440,450,460,470,480,490,500,510,520,530,540,550,560,570,580,"
    b"590,600,630,660,690,720,750,780,810,840,870,900,930,960,990,1020,1050,1080,"
    b"1110,1140,1170,1200,1230,1260,1290,1320,1350,1380,1410,1440,1470,1500,1530,"
    b"1560,1590,1620,1650,1680,1710,1740,1770,1800,1920,2040,2160,2280,2400,2520,"
    b"2640,2760,2880,3000,3120,3240,3360,3480,3600]::integer[]"
)
LEGACY_RESULTS = (
    b'{"bins":[0,1,159,160],"merge":[[1,7,160],[3,7,5]],"empty":[[],[]],'
    b'"quantiles":[{"bin":45,"lower_s":0,"upper_s":10,"n":1000},'
    b'{"bin":160,"lower_s":3600,"upper_s":null,"n":1000}],'
    b'"open":[{"bin":0,"lower_s":null,"upper_s":-3600,"n":4},'
    b'{"bin":160,"lower_s":3600,"upper_s":null,"n":4}],'
    b'"r3":[{"bin":45,"lower_s":0,"upper_s":10,"n":1000},'
    b'{"bin":45,"lower_s":0,"upper_s":10,"n":1000}]}'
)


def test_each_layout_has_a_unit() -> None:
    assert DELAY_HIST_LAYOUTS[2].unit == "seconds"
    assert DELAY_HIST_LAYOUTS[2].layout_id == 2
    assert DELAY_HIST_LAYOUTS[2].left_closed is True
    assert 1 not in DELAY_HIST_LAYOUTS


def test_sql_edges_equal_python_edges() -> None:
    assert CANCEL_NOTICE_HIST_LAYOUT == 3
    assert hist_edges_sql(3) == (
        "ARRAY[-3600,-1800,-600,0,300,600,1200,1800,3600,7200,14400,28800,86400]::integer[]"
    )
    layout = DELAY_HIST_LAYOUTS[3]
    assert layout.edges_s == (
        -3600,
        -1800,
        -600,
        0,
        300,
        600,
        1200,
        1800,
        3600,
        7200,
        14400,
        28800,
        86400,
    )
    assert layout.layout_id == 3
    assert layout.left_closed is True
    assert layout.unit == "seconds"


def test_python_bins_have_literal_left_closed_boundaries() -> None:
    for edge, before, on, after in CANCEL_BOUNDARIES:
        assert [bin_index(edge + offset, layout=3) for offset in (-1, 0, 1)] == [before, on, after]
    assert bin_index(-100000, layout=3) == 0
    assert bin_index(100000, layout=3) == 13


@pytest.mark.parametrize("layout", [2, 3])
def test_sql_and_python_bins_agree_on_every_edge(real_db_engine: Engine, layout: int) -> None:
    # Layout 2's frozen SQL supplies its independently captured baseline edges.
    legacy_edges = [int(v) for v in LEGACY_SQL[6:-12].decode("ascii").split(",")]
    boundaries = (
        [(edge, i, i + 1, i + 1) for i, edge in enumerate(legacy_edges)]
        if layout == 2
        else list(CANCEL_BOUNDARIES)
    )
    samples = [(-100000, 0), (100000, 160 if layout == 2 else 13)]
    for edge, before, on, after in boundaries:
        samples.extend([(edge - 1, before), (edge, on), (edge + 1, after)])
    query = text(f"SELECT width_bucket(CAST(:value AS integer), {hist_edges_sql(layout)})")
    with real_db_engine.connect() as connection:
        for value, expected in samples:
            sql_bin = connection.execute(query, {"value": value}).scalar_one()
            assert sql_bin == expected, (layout, value)
            assert bin_index(value, layout=layout) == expected
            assert sql_bin == bin_index(value, layout=layout)


@pytest.mark.parametrize("target,foreign", [(3, 2), (2, 3)])
@pytest.mark.parametrize("bins,counts", [([], []), ([4], [1])])
def test_merge_refuses_a_part_of_layout_2(
    target: int, foreign: int, bins: list[int], counts: list[int]
) -> None:
    parts = [(target, [0], [1]), (foreign, bins, counts), (target, [4], [2])]
    for order in permutations(parts):
        with pytest.raises(HistLayoutMismatch):
            merge_hist(order, layout=target)
    if foreign == 3:
        with pytest.raises(HistLayoutMismatch):
            delay_bins([(foreign, bins, counts)])


def test_cancel_notice_merges_sparse_mass_and_preserves_absence() -> None:
    parts = [(3, [0, 4, 4, 13], [1, 2, 3, 4]), (3, [4, 5], [7, 0])]
    original = deepcopy(parts)
    for order in permutations(parts):
        assert merge_hist(iter(order), layout=3) == ([0, 4, 13], [1, 12, 4])
    assert parts == original
    assert merge_hist([], layout=3) == ([], [])
    assert merge_hist([(3, [], []), (3, [0, 13], [0, 0])], layout=3) == ([], [])
    assert quantile_bin([], [], 0.5, layout=3) is None
    assert quantile_bin([0, 13], [0, 0], 0.5, layout=3) is None


def test_cancel_notice_quantiles_keep_open_ends() -> None:
    bins, counts = merge_hist([(3, [0, 4, 13], [1, 2, 1])], layout=3)
    assert quantile_bin(bins, counts, 0.25, layout=3) == QuantileBin(0, None, -3600, 4)
    assert quantile_bin(bins, counts, 0.5, layout=3) == QuantileBin(4, 0, 300, 4)
    assert quantile_bin(bins, counts, 1, layout=3) == QuantileBin(13, 86400, None, 4)


def test_layout_2_outputs_keep_exact_bytes() -> None:
    assert hist_edges_sql(2).encode("ascii") == LEGACY_SQL
    assert DELAY_HIST_LAYOUTS[2].edges_s == tuple(
        int(v) for v in LEGACY_SQL[6:-12].decode("ascii").split(",")
    )
    quantiles = [quantile_bin([45, 160], [900, 100], q) for q in (0.9, 0.99)]
    open_ends = [quantile_bin([i], [4], 0.5) for i in (0, 160)]
    r3 = delay_bins([(2, [45, 160], [900, 100])])
    assert all(v is not None for v in [*quantiles, *open_ends, *r3])
    results = {
        "bins": [bin_index(x) for x in (-3601, -3600, 3599, 3600)],
        "merge": merge_hist([(2, [7, 1, 7], [2, 3, 4]), (2, [160, 7, 0], [5, 1, 0])], layout=2),
        "empty": merge_hist([], layout=2),
        "quantiles": [asdict(v) for v in quantiles if v is not None],
        "open": [asdict(v) for v in open_ends if v is not None],
        "r3": [asdict(v) for v in r3 if v is not None],
    }
    assert json.dumps(results, separators=(",", ":")).encode("ascii") == LEGACY_RESULTS


@pytest.mark.parametrize("layout", [1, 4])
def test_reserved_and_unknown_layouts_still_refuse(layout: int) -> None:
    for operation in (
        lambda: hist_edges_sql(layout),
        lambda: bin_index(0, layout=layout),
        lambda: merge_hist([], layout=layout),
        lambda: quantile_bin([], [], 0.5, layout=layout),
    ):
        with pytest.raises(ValueError, match=f"^Unknown histogram layout: {layout}$"):
            operation()
