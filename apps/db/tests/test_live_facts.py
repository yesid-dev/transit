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


def test_providers_are_isolated_and_trip_updates_refuse(tmp_path):
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
            with pytest.raises(ValueError, match="only vehicle_positions"):
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
