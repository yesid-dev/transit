"""Guarded PG difference detection on the identical detached cycle, no operational access.

Every difference fails as a new engine error. No semantic normalization is permitted.
Independent arithmetic and the inherited R28(b) movement corrections live in focused tests.
"""

import json
import re
from dataclasses import replace
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text
from test_live_builders_status import apply_alert_window_snapshot, captured, context
from test_live_facts import parsed_vehicle, vehicle_message
from test_live_running import AT, Holder, inputs
from test_live_running import local as local
from test_local_alert_apply import ALERT
from test_local_alert_seed import bundle

from transit_ops.live.builders_status import build_bundle
from transit_ops.live.facts import apply_capture
from transit_ops.live.running import FeedPolicy
from transit_ops.providers.registry import ProviderRegistry
from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.snapshots.builders import live
from transit_ops.snapshots.builders._helpers import _iso
from transit_ops.snapshots.serialization import snapshot_json_bytes
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_seed_contract import SCHEMAS
from transit_ops.static.alert_state import seed_alert_state


class Sources:
    def __init__(self, pg):
        self.pg = pg

    def execute(self, query, params):
        sql = re.sub(r"\b(?:core|gold|raw)\.", "pg_temp.", str(query))
        sql = sql.replace("now()", "CAST(:cycle AS timestamptz)")
        return self.pg.execute(text(sql), params | {"cycle": AT})


def prepare(pg, ctx, local):
    tables = (
        "core.providers",
        "core.dataset_versions",
        "core.feed_endpoints",
        "core.snapshot_publish_state",
        "gold.feed_freshness_current",
        "gold.realtime_serving_state",
        "raw.ingestion_runs",
        "gold.current_vehicle_map_with_status",
        "gold.latest_vehicle_snapshot",
        "gold.current_trip_delay_computed",
        "gold.non_responding_current",
        "raw.alert_feed_observations",
    )
    for table in tables:
        pg.execute(
            text(
                f"CREATE TEMP TABLE {table.split('.')[1]} ON COMMIT DROP AS "
                f"SELECT * FROM {table} WITH NO DATA"
            )
        )
    populate_context(pg, ctx)
    for row in ctx.rows("feeds"):
        pg.execute(
            text(
                "INSERT INTO pg_temp.feed_freshness_current "
                "(provider_id,endpoint_key,status) VALUES (:provider_id,:endpoint_key,:status)"
            ),
            row,
        )
    prepare_alerts(pg, ctx, local)


def prepare_alerts(pg, ctx, local):
    # Exercise the actual installed alert view against the same first-seen child rows.
    for table, schema in SCHEMAS.items():
        short = table.split(".")[1]
        if short == "alert_feed_observations":
            continue
        pg.execute(
            text(f"CREATE TEMP TABLE {short} ON COMMIT DROP AS SELECT * FROM {table} WITH NO DATA")
        )
        fields = [
            f"CAST({c} AS VARCHAR)" if t == "timestamp with time zone" else c
            for c, t in schema.items()
        ]
        for values in local.connection.execute(
            f"SELECT {','.join(fields)} FROM {table}"
        ).fetchall():
            row = dict(zip(schema, values, strict=True))
            pg.execute(
                text(
                    f"INSERT INTO pg_temp.{short} ({','.join(row)}) "
                    f"VALUES ({','.join('CAST(:' + k + ' AS ' + schema[k] + ')' for k in row)})"
                ),
                row,
            )
    pg.execute(
        text(
            "INSERT INTO pg_temp.alert_feed_observations "
            "(provider_id,observation_date,alert_count,observed_at_utc) "
            "VALUES (:p,CAST(:cycle AS date),1,:cycle)"
        ),
        dict(p=ctx.provider_id, cycle=AT),
    )
    view = pg.execute(
        text("SELECT pg_get_viewdef('gold.current_i3_alerts'::regclass,true)")
    ).scalar_one()
    view = view.replace("silver.", "pg_temp.").replace("now()", f"TIMESTAMPTZ '{AT.isoformat()}'")
    pg.execute(text("CREATE TEMP VIEW current_i3_alerts AS " + view))


@pytest.mark.parametrize("provider", ["stm", "octranspo"])
@pytest.mark.parametrize("synthetic", [False, True])
def test_four_complete_payload_maps_detect_every_difference(
    real_db_engine, local, provider, synthetic
):
    ctx, settings = cycle_fixture(local, provider, synthetic)
    ours = build_bundle(local, Holder(None), inputs(local), ctx)
    keys = {"alerts.json", "network.json", "manifest.json", "status/data_health.json"}
    with real_db_engine.connect() as pg, pg.begin() as tx:
        try:
            prepare(pg, ctx, local)
            pg.execute(
                text(
                    "INSERT INTO pg_temp.non_responding_current "
                    "(provider_id,route_id,non_responding_count,trip_ids) "
                    "VALUES (:p,'路线',1,ARRAY['行程'])"
                ),
                {"p": provider},
            )
            sources = Sources(pg)
            args = dict(provider_id=provider, generated_utc=_iso(AT))
            expected = {
                "alerts.json": live.build_alerts(sources, **args),
                "network.json": live.build_network(sources, **args),
                "manifest.json": live.build_manifest(sources, settings=settings, **args),
                "status/data_health.json": live.build_data_health(sources, **args),
            }
            expected = {k: snapshot_json_bytes(v) for k, v in expected.items()}
            actual = {k: ours[k] for k in keys}
            differences = {
                k: (json.loads(expected[k]), json.loads(actual[k]))
                for k in keys
                if expected[k] != actual[k]
            }
            assert not differences, f"unclassified new engine error: {differences}"
        finally:
            tx.rollback()


def cycle_fixture(local, provider, synthetic):
    local.connection.execute("UPDATE meta SET provider_id=?", [provider])
    local.connection.execute("UPDATE edition_meta SET provider_id=?", [provider])
    seed = bundle()
    for table in seed.tables.values():
        table.rows.clear()
    seed.provider_id = provider
    seed_alert_state(local, seed)
    payload = ALERT | {"id": None if synthetic else "avis"}
    apply_alert_snapshot(
        local, RawI3AlertSnapshot(101, provider, "America/Toronto", AT, [payload]), loaded_at_utc=AT
    )
    ctx = context(provider, ("i3_alerts",))
    settings = SimpleNamespace(SNAPSHOT_PUBLIC_BASE_URL="https://example.org")
    registry = ProviderRegistry.from_project_root(settings=settings)
    prow = ctx.rows("provider")[0] | dict(
        basemap_url=registry.get_public_config(provider).basemap_url,
        source_lag_s=(
            registry.get_provider(provider).provider.live_source_lag_seconds
            if provider in registry.list_provider_ids()
            else 0
        ),
    )
    ctx = replace(ctx, provider=captured([prow]))
    ctx = replace(
        ctx,
        feeds=captured([dict(provider_id=provider, endpoint_key="i3_alerts", status="failed")]),
        tiers=captured(
            [
                dict(
                    provider_id=provider,
                    tier="static",
                    generated_utc=(AT - timedelta(seconds=60)).isoformat(),
                    files_written=2,
                    files_skipped=1,
                    files_total=3,
                    gate_errors=1,
                    gate_verdict="error",
                    gate_generated_utc=(AT - timedelta(seconds=60)).isoformat(),
                )
            ]
        ),
    )
    return ctx, settings


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
def test_alert_view_window_is_frozen_at_explicit_cycle(real_db_engine, local, start, end, active):
    ctx, _ = cycle_fixture(local, "network", False)
    apply_alert_window_snapshot(local, start, end)
    ours = build_bundle(local, Holder(None), inputs(local), ctx)["alerts.json"]
    assert {r["id"] for r in json.loads(ours)["alerts"]} == (
        {"avis", "window"} if active else {"avis"}
    )
    with real_db_engine.connect() as pg, pg.begin() as tx:
        try:
            prepare(pg, ctx, local)
            expected = live.build_alerts(Sources(pg), provider_id="network", generated_utc=_iso(AT))
            assert ours == snapshot_json_bytes(expected), "new engine alert-window error"
        finally:
            tx.rollback()


@pytest.mark.parametrize(
    "latitude,unbounded,count",
    [
        (10, False, 0),
        (45.5, False, 1),
        (10, True, 1),
        (45, False, 1),
        (46, False, 1),
    ],
)
def test_network_uses_installed_map_bbox_population(
    real_db_engine, local, latitude, unbounded, count
):
    ctx, _ = cycle_fixture(local, "network", False)
    message = vehicle_message()
    del message.entity[1:]
    message.entity[0].vehicle.position.latitude = latitude
    apply_capture(local, parsed_vehicle(message), provider_timezone="America/Toronto")
    provider = ctx.rows("provider")[0]
    if unbounded:
        provider.update(
            {k: None for k in ("min_longitude", "min_latitude", "max_longitude", "max_latitude")}
        )
    ctx = replace(
        ctx,
        provider=captured([provider]),
        endpoints=captured(
            ctx.rows("endpoints") + [dict(provider_id="network", endpoint_key="vehicle_positions")]
        ),
        vehicle_policy=FeedPolicy(True, 60),
    )
    result = build_bundle(local, Holder(None), inputs(local), ctx)
    ours = result["network.json"]
    assert json.loads(ours)["vehicles_in_service"] == count
    assert len(json.loads(result["vehicles.json"])["vehicles"]) == count
    with real_db_engine.connect() as pg, pg.begin() as tx:
        try:
            prepare(pg, ctx, local)
            prepare_map_views(pg, provider, latitude)
            expected = live.build_network(
                Sources(pg), provider_id="network", generated_utc=_iso(AT)
            )
            assert ours == snapshot_json_bytes(expected), "new engine bbox-population error"
        finally:
            tx.rollback()


def prepare_map_views(pg, provider, latitude):
    pg.execute(
        text(
            "CREATE TEMP TABLE dim_provider ON COMMIT DROP AS "
            "SELECT * FROM gold.dim_provider WITH NO DATA"
        )
    )
    fields = ["provider_id", "min_longitude", "min_latitude", "max_longitude", "max_latitude"]
    pg.execute(
        text(
            f"INSERT INTO pg_temp.dim_provider ({','.join(fields)}) "
            f"VALUES ({','.join(':' + k for k in fields)})"
        ),
        provider,
    )
    pg.execute(
        text(
            "INSERT INTO pg_temp.latest_vehicle_snapshot "
            "(provider_id,realtime_snapshot_id,entity_index,vehicle_id,trip_id,"
            "latitude,longitude,occupancy_status) "
            "VALUES ('network',42,0,'bus-0','行程',:lat,-73.5,2)"
        ),
        dict(lat=latitude),
    )
    pg.execute(text("DROP TABLE pg_temp.current_vehicle_map_with_status"))
    for name in ("current_vehicle_map", "current_vehicle_map_with_status"):
        view = pg.execute(text(f"SELECT pg_get_viewdef('gold.{name}'::regclass,true)")).scalar_one()
        view = view.replace("gold.", "pg_temp.").replace("now()", f"TIMESTAMPTZ '{AT.isoformat()}'")
        pg.execute(text(f"CREATE TEMP VIEW {name} AS " + view))


@pytest.mark.parametrize("endpoint", ["trip_updates", "vehicle_positions"])
@pytest.mark.parametrize("retained", [False, True])
def test_disabled_feed_health_matches_retained_serving_history(
    real_db_engine, local, endpoint, retained
):
    ctx, _ = cycle_fixture(local, "network", False)
    ctx = replace(
        ctx,
        feeds=captured([dict(provider_id="network", endpoint_key=endpoint, status="succeeded")]),
    )
    if retained:
        local.connection.execute(
            "INSERT INTO local_serving VALUES (?,9,?,?)", [endpoint, AT - timedelta(seconds=30), AT]
        )
    ours = build_bundle(local, Holder(None), inputs(local), ctx)["status/data_health.json"]
    assert json.loads(ours)["feeds"][0]["age_s"] == (30 if retained else None)
    with real_db_engine.connect() as pg, pg.begin() as tx:
        try:
            prepare(pg, ctx, local)
            if retained:
                pg.execute(
                    text(
                        "INSERT INTO pg_temp.realtime_serving_state "
                        "(provider_id,endpoint_key,realtime_snapshot_id,captured_at_utc) "
                        "VALUES ('network',:endpoint,9,:stamp)"
                    ),
                    dict(endpoint=endpoint, stamp=AT - timedelta(seconds=30)),
                )
            expected = live.build_data_health(
                Sources(pg), provider_id="network", generated_utc=_iso(AT)
            )
            assert ours == snapshot_json_bytes(expected), "new engine disabled-history error"
        finally:
            tx.rollback()


def test_pg_network_detector_against_independent_counts(real_db_engine, local):
    from decimal import Decimal

    from transit_ops.live.builders_status import build_network
    from transit_ops.live.running import Evidence, Projection

    delays = [-360, -120, -60, 0, 90, 300, 900]
    bands = (
        ["EN AVANCE / EARLY"] * 2
        + ["À L'HEURE / ON TIME"] * 2
        + ["EN RETARD / LATE", "CRITIQUE / SEVERE", "CRITIQUE / SEVERE", "INCONNU / UNKNOWN"]
    )
    vehicles = tuple(
        dict(
            trip_id=str(i),
            trip_avg_delay_seconds=(Decimal(delays[i]) if i < 7 else None),
            occupancy_status=i % 3,
        )
        for i in range(8)
    )
    projection = Projection(
        (),
        vehicles,
        tuple(dict(avg_delay_seconds=Decimal(d)) for d in delays),
        (),
        Evidence("missing"),
        Evidence("missing"),
    )
    ours = build_network(local, context(), projection, set(), bounds=None)
    assert (ours.on_time_pct, ours.coverage_pct, ours.delay_p90_min) == (43, 88, 9)
    with real_db_engine.connect() as pg, pg.begin() as tx:
        try:
            ctx, _ = cycle_fixture(local, "network", False)
            prepare(pg, ctx, local)
            insert_network(pg, bands, delays)
            expected = live.build_network(
                Sources(pg), provider_id="network", generated_utc=_iso(AT)
            )
            assert snapshot_json_bytes(ours) == snapshot_json_bytes(expected), "new engine error"
        finally:
            tx.rollback()


def insert_network(pg, bands, delays):
    for i, band in enumerate(bands):
        pg.execute(
            text(
                "INSERT INTO pg_temp.current_vehicle_map_with_status "
                "(provider_id,trip_id,realtime_snapshot_id,entity_index,status_band) "
                "VALUES ('network',:trip,42,:i,:band)"
            ),
            dict(trip=str(i), i=i, band=band),
        )
        pg.execute(
            text(
                "INSERT INTO pg_temp.latest_vehicle_snapshot "
                "(provider_id,realtime_snapshot_id,entity_index,occupancy_status) "
                "VALUES ('network',42,:i,:occ)"
            ),
            dict(i=i, occ=i % 3),
        )
    for delay in delays:
        pg.execute(
            text(
                "INSERT INTO pg_temp.current_trip_delay_computed "
                "(provider_id,avg_delay_seconds) VALUES ('network',:delay)"
            ),
            dict(delay=delay),
        )


def populate_context(pg, ctx):
    for name, table in (
        ("provider", "providers"),
        ("editions", "dataset_versions"),
        ("endpoints", "feed_endpoints"),
        ("tiers", "snapshot_publish_state"),
    ):
        columns = set(pg.execute(text(f"SELECT * FROM pg_temp.{table} LIMIT 0")).keys())
        for record in ctx.rows(name):
            row = {
                k: (datetime.fromisoformat(v) if k.endswith("_utc") and isinstance(v, str) else v)
                for k, v in record.items()
                if k in columns
            }
            if table == "dataset_versions":
                row.update(dataset_kind="static_schedule", is_current=True)
            if table == "feed_endpoints":
                row["is_enabled"] = True
            pg.execute(
                text(
                    f"INSERT INTO pg_temp.{table} ({','.join(row)}) "
                    f"VALUES ({','.join(':' + k for k in row)})"
                ),
                row,
            )
