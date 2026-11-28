from transit_ops.providers.corridor_paths import cut_corridor_paths
from transit_ops.providers.schedule import ScheduledStop


def test_corridor_paths_cut_serving_patterns_and_keep_the_bend():
    stops = {
        name: ScheduledStop(name, lat, lon, None, None)
        for name, lon, lat in (("a", -73.6, 45.5), ("b", -73.59, 45.51), ("c", -73.58, 45.51))
    }
    bend = [
        (-73.601, 45.5),
        (-73.6, 45.5),
        (-73.60001, 45.505),
        (-73.6, 45.51),
        (-73.58, 45.51),
    ]
    paths = cut_corridor_paths(
        [
            ("24", 0, ("a", "b"), "missing"),
            ("24", 0, ("a", "b"), "bend"),
            ("24", 0, ("a", "c"), "bend"),
            ("24", 1, ("c", "a"), "reverse"),
        ],
        {"bend": bend, "reverse": list(reversed(bend))},
        stops,
    )
    assert paths == (
        ("24", 0, "a", "b", ((-73.6, 45.5), (-73.6, 45.51), (-73.59, 45.51))),
        ("24", 0, "a", "c", ((-73.6, 45.5), (-73.6, 45.51), (-73.58, 45.51))),
        ("24", 1, "c", "a", ((-73.58, 45.51), (-73.6, 45.51), (-73.6, 45.5))),
    )
