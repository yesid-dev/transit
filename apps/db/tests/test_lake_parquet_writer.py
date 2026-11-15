import hashlib
import json
import struct
from decimal import Decimal

import duckdb
import pytest

from transit_ops.lake.csv_validation import InvalidCsvValue
from transit_ops.lake.parquet_codec import (
    CsvHeaderMismatch,
    ParquetCodec,
    RequiredValueMissing,
    connect,
    read_canonical_csv,
    write_window,
)
from transit_ops.lake.table_schema import TableSchema


def write(tmp_path, data=b'id,value\n1,\n2,""\n', types=("integer", "text"), **kwargs):
    source = tmp_path / "input.csv"
    source.write_bytes(data)
    schema = TableSchema.from_columns([("id", types[0], True), ("value", types[1], False)], ["id"])
    return write_window(source, schema, tmp_path / "out.parquet", temp_dir=tmp_path, **kwargs)


def rows(window):
    with duckdb.connect() as connection:
        return connection.read_parquet(str(window.path), hive_partitioning=False).fetchall()


def test_written_file_has_the_schema_names_and_types(tmp_path):
    window = write(tmp_path, metadata={})
    with duckdb.connect() as connection:
        description = connection.execute(
            "DESCRIBE SELECT * FROM read_parquet(?)", [str(window.path)]
        ).fetchall()
    assert [row[:2] for row in description] == [("id", "INTEGER"), ("value", "VARCHAR")]


def test_codec_connection_has_an_explicit_memory_budget(tmp_path):
    with connect(tmp_path) as connection:
        assert (
            connection.execute("SELECT current_setting('memory_limit')").fetchone()[0]
            == "256.0 MiB"
        )


def test_codec_refuses_a_row_group_larger_than_the_legacy_bound(tmp_path):
    with pytest.raises(ValueError, match="row_group_rows"):
        write(tmp_path, metadata={}, codec=ParquetCodec(row_group_rows=245_760))


def test_null_and_empty_string_stay_distinct(tmp_path):
    assert rows(write(tmp_path, metadata={})) == [(1, None), (2, "")]


def test_rows_keep_the_csv_order(tmp_path):
    window = write(tmp_path, b"id,value\nb,x\na,y\nB,z\n", ("text", "text"), metadata={})
    assert rows(window) == [("b", "x"), ("a", "y"), ("B", "z")]


def test_timestamptz_keeps_microseconds_and_offset(tmp_path):
    window = write(
        tmp_path,
        b"id,value\n1,2026-11-01 04:32:15.118375+00\n2,2026-11-01 00:02:15.000001-04\n",
        ("integer", "timestamp with time zone"),
        metadata={},
    )
    with duckdb.connect() as connection:
        actual = connection.execute(
            "SELECT epoch_us(value) FROM read_parquet(?)", [str(window.path)]
        ).fetchall()
    assert actual == [(1793507535118375,), (1793505735000001,)]


@pytest.mark.parametrize(
    "literal,expected",
    [("0.1", 0.1), ("-0", -0.0), ("1.7976931348623157e+308", 1.7976931348623157e308)],
)
def test_doubles_keep_their_bits(tmp_path, literal, expected):
    window = write(
        tmp_path, f"id,value\n1,{literal}\n".encode(), ("integer", "double precision"), metadata={}
    )
    assert struct.pack(">d", rows(window)[0][1]) == struct.pack(">d", expected)


@pytest.mark.parametrize(
    "pg_type,literal,expected",
    [
        ("numeric(12,2)", "1.50", Decimal("1.50")),
        ("numeric", "1.50", "1.50"),
        ("smallint[]", '"{1,NULL,3}"', "{1,NULL,3}"),
        ("jsonb", '"{""a"": 1}"', '{"a": 1}'),
    ],
)
def test_decimals_and_postgres_text_are_exact(tmp_path, pg_type, literal, expected):
    window = write(tmp_path, f"id,value\n1,{literal}\n".encode(), ("integer", pg_type), metadata={})
    assert rows(window) == [(1, expected)]


@pytest.mark.parametrize("data", [b"value,id\nx,1\n", b"id\n1\n", b"id,value\r\n1,x\r\n"])
def test_header_mismatch_is_refused(tmp_path, data):
    with pytest.raises(CsvHeaderMismatch):
        write(tmp_path, data, metadata={})
    assert not (tmp_path / "out.parquet").exists()


def test_null_in_required_column_is_refused_and_no_file_is_left(tmp_path):
    with pytest.raises(RequiredValueMissing, match="id"):
        write(tmp_path, b"id,value\n,x\n", metadata={})
    assert not (tmp_path / "out.parquet").exists()


def test_content_digest_is_the_sha256_of_the_csv_bytes(tmp_path):
    data = b"id,value\n1,hello\n"
    window = write(tmp_path, data, metadata={})
    assert (window.content_sha256, window.content_bytes) == (
        hashlib.sha256(data).hexdigest(),
        len(data),
    )
    assert (window.sha256, window.byte_size, window.rows) == (
        hashlib.sha256(window.path.read_bytes()).hexdigest(),
        window.path.stat().st_size,
        1,
    )


def test_same_input_gives_the_same_parquet_bytes(tmp_path):
    first = write(tmp_path, metadata={"z": "last", "a": "first"})
    second = write_window(
        tmp_path / "input.csv",
        first.schema,
        tmp_path / "other.parquet",
        temp_dir=tmp_path,
        metadata={"a": "first", "z": "last"},
    )
    assert first.path.read_bytes() == second.path.read_bytes()


def _write_pre_budget_codec(source, schema, destination):
    # Frozen scan/COPY settings from ad870eb63b079155fed87f267ac14d38d450176a.
    # Do not use current codec/reader helpers: this is the pre-change byte oracle.
    options = (
        "auto_detect=false, header=true, delim=',', quote='\"', escape='\"', nullstr='', "
        "allow_quoted_nulls=false, strict_mode=true, ignore_errors=false, hive_partitioning=false, "
        f"max_line_size={1664 * (2 * 1024**3 + 3)}"
    )
    content = hashlib.sha256(source.read_bytes()).hexdigest()
    with duckdb.connect(
        config={
            "threads": 1,
            "preserve_insertion_order": True,
            "autoinstall_known_extensions": False,
            "autoload_known_extensions": False,
            "temp_directory": str(destination.parent),
        }
    ) as connection:
        connection.execute("SET TimeZone='UTC'")
        relation = connection.sql(
            f"SELECT * FROM read_csv(?, columns=?, {options})",
            params=[str(source), schema.duckdb_types()],
        )
        count = relation.aggregate("count(*)").fetchall()[0][0]
        metadata = {
            "transit.schema": schema.to_json().decode(),
            "transit.content_sha256": content,
            "transit.rows": str(count),
            "transit.codec": '{"compression":"zstd","level":9,"row_group_rows":122880}',
        }
        relation.create_view("window_rows")
        connection.execute(
            "COPY (SELECT * FROM window_rows) TO ? (FORMAT parquet, "
            "COMPRESSION zstd, COMPRESSION_LEVEL ?, ROW_GROUP_SIZE ?, KV_METADATA ?)",
            [str(destination), 9, 122_880, dict(sorted(metadata.items()))],
        )


def test_codec_preserves_pre_change_bytes_across_buffer_and_row_group_boundaries(tmp_path):
    source = tmp_path / "input.csv"
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(160_000):
            stream.write(f"{i},{hashlib.sha256(str(i).encode()).hexdigest() * 2}\n")
    assert source.stat().st_size > 8 * 1024**2  # exceeds the new reader's default buffer
    schema = TableSchema.from_columns([("id", "integer", True), ("payload", "text", False)], ["id"])
    legacy = tmp_path / "legacy.parquet"
    _write_pre_budget_codec(source, schema, legacy)
    # Independently measured using the actual pre-change writer on pinned DuckDB.
    legacy_sha = hashlib.sha256(legacy.read_bytes()).hexdigest()
    assert legacy_sha == "e7cc9cdaecd3e85e170e95a97f56ccaadcbea61364639bd17384df9927d59277"
    written = write_window(source, schema, tmp_path / "new.parquet", metadata={}, temp_dir=tmp_path)
    assert written.rows == 160_000
    assert (
        written.content_sha256 == "84ceb9264224a879a2388dcd1e0c3ec768c191eac4fcc9dcf40bb4b5abaa64e2"
    )
    assert written.sha256 == legacy_sha
    assert written.path.read_bytes() == legacy.read_bytes()
    with connect(tmp_path) as connection:
        for path in (legacy, written.path):
            assert connection.execute(
                "SELECT row_group_num_rows FROM parquet_metadata(?) "
                "WHERE column_id=0 ORDER BY row_group_id",
                [str(path)],
            ).fetchall() == [(122_880,), (37_120,)]


def test_key_value_metadata_records_schema_digest_and_codec(tmp_path):
    window = write(tmp_path, metadata={"owner": "a'b"})
    with duckdb.connect() as connection:
        metadata = dict(
            connection.execute(
                "SELECT key, value FROM parquet_kv_metadata(?)", [str(window.path)]
            ).fetchall()
        )
    assert metadata[b"owner"] == b"a'b"
    assert metadata[b"transit.schema"] == window.schema.to_json()
    assert metadata[b"transit.content_sha256"].decode() == window.content_sha256
    assert metadata[b"transit.rows"] == b"2"
    codec = {"compression": "zstd", "level": 9, "row_group_rows": 122880}
    assert json.loads(metadata[b"transit.codec"]) == codec
    assert window.details() == {
        "codec": "parquet",
        "codec_params": codec,
        "writer": "duckdb",
        "writer_version": duckdb.__version__,
        "schema_sha256": window.schema.columns_sha256(),
        "content_digest": "canonical_csv_sha256",
    }


def test_caller_metadata_cannot_use_the_transit_prefix(tmp_path):
    with pytest.raises(ValueError, match="transit"):
        write(tmp_path, metadata={"transit.rows": "99"})
    assert not (tmp_path / "out.parquet").exists()


def test_existing_output_path_is_refused(tmp_path):
    target = tmp_path / "out.parquet"
    target.write_bytes(b"keep")
    with pytest.raises(FileExistsError):
        write(tmp_path, metadata={})
    assert target.read_bytes() == b"keep"


def test_public_csv_reader_preserves_absence(tmp_path):
    window = write(tmp_path, metadata={})
    with connect(tmp_path) as connection:
        assert read_canonical_csv(connection, tmp_path / "input.csv", window.schema).fetchall() == [
            (1, None),
            (2, ""),
        ]


def test_header_only_window_retains_schema_and_zero_rows(tmp_path):
    window = write(tmp_path, b"id,value\n", metadata={})
    assert window.rows == 0
    assert rows(window) == []


@pytest.mark.parametrize("data", [b"id,value\nwrong,x\n", b"id,value\n1,x,extra\n"])
def test_invalid_csv_is_refused_without_leaving_output(tmp_path, data):
    with pytest.raises(InvalidCsvValue):
        write(tmp_path, data, metadata={})
    assert not (tmp_path / "out.parquet").exists()


def test_connection_pins_utc_and_disables_extension_loading(tmp_path):
    with connect(tmp_path) as connection:
        actual = connection.execute(
            "SELECT current_setting('TimeZone'), current_setting('threads'), "
            "current_setting('preserve_insertion_order'), "
            "current_setting('autoinstall_known_extensions'), "
            "current_setting('autoload_known_extensions')"
        ).fetchone()
    assert actual == ("UTC", 1, True, False, False)


@pytest.mark.parametrize("side", ["input", "output"])
@pytest.mark.parametrize("character", list("*?[]{}"))
def test_review_glob_paths_are_refused_by_name(tmp_path, side, character):
    window = write(tmp_path, metadata={})
    source = tmp_path / (f"input{character}1.csv" if side == "input" else "input.csv")
    target = tmp_path / ("other.parquet" if side == "input" else f"out{character}1.parquet")
    with pytest.raises(ValueError) as error:
        write_window(source, window.schema, target, metadata={}, temp_dir=tmp_path)
    assert str(source if side == "input" else target) in str(error.value)


@pytest.mark.parametrize("directory", ["value=wrong", "id=999", "batch=2026", "plain"])
def test_review_hive_and_unrelated_sibling_are_preserved(tmp_path, directory):
    folder = tmp_path / directory
    folder.mkdir()
    sibling = folder / "tmp_out.parquet"
    sibling.write_bytes(b"keep")
    assert rows(write(folder, metadata={})) == [(1, None), (2, "")]
    assert sibling.read_bytes() == b"keep"
