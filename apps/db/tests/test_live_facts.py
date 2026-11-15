from contextlib import closing
from dataclasses import replace
from datetime import UTC, date, datetime
from hashlib import sha256

import duckdb
import pytest
from google.transit import gtfs_realtime_pb2 as pb
from test_live_captures import AT, _message, _parse
from test_live_local_file import SETTINGS

from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.facts import apply_capture, read_vehicle_facts
from transit_ops.live.local_file import LocalFile, LocalFileMismatch


def test_apply_vehicle_capture_keeps_normalized_rows_and_receipt(tmp_path):
    parsed = _parse(_message("vehicle_positions"), "vehicle_positions")
    with closing(
        LocalFile.open(tmp_path / "live.db", provider_id="network", settings=SETTINGS)
    ) as local:
        assert apply_capture(local, parsed, provider_timezone="America/Toronto") == 3
        facts = read_vehicle_facts(local)
        row = dict(zip(facts.columns, facts.rows[0], strict=True))
        assert row["provider_id"] == "network"
        assert row["realtime_snapshot_id"] == 42
        assert row["snapshot_local_date"] == date(2026, 6, 20)
        assert row["snapshot_date_key"] == 20260620
        assert row["captured_at_utc"] == AT
        assert row["latitude"] == 45.5
        assert row["position_timestamp_utc"] is None
        assert local.connection.execute("SELECT row_count FROM fact_processing").fetchall() == [
            (3,)
        ]


def vehicle_message():
    message = pb.FeedMessage(header=dict(gtfs_realtime_version="2.0"))
    for index, (latitude, speed) in enumerate(((45.5, 10), (0, 10), (45.5, 1000))):
        entity = message.entity.add(id=f"\ufeff车辆-é-{index}")
        vehicle = entity.vehicle
        vehicle.trip.trip_id = "行程"
        vehicle.trip.start_date = "20260620"
        vehicle.trip.route_id = "路线"
        vehicle.vehicle.id = f"bus-{index}"
        vehicle.position.latitude = latitude
        vehicle.position.longitude = -73.5
        vehicle.position.speed = speed
        vehicle.position.bearing = 123.4
        vehicle.timestamp = 1781956800
        vehicle.stop_id = "站"
        vehicle.current_stop_sequence = 3
        vehicle.current_status = pb.VehiclePosition.IN_TRANSIT_TO
        vehicle.occupancy_status = pb.VehiclePosition.FEW_SEATS_AVAILABLE
    message.entity.add(id="nulls").vehicle.SetInParent()
    message.entity.add(id="deleted", is_deleted=True)
    return message


def parsed_vehicle(message=None):
    return _parse(vehicle_message() if message is None else message, "vehicle_positions")


def test_identical_retry_survives_reopen_and_changed_identity_refuses(tmp_path):
    path = tmp_path / "live.db"
    parsed = parsed_vehicle()
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        apply_capture(local, parsed, provider_timezone="America/Toronto")
        before = read_vehicle_facts(local)
    with closing(LocalFile.open(path, provider_id="network", settings=SETTINGS)) as local:
        assert apply_capture(local, parsed, provider_timezone="America/Toronto") == 0
        for changed in (
            replace(parsed, capture=replace(parsed.capture, sha256="0" * 64)),
            replace(
                parsed,
                frames={
                    **parsed.frames,
                    "rt_vehicle_positions": replace(
                        parsed.frames["rt_vehicle_positions"],
                        rows=(),
                    ),
                },
            ),
            replace(
                parsed, capture=replace(parsed.capture, captured_at_utc=AT.replace(microsecond=1))
            ),
        ):
            with pytest.raises(LocalFileMismatch, match="different content"):
                apply_capture(local, changed, provider_timezone="America/Toronto")
        assert read_vehicle_facts(local) == before
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (1,)


def test_providers_are_isolated_and_trip_updates_require_edition(tmp_path):
    parsed = parsed_vehicle()
    for provider in ("network", "other"):
        with closing(
            LocalFile.open(tmp_path / f"{provider}.db", provider_id=provider, settings=SETTINGS)
        ) as local:
            own = replace(parsed, capture=replace(parsed.capture, provider_id=provider))
            assert apply_capture(local, own, provider_timezone="UTC") == 4
            with pytest.raises(LocalFileMismatch, match="provider"):
                apply_capture(
                    local,
                    replace(own, capture=replace(own.capture, provider_id="wrong")),
                    provider_timezone="UTC",
                )
            from transit_ops.live.edition import EditionMissing

            with pytest.raises(EditionMissing, match="loaded edition"):
                trip = _parse(_message())
                trip = replace(trip, capture=replace(trip.capture, provider_id=provider))
                apply_capture(local, trip, provider_timezone="UTC")
            assert {r[0] for r in read_vehicle_facts(local).rows} == {provider}


def test_empty_capture_has_success_receipt_but_no_facts(tmp_path):
    parsed = parsed_vehicle(pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")))
    with closing(
        LocalFile.open(tmp_path / "empty.db", provider_id="network", settings=SETTINGS)
    ) as local:
        assert apply_capture(local, parsed, provider_timezone="UTC") == 0
        assert read_vehicle_facts(local).rows == ()
        assert local.connection.execute("SELECT row_count FROM fact_processing").fetchall() == [
            (0,)
        ]
        assert apply_capture(local, parsed, provider_timezone="UTC") == 0


@pytest.mark.parametrize("failure", ["projection", "receipt", "outer"])
def test_failure_rolls_back_facts_and_success_receipt(tmp_path, failure, monkeypatch):
    parsed = parsed_vehicle()
    with closing(
        LocalFile.open(tmp_path / "rollback.db", provider_id="network", settings=SETTINGS)
    ) as local:
        assert read_vehicle_facts(local).rows == ()
        if failure == "projection":
            frame = parsed.frames["rt_vehicle_positions"]
            # DuckDB inserts earlier rows before encountering this duplicate key.
            parsed = replace(
                parsed,
                frames={
                    **parsed.frames,
                    frame.table: replace(
                        frame,
                        rows=(*frame.rows, frame.rows[0]),
                    ),
                },
            )
        if failure == "receipt":
            connection = local.connection

            class FailingReceiptConnection:
                def execute(self, sql, *args):
                    if sql.startswith("INSERT INTO fact_processing"):
                        raise RuntimeError("receipt storage failed")
                    return connection.execute(sql, *args)

                def executemany(self, *args):
                    return connection.executemany(*args)

            monkeypatch.setattr(local, "connection", FailingReceiptConnection())
        with pytest.raises((duckdb.Error, RuntimeError)):
            with local.transaction():
                apply_capture(local, parsed, provider_timezone="UTC")
                if failure == "outer":
                    raise RuntimeError("caller failed after application")
        assert local.connection.execute(
            "SELECT count(*) FROM fact_vehicle_snapshot"
        ).fetchone() == (0,)
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (0,)
        if failure == "receipt":
            monkeypatch.setattr(local, "connection", connection)


@pytest.mark.parametrize("drift", ["type", "collation", "key", "missing"])
def test_schema_drift_refuses_even_identical_retry(tmp_path, drift):
    parsed = parsed_vehicle()
    with closing(
        LocalFile.open(tmp_path / "drift.db", provider_id="network", settings=SETTINGS)
    ) as local:
        apply_capture(local, parsed, provider_timezone="UTC")
        if drift == "missing":
            local.connection.execute("DROP TABLE fact_processing")
        else:
            sql = local.connection.execute(
                "SELECT sql FROM duckdb_tables() WHERE table_name='fact_vehicle_snapshot'"
            ).fetchone()[0]
            local.connection.execute("ALTER TABLE fact_vehicle_snapshot RENAME TO original")
            if drift == "type":
                sql = sql.replace("latitude DOUBLE", "latitude FLOAT")
            elif drift == "collation":
                sql = sql.replace("entity_id VARCHAR", "entity_id VARCHAR COLLATE NOCASE")
            else:
                sql = sql[: sql.index(", PRIMARY KEY")] + ");"
            local.connection.execute(sql)
        with pytest.raises(LocalFileMismatch, match="fact_"):
            apply_capture(local, parsed, provider_timezone="UTC")


@pytest.mark.parametrize(
    "stamp, expected",
    [
        ("2026-01-01T00:01:00.123456+00:00", date(2025, 12, 31)),
        ("2026-11-01T05:30:00.123456+00:00", date(2026, 11, 1)),
        ("2026-11-01T06:30:00.123456+00:00", date(2026, 11, 1)),
    ],
)
def test_provider_day_uses_feed_time_and_preserves_utc_microseconds(tmp_path, stamp, expected):
    payload = vehicle_message().SerializeToString()
    at = datetime.fromisoformat(stamp)
    parsed = parse_capture(
        payload,
        CaptureRef(
            "network",
            "vehicle_positions",
            42,
            AT,
            at,
            len(payload),
            sha256(payload).hexdigest(),
        ),
        ParsePolicy(None, 100),
    )
    with closing(
        LocalFile.open(tmp_path / "date.db", provider_id="network", settings=SETTINGS)
    ) as local:
        apply_capture(local, parsed, provider_timezone="America/Toronto")
        facts = read_vehicle_facts(local)
        for row in facts.rows:
            assert row[4] == expected
            assert row[5] == at.astimezone(UTC)
            assert row[6] == AT
        assert facts.rows[0][8] == "\ufeff车辆-é-0"
        assert facts.rows[3][16:] == (None, None, None, None)


def test_caught_application_failure_aborts_enclosing_transaction(tmp_path):
    parsed = parsed_vehicle()
    frame = parsed.frames["rt_vehicle_positions"]
    broken = replace(
        parsed,
        frames={
            **parsed.frames,
            frame.table: replace(
                frame,
                rows=(*frame.rows, frame.rows[0]),
            ),
        },
    )
    with closing(
        LocalFile.open(tmp_path / "nested.db", provider_id="network", settings=SETTINGS)
    ) as local:
        read_vehicle_facts(local)
        with pytest.raises(RuntimeError, match="transaction aborted"):
            with local.transaction():
                with pytest.raises(duckdb.Error):
                    apply_capture(local, broken, provider_timezone="UTC")
        assert read_vehicle_facts(local).rows == ()
        assert apply_capture(local, parsed, provider_timezone="UTC") == 4


def test_bad_parse_cannot_create_facts_or_receipt(tmp_path):
    from transit_ops.live.captures import CaptureIntegrityError

    parsed = parsed_vehicle()
    with closing(
        LocalFile.open(tmp_path / "parse.db", provider_id="network", settings=SETTINGS)
    ) as local:
        with pytest.raises(CaptureIntegrityError):
            apply_capture(
                local,
                parse_capture(b"broken", parsed.capture, ParsePolicy(None, 100)),
                provider_timezone="UTC",
            )
        assert read_vehicle_facts(local).rows == ()
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (0,)


def test_signed_zero_is_stored_as_canonical_zero(tmp_path):
    import math

    message = vehicle_message()
    message.entity[0].vehicle.position.latitude = -0.0
    with closing(
        LocalFile.open(tmp_path / "zero.db", provider_id="network", settings=SETTINGS)
    ) as local:
        apply_capture(local, parsed_vehicle(message), provider_timezone="UTC")
        value = read_vehicle_facts(local).rows[0][16]
        assert value == 0.0
        assert math.copysign(1, value) == 1


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_position_refuses_without_success(tmp_path, value):
    message = vehicle_message()
    message.entity[0].vehicle.position.latitude = value
    with closing(
        LocalFile.open(tmp_path / "finite.db", provider_id="network", settings=SETTINGS)
    ) as local:
        read_vehicle_facts(local)
        with pytest.raises(ValueError):
            apply_capture(local, parsed_vehicle(message), provider_timezone="UTC")
        assert read_vehicle_facts(local).rows == ()
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (0,)


@pytest.mark.parametrize(
    "field, value",
    [
        ("latitude", -91.0),
        ("latitude", 91.0),
        ("longitude", -181.0),
        ("longitude", 181.0),
        ("bearing", -1.0),
        ("bearing", 360.0),
        ("bearing", 361.0),
    ],
)
def test_invalid_physical_measure_is_null_but_observation_is_retained(tmp_path, field, value):
    # R28 (2)(b): PostgreSQL wrong. Latitude [-90,90], longitude [-180,180],
    # bearing [0,360); e.g. 91 > 90 and 181 > 180. No modulo or clamping.
    message = vehicle_message()
    setattr(message.entity[0].vehicle.position, field, value)
    with closing(
        LocalFile.open(tmp_path / "domain.db", provider_id="network", settings=SETTINGS)
    ) as local:
        assert apply_capture(local, parsed_vehicle(message), provider_timezone="UTC") == 4
        facts = read_vehicle_facts(local)
        row = dict(zip(facts.columns, facts.rows[0], strict=True))
        assert row[field] is None
        assert row["vehicle_id"] == "bus-0"
        assert local.connection.execute("SELECT row_count FROM fact_processing").fetchall() == [
            (4,)
        ]


@pytest.mark.parametrize("field", ["entity_id", "vehicle_id", "trip_id", "route_id", "stop_id"])
def test_nul_in_identifier_refuses_capture_and_receipt(tmp_path, field):
    message = vehicle_message()
    entity = message.entity[1]
    targets = {
        "entity_id": (entity, "id"),
        "vehicle_id": (entity.vehicle.vehicle, "id"),
        "trip_id": (entity.vehicle.trip, "trip_id"),
        "route_id": (entity.vehicle.trip, "route_id"),
        "stop_id": (entity.vehicle, "stop_id"),
    }
    target, attribute = targets[field]
    setattr(target, attribute, "é\x00尾")
    with closing(
        LocalFile.open(tmp_path / "nul.db", provider_id="network", settings=SETTINGS)
    ) as local:
        read_vehicle_facts(local)
        with pytest.raises(ValueError, match="nul_in_text"):
            apply_capture(local, parsed_vehicle(message), provider_timezone="UTC")
        assert read_vehicle_facts(local).rows == ()
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (0,)


@pytest.mark.parametrize("latitude, longitude", [(-90.0, -180.0), (90.0, 180.0)])
def test_physical_boundary_and_outside_provider_bbox_are_retained(tmp_path, latitude, longitude):
    message = vehicle_message()
    position = message.entity[0].vehicle.position
    position.latitude, position.longitude, position.bearing = latitude, longitude, 0
    parsed = parsed_vehicle(message)
    assert (
        parsed.frames["rt_vehicle_positions"].column("position_quality")[0]
        == "outside_provider_bbox"
    )
    with closing(
        LocalFile.open(tmp_path / "edge.db", provider_id="network", settings=SETTINGS)
    ) as local:
        apply_capture(local, parsed, provider_timezone="UTC")
        assert read_vehicle_facts(local).rows[0][16:19] == (latitude, longitude, 0.0)


@pytest.mark.parametrize("field", ["provider_id", "endpoint_key", "sha256"])
def test_nul_in_capture_text_refuses_by_name(tmp_path, field):
    parsed = parsed_vehicle()
    parsed = replace(parsed, capture=replace(parsed.capture, **{field: "prefix\x00tail"}))
    with closing(
        LocalFile.open(tmp_path / "identity.db", provider_id="network", settings=SETTINGS)
    ) as local:
        read_vehicle_facts(local)
        with pytest.raises(ValueError, match="nul_in_text"):
            apply_capture(local, parsed, provider_timezone="UTC")
        assert read_vehicle_facts(local).rows == ()
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (0,)


def seed_fact_edition(local, provider="network"):
    from transit_ops.live.edition import create_edition_tables

    create_edition_tables(local.connection)
    local.connection.execute(
        "INSERT INTO edition_meta VALUES (?, 7, 'seed', NULL, NULL)", [provider]
    )
    local.connection.execute(
        "INSERT INTO edition_stop_times VALUES ('行程', 3, '08:00:00', NULL, '站')"
    )


def trip_message():
    message = pb.FeedMessage(header=dict(gtfs_realtime_version="2.0"))
    update = message.entity.add(id="trip-é").trip_update
    update.trip.trip_id = "行程"
    update.trip.route_id = "路线"
    update.trip.start_date = "20260620"
    update.trip.direction_id = 1
    update.stop_time_update.add(stop_sequence=3).arrival.time = 1781956980
    update.stop_time_update.add(stop_sequence=4).schedule_relationship = 1
    return message


def test_trip_capture_projects_delay_counts_and_vehicle_match_atomically(tmp_path):
    from transit_ops.live.facts import read_trip_facts

    with closing(
        LocalFile.open(tmp_path / "trip.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        apply_capture(local, parsed_vehicle(), provider_timezone="America/Toronto")
        parsed = _parse(trip_message())
        assert apply_capture(local, parsed, provider_timezone="America/Toronto") == 1
        facts = read_trip_facts(local)
        row = dict(zip(facts.columns, facts.rows[0], strict=True))
        assert row["delay_seconds"] == 180  # 12:03 UTC - 08:00 EDT
        assert (row["delay_stop_id"], row["delay_stop_sequence"]) == ("站", 3)
        assert (row["stop_time_update_count"], row["skipped_stop_count"]) == (2, 1)
        assert (row["vehicle_id"], row["occupancy_status"]) == ("bus-0", 2)
        assert apply_capture(local, parsed, provider_timezone="America/Toronto") == 0
        with pytest.raises(LocalFileMismatch, match="different content"):
            apply_capture(
                local,
                replace(parsed, capture=replace(parsed.capture, sha256="0" * 64)),
                provider_timezone="America/Toronto",
            )


@pytest.mark.parametrize("stamp", ["2026-11-01T05:30:00+00:00", "2026-11-01T06:30:00+00:00"])
@pytest.mark.parametrize("offset", [-2147483648, -3601, -3600, 0, 3600, 3601, 2147483647])
def test_trip_delay_integer_domain_and_fall_back_anchor(tmp_path, stamp, offset):
    from datetime import timedelta

    from transit_ops.live.facts import read_trip_facts

    at = datetime.fromisoformat(stamp)
    message = trip_message()
    trip = message.entity[0].trip_update
    trip.trip.start_date = "20261101"
    # Noon EST minus 12 elapsed hours = 01:00 EDT; + 8 hours = 13:00 UTC.
    expected = datetime(2026, 11, 1, 13, tzinfo=UTC)
    if offset == -2147483648:
        expected += timedelta(hours=600000)  # Keep raw POSIX time positive on Windows.
    trip.stop_time_update[0].arrival.time = int((expected + timedelta(seconds=offset)).timestamp())
    parsed = _parse(message)
    parsed = replace(parsed, capture=replace(parsed.capture, feed_timestamp_utc=at))
    frame = parsed.frames["rt_trip_updates"]
    parsed = replace(
        parsed,
        frames={
            **parsed.frames,
            frame.table: replace(
                frame,
                rows=tuple(
                    tuple(
                        at if name == "feed_timestamp_utc" else value
                        for name, value in zip(frame.columns, row, strict=True)
                    )
                    for row in frame.rows
                ),
            ),
        },
    )
    with closing(
        LocalFile.open(tmp_path / "dst.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        if offset == -2147483648:
            local.connection.execute("UPDATE edition_stop_times SET arrival_time='600008:00:00'")
        apply_capture(local, parsed, provider_timezone="America/Toronto")
        row = dict(zip(read_trip_facts(local).columns, read_trip_facts(local).rows[0], strict=True))
        assert row["delay_seconds"] == offset
        assert row["snapshot_local_date"] == date(2026, 11, 1)
        assert row["snapshot_date_key"] == 20261101
        # Ghost delays remain historical facts; downstream eligibility is a range,
        # never ABS(INTEGER_MIN), which overflows PostgreSQL INTEGER.
        assert (-3600 <= row["delay_seconds"] <= 3600) == (offset in (-3600, 0, 3600))


@pytest.mark.parametrize("failure", ["overflow", "nul", "outer"])
def test_trip_failure_rolls_back_vehicle_trip_and_receipt(tmp_path, failure):
    from transit_ops.live.facts import read_trip_facts

    message = trip_message()
    if failure == "overflow":
        message.entity[0].trip_update.stop_time_update[0].arrival.time = 1781956800 + 2**31
    if failure == "nul":
        message.entity[0].trip_update.stop_time_update[0].stop_id = "bad\x00stop"
    with closing(
        LocalFile.open(tmp_path / "rollback-trip.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        read_trip_facts(local)
        with pytest.raises(
            (ValueError, RuntimeError),
            match={"overflow": "delay_seconds", "nul": "nul_in_text", "outer": "caller"}[failure],
        ):
            with local.transaction():
                apply_capture(local, parsed_vehicle(), provider_timezone="UTC")
                apply_capture(local, _parse(message), provider_timezone="UTC")
                if failure == "outer":
                    raise RuntimeError("caller failed")
        assert read_vehicle_facts(local).rows == read_trip_facts(local).rows == ()
        assert local.connection.execute("SELECT count(*) FROM fact_processing").fetchone() == (0,)


def test_trip_integer_overflow_refuses_by_field_name(tmp_path):
    message = trip_message()
    message.entity[0].trip_update.trip.direction_id = 2**31
    with closing(
        LocalFile.open(tmp_path / "integer.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        with pytest.raises(ValueError, match="direction_id.*INTEGER"):
            apply_capture(local, _parse(message), provider_timezone="UTC")


def trip_delay_case(scenario):
    """Small raw inputs and worked event math, shared with the PostgreSQL detector."""
    message = trip_message()
    update = message.entity[0].trip_update
    update.ClearField("stop_time_update")
    stop = update.stop_time_update.add(stop_sequence=3)
    stop.arrival.time = 1781956980  # 2026-06-20 12:03 UTC = 08:03 EDT.
    schedule = [
        ("行程", 3, "08:00:00", "08:05:00", "站"),
        ("行程", 4, "08:20:00", "08:20:00", "站4"),
    ]
    expected = (3 * 60, "站", 3)
    if scenario == "dwell_departure":
        stop.ClearField("arrival")
        stop.departure.time = 1781957160  # 08:06 EDT - scheduled 08:05.
        expected = (60, "站", 3)
    elif scenario == "dwell_arrival":
        stop.arrival.time = 1781956860  # 08:01 EDT - scheduled 08:00.
        stop.departure.time = 1781957400  # Both pairs present: arrival wins.
        expected = (60, "站", 3)
    elif scenario == "cancelled":
        update.trip.schedule_relationship = 3
        expected = (None, None, None)
    elif scenario == "skipped":
        stop.arrival.time = 1781957460  # Skipped 08:11 prediction is ineligible.
        stop.schedule_relationship = 1
        update.stop_time_update.add(stop_sequence=4).arrival.time = 1781958120
        expected = (2 * 60, "站4", 4)  # Served 08:22 - scheduled 08:20.
    elif scenario in ("unique_id", "repeated_id", "wrong_sequence", "no_schedule"):
        stop.stop_id = "站"
        if scenario == "wrong_sequence":
            stop.stop_sequence = 999  # An explicit wrong sequence must not fall back to id.
        else:
            stop.ClearField("stop_sequence")
        expected = (180, "站", None)
        if scenario == "repeated_id":
            schedule[1] = ("行程", 4, "08:20:00", "08:20:00", "站")
        if scenario == "no_schedule":
            schedule = [("different-trip", *row[1:]) for row in schedule]
        if scenario != "unique_id":
            expected = (None, None, None)
    elif scenario == "unmatched_event":
        schedule[0] = ("行程", 3, None, "08:05:00", "站")
        expected = (None, None, None)  # No realtime departure; no like-for-like pair.
    elif scenario == "alternate_pair":
        schedule[0] = ("行程", 3, None, "08:05:00", "站")
        stop.departure.time = 1781957160
        expected = (60, "站", 3)  # Missing scheduled arrival uses the complete departure pair.
    elif scenario in ("next", "past"):
        stop.arrival.time = 1781957340 if scenario == "next" else 1781956860
        update.stop_time_update.add(stop_sequence=4).arrival.time = (
            1781958120 if scenario == "next" else 1781957340
        )
        expected = (120, "站4", 4) if scenario == "next" else (-11 * 60, "站4", 4)
    elif scenario in ("rollover", "spring"):
        update.trip.start_date = "20260620" if scenario == "rollover" else "20260308"
        clock = "25:30:00" if scenario == "rollover" else "03:30:00"
        schedule[0] = ("行程", 3, clock, clock, "站")
        observed = (
            "2026-06-21T05:33:00+00:00" if scenario == "rollover" else "2026-03-08T07:33:00+00:00"
        )
        stop.arrival.time = int(datetime.fromisoformat(observed).timestamp())
        expected = (3 * 60, "站", 3)  # Scheduled UTC 05:30 (25:30) or 07:30 (spring 03:30).
    return message, schedule, expected


@pytest.mark.parametrize(
    "scenario",
    [
        "dwell_departure",
        "dwell_arrival",
        "cancelled",
        "skipped",
        "unique_id",
        "repeated_id",
        "wrong_sequence",
        "no_schedule",
        "unmatched_event",
        "alternate_pair",
        "next",
        "past",
        "rollover",
        "spring",
    ],
)
def test_trip_delay_uses_eligible_matching_events(tmp_path, scenario):
    from transit_ops.live.facts import read_trip_facts

    message, schedule, expected = trip_delay_case(scenario)
    with closing(
        LocalFile.open(tmp_path / "events.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        local.connection.execute("DELETE FROM edition_stop_times")
        local.connection.executemany(
            "INSERT INTO edition_stop_times VALUES (?, ?, ?, ?, ?)", schedule
        )
        parsed = _parse(message)
        if scenario in ("rollover", "spring"):
            from datetime import timedelta

            observed = message.entity[0].trip_update.stop_time_update[0].arrival.time
            feed = datetime.fromtimestamp(observed, UTC) - timedelta(seconds=180)
            parsed = parse_capture(
                message.SerializeToString(),
                replace(parsed.capture, feed_timestamp_utc=feed),
                ParsePolicy(None, 100),
            )
        apply_capture(local, parsed, provider_timezone="America/Toronto")
        facts = read_trip_facts(local)
        from zoneinfo import ZoneInfo

        from test_live_facts_real_db import raw_trip_rows

        raw_schedule = {(r[0], r[1]): r[2:] for r in schedule}
        assert facts.rows == raw_trip_rows(
            message.SerializeToString(), parsed.capture, raw_schedule
        )
        row = dict(zip(facts.columns, facts.rows[0], strict=True))
        assert (
            row["snapshot_local_date"]
            == parsed.capture.feed_timestamp_utc.astimezone(ZoneInfo("America/Toronto")).date()
        )
        assert (
            tuple(row[n] for n in ("delay_seconds", "delay_stop_id", "delay_stop_sequence"))
            == expected
        )
        assert row["stop_time_update_count"] == len(message.entity[0].trip_update.stop_time_update)
        assert row["skipped_stop_count"] == (1 if scenario == "skipped" else 0)


@pytest.mark.parametrize(
    "captures, expected",
    [
        ([(43, -600)], "43-0"),
        ([(43, 600)], "43-0"),
        ([(43, -600.000001)], None),
        ([(43, 600.000001)], None),
        ([(43, -600), (44, 600)], "44-0"),  # Higher capture, then entity 0.
        ([(44, -600), (43, 600)], "44-0"),  # Independent of application order.
        ([(43, -1), (44, 600)], "43-0"),  # Distance precedes capture id.
    ],
)
def test_trip_vehicle_match_has_inclusive_window_and_total_ties(tmp_path, captures, expected):
    from datetime import timedelta

    from transit_ops.live.facts import read_trip_facts

    with closing(
        LocalFile.open(tmp_path / "match.db", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_fact_edition(local)
        for identity, offset in captures:
            message = vehicle_message()
            for index, entity in enumerate(message.entity[:3]):
                entity.vehicle.vehicle.id = f"{identity}-{index}"
            payload = message.SerializeToString()
            parsed = parsed_vehicle(message)
            ref = replace(
                parsed.capture,
                capture_row_id=identity,
                feed_timestamp_utc=AT + timedelta(seconds=offset),
            )
            apply_capture(
                local,
                parse_capture(payload, ref, ParsePolicy(None, 100)),
                provider_timezone="America/Toronto",
            )
        apply_capture(local, _parse(trip_message()), provider_timezone="America/Toronto")
        facts = read_trip_facts(local)
        row = dict(zip(facts.columns, facts.rows[0], strict=True))
        assert row["vehicle_id"] == expected
        assert row["occupancy_status"] == (2 if expected else None)
