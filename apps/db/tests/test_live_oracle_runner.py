import hashlib
import json
import os
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from google.transit import gtfs_realtime_pb2 as rt
from test_live_oracle_seed import case as case
from test_live_oracle_seed import poll_record
from test_static_silver import _minimal_compliant_members, _write_members_zip

from transit_ops.gold.realtime import refresh_gold_realtime
from transit_ops.live.oracle import PinnedClock, RecordingSink, oracle_database, replay_window
from transit_ops.live.oracle.database import UnpinnableClockError, assert_clock_pinned
from transit_ops.live.oracle.seed import admit_polls, seed_static
from transit_ops.live.oracle.window import CycleSpec
from transit_ops.silver.realtime_gtfs import load_realtime_to_silver
from transit_ops.snapshots import publish


def test_recording_sink_preserves_bytes_and_drains_write_order():
    initial = {"manifest.json": b'{"prior":true}'}
    sink = RecordingSink(initial)
    assert sink.get_json("manifest.json") == {"prior": True}
    assert sink.get_json("missing") is None
    assert sink.put_json("live/trips.json", {"b": 2, "a": 1}, tier="live") == "live/trips.json"
    assert sink.objects["live/trips.json"] == b'{"a":1,"b":2}'
    assert sink.take_written() == ["live/trips.json"]
    assert sink.take_written() == []
    assert initial == {"manifest.json": b'{"prior":true}'}


def test_oracle_keeps_clock_refusals_after_setup(real_db_engine, case):
    with oracle_database(
        real_db_engine.url.render_as_string(hide_password=False),
        clock=PinnedClock(case.window.serving_initialized_at_utc),
        environment=os.environ,
    ) as oracle:
        with oracle.engine.begin() as connection:
            connection.exec_driver_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            connection.exec_driver_sql("CREATE VIEW gold.probe AS SELECT ('now')::timestamptz AS d")
            with pytest.raises(
                UnpinnableClockError, match="clock literal resolved at DDL time"
            ) as error:
                assert_clock_pinned(connection)
            assert error.value.objects == ("gold.probe",)


def capture_payload(endpoint, at, captured_at, delay):
    message = rt.FeedMessage(
        header=dict(gtfs_realtime_version="2.0", timestamp=int(captured_at.timestamp()))
    )
    entity = message.entity.add(id="entity")
    if endpoint == "trip_updates":
        entity.trip_update.trip.trip_id = "trip-1"
        entity.trip_update.trip.start_date = "20250324"
        for sequence, seconds in ((1, 0), (2, 3600)):
            entity.trip_update.stop_time_update.add(
                stop_sequence=sequence,
                stop_id="stop-1",
                departure=dict(time=int(at.timestamp()) + seconds + delay, delay=delay),
            )
    else:
        entity.vehicle.trip.trip_id = "trip-1"
        entity.vehicle.position.latitude = 45.4
        entity.vehicle.position.longitude = -71.9
    return message.SerializeToString()


@pytest.fixture
def replay_case(case):
    at = datetime(2025, 3, 24, 12, tzinfo=UTC)
    members = {k: v.replace("2026", "2025") for k, v in _minimal_compliant_members().items()}
    members["stops.txt"] = members["stops.txt"].replace("node-1,,", "node-1,Generic node,")
    path = case.bronze("local").root / "schedule.zip"
    case.settings = case.settings.model_copy(update={"BRONZE_LOCAL_ROOT": str(path.parent)})
    _write_members_zip(path, members)
    payload = path.read_bytes()
    edition = replace(
        case.window.edition,
        checksum_sha256=hashlib.sha256(payload).hexdigest(),
        byte_size=len(payload),
        **{
            k: at - timedelta(minutes=20) for k in asdict(case.window.edition) if k.endswith("_utc")
        },
    )
    edition = replace(edition, loaded_at_utc=at - timedelta(minutes=10))
    case.window = replace(case.window, edition=edition, serving_initialized_at_utc=at)
    case.registry.get_provider(case.window.provider_id).realtime.lines_without_live_data = []
    records = []
    for run, delay in ((1101, 60), (1102, 120), (1103, None), (1100, 900)):
        endpoint = "vehicle_positions" if delay is None else "trip_updates"
        record = poll_record(case, run_id=run, endpoint=endpoint)
        capture = record.captures[0]
        payload = capture_payload(endpoint, at, capture.captured_at_utc, delay)
        (path.parent / capture.storage_path).write_bytes(payload)
        capture = replace(
            capture,
            byte_size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
            entity_count=1,
            object_kind=f"gtfs_rt_{endpoint}",
        )
        records.append(
            replace(record, captures=(capture,), polls=(replace(record.polls[0], entity_count=1),))
        )
    cycles = tuple(
        CycleSpec(at + timedelta(seconds=30 * i), (("realtime_snapshot", sid),))
        for i, sid in enumerate((1201, 1202, 1203, 1200), 1)
    )
    case.window = replace(case.window, poll_records=tuple(records), cycles=cycles)
    return case


@pytest.fixture
def replay(real_db_engine, replay_case):
    options = dict(
        environment=os.environ,
        settings=replay_case.settings,
        registry=replay_case.registry,
        bronze=replay_case.bronze,
    )

    def run():
        return list(
            replay_window(
                replay_case.window,
                **options,
                admin_url=real_db_engine.url.render_as_string(hide_password=False),
            )
        )

    return run


def test_two_replays_give_identical_publications(replay):
    first, second = replay(), replay()
    assert [c.public["manifest.json"] for c in first] == [c.public["manifest.json"] for c in second]
    assert [c.public for c in first] == [c.public for c in second]


def test_every_stamp_and_age_follows_the_cycle_clock(replay):
    source_stamps = [
        ("2025-03-24T12:00:05Z", None),
        ("2025-03-24T12:00:06Z", None),
        ("2025-03-24T12:00:06Z", "2025-03-24T12:00:07Z"),
        ("2025-03-24T12:00:06Z", "2025-03-24T12:00:07Z"),
    ]
    for index, cycle in enumerate(replay()):
        stamp = cycle.generated_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
        for key, body in cycle.written:
            payload = json.loads(body)
            stamped = payload["files"]["live"] if key == "manifest.json" else payload
            assert stamped["generated_utc"] == stamp
        captures = json.loads(cycle.public["manifest.json"])["files"]["live"]["input_captures"]
        trip_stamp, vehicle_stamp = source_stamps[index]
        assert captures == {
            "static_schedule": "2025-03-24T11:50:00Z",
            "trip_updates": trip_stamp,
            "vehicle_positions": vehicle_stamp,
            "i3_alerts": None,
        }
        lanes = json.loads(cycle.public["status/data_health.json"])["lanes"]
        if index:
            lane = next(lane for lane in lanes if lane["lane"] == "live")
            assert lane["last_publish_utc"] == (
                cycle.generated_utc - timedelta(seconds=30)
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
            assert lane["age_s"] == 30
        if index < 2:
            stops = json.loads(cycle.public["live/trips.json"])["trips"]["trip-1"]["stops"]
            assert [s["eta_utc"] for s in stops] == [f"2025-03-24T12:0{index + 1}:00Z"]


def test_unchanged_inputs_keep_their_generation(replay):
    first, second, third, _ = replay()
    assert {key for key, _ in third.written} == {
        "live/vehicles.json",
        "live/network.json",
        "status/data_health.json",
        "manifest.json",
    }
    for key in ("live/trips.json", "live/stop_departures.json"):
        assert third.public[key] == second.public[key]
        generations = [
            json.loads(c.public["manifest.json"])["files"]["live"]["generations"]
            for c in (first, second, third)
        ]
        assert generations[0][key] != generations[1][key] == generations[2][key]


def test_the_manifest_is_written_last(replay):
    assert all(cycle.written[-1][0] == "manifest.json" for cycle in replay())


def test_serving_does_not_move_back(replay):
    _, _, newer, older = replay()
    assert older.public["live/trips.json"] == newer.public["live/trips.json"]


def test_default_and_sequential_publication_have_identical_bytes(real_db_engine, replay_case):
    case = replay_case
    results = []
    original = case.settings.SNAPSHOT_PUBLISH_CONCURRENCY
    for settings in (
        case.settings,
        case.settings.model_copy(update={"SNAPSHOT_PUBLISH_CONCURRENCY": 1}),
    ):
        clock = PinnedClock(case.window.serving_initialized_at_utc)
        with oracle_database(
            real_db_engine.url.render_as_string(hide_password=False),
            clock=clock,
            environment=os.environ,
        ) as oracle:
            seed_static(
                oracle, case.window, settings=settings, registry=case.registry, bronze=case.bronze
            )
            clock.set(case.window.cycles[0].generated_utc)
            admit_polls(oracle, case.window, until_utc=clock.instant, bronze=case.bronze)
            receipt = load_realtime_to_silver(
                case.window.provider_id,
                "trip_updates",
                snapshot_id=1201,
                settings=settings,
                registry=case.registry,
                engine=oracle.engine,
            )
            refresh_gold_realtime(
                case.window.provider_id,
                snapshots=[receipt],
                settings=settings,
                registry=case.registry,
                engine=oracle.engine,
            )
            sink = RecordingSink()
            with patch.object(publish, "utc_now", return_value=clock.instant):
                publish.publish_snapshot(
                    case.window.provider_id,
                    tier="live",
                    settings=settings,
                    registry=case.registry,
                    engine=oracle.engine,
                    storage=sink,
                )
            assert sink.take_written()[-1] == "manifest.json"
            results.append(sink.objects)
    assert results[0] == results[1]
    assert case.settings.SNAPSHOT_PUBLISH_CONCURRENCY == original
