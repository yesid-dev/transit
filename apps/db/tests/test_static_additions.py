import json

import pytest
from revision_2_allowlist import revision_2_projection
from test_snapshots_builders import FakeConn

from transit_ops.snapshots.builders.static import build_routes_index
from transit_ops.snapshots.contract import RoutesIndex
from transit_ops.snapshots.serialization import snapshot_json_bytes
from transit_ops.sql_registry import query_name

OLD_INDEX = {
    "schema_version": 1,
    "methodology_version": None,
    "publish_generation_id": None,
    "generated_utc": "2025-01-01T00:00:00Z",
    "routes": [
        {
            "id": "2",
            "short": "2",
            "long": "Line",
            "color": None,
            "type": 0,
            "reliability": True,
        },
        {
            "id": "10",
            "short": "10",
            "long": "Line",
            "color": None,
            "type": 3,
            "reliability": False,
        },
        {
            "id": "A",
            "short": "A",
            "long": "Line",
            "color": None,
            "type": 3,
            "reliability": False,
        },
    ],
}


def test_static_additions_preserve_existing_payload_projection():
    conn = FakeConn(
        {
            "static.routes_index": [
                {
                    "route_id": rid,
                    "route_short_name": None,
                    "route_long_name": "Line",
                    "route_color": None,
                    "route_type": kind,
                    "live_data": live,
                }
                for rid, kind, live in [("10", 3, False), ("2", 0, True), ("A", None, False)]
            ],
            "static.reliability_route_ids": [{"route_id": "2"}],
        }
    )
    payload = build_routes_index(conn, provider_id="example", generated_utc="2025-01-01T00:00:00Z")
    actual = json.loads(snapshot_json_bytes(payload))
    assert [r["live_data"] for r in actual["routes"]] == [True, False, False]
    assert revision_2_projection("static/routes_index.json", actual) == OLD_INDEX


def test_old_payloads_validate_and_additions_remain_optional():
    old = {
        "generated_utc": "2025-01-01T00:00:00Z",
        "routes": [{"id": "R", "short": "R", "type": 3}],
    }
    assert RoutesIndex.model_validate(old).routes[0].live_data is None
    for value in (False, True, None):
        old["routes"][0]["live_data"] = value
        assert (
            json.loads(snapshot_json_bytes(RoutesIndex.model_validate(old)))["routes"][0][
                "live_data"
            ]
            is value
        )
    schema = RoutesIndex.model_json_schema()["$defs"]["RouteIndexEntry"]
    assert "live_data" not in schema["required"]


def test_routes_index_fails_when_policy_read_fails():
    class BrokenConn(FakeConn):
        def execute(self, statement, params=None):
            if query_name(statement) == "static.routes_index":
                raise RuntimeError("policy read failed")
            return super().execute(statement, params)

    with pytest.raises(RuntimeError, match="policy read failed"):
        build_routes_index(BrokenConn({}), provider_id="example", generated_utc="old")


def test_static_upgrade_rebuilds_an_unchanged_dataset_once():
    from snapshot_storage_fixtures import MemorySnapshotStore
    from test_snapshots_publish import (
        NamedRowsResult,
        _publish_static_once,
        _RecordingConn,
    )

    from transit_ops.sql_registry import query_name

    class DatasetConn(_RecordingConn):
        def execute(self, statement, params=None):
            if query_name(statement) == "publish.static_skip.match":
                return NamedRowsResult([(5,)])
            if query_name(statement) == "static.routes_index":
                return NamedRowsResult(
                    [
                        {
                            "route_id": "R",
                            "route_short_name": "R",
                            "route_long_name": None,
                            "route_color": None,
                            "route_type": 3,
                            "live_data": False,
                        }
                    ]
                )
            return super().execute(statement, params)

    store, conn = MemorySnapshotStore(), DatasetConn()
    _publish_static_once(store, conn)
    state_key = "_meta/publish_state_static.json"
    state = json.loads(store.store[state_key])
    # Pin the previous version independently; keep the same config/hash state.
    state["fingerprint"] = "v4|" + state["fingerprint"].split("|", 1)[1]
    store.store[state_key] = json.dumps(state).encode()
    key = "static/routes_index.json"
    assert key in _publish_static_once(store, conn).keys_written
    assert json.loads(store.store[key])["routes"][0]["live_data"] is False
    assert json.loads(store.store[state_key])["fingerprint"].startswith("v5|")
    before = dict(store.store)
    calls = list(store.calls)
    assert _publish_static_once(store, conn).keys_written == []
    assert store.store == before
    assert store.calls == calls


@pytest.mark.parametrize(
    "raw, expected", [(1, "yes"), (2, "no"), (0, None), (None, None), ("", None)]
)
@pytest.mark.parametrize("scheduled", [False, True])
def test_wheelchair_boarding_is_null_for_blank_and_zero(raw, expected, scheduled):
    from transit_ops.snapshots.builders._helpers import StaticScheduleContext
    from transit_ops.snapshots.builders.static import build_all_stops_data

    conn = FakeConn(
        {
            "static.all_stops": [
                dict(
                    stop_id="S",
                    stop_code=None,
                    stop_name="Stop",
                    stop_lat=45,
                    stop_lon=-73,
                    wheelchair_boarding=raw,
                )
            ],
            "static.all_stop_schedules": [
                dict(stop_id="S", route_id="R", trip_headsign="End", departure_time="08:00:00")
            ]
            if scheduled
            else [],
        }
    )
    stop = build_all_stops_data(
        conn, provider_id="example", generated_utc="t", static_context=StaticScheduleContext(1)
    )["S"]
    actual = json.loads(snapshot_json_bytes(stop))
    assert actual["wheelchair_boarding"] == expected
    assert actual["wheelchair"] is (raw == 1)
    assert actual["routes_served"] == (["R"] if scheduled else [])


def test_bulk_and_standalone_routes_have_identical_r3_headway_bytes():
    from transit_ops.snapshots.builders._helpers import StaticScheduleContext
    from transit_ops.snapshots.builders.static import build_all_routes_data, build_route

    metadata = [
        dict(route_id=r, route_long_name="Line", route_type=t) for r, t in [("R", 0), ("empty", 3)]
    ]
    rows = [
        dict(route_id="R", direction_id=0, is_weekday=True, departure_time=t)
        for t in ["08:10:00", "08:00:00", "08:00:00"]
    ]
    context = StaticScheduleContext(1, ("W",))
    bulk = build_all_routes_data(
        FakeConn({"static.all_route_metadata": metadata, "static.r3_headways": rows}),
        provider_id="example",
        generated_utc="t",
        static_context=context,
    )
    for meta in metadata:
        rid = meta["route_id"]
        single = build_route(
            FakeConn(
                {"static.route_name_type": [meta], "static.r3_headways": rows if rid == "R" else []}
            ),
            provider_id="example",
            route_id=rid,
            generated_utc="t",
            static_context=context,
        )
        assert snapshot_json_bytes(bulk[rid]) == snapshot_json_bytes(single)
        actual = json.loads(snapshot_json_bytes(single))
        assert actual["r3"] == {
            "headway": [dict(shift="am_peak", window="06:00–09:00", headway_min=10.0)]
            if rid == "R"
            else None
        }
        assert revision_2_projection("static/routes/R.json", actual) == dict(
            schema_version=1,
            methodology_version=None,
            publish_generation_id=None,
            generated_utc="t",
            id=rid,
            long="Line",
            type=meta["route_type"],
            directions=[],
            service_periods=[],
            first_departure=None,
            last_departure=None,
        )


def test_old_route_and_stop_payloads_keep_optional_additions():
    from transit_ops.snapshots.contract import RouteFile, StopFile

    route = RouteFile.model_validate(dict(generated_utc="t", id="R"))
    assert route.r3 is None
    for value in ["yes", "no", None]:
        stop = StopFile.model_validate(
            dict(generated_utc="t", id="S", name="Stop", lat=0, lon=0, wheelchair_boarding=value)
        )
        assert json.loads(snapshot_json_bytes(stop))["wheelchair_boarding"] == value
    assert "r3" not in RouteFile.model_json_schema()["required"]
    assert "wheelchair_boarding" not in StopFile.model_json_schema()["required"]
