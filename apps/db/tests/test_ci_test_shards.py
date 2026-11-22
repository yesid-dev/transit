import runpy
from pathlib import Path

import pytest

DB_ROOT = Path(__file__).resolve().parents[1]
SHARD_SCRIPT = DB_ROOT.parents[1] / ".github/scripts/db_test_shards.py"


@pytest.mark.parametrize("suite", ["offline", "real-db"])
def test_ci_shard_plan_covers_the_current_suite(suite: str) -> None:
    script = runpy.run_path(str(SHARD_SCRIPT))
    files = script["discover_test_files"](DB_ROOT)
    shards = script["partition_test_files"](files, script["timing_weights"](suite))

    assert len(shards) == 3
    assert all(shards)
    assert sorted(path for shard in shards for path in shard) == sorted(files)


@pytest.mark.parametrize(
    ("shards", "message"),
    [
        ([["a.py"], ["b.py"], ["d.py"]], r"Missing: \['c.py'\]"),
        ([["a.py"], ["b.py"], ["a.py", "c.py", "d.py"]], r"Duplicates: \['a.py'\]"),
    ],
)
def test_ci_shard_coverage_rejects_an_invalid_partition(
    shards: list[list[str]], message: str
) -> None:
    script = runpy.run_path(str(SHARD_SCRIPT))

    with pytest.raises(ValueError, match=message):
        script["validate_partition"]({"a.py", "b.py", "c.py", "d.py"}, shards)
