import hashlib
import io
from contextlib import contextmanager
from dataclasses import replace

import duckdb
import pytest

from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.parquet_verify import CopyDiffers, Expected, check_window_files, read_back
from transit_ops.lake.table_schema import TableSchema


def test_returns_a_proof_for_an_equal_window(tmp_path):
    from transit_ops.lake.parquet_verify import prove_window

    csv, written, expected = window(tmp_path)
    proof = prove_window(csv, written.path, written.schema, expect=expected, temp_dir=tmp_path)
    assert proof.rows == 2
    assert proof.content_sha256 == hashlib.sha256(csv.read_bytes()).hexdigest()
    assert proof.object_sha256 == hashlib.sha256(written.path.read_bytes()).hexdigest()
    assert proof.object_bytes == written.path.stat().st_size
    assert proof.schema_sha256 == written.schema.columns_sha256()
    assert proof.missing_from_copy == 0
    assert proof.extra_in_copy == 0
    assert proof.in_key_order is True
    assert proof.checked_with == duckdb.__version__


def window(tmp_path, data=b'id,value\n1,\n2,""\n', pg_type="text", names=("id", "value")):
    csv = tmp_path / "input.csv"
    csv.write_bytes(data)
    schema = TableSchema.from_columns(
        [(names[0], "integer", True), (names[1], pg_type, False)], [names[0]]
    )
    written = write_window(csv, schema, tmp_path / "out.parquet", metadata={}, temp_dir=tmp_path)
    return csv, written, Expected(hashlib.sha256(data).hexdigest(), written.rows, None)


def test_checks_an_equal_window(tmp_path):
    csv, written, expected = window(tmp_path)
    checks = check_window_files(
        csv, written.path, written.schema, expect=expected, temp_dir=tmp_path
    )
    assert checks.rows == 2
    assert checks.content_sha256 == hashlib.sha256(csv.read_bytes()).hexdigest()
    assert checks.object_sha256 == hashlib.sha256(written.path.read_bytes()).hexdigest()
    assert checks.object_bytes == written.path.stat().st_size
    assert checks.schema_sha256 == written.schema.columns_sha256()
    assert checks.checked_with == duckdb.__version__


def changed_file(tmp_path, written, query="SELECT * FROM original", changes=None):
    target = tmp_path / "changed.parquet"
    with duckdb.connect() as connection:
        metadata = {
            key.decode(): value.decode()
            for key, value in connection.execute(
                "SELECT key, value FROM parquet_kv_metadata(?)", [str(written.path)]
            ).fetchall()
        }
        for key, value in (changes or {}).items():
            if value is None:
                metadata.pop(key)
            else:
                metadata[key] = value
        connection.read_parquet(str(written.path), hive_partitioning=False).create_view("original")
        connection.execute(
            f"COPY ({query}) TO ? (FORMAT parquet, KV_METADATA ?)", [str(target), metadata]
        )
    return target


@pytest.mark.parametrize("side", ["content", "object"])
def test_refuses_incorrect_digests_in_order(tmp_path, side):
    csv, written, expected = window(tmp_path)
    expected = replace(expected, object_sha256="0" * 64)
    if side == "content":
        csv.write_bytes(b"different")
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, written.path, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == f"{side}_digest"


@pytest.mark.parametrize("key", ["transit.schema", "transit.content_sha256", "transit.rows"])
@pytest.mark.parametrize("value", [None, "wrong"])
def test_refuses_missing_or_changed_metadata(tmp_path, key, value):
    csv, written, expected = window(tmp_path)
    target = changed_file(tmp_path, written, changes={key: value})
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "metadata"
    assert key in error.value.detail


@pytest.mark.parametrize(
    "query",
    [
        "SELECT id::BIGINT AS id, value FROM original",
        "SELECT value, id FROM original",
        "SELECT id AS other, value FROM original",
        "SELECT id FROM original",
        "SELECT *, 1 AS extra FROM original",
    ],
)
def test_refuses_changed_types_names_and_order(tmp_path, query):
    csv, written, expected = window(tmp_path)
    target = changed_file(tmp_path, written, query)
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "types"


@pytest.mark.parametrize("side", ["CSV", "Parquet"])
def test_checks_both_row_counts(tmp_path, side):
    csv, written, expected = window(tmp_path)
    if side == "CSV":
        csv.write_bytes(b"id,value\n1,x\n")
        expected = replace(expected, content_sha256=hashlib.sha256(csv.read_bytes()).hexdigest())
        target = changed_file(
            tmp_path,
            written,
            changes={
                "transit.content_sha256": expected.content_sha256,
            },
        )
    else:
        target = changed_file(tmp_path, written, "SELECT * FROM original WHERE id=1")
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "rows"
    assert error.value.detail == f"{side} has 1 rows; expected 2"


@pytest.mark.parametrize(
    "pg_type,value",
    [
        ("timestamp with time zone", "2026-11-01 00:00:00+00"),
        ("numeric(12,2)", "1.50"),
        ("numeric", "1.50"),
        ("uuid", "00000000-0000-0000-0000-000000000001"),
    ],
)
def test_accepts_the_declared_types_including_aliases(tmp_path, pg_type, value):
    csv, written, expected = window(tmp_path, f"id,value\n1,{value}\n".encode(), pg_type)
    expected = replace(expected, object_sha256=written.sha256)
    checks = check_window_files(
        csv, written.path, written.schema, expect=expected, temp_dir=tmp_path
    )
    assert checks.rows == 1


def test_accepts_an_empty_window_in_a_hive_named_directory(tmp_path, monkeypatch):
    folder = tmp_path / "id=999"
    folder.mkdir()
    csv, written, expected = window(folder, b"id,value\n")
    original = duckdb.DuckDBPyConnection.read_parquet

    def hive_default(connection, *args, hive_partitioning=True, **kwargs):
        assert hive_partitioning is False  # Guard omission despite the pinned reader's default.
        return original(connection, *args, hive_partitioning=hive_partitioning, **kwargs)

    monkeypatch.setattr(duckdb.DuckDBPyConnection, "read_parquet", hive_default)
    assert (
        check_window_files(csv, written.path, written.schema, expect=expected, temp_dir=folder).rows
        == 0
    )


@pytest.mark.parametrize("side", ["csv", "parquet", "temp"])
@pytest.mark.parametrize("character", list("*?[]{}"))
def test_refuses_globs_by_name(tmp_path, side, character):
    csv, written, expected = window(tmp_path)
    paths = {"csv": csv, "parquet": written.path, "temp": tmp_path}
    paths[side] = tmp_path / f"bad{character}path"
    with pytest.raises(ValueError, match="Glob") as error:
        check_window_files(
            paths["csv"], paths["parquet"], written.schema, expect=expected, temp_dir=paths["temp"]
        )
    assert str(paths[side]) in str(error.value)


class StreamingStorage(BronzeStorage):
    @contextmanager
    def open_stream(self, key, **kwargs):
        assert key == "object"

        class Stream(io.BytesIO):
            def read(self, size=-1):
                assert 0 < size <= 64 * 1024
                assert not destination.exists()
                chunk = super().read(size)
                if failure and self.tell() > 64 * 1024:
                    raise OSError("interrupted")
                return chunk

        destination, failure = self.destination, self.failure
        with Stream(b"abc" * 50_000) as stream:
            yield stream


@pytest.mark.parametrize("failure", [False, True])
def test_read_back_streams_and_leaves_no_partial_final_file(tmp_path, failure):
    destination = tmp_path / "download.parquet"
    storage = StreamingStorage("test")
    object.__setattr__(storage, "destination", destination)
    object.__setattr__(storage, "failure", failure)
    if failure:
        with pytest.raises(OSError, match="interrupted"):
            read_back(storage, "object", destination)
        assert not destination.exists()
    else:
        assert read_back(storage, "object", destination) == (
            hashlib.sha256(b"abc" * 50_000).hexdigest(),
            150_000,
        )
        assert destination.read_bytes() == b"abc" * 50_000
        with pytest.raises(FileExistsError):
            read_back(storage, "object", destination)
        assert destination.read_bytes() == b"abc" * 50_000
    assert set(tmp_path.iterdir()) == ({destination} if not failure else set())


def test_refuses_physical_duplicate_names(tmp_path):
    csv, written, expected = window(tmp_path, b"id,id_1\n1,x\n", names=("id", "id_1"))
    target = changed_file(tmp_path, written, "SELECT id, id_1 AS zz FROM original")
    target.write_bytes(target.read_bytes().replace(b"zz", b"id"))
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "types"


@pytest.mark.parametrize("payload", [b"", b"not parquet", None])
def test_unreadable_metadata_is_a_named_failure(tmp_path, payload):
    csv, written, expected = window(tmp_path)
    written.path.write_bytes(payload if payload is not None else written.path.read_bytes()[:-10])
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, written.path, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "metadata"
    assert isinstance(error.value.__cause__, duckdb.InvalidInputException)
    assert len(error.value.detail) < 100


def test_refuses_millisecond_timestamp_storage(tmp_path):
    csv, written, expected = window(
        tmp_path, b"id,value\n1,2026-11-01 00:00:00.123456\n", "timestamp without time zone"
    )
    target = changed_file(
        tmp_path, written, "SELECT id, value::TIMESTAMP_MS AS value FROM original"
    )
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "types"


def test_refuses_a_csv_header_that_differs_from_the_schema(tmp_path):
    csv, written, expected = window(tmp_path)
    csv.write_bytes(b"value,id\n1,x\n2,y\n")
    expected = replace(expected, content_sha256=hashlib.sha256(csv.read_bytes()).hexdigest())
    target = changed_file(
        tmp_path, written, changes={"transit.content_sha256": expected.content_sha256}
    )
    with pytest.raises(CopyDiffers) as error:
        check_window_files(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "schema"


@pytest.mark.parametrize(
    "query,reason,key",
    [
        ("SELECT * FROM original WHERE id=1", "rows", None),
        ("SELECT * FROM original UNION ALL SELECT 3, 'x'", "rows", None),
        ("SELECT 3 AS id, value FROM original", "missing_rows", "1"),
        (
            "SELECT * FROM original WHERE id=1 UNION ALL SELECT * FROM original WHERE id=1",
            "missing_rows",
            "2",
        ),
    ],
)
def test_refuses_missing_extra_and_duplicated_rows(tmp_path, query, reason, key):
    from transit_ops.lake.parquet_verify import prove_window

    csv, written, expected = window(tmp_path)
    target = changed_file(tmp_path, written, query)
    with pytest.raises(CopyDiffers) as error:
        prove_window(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == reason
    if key is not None:
        assert key in error.value.detail
        assert "rows; first key" in error.value.detail


@pytest.mark.parametrize(
    "pg_type,value,replacement",
    [
        ("text", "", "''"),
        ("double precision", "0.1", "0.1000000000000001::DOUBLE"),
        (
            "timestamp without time zone",
            "2026-11-01 00:00:00.123456",
            "TIMESTAMP '2026-11-01 00:00:00.123457'",
        ),
        ("numeric", "1.50", "'1.5'"),
    ],
)
def test_refuses_a_changed_value(tmp_path, pg_type, value, replacement):
    from transit_ops.lake.parquet_verify import prove_window

    csv, written, expected = window(tmp_path, f"id,value\n1,{value}\n".encode(), pg_type)
    target = changed_file(tmp_path, written, f"SELECT id, {replacement} AS value FROM original")
    with pytest.raises(CopyDiffers) as error:
        prove_window(csv, target, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "missing_rows"
    assert error.value.detail == "1 rows; first key (1,)"


@pytest.mark.parametrize("data", [b"id,value\n1,x\n1,x\n", b"id,value\n2,x\n1,y\n"])
def test_refuses_rows_out_of_key_order(tmp_path, data):
    from transit_ops.lake.parquet_verify import prove_window

    csv, written, expected = window(tmp_path, data)
    with pytest.raises(CopyDiffers) as error:
        prove_window(csv, written.path, written.schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "key_order"
    assert error.value.detail == "Non-increasing primary key at file row 1 (zero-based)"


def test_key_order_is_bytewise_and_uses_the_whole_quoted_key(tmp_path):
    from transit_ops.lake.parquet_verify import prove_window

    csv = tmp_path / "input.csv"
    csv.write_bytes(b'key"name,part,value\nB,1,x\nB,2,y\na,1,z\n')
    schema = TableSchema.from_columns(
        [('key"name', "text", True), ("part", "integer", True), ("value", "text", False)],
        ['key"name', "part"],
    )
    written = write_window(csv, schema, tmp_path / "out.parquet", metadata={}, temp_dir=tmp_path)
    expected = Expected(hashlib.sha256(csv.read_bytes()).hexdigest(), 3, None)
    assert prove_window(csv, written.path, schema, expect=expected, temp_dir=tmp_path).in_key_order
    target = changed_file(
        tmp_path, written, 'SELECT * FROM original ORDER BY "key""name" DESC, part'
    )
    with pytest.raises(CopyDiffers) as error:
        prove_window(csv, target, schema, expect=expected, temp_dir=tmp_path)
    assert error.value.reason == "key_order"


def test_proof_json_is_canonical_and_stable():
    from transit_ops.lake.parquet_verify import WindowProof

    proof = WindowProof(2, "c", "o", 10, "s", 0, 0, True, "é")
    expected = (
        b'{"checked_with":"\xc3\xa9","content_sha256":"c","extra_in_copy":0,'
        b'"in_key_order":true,"missing_from_copy":0,"object_bytes":10,'
        b'"object_sha256":"o","rows":2,"schema_sha256":"s"}'
    )
    assert proof.to_json() == expected
    assert proof.to_json() == expected


@pytest.mark.parametrize("side", ["csv", "parquet"])
def test_refuses_bytes_changed_after_row_and_order_checks(tmp_path, monkeypatch, side):
    from transit_ops.lake import parquet_verify

    csv, written, expected = window(tmp_path)
    original_connect = parquet_verify.connect
    calls = 0

    @contextmanager
    def changing_connection(temp_dir):
        nonlocal calls
        calls += 1
        with original_connect(temp_dir) as connection:
            yield connection
        if calls == 2:
            path = csv if side == "csv" else written.path
            path.write_bytes(path.read_bytes() + b"changed")

    monkeypatch.setattr(parquet_verify, "connect", changing_connection)
    with pytest.raises(CopyDiffers) as error:
        parquet_verify.prove_window(
            csv, written.path, written.schema, expect=expected, temp_dir=tmp_path
        )
    assert error.value.reason == ("content_digest" if side == "csv" else "object_digest")


def test_proves_an_empty_window(tmp_path):
    from transit_ops.lake.parquet_verify import prove_window

    csv, written, expected = window(tmp_path, b"id,value\n")
    proof = prove_window(csv, written.path, written.schema, expect=expected, temp_dir=tmp_path)
    assert proof.rows == 0
    assert proof.in_key_order is True
