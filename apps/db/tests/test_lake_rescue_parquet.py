import gzip
import hashlib
import json
from datetime import date

import duckdb
import pytest
from typer.testing import CliRunner

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.lake.rescue_parquet import RescueNotConvertible, convert_rescued_day

DAY = date(2026, 11, 13)
COMMIT = "a" * 40
TABLES = ("fact_trip_delay_snapshot", "fact_vehicle_snapshot")
PREFIX = "rescue/v1/facts/test/2026-11-13/"
TARGET = "rescue/v1/parquet/test/2026-11-13/"
COMMON = "provider_id:t realtime_snapshot_id:b entity_index:i snapshot_date_key:i "
COMMON += "snapshot_local_date:d feed_timestamp_utc:z captured_at_utc:z "
TAILS = (
    "entity_id:t trip_id:t route_id:t direction_id:i start_date:d vehicle_id:t "
    "trip_schedule_relationship:i delay_seconds:i stop_time_update_count:i! "
    "delay_stop_id:t delay_stop_sequence:i skipped_stop_count:i! occupancy_status:i",
    "position_timestamp_utc:z entity_id:t vehicle_id:t trip_id:t route_id:t stop_id:t "
    "current_stop_sequence:i current_status:i occupancy_status:i latitude:f longitude:f "
    "bearing:f speed:f",
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def rescue(tmp_path):
    root = tmp_path / "objects"
    root.mkdir()
    storage = LocalBronzeStorage(storage_backend="local", root=root)
    receipt = dict(
        format_version=1,
        provider="test",
        day=DAY.isoformat(),
        status="closed_emergency_snapshot",
        tables={},
    )
    types = dict(
        t="text",
        b="bigint",
        i="integer",
        d="date",
        z="timestamp with time zone",
        f="double precision",
    )
    for table, tail in zip(TABLES, TAILS, strict=True):
        columns = [token.split(":") for token in (COMMON + tail).split()]
        schema = [
            [name, types[kind.rstrip("!")], i < 7 or kind.endswith("!")]
            for i, (name, kind) in enumerate(columns)
        ]
        header = ",".join(name for name, _ in columns) + "\n"
        common = "test,1,0,20261113,2026-11-13,2026-11-13 00:00:00+00,2026-11-13 00:00:00+00,"
        payload = (
            ',"",,,,,,,0,,,0,\n'
            if table == TABLES[0]
            else ",".join(["", "", '""', "", "", "", "", "", "", "45", "-73", "0", "0"]) + "\n"
        )
        csv = (header + common + payload).encode()
        zipped = gzip.compress(csv, compresslevel=9, mtime=0)
        key = PREFIX + table + ".csv.gz"
        path = root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(zipped)
        receipt["tables"][table] = dict(
            schema=schema,
            schema_sha256=sha(json.dumps(schema, sort_keys=True, separators=(",", ":")).encode()),
            rows=1,
            csv_sha256=sha(csv),
            csv_bytes=len(csv),
            object_sha256=sha(zipped),
            object_bytes=len(zipped),
            key=key,
        )
    save_receipt(storage, receipt)
    return storage, receipt


def save_receipt(storage, receipt):
    (storage.root / (PREFIX + "receipt.json")).write_text(json.dumps(receipt), encoding="utf-8")


def convert(storage, tmp_path, **kwargs):
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    return convert_rescued_day(
        storage, provider_id="test", utc_day=DAY, work_dir=work, converted_by=COMMIT, **kwargs
    )


def test_converts_and_reruns_without_database(rescue, tmp_path, monkeypatch):
    import psycopg
    import sqlalchemy

    def refuse(*args, **kwargs):
        pytest.fail("database connection attempted")

    monkeypatch.setattr(sqlalchemy, "create_engine", refuse)
    monkeypatch.setattr(psycopg, "connect", refuse)
    storage, source = rescue
    result = convert(storage, tmp_path)
    assert result.receipt_outcome == "created"
    receipt = json.loads(storage.read_bytes(TARGET + "receipt.json"))
    for table in TABLES:
        record = receipt["tables"][table]
        assert record["content_sha256"] == source["tables"][table]["csv_sha256"]
        assert record["object_sha256"] == sha(storage.read_bytes(record["key"]))
        assert record["proof"]["verified"] is True
        with duckdb.connect() as connection:
            row = connection.execute(
                "SELECT entity_id, trip_id FROM read_parquet(?, hive_partitioning=false)",
                [str(storage.root / record["key"])],
            ).fetchone()
        assert row == (None, "") if table == TABLES[0] else row == (None, None)
    before = {key: sha(storage.read_bytes(key)) for key in storage.list_keys(TARGET)}
    result = convert(storage, tmp_path)
    assert result.receipt_outcome == "already_equal"
    assert all(t.outcome == "already_equal" for t in result.tables)
    assert before == {key: sha(storage.read_bytes(key)) for key in storage.list_keys(TARGET)}
    assert list((tmp_path / "work").iterdir()) == []


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        ("format_version", 2, "unknown_format"),
        ("status", "partial_asof", "not_closed"),
        ("provider", "other", "identity"),
        ("day", "2026-11-12", "identity"),
        ("tables", {}, "unexpected_tables"),
    ],
)
def test_refuses_receipt(rescue, tmp_path, field, value, reason):
    storage, receipt = rescue
    receipt[field] = value
    save_receipt(storage, receipt)
    with pytest.raises(RescueNotConvertible) as error:
        convert(storage, tmp_path)
    assert error.value.reason == reason
    assert list(storage.list_keys(TARGET)) == []


@pytest.mark.parametrize(
    "reason",
    [
        "schema_digest",
        "object_digest",
        "content_digest",
        "record_mismatch",
        "unexpected_tables",
        "receipt_missing",
    ],
)
def test_refuses_untrusted_inputs_before_upload(rescue, tmp_path, reason):
    storage, receipt = rescue
    table = receipt["tables"][TABLES[1]]
    options = {}
    if reason == "record_mismatch":
        options["expected"] = {"test-2026-11-13": {"tables": {}}}
    elif reason == "receipt_missing":
        (storage.root / (PREFIX + "receipt.json")).unlink()
    else:
        field = dict(
            schema_digest="schema_sha256",
            object_digest="object_sha256",
            content_digest="csv_sha256",
            unexpected_tables="key",
        )[reason]
        table[field] = "0" * 64
        save_receipt(storage, receipt)
    with pytest.raises(RescueNotConvertible) as error:
        convert(storage, tmp_path, **options)
    assert error.value.reason == reason
    assert list(storage.list_keys(TARGET)) == []


def test_taken_key_is_preserved(rescue, tmp_path):
    from transit_ops.lake.objects import ObjectKeyTaken

    storage, _ = rescue
    path = storage.root / (TARGET + TABLES[0] + ".parquet")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"other")
    with pytest.raises(ObjectKeyTaken):
        convert(storage, tmp_path)
    assert path.read_bytes() == b"other"
    assert not storage.exists(TARGET + "receipt.json")


@pytest.mark.parametrize("broken", ["compressed", "content"])
def test_changed_source_bytes_are_refused(rescue, tmp_path, broken):
    storage, receipt = rescue
    record = receipt["tables"][TABLES[1]]
    path = storage.root / record["key"]
    changed = gzip.compress(gzip.decompress(path.read_bytes()).replace(b"45", b"46"), mtime=0)
    path.write_bytes(changed)
    if broken == "content":
        record["object_sha256"] = sha(changed)
        record["object_bytes"] = len(changed)
        save_receipt(storage, receipt)
    with pytest.raises(RescueNotConvertible) as error:
        convert(storage, tmp_path)
    assert error.value.reason == ("object_digest" if broken == "compressed" else "content_digest")
    assert list(storage.list_keys(TARGET)) == []


@pytest.mark.parametrize("argument", ["converted_by", "work_dir"])
def test_refuses_invalid_conversion_arguments(rescue, tmp_path, argument):
    storage, _ = rescue
    work = tmp_path / "work"
    work.mkdir()
    if argument == "work_dir":
        (work / "keep").write_bytes(b"keep")
    with pytest.raises(RescueNotConvertible, match=argument):
        convert_rescued_day(
            storage,
            provider_id="test",
            utc_day=DAY,
            work_dir=work,
            converted_by="bad" if argument == "converted_by" else COMMIT,
        )
    assert list(storage.list_keys(TARGET)) == []


def test_cli_real_conversion_and_bare_group(rescue, tmp_path, monkeypatch):
    from transit_ops.cli import app
    from transit_ops.settings import get_settings

    storage, receipt = rescue
    records = tmp_path / "records.json"
    records.write_text(json.dumps({"test-2026-11-13": receipt}), encoding="utf-8")
    work = tmp_path / "cli-work"
    work.mkdir()
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(storage.root))
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    get_settings.cache_clear()
    try:
        result = CliRunner().invoke(
            app,
            [
                "lake",
                "convert-rescue",
                "--provider",
                "test",
                "--date",
                DAY.isoformat(),
                "--converted-by",
                COMMIT,
                "--work-dir",
                str(work),
                "--expect-receipts",
                str(records),
            ],
        )
        assert result.exit_code == 0, result.output
        assert len(result.stdout.splitlines()) == 1
        assert json.loads(result.stdout)["receipt_outcome"] == "created"
        bare = CliRunner().invoke(app, ["lake"])
        assert bare.exit_code == 0
        assert "Usage:" in bare.output
    finally:
        get_settings.cache_clear()
