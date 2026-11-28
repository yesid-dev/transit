import re
from pathlib import Path

UNIT = Path(__file__).parents[1] / "ops" / "linux" / "transit-engine.service"
# The catalogue and alert lanes query with 256 MiB each; Python itself needs about as much.
SMALL_LANE_MIB = 256
PYTHON_MIB = 256


def _settings() -> tuple[dict[str, str], dict[str, str]]:
    environment: dict[str, str] = {}
    service: dict[str, str] = {}
    for line in UNIT.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if not sep or line.startswith("#"):
            continue
        if key == "Environment":
            for item in value.split():
                name, _, setting = item.partition("=")
                environment[name] = setting
        else:
            service[key] = value
    return environment, service


def _mib(limit: str) -> int:
    match = re.fullmatch(r"(\d+)([MG])", limit)
    assert match, f"limit {limit!r} is not in M or G"
    return int(match[1]) * (1024 if match[2] == "G" else 1)


def test_every_lane_can_use_its_memory_inside_the_unit_limit() -> None:
    environment, service = _settings()
    concurrency = int(environment["ENGINE_CONCURRENCY"])
    query_mib = int(environment["ENGINE_QUERY_MEMORY_MIB"])
    # The record and heavy lanes each run ENGINE_CONCURRENCY queries.
    needed = 2 * concurrency * query_mib + 2 * SMALL_LANE_MIB + PYTHON_MIB
    assert needed <= _mib(service["MemoryHigh"]) <= _mib(service["MemoryMax"])
