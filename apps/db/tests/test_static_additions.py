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
    state["fingerprint"] = "v3|" + state["fingerprint"].split("|", 1)[1]
    store.store[state_key] = json.dumps(state).encode()
    key = "static/routes_index.json"
    assert key in _publish_static_once(store, conn).keys_written
    assert json.loads(store.store[key])["routes"][0]["live_data"] is False
    assert json.loads(store.store[state_key])["fingerprint"].startswith("v4|")
    before = dict(store.store)
    calls = list(store.calls)
    assert _publish_static_once(store, conn).keys_written == []
    assert store.store == before
    assert store.calls == calls
