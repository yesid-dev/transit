import json
from dataclasses import replace
from datetime import timedelta

import pytest
from test_live_facts import parsed_vehicle, vehicle_message
from test_live_running import AT, Holder, inputs
from test_live_running import local as local

from transit_ops.live.builders_status import build_bundle
from transit_ops.live.facts import apply_capture
from transit_ops.live.publication_context import CapturedRows, PublicationContext
from transit_ops.live.running import FeedPolicy
from transit_ops.snapshots.serialization import snapshot_json_bytes


def captured(rows, source="fixture"):
    return CapturedRows(source, AT, snapshot_json_bytes(rows))


def context(provider="network", endpoints=()):
    identity = {"provider_id": provider}
    return PublicationContext(
        AT,
        provider,
        provider=captured(
            [
                identity
                | dict(
                    display_name="Network",
                    short_name=None,
                    city=None,
                    timezone="America/Toronto",
                    default_language="fr",
                    attribution_text="",
                    min_longitude=-74,
                    min_latitude=45,
                    max_longitude=-73,
                    max_latitude=46,
                    public_base_url="https://example.org",
                    basemap_url=None,
                    source_lag_s=120,
                )
            ]
        ),
        endpoints=captured([identity | dict(endpoint_key=e) for e in endpoints]),
        editions=captured(
            [
                identity
                | dict(
                    dataset_version_id=7,
                    source_version="v7",
                    loaded_at_utc=(AT - timedelta(days=1)).isoformat(),
                )
            ]
        ),
        tiers=captured([]),
        feeds=captured([]),
        trip_policy=FeedPolicy("trip_updates" in endpoints, 60),
        vehicle_policy=FeedPolicy("vehicle_positions" in endpoints, 60),
    )


def build(local, ctx=None, holder=None):
    return build_bundle(local, holder or Holder(None), inputs(local), ctx or context())


def apply_alert_window_snapshot(local, start, end):
    from test_local_alert_apply import ALERT

    from transit_ops.silver.i3 import RawI3AlertSnapshot
    from transit_ops.static.alert_apply import apply_alert_snapshot

    period = {
        k: (AT + timedelta(seconds=v)).isoformat()
        for k, v in (("start", start), ("end", end))
        if v is not None
    }
    payload = ALERT | {"id": "window", "activePeriods": [period]}
    apply_alert_snapshot(
        local,
        RawI3AlertSnapshot(102, "network", "America/Toronto", AT, [ALERT, payload]),
        loaded_at_utc=AT,
    )


@pytest.mark.parametrize(
    "start,end,active",
    [
        (0, None, True),
        (-3600, 0, True),
        (0.000001, None, False),
        (None, -0.000001, False),
        (None, None, True),
    ],
)
def test_complete_alert_window_fixture_keeps_base_message(local, start, end, active):
    from test_local_alert_apply import ALERT
    from test_local_alert_seed import bundle

    from transit_ops.silver.i3 import RawI3AlertSnapshot
    from transit_ops.static.alert_apply import apply_alert_snapshot
    from transit_ops.static.alert_state import seed_alert_state

    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    seed_alert_state(local, seed)
    apply_alert_snapshot(
        local, RawI3AlertSnapshot(101, "network", "America/Toronto", AT, [ALERT]), loaded_at_utc=AT
    )
    apply_alert_window_snapshot(local, start, end)
    alerts = json.loads(build(local, context(endpoints=("i3_alerts",)))["alerts.json"])["alerts"]
    assert {a["id"] for a in alerts} == ({"avis", "window"} if active else {"avis"})
    original = next(a for a in alerts if a["id"] == "avis")
    assert str(original["message"]["snapshot_id"]) == "102"
    assert original["routes"] == ["first"]


def test_missing_context_refuses_by_name(local):
    with pytest.raises(ValueError, match="provider"):
        build_bundle(local, Holder(None), inputs(local), PublicationContext(AT, "network"))


def test_bundle_preserves_provider_map_bounds(local):
    message = vehicle_message()
    del message.entity[1:]
    for entity in message.entity:
        if entity.HasField("vehicle"):
            entity.vehicle.position.latitude = 10
    apply_capture(local, parsed_vehicle(message), provider_timezone="America/Toronto")
    result = build(local, context(endpoints=("vehicle_positions",)))
    assert json.loads(result["vehicles.json"])["vehicles"] == []


@pytest.mark.parametrize(
    "longitude,latitude,visible",
    [
        (-74, 45, True),
        (-73, 46, True),
        (-73.5, 10, False),
        (-74.0001, 45.5, False),
        (-73.5, 46.0001, False),
    ],
)
def test_map_and_network_use_same_bbox_without_losing_raw_presence(
    local, longitude, latitude, visible
):
    message = vehicle_message()
    del message.entity[1:]
    message.entity[0].vehicle.position.longitude = longitude
    message.entity[0].vehicle.position.latitude = latitude
    apply_capture(local, parsed_vehicle(message), provider_timezone="America/Toronto")
    result = build(local, context(endpoints=("vehicle_positions",)))
    network = json.loads(result["network.json"])
    assert len(json.loads(result["vehicles.json"])["vehicles"]) == int(visible)
    assert network["vehicles_in_service"] == network["status_dist"]["unknown"] == int(visible)
    assert network["coverage_pct"] == (0 if visible else None)
    assert network["occupancy_mix"] == (
        {"empty": 0, "many_seats": 0, "few_seats": 1, "standing": 0, "full": 0} if visible else None
    )
    assert network["non_responding"] == 0


def test_null_bbox_is_unbounded_for_map_and_network(local):
    message = vehicle_message()
    del message.entity[1:]
    message.entity[0].vehicle.position.latitude = 10
    apply_capture(local, parsed_vehicle(message), provider_timezone="America/Toronto")
    ctx = context(endpoints=("vehicle_positions",))
    provider = ctx.rows("provider")[0]
    provider.update(
        {k: None for k in ("min_longitude", "min_latitude", "max_longitude", "max_latitude")}
    )
    result = build(local, replace(ctx, provider=captured([provider])))
    assert len(json.loads(result["vehicles.json"])["vehicles"]) == 1
    assert json.loads(result["network.json"])["vehicles_in_service"] == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"min_longitude": None},
        {"min_latitude": None},
        {"max_longitude": None},
        {"max_latitude": None},
        {"min_latitude": 47},
        {"max_longitude": -75},
    ],
)
def test_inconsistent_bbox_refuses_by_name(local, changes):
    ctx = context()
    provider = ctx.rows("provider")[0] | changes
    with pytest.raises(ValueError, match="provider bounds"):
        build(local, replace(ctx, provider=captured([provider])))


@pytest.mark.parametrize("name", ["provider", "endpoints", "editions", "tiers", "feeds"])
def test_every_missing_store_refuses(local, name):
    with pytest.raises(ValueError, match=name):
        build(local, replace(context(), **{name: None}))


@pytest.mark.parametrize("name", ["provider", "endpoints", "editions", "tiers", "feeds"])
def test_mixed_cycle_context_refuses(local, name):
    source = getattr(context(), name)
    with pytest.raises(ValueError, match=name):
        build(
            local,
            replace(context(), **{name: replace(source, captured_at=AT - timedelta(seconds=1))}),
        )


def test_no_endpoint_unknown_stamps_and_no_borrowed_mutation(local):
    class Forbidden:
        def latest(self):
            pytest.fail("disabled trip feed resolved")

    before = local.connection.execute("SHOW TABLES").fetchall()
    result = build(local, holder=Forbidden())
    assert set(result) == {
        "vehicles.json",
        "trips.json",
        "stop_departures.json",
        "alerts.json",
        "network.json",
        "status/data_health.json",
        "manifest.json",
    }
    assert all(type(v) is bytes for v in result.values())
    network = json.loads(result["network.json"])
    assert network["feed_freshness_s"] is network["on_time_pct"] is None
    assert json.loads(result["alerts.json"])["feed_captured_utc"] is None
    health = json.loads(result["status/data_health.json"])
    assert health["lanes"] == health["feeds"] == []
    manifest = json.loads(result["manifest.json"])
    assert manifest["files"]["static"]["generated_utc"] is None
    assert manifest["files"]["live"]["source_lag_s"] == 120
    assert local.connection.execute("SHOW TABLES").fetchall() == before
    assert result == build(local, holder=Forbidden())


def test_one_holder_resolution_and_original_serving_capture(local):
    from test_live_builders_movement import future_message
    from test_live_captures import _parse

    parsed = _parse(future_message())

    class Once:
        calls = 0

        def latest(self):
            self.calls += 1
            assert self.calls == 1
            return parsed

    ctx = context(endpoints=("trip_updates",))
    local.connection.execute(
        "INSERT INTO local_serving VALUES ('trip_updates',41,?,?)", [AT - timedelta(seconds=30)] * 2
    )
    result = build(local, ctx, Once())
    assert json.loads(result["network.json"])["feed_freshness_s"] is None
    local.connection.execute(
        "UPDATE local_serving SET capture_row_id=42,captured_at_utc=?",
        [parsed.capture.captured_at_utc],
    )
    result = build(local, ctx, Once())
    assert json.loads(result["network.json"])["feed_freshness_s"] == 0
    local.connection.execute(
        "UPDATE local_serving SET captured_at_utc=?", [AT - timedelta(seconds=1)]
    )
    with pytest.raises(ValueError, match="serving_mismatch"):
        build(local, ctx, Once())


def test_independent_network_math(local):
    from decimal import Decimal

    from transit_ops.live.builders_status import build_network
    from transit_ops.live.running import Evidence, Projection

    delays = [-360, -120, -60, 0, 90, 300, 900]
    vehicles = tuple(
        dict(
            trip_id=str(i),
            trip_avg_delay_seconds=(Decimal(d) if d is not None else None),
            occupancy_status=i % 3,
        )
        for i, d in enumerate([*delays, None])
    )
    projection = Projection(
        (),
        vehicles,
        tuple(dict(avg_delay_seconds=Decimal(d)) for d in delays),
        (),
        Evidence("missing"),
        Evidence("missing"),
    )
    result = build_network(local, context(), projection, set(), bounds=None)
    assert result.vehicles_in_service == 8
    assert result.on_time_pct == 43  # 3 within [-60,300) out of 7 known? -60 is on-time.
    assert result.coverage_pct == 88
    assert result.delay_p50_min == 0 and result.delay_p90_min == 9
    assert [b.count for b in result.delay_histogram] == [1, 0, 2, 1, 1, 1, 0, 1]


def test_alert_continuity_and_empty_observations(local):
    from test_local_alert_apply import ALERT
    from test_local_alert_seed import bundle

    from transit_ops.silver.i3 import RawI3AlertSnapshot
    from transit_ops.static.alert_apply import apply_alert_snapshot
    from transit_ops.static.alert_state import seed_alert_state

    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    seed_alert_state(local, seed)
    for sid, seconds, payload in [(101, -2, [ALERT]), (102, -1, [ALERT | {"routes": ["new"]}])]:
        apply_alert_snapshot(
            local,
            RawI3AlertSnapshot(
                sid, "network", "America/Toronto", AT + timedelta(seconds=seconds), payload
            ),
            loaded_at_utc=AT,
        )
    ctx = context(endpoints=("i3_alerts",))
    result = json.loads(build(local, ctx)["alerts.json"])
    assert result["alerts"][0]["routes"] == ["first"]
    assert str(result["alerts"][0]["message"]["snapshot_id"]) == "102"
    assert result["feed_captured_utc"] == "2026-06-20T12:09:59Z"
    apply_alert_snapshot(
        local, RawI3AlertSnapshot(103, "network", "America/Toronto", AT, []), loaded_at_utc=AT
    )
    # Successful empty observes the feed without falsely closing prior alerts.
    empty = json.loads(build(local, ctx)["alerts.json"])
    assert empty["feed_captured_utc"] == "2026-06-20T12:10:00Z"
    assert empty["alerts"] == result["alerts"]


@pytest.mark.parametrize(
    "start,end,active",
    [
        (-7200, -3600, False),
        (3600, None, False),
        (0, None, True),
        (-3600, 0, True),
        (None, None, True),
        (None, 0, True),
        (None, -0.000001, False),
        (0.000001, None, False),
    ],
)
def test_alert_current_window_uses_explicit_inclusive_cycle(local, start, end, active):
    from test_local_alert_apply import ALERT
    from test_local_alert_seed import bundle

    from transit_ops.silver.i3 import RawI3AlertSnapshot
    from transit_ops.static.alert_apply import apply_alert_snapshot
    from transit_ops.static.alert_state import seed_alert_state

    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    seed_alert_state(local, seed)
    period = {
        k: (AT + timedelta(seconds=v)).isoformat()
        for k, v in (("start", start), ("end", end))
        if v is not None
    }
    payload = ALERT | {"activePeriods": [period]}
    apply_alert_snapshot(
        local,
        RawI3AlertSnapshot(101, "network", "America/Toronto", AT, [payload]),
        loaded_at_utc=AT,
    )
    result = json.loads(build(local, context(endpoints=("i3_alerts",)))["alerts.json"])
    assert [a["id"] for a in result["alerts"]] == (["avis"] if active else [])
    assert result["feed_captured_utc"] == "2026-06-20T12:10:00Z"


@pytest.mark.parametrize("endpoint", ["trip_updates", "vehicle_positions"])
@pytest.mark.parametrize("retained", [False, True])
def test_disabled_feed_keeps_committed_health_history_without_resolving(local, endpoint, retained):
    class Forbidden:
        def latest(self):
            pytest.fail("disabled holder resolved")

    if retained:
        local.connection.execute(
            "INSERT INTO local_serving VALUES (?,9,?,?)", [endpoint, AT - timedelta(seconds=30), AT]
        )
    feeds = captured([dict(provider_id="network", endpoint_key=endpoint, status="succeeded")])
    ctx = replace(context(), feeds=feeds)
    result = build(local, ctx, Forbidden())
    health = json.loads(result["status/data_health.json"])
    assert health["feeds"] == [
        dict(feed=endpoint, status="succeeded", age_s=30 if retained else None)
    ]
    assert json.loads(result["trips.json"])["feed_captured_utc"] is None
    if retained:
        with pytest.raises(ValueError, match="serving_mismatch"):
            build(local, replace(context(endpoints=(endpoint,)), feeds=feeds))


def test_tier_gate_and_poll_success_do_not_promote_serving(local):
    ctx = context(endpoints=("trip_updates",))
    identity = dict(provider_id="network")
    ctx = replace(
        ctx,
        tiers=captured(
            [identity | dict(tier="live", generated_utc=None, gate_errors=1, gate_verdict="error")]
        ),
        feeds=captured(
            [
                identity
                | dict(
                    endpoint_key="trip_updates",
                    status="succeeded",
                    successful_completed_at_utc=AT.isoformat(),
                )
            ]
        ),
    )
    health = json.loads(build(local, ctx)["status/data_health.json"])
    assert health["feeds"][0]["status"] == "succeeded"
    assert health["feeds"][0]["age_s"] is None
    assert health["lanes"][0]["age_s"] is None
    assert health["lanes"][0]["gate"]["errors"] == 1


@pytest.mark.parametrize(
    "stamp,expected",
    [
        ("2026-06-20T12:09:00.123456+00:00", "2026-06-20T12:09:00Z"),
        ("2026-06-20T08:09:00.123456-04:00", "2026-06-20T12:09:00Z"),
        ("2026-06-20T12:09:00Z", "2026-06-20T12:09:00Z"),
        (None, None),
    ],
)
def test_gate_timestamp_uses_public_utc_seconds_without_mutating_context(local, stamp, expected):
    tiers = captured(
        [
            dict(
                provider_id="network",
                tier="static",
                gate_errors=1,
                gate_verdict="error",
                gate_generated_utc=stamp,
            )
        ]
    )
    ctx = replace(context(), tiers=tiers)
    before = tiers.body
    health = json.loads(build(local, ctx)["status/data_health.json"])
    assert health["lanes"][0]["gate"] == {
        "checks_run": None,
        "errors": 1,
        "warnings": None,
        "verdict": "error",
        "generated_utc": expected,
    }
    assert tiers.body == before


@pytest.mark.parametrize(
    "provider,endpoints",
    [("stm", ("vehicle_positions", "trip_updates")), ("octranspo", ("static_schedule",))],
)
def test_providers_use_capabilities(local, provider, endpoints):
    local.connection.execute("UPDATE meta SET provider_id=?", [provider])
    local.connection.execute("UPDATE edition_meta SET provider_id=?", [provider])
    manifest = json.loads(build(local, context(provider, endpoints))["manifest.json"])
    assert manifest["capabilities"]["live_map"] == (
        "enabled" if "vehicle_positions" in endpoints else "unavailable"
    )


def test_manifest_loaded_at_only_and_all_current_inventory(local):
    ctx = context()
    editions = ctx.editions.read(AT, "editions")
    editions.append(
        editions[0]
        | dict(
            dataset_version_id=999,
            source_version="older",
            loaded_at_utc=(AT - timedelta(days=2)).isoformat(),
        )
    )
    ctx = replace(ctx, editions=captured(editions))
    schedule = inputs(local)
    other = replace(
        schedule.selected, edition=replace(schedule.selected.edition, dataset_version_id=999)
    )
    schedule = replace(
        schedule, current_ids=frozenset({7, 999}), current=(schedule.selected, other)
    )
    result = build_bundle(local, Holder(None), schedule, ctx)
    assert json.loads(result["manifest.json"])["dataset_version"] == "v7"
    with pytest.raises(ValueError, match="all-current"):
        build(local, ctx)


def test_lifecycle_and_naive_clock_refuse(local):
    with pytest.raises(ValueError, match="aware"):
        build(local, replace(context(), cycle=AT.replace(tzinfo=None)))
    with local.transaction():
        with pytest.raises(Exception, match="committed"):
            build(local)


def test_successful_empty_stale_certificate_uses_original_time(local):
    from google.transit import gtfs_realtime_pb2 as pb
    from test_live_captures import _parse

    parsed = _parse(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")))
    ctx = context(endpoints=("trip_updates",))
    local.connection.execute("INSERT INTO local_serving VALUES ('trip_updates',42,?,?)", [AT, AT])
    later = AT + timedelta(seconds=61)
    ctx = replace(
        ctx,
        cycle=later,
        **{
            name: replace(getattr(ctx, name), captured_at=later)
            for name in ("provider", "endpoints", "editions", "tiers", "feeds")
        },
    )
    result = build(local, ctx, Holder(parsed))
    assert json.loads(result["network.json"])["feed_freshness_s"] == 61
    assert json.loads(result["trips.json"])["feed_captured_utc"] == "2026-06-20T12:10:00Z"
    local.connection.execute(
        "UPDATE local_serving SET captured_at_utc=?", [later + timedelta(seconds=1)]
    )
    with pytest.raises(ValueError, match="after cycle"):
        build(local, ctx, Holder(parsed))


def test_context_cannot_retain_mutable_payload():
    with pytest.raises(ValueError, match="immutable bytes"):
        CapturedRows("fixture", AT, bytearray(b"[]"))
