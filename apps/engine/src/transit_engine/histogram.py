"""Continuous percentiles estimated from cumulative histogram bin counts."""

DELAY_BIN_SECONDS = 15


def percentile(
    histogram: list[tuple[int, int]],
    count: int,
    percent: int,
    *,
    width: int = DELAY_BIN_SECONDS,
    ceiling: int | None = None,
    continuous: bool = False,
) -> float:
    rank, remainder = divmod((count - 1) * percent, 100)
    seen = 0
    lower_midpoint = None
    offset = (width if continuous else width - 1) / 2
    for edge, occurrences in histogram:
        midpoint = edge + offset
        if ceiling is not None:
            midpoint = min(midpoint, ceiling)
        seen += occurrences
        if lower_midpoint is None and seen > rank:
            lower_midpoint = midpoint
        if lower_midpoint is not None and seen > rank + bool(remainder):
            return lower_midpoint + (midpoint - lower_midpoint) * remainder / 100
    raise RuntimeError("histogram counts do not match the sample count")
