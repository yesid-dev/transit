"""Math-first vehicle facts: raw recomputation first, classified PG differences second.

R28 (2)(b): PostgreSQL copies impossible measures. Keep the observation and NULL
only latitude outside [-90,90], longitude outside [-180,180], bearing outside
[0,360). Bearing correction on a valid map point can change a published value:
flag the methodology version before activation. No trip-delay correctness claim.
"""

import math
import os
from contextlib import closing, nullcontext
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from test_live_facts import vehicle_message
from test_live_local_file import SETTINGS
from test_live_oracle_alert_rows_real_db import tracked_owner
from test_live_oracle_runner import replay_case as replay_case
from test_live_oracle_seed import case as case
from test_live_oracle_seed import poll_record

from transit_ops.batch.build import TableRows
from transit_ops.batch.compare import compare_tables
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.facts import apply_capture, read_vehicle_facts
from transit_ops.live.local_file import LocalFile
from transit_ops.live.oracle import replay_window
from transit_ops.live.oracle.window import CycleSpec
from transit_ops.providers import ProviderRegistry

COLUMNS = tuple(
    (
        "provider_id realtime_snapshot_id entity_index snapshot_date_key "
        "snapshot_local_date feed_timestamp_utc captured_at_utc position_timestamp_utc "
        "entity_id vehicle_id trip_id route_id stop_id current_stop_sequence current_status "
        "occupancy_status latitude longitude bearing speed"
    ).split()
)
DOMAINS = {"latitude": (-90, 90), "longitude": (-180, 180), "bearing": (0, 360)}


def raw_rows(payload, capture, timezone, max_speed):
    """Independent protobuf-to-20-column derivation; no normalized frames/Gold SQL."""
    message = pb.FeedMessage.FromString(payload)
    day = capture.feed_timestamp_utc.astimezone(ZoneInfo(timezone)).date()
    rows = []
    for index, entity in enumerate(message.entity):
        if not entity.HasField("vehicle"):
            continue
        vehicle = entity.vehicle
        position = vehicle.position if vehicle.HasField("position") else None
        measures = []
        for field in ("latitude", "longitude", "bearing", "speed"):
            value = getattr(position, field) if position and position.HasField(field) else None
            if value is not None:
                assert math.isfinite(value)
                if field == "speed":
                    value = value if 0 <= value * 3.6 <= max_speed else None
                else:
                    lo, hi = DOMAINS[field]
                    if not lo <= value <= hi or (field == "bearing" and value == hi):
                        value = None
                if value == 0:
                    value = 0.0
            measures.append(value)
        stamp = datetime.fromtimestamp(vehicle.timestamp, UTC) if vehicle.timestamp else None

        def optional(name, source=vehicle):
            return getattr(source, name) if source.HasField(name) else None

        rows.append(
            (
                capture.provider_id,
                capture.capture_row_id,
                index,
                day.year * 10000 + day.month * 100 + day.day,
                day,
                capture.feed_timestamp_utc.astimezone(UTC),
                capture.captured_at_utc.astimezone(UTC),
                stamp,
                entity.id.strip() or None,
                vehicle.vehicle.id.strip() or None,
                vehicle.trip.trip_id.strip() or None,
                vehicle.trip.route_id.strip() or None,
                vehicle.stop_id.strip() or None,
                optional("current_stop_sequence"),
                optional("current_status"),
                optional("occupancy_status"),
                *measures,
            )
        )
    return tuple(rows)


def assert_math(local, derived):
    actual = read_vehicle_facts(local)
    assert actual.columns == COLUMNS
    assert actual.rows == tuple(derived), "raw protobuf derivation differs"
    for row in actual.rows:
        for name, value in zip(COLUMNS, row, strict=True):
            if isinstance(value, float):
                assert math.isfinite(value)
                assert value != 0 or math.copysign(1, value) == 1
            if name in DOMAINS and value is not None:
                lo, hi = DOMAINS[name]
                assert lo <= value <= hi and (name != "bearing" or value < hi)
    counts = local.connection.execute("SELECT row_count FROM fact_processing").fetchall()
    assert all(type(count) is int and count >= 0 for (count,) in counts)
    assert sum(count for (count,) in counts) == len(derived)
    return actual


def assert_postgres_comparison(pg, local, declared):
    """Only R28 canonical representations and exact declared class-(b) cells pass."""
    left = TableRows(pg.table, pg.columns, COLUMNS[:3], pg.rows)
    right = TableRows(pg.table, local.columns, COLUMNS[:3], local.rows)
    observed = {}
    for difference in compare_tables(left, right):
        if difference.difference_class == "representation":
            continue  # R28 (2)(c): +/-0 and double precision at 12 significant digits.
        identity = difference.key, difference.column
        observed[identity] = difference.expected, difference.actual
        assert difference.kind in ("value", "type") and difference.column in DOMAINS, difference
        assert identity in declared, difference
        assert observed[identity] == declared[identity], difference
        value = difference.expected
        lo, hi = DOMAINS[difference.column]
        assert math.isfinite(value)
        assert not lo <= value <= hi or (difference.column == "bearing" and value == hi)
        assert difference.actual is None  # class (b), PostgreSQL wrong by the domain math.
    assert observed == declared, "declared PostgreSQL correction was not observed"


def declarations(payload, capture):
    """Exact class-(b) cells, including PK, raw measure, NULL and domain derivation."""
    result = {}
    for index, entity in enumerate(pb.FeedMessage.FromString(payload).entity):
        if not entity.HasField("vehicle") or not entity.vehicle.HasField("position"):
            continue
        for field, (lo, hi) in DOMAINS.items():
            position = entity.vehicle.position
            if position.HasField(field):
                value = getattr(position, field)
                if not lo <= value <= hi or (field == "bearing" and value == hi):
                    result[((capture.provider_id, capture.capture_row_id, index), field)] = (
                        value,
                        None,
                    )
    return result


@pytest.fixture
def vehicle_case(replay_case):
    case = replay_case
    provider = "facts_" + uuid4().hex
    manifest = case.registry.get_provider(case.window.provider_id)
    manifest.provider.provider_id = provider
    (case.registry.config_dir / "test.yaml").write_text(
        manifest.model_dump_json(), encoding="utf-8"
    )
    case.registry = ProviderRegistry(case.registry.config_dir, case.settings)
    case.window = replace(case.window, provider_id=provider, poll_records=(), cycles=())
    return case


def set_vehicle_window(case, scenario):
    records, cycles = [], []
    for index in range(2):
        record = poll_record(case, run_id=1101 + index, endpoint="vehicle_positions")
        message = vehicle_message()
        if scenario == "empty":
            message.ClearField("entity")
        elif scenario == "invalid":
            message.entity[0].vehicle.position.latitude = 91
            message.entity[1].vehicle.position.longitude = -181
            message.entity[2].vehicle.position.bearing = 360
        else:
            message.entity[0].vehicle.position.latitude = -0.0
        # Separate capture/feed clocks with exact microseconds, same provider-local day.
        capture = replace(
            record.captures[0],
            captured_at_utc=record.captures[0].captured_at_utc + timedelta(microseconds=123456),
            feed_timestamp_utc=record.captures[0].feed_timestamp_utc
            - timedelta(microseconds=234567),
        )
        message.header.timestamp = int(capture.feed_timestamp_utc.timestamp())
        payload = message.SerializeToString()
        (case.bronze("local").root / capture.storage_path).write_bytes(payload)
        capture = replace(
            capture,
            sha256=sha256(payload).hexdigest(),
            byte_size=len(payload),
            entity_count=len(message.entity),
            object_kind="gtfs_rt_vehicle_positions",
        )
        poll = replace(
            record.polls[0],
            entity_count=len(message.entity),
            feed_timestamp_utc=capture.feed_timestamp_utc,
            completed_at_utc=capture.captured_at_utc,
            time_utc=capture.captured_at_utc,
        )
        records.append(replace(record, captures=(capture,), polls=(poll,)))
        cycles.append(
            CycleSpec(
                case.window.serving_initialized_at_utc + timedelta(seconds=30 + index),
                (("realtime_snapshot", capture.capture_row_id),),
            )
        )
    case.window = replace(case.window, poll_records=tuple(records), cycles=tuple(cycles))


@pytest.mark.parametrize("scenario", ["normal", "invalid", "empty", "assertion_failure"])
def test_vehicle_facts_follow_math_with_classified_postgres_comparison(
    real_db_engine,
    vehicle_case,
    tmp_path,
    scenario,
):
    case = vehicle_case
    set_vehicle_window(case, scenario)
    provider = case.window.provider_id
    policy = ParsePolicy.from_manifest(case.registry.get_provider(provider))
    raises = (
        pytest.raises(AssertionError, match="injected comparison failure")
        if scenario == "assertion_failure"
        else nullcontext()
    )
    with tracked_owner(real_db_engine) as names:
        with (
            raises,
            closing(
                replay_window(
                    case.window,
                    admin_url=real_db_engine.url.render_as_string(hide_password=False),
                    environment=os.environ,
                    settings=case.settings,
                    registry=case.registry,
                    bronze=case.bronze,
                )
            ) as outcomes,
            closing(
                LocalFile.open(
                    tmp_path / "facts.db",
                    provider_id=provider,
                    settings=SETTINGS,
                )
            ) as local,
        ):
            derived, declared = [], {}
            for cycle, outcome in zip(case.window.cycles, outcomes, strict=True):
                for family, capture_id in cycle.captures:
                    _, capture = case.window.capture(family, capture_id)
                    payload = (case.bronze("local").root / capture.storage_path).read_bytes()
                    ref = CaptureRef.from_entry(
                        capture, provider_id=provider, endpoint_key="vehicle_positions"
                    )
                    parsed = parse_capture(payload, ref, policy)
                    apply_capture(local, parsed, provider_timezone="America/Toronto")
                    assert apply_capture(local, parsed, provider_timezone="America/Toronto") == 0
                    derived.extend(
                        raw_rows(payload, ref, "America/Toronto", policy.max_vehicle_speed_kmh)
                    )
                    declared.update(declarations(payload, ref))
                actual = assert_math(local, derived)  # Correctness before PostgreSQL comparison.
                pg = next(t for t in outcome.facts if t.table == "gold.fact_vehicle_snapshot")
                assert_postgres_comparison(pg, actual, declared)
                if scenario == "assertion_failure":
                    raise AssertionError("injected comparison failure")
        assert len(names) == 1
    # tracked_owner asserts no checked-out connections, pg_database or pg_stat_activity
    # remains, including when the consumer raises with a suspended replay generator.


@pytest.mark.parametrize("invalid", [False, True])
def test_every_vehicle_column_is_derived_from_raw_protobuf(tmp_path, invalid):
    message = vehicle_message()
    message.entity[1].vehicle.trip.trip_id = " "
    message.entity[1].vehicle.position.speed = -1
    if invalid:
        message.entity[0].vehicle.position.latitude = 91
        message.entity[1].vehicle.position.longitude = -181
        message.entity[2].vehicle.position.bearing = 360
    payload = message.SerializeToString()
    # Distinct microseconds, non-UTC feed stamp, repeated DST hour and id > 2**53.
    feed = datetime.fromisoformat("2026-11-01T01:30:00.234567-05:00")
    captured = feed.astimezone(UTC) + timedelta(seconds=1, microseconds=123)
    ref = CaptureRef(
        "原始",
        "vehicle_positions",
        2**53 + 7,
        captured,
        feed,
        len(payload),
        sha256(payload).hexdigest(),
    )
    policy = ParsePolicy(None, 100)
    with closing(
        LocalFile.open(tmp_path / "math.db", provider_id=ref.provider_id, settings=SETTINGS)
    ) as local:
        apply_capture(
            local, parse_capture(payload, ref, policy), provider_timezone="America/Toronto"
        )
        derived = raw_rows(payload, ref, "America/Toronto", 100)
        actual = assert_math(local, derived)
        assert actual.rows[0][8] == "\ufeff车辆-é-0"
        assert actual.rows[1][10] is None
        assert actual.rows[1][19] is None


def test_comparison_allows_only_canonical_or_declared_differences():
    from types import SimpleNamespace

    # Compare -0/+0 and last-digit double differences at R28's 12 significant digits.
    columns = COLUMNS[:3] + ("latitude", "bearing")
    pg = SimpleNamespace(
        table="gold.fact_vehicle_snapshot",
        columns=columns,
        rows=(("p", 7, 0, -0.0, 1.0000000000001),),
    )
    local = replace(
        TableRows(pg.table, columns, COLUMNS[:3], pg.rows), rows=(("p", 7, 0, 0.0, 1.0),)
    )
    assert_postgres_comparison(pg, local, {})
    pg.rows = (("p", 7, 0, 91.0, 1.0),)
    local = replace(local, rows=(("p", 7, 0, None, 1.0),))
    with pytest.raises(AssertionError):
        assert_postgres_comparison(pg, local, {})
    assert_postgres_comparison(pg, local, {(("p", 7, 0), "latitude"): (91.0, None)})
    # Even an explicit declaration cannot excuse a wrong local NULL for valid latitude.
    pg.rows = (("p", 7, 0, 45.0, 1.0),)
    with pytest.raises(AssertionError):
        assert_postgres_comparison(pg, local, {(("p", 7, 0), "latitude"): (45.0, None)})


def test_consumer_assertion_closes_suspended_replay(vehicle_case, tmp_path, monkeypatch):
    from types import SimpleNamespace

    import test_live_facts_real_db as twin

    closed = []

    def replay(window, **kwargs):
        try:
            _, capture = window.capture(*window.cycles[0].captures[0])
            ref = CaptureRef.from_entry(
                capture, provider_id=window.provider_id, endpoint_key="vehicle_positions"
            )
            payload = (vehicle_case.bronze("local").root / capture.storage_path).read_bytes()
            facts = SimpleNamespace(
                table="gold.fact_vehicle_snapshot",
                columns=COLUMNS,
                rows=raw_rows(payload, ref, "America/Toronto", 130),
            )
            yield SimpleNamespace(facts=(facts,))
        finally:
            closed.append(True)

    monkeypatch.setattr(twin, "replay_window", replay)
    monkeypatch.setattr(twin, "tracked_owner", lambda admin: nullcontext(["test-oracle"]))
    # No database: exercise the actual twin's suspended-iterator consumer failure.
    # The real-db scenario independently proves database/connection cleanup.
    admin = SimpleNamespace(url=SimpleNamespace(render_as_string=lambda **kwargs: "unused"))
    twin.test_vehicle_facts_follow_math_with_classified_postgres_comparison(
        admin,
        vehicle_case,
        tmp_path,
        "assertion_failure",
    )
    assert closed == [True]
