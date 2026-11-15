import gzip
import hashlib
import json
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import replace
from datetime import date
from io import BytesIO

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


def test_converts_and_reruns_with_verified_receipt(rescue, tmp_path):
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


def test_fresh_import_conversion_and_cli_open_no_database_connection(rescue, tmp_path):
    storage, _ = rescue
    script = """
import json, os, sys
from datetime import date
from pathlib import Path
import psycopg
import sqlalchemy
import sqlalchemy.engine

def refuse(*args, **kwargs):
    raise AssertionError("database connection attempted")

sqlalchemy.create_engine = sqlalchemy.engine.create_engine = refuse
psycopg.connect = refuse
from transit_ops.db import connection
connection.make_engine = connection.test_connection = refuse
assert "transit_ops.lake.rescue_parquet" not in sys.modules
from transit_ops.lake.rescue_parquet import convert_rescued_day
from transit_ops.ingestion.storage import LocalBronzeStorage

root, work = map(Path, sys.argv[1:])
work.mkdir()
result = convert_rescued_day(
    LocalBronzeStorage(storage_backend="local", root=root),
    provider_id="test", utc_day=date(2026, 11, 13), work_dir=work,
    converted_by="a" * 40,
)
assert result.receipt_outcome == "created"
os.environ["BRONZE_STORAGE_BACKEND"] = "local"
os.environ["BRONZE_LOCAL_ROOT"] = str(root)
from typer.testing import CliRunner
from transit_ops.cli import app
result = CliRunner().invoke(app, ["lake", "convert-rescue", "--provider", "test",
    "--date", "2026-11-13", "--converted-by", "a" * 40, "--work-dir", str(work)])
assert result.exit_code == 0, (result.output, result.exception)
assert json.loads(result.stdout)["receipt_outcome"] == "already_equal"
assert sqlalchemy.create_engine is sqlalchemy.engine.create_engine is refuse
assert psycopg.connect is connection.make_engine is connection.test_connection is refuse
"""
    result = subprocess.run(
        [sys.executable, "-I", "-c", script, str(storage.root), str(tmp_path / "fresh-work")],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


class InterruptedStorage:
    """Keep real local publication, injecting faults only at the storage seam."""

    def __init__(self, storage, failure=None):
        self.storage, self.failure = storage, failure
        self.events = []

    def __getattr__(self, name):
        return getattr(self.storage, name)

    def put_if_absent(self, path, key):
        self.events.append(("put", key))
        if self.failure == "receipt_put" and key == TARGET + "receipt.json":
            raise OSError("receipt upload interrupted")
        return self.storage.put_if_absent(path, key)

    @contextmanager
    def open_stream(self, key, **kwargs):
        if self.failure == "first_readback" and key == TARGET + TABLES[0] + ".parquet":
            raise OSError("readback interrupted")
        with self.storage.open_stream(key, **kwargs) as source:
            if self.failure == "second_truncated" and key == TARGET + TABLES[1] + ".parquet":
                with BytesIO(source.read()[:-1]) as truncated:
                    yield truncated
            else:
                yield source

    def delete_object(self, key):
        pytest.fail(f"unexpected deletion: {key}")

    def persist_temp_file(self, path, key):
        pytest.fail(f"unexpected unconditional publication: {key}")


def stored_objects(storage):
    return {key: storage.read_bytes(key) for key in storage.list_keys("")}


@pytest.mark.parametrize("failure", ["first_readback", "receipt_put", "second_truncated"])
def test_interrupted_conversion_retains_evidence_and_retries_safely(rescue, tmp_path, failure):
    from transit_ops.lake.parquet_verify import CopyDiffers

    storage, _ = rescue
    original = stored_objects(storage)
    boundary = InterruptedStorage(storage, failure)
    expected_error = CopyDiffers if failure == "second_truncated" else OSError
    with pytest.raises(expected_error):
        convert(boundary, tmp_path)
    before = stored_objects(storage)
    assert TARGET + "receipt.json" not in before
    assert all(before[key] == value for key, value in original.items())
    copied = {key for key in before if key.startswith(TARGET)}
    expected_tables = TABLES[:1] if failure == "first_readback" else TABLES
    assert copied == {TARGET + table + ".parquet" for table in expected_tables}
    evidence = {
        path: path.read_bytes() for path in (tmp_path / "work").rglob("*") if path.is_file()
    }
    assert any(path.suffix == ".csv" for path in evidence)
    assert any(path.suffix == ".parquet" for path in evidence)
    retry_dir = tmp_path / "retry"
    retry_dir.mkdir()
    result = convert(InterruptedStorage(storage), retry_dir)
    assert result.receipt_outcome == "created"
    assert all(
        table.outcome == ("already_equal" if table.key in copied else "created")
        for table in result.tables
    )
    after = stored_objects(storage)
    assert all(after[key] == value for key, value in before.items())
    assert all(path.read_bytes() == value for path, value in evidence.items())
    result = convert(InterruptedStorage(storage), retry_dir)
    assert result.receipt_outcome == "already_equal"
    assert all(table.outcome == "already_equal" for table in result.tables)
    assert stored_objects(storage) == after


def test_receipt_binds_downloaded_proofs_after_both_local_proofs(rescue, tmp_path, monkeypatch):
    from transit_ops.lake import rescue_parquet as conversion

    storage, _ = rescue
    boundary = InterruptedStorage(storage)
    prove = conversion.prove_window
    downloaded = {}

    def observe(csv, parquet, schema, **kwargs):
        proof = prove(csv, parquet, schema, **kwargs)
        assert proof.verified is True
        if parquet.suffix == ".readback":
            proof = replace(proof, checked_with="downloaded-bytes")
            downloaded[parquet.stem] = json.loads(proof.to_json())
        else:
            boundary.events.append(("local_proof", parquet.stem))
        return proof

    monkeypatch.setattr(conversion, "prove_window", observe)
    convert(boundary, tmp_path)
    first_put = next(i for i, event in enumerate(boundary.events) if event[0] == "put")
    assert boundary.events[:first_put] == [("local_proof", table) for table in TABLES]
    receipt = json.loads(storage.read_bytes(TARGET + "receipt.json"))
    assert set(downloaded) == set(TABLES)
    assert {table: record["proof"] for table, record in receipt["tables"].items()} == downloaded


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
