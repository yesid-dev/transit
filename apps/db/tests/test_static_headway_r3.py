import pytest
from test_snapshots_builders import FakeConn

from transit_ops.snapshots.builders._helpers import StaticScheduleContext
from transit_ops.snapshots.builders.static_headway_r3 import build_route_headways_r3


def row(time, direction=0, weekday=True, route="R"):
    return dict(route_id=route, departure_time=time, direction_id=direction, is_weekday=weekday)


def test_headways_keep_direction_zero_and_deduplicate_branches():
    rows = [row("08:00:00"), row("08:00:00"), row("08:10:00")]
    rows += [row("08:00:00", 1), row("08:30:00", 1)]
    for ordered in (rows, list(reversed(rows))):
        conn = FakeConn({"static.r3_headways": ordered})
        result = build_route_headways_r3(
            conn, provider_id="synthetic", static_context=StaticScheduleContext(1, ("W",))
        )
        assert {key: value.model_dump() for key, value in result.items()} == {
            "R": {"headway": [{"shift": "am_peak", "window": "06:00–09:00", "headway_min": 10.0}]}
        }
        assert len(conn.executed) == 1


def test_headways_keep_overnight_and_calendar_exception_service():
    class ContextConn(FakeConn):
        def execute(self, statement, params=None):
            assert params == {
                "provider_id": "synthetic",
                "dataset_version_id": 7,
                "route_id": None,
                "weekday_services": ["added"],
                "weekend_services": ["sat"],
            }
            return super().execute(statement, params)

    conn = ContextConn(
        {
            "static.r3_headways": [
                row("23:50:00"),
                row("24:10:00"),
                row("12:00:00", weekday=False),
                row("12:17:00", weekday=False),
            ]
        }
    )
    result = build_route_headways_r3(
        conn, provider_id="synthetic", static_context=StaticScheduleContext(7, ("added",), ("sat",))
    )
    assert result["R"].model_dump() == {
        "headway": [
            {"shift": "night", "window": "23:00–06:00", "headway_min": 20.0},
            {"shift": "weekend", "window": None, "headway_min": 17.0},
        ]
    }
    assert len(conn.executed) == 1


@pytest.mark.parametrize(
    "edition, rows, expected",
    [
        (None, [], None),
        (1, [], None),
        (1, [row(None)], None),
        (
            1,
            [row("08:00:00")],
            [{"shift": "am_peak", "window": "06:00–09:00", "headway_min": None}],
        ),
        (
            1,
            [row("08:00:00"), row("08:00:00")],
            [{"shift": "am_peak", "window": "06:00–09:00", "headway_min": None}],
        ),
    ],
)
def test_headway_absence_is_null_not_zero(edition, rows, expected):
    conn = FakeConn({"static.r3_headways": rows})
    result = build_route_headways_r3(
        conn, provider_id="synthetic", static_context=StaticScheduleContext(edition), route_id="R"
    )
    assert result["R"].model_dump() == {"headway": expected}
    assert len(conn.executed) == (0 if edition is None else 1)


def test_headways_batch_routes_and_round_median_once():
    conn = FakeConn(
        {
            "static.r3_headways": [
                row("08:00:00", route="B"),
                row("08:02:00", route="B"),
                row("08:05:00", route="B"),
                row(None, route="A"),
            ]
        }
    )
    result = build_route_headways_r3(
        conn, provider_id="synthetic", static_context=StaticScheduleContext(1, ("W",))
    )
    assert list(result) == ["A", "B"]
    assert result["A"].headway is None
    assert result["B"].headway[0].headway_min == 2.5
    assert len(conn.executed) == 1
