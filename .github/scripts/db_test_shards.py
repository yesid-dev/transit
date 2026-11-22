"""Run one of three file-level shards of the apps/db pytest suite."""

import subprocess
import sys
from collections import Counter
from pathlib import Path

SHARD_COUNT = 3
SUITES = ("offline", "real-db")
TIMINGS = Path(__file__).with_name("db-test-timings.tsv")


def discover_test_files(root: Path) -> set[str]:
    # Match pytest's default Python file patterns under the suite's tests directory.
    return {
        path.relative_to(root).as_posix()
        for pattern in ("test_*.py", "*_test.py")
        for path in (root / "tests").rglob(pattern)
        if path.is_file()
    }


def timing_weights(suite: str) -> dict[str, int]:
    weights: dict[str, int] = {}
    column = SUITES.index(suite)
    for line in TIMINGS.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            offline, real_db, path = line.split("\t")
            if path in weights:
                raise ValueError(f"Duplicate test timing: {path}")
            weights[path] = max(10, int((offline, real_db)[column]))
    return weights


def validate_partition(files: set[str], shards: list[list[str]]) -> None:
    assigned = Counter(path for shard in shards for path in shard)
    missing = sorted(files - assigned.keys())
    unexpected = sorted(assigned.keys() - files)
    duplicates = sorted(path for path, count in assigned.items() if count > 1)
    if missing or unexpected or duplicates or len(shards) != SHARD_COUNT or not all(shards):
        raise ValueError(
            f"Expected {SHARD_COUNT} nonempty shards covering every test file once. "
            f"Missing: {missing}. Unexpected: {unexpected}. Duplicates: {duplicates}."
        )


def partition_test_files(files: set[str], weights: dict[str, int]) -> list[list[str]]:
    shards: list[list[str]] = [[] for _ in range(SHARD_COUNT)]
    totals = [0] * SHARD_COUNT
    # Place the heaviest files first. Stable ties keep assignment runner-independent.
    for path in sorted(files, key=lambda path: (-weights.get(path, 10), path)):
        index = min(range(SHARD_COUNT), key=totals.__getitem__)
        shards[index].append(path)
        totals[index] += weights.get(path, 10)
    validate_partition(files, shards)
    return [sorted(shard) for shard in shards]


def main() -> int:
    suite, shard_arg, *pytest_args = sys.argv[1:]
    shard = int(shard_arg)
    if suite not in SUITES or not 1 <= shard <= SHARD_COUNT:
        raise ValueError(f"Expected {SUITES} and a shard from 1 to {SHARD_COUNT}")
    files = discover_test_files(Path.cwd())
    shards = partition_test_files(files, timing_weights(suite))
    selected = shards[shard - 1]
    print(
        f"{suite} shard {shard}/{SHARD_COUNT}: {len(selected)} of {len(files)} test files",
        flush=True,
    )
    return subprocess.call([sys.executable, "-m", "pytest", *pytest_args, *selected])


if __name__ == "__main__":
    raise SystemExit(main())
