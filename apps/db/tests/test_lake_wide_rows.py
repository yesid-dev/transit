"""Wide-row windows write within the codec memory budget; ordinary windows keep their bytes."""

import hashlib

import duckdb
import pytest

from transit_ops.lake import wide_rows
from transit_ops.lake.parquet_codec import ParquetCodec, write_window
from transit_ops.lake.parquet_verify import Expected, prove_window
from transit_ops.lake.table_schema import TableSchema

TEXT_SCHEMA = TableSchema.from_columns(
    [("id", "integer", True), ("payload", "text", False)], ["id"]
)

# Object digests written by the codec before wide-row handling existed (duckdb 2.0.0).
# Re-runs accept only identical bytes, so these must never move.
MIXED_FIXTURE_SHA256 = "c70ba298389c9d4d41ad47ac613c20ec05b0c4ec9cdc305803e1b0b748a43cc1"
NARROW_FIXTURE_SHA256 = "b3e4d046291046a8e147fe5ac27f5d4bb12d0fb00a93f9242f2880d83f1516ea"


def groups(path):
    with duckdb.connect() as connection:
        return connection.execute(
            "SELECT max(row_group_num_rows) FROM parquet_metadata(?) GROUP BY row_group_id "
            "ORDER BY row_group_id",
            [str(path)],
        ).fetchall()


def wide_csv(path, rows, width=576_000):
    with path.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(rows):
            stream.write(f"{i},{(hashlib.sha256(str(i).encode()).hexdigest() * 9000)[:width]}\n")
    return path


def test_rows_of_580_kb_write_within_the_real_codec_budget(tmp_path):
    # 160 rows: 92 MB of CSV, over the 256 MiB budget as one default-size group.
    source = wide_csv(tmp_path / "wide.csv", 160)
    written = write_window(
        source, TEXT_SCHEMA, tmp_path / "wide.parquet", metadata={}, temp_dir=tmp_path
    )
    widest = wide_rows.measure(source, 122_880).max_record_bytes
    expected_rows = wide_rows.TARGET_GROUP_BYTES // widest
    assert 1 < expected_rows < 122_880
    assert written.rows == 160
    assert written.codec.row_group_rows == expected_rows < 122_880
    sizes = [row[0] for row in groups(written.path)]
    assert sum(sizes) == 160
    assert set(sizes[:-1]) == {expected_rows}
    assert sizes[-1] <= expected_rows
    proof = prove_window(
        source,
        written.path,
        TEXT_SCHEMA,
        expect=Expected(written.content_sha256, written.rows, written.sha256),
        temp_dir=tmp_path,
    )
    assert proof.verified is True


def test_the_chosen_group_size_is_recorded_with_the_codec_facts(tmp_path):
    source = wide_csv(tmp_path / "wide.csv", 160)
    written = write_window(
        source, TEXT_SCHEMA, tmp_path / "wide.parquet", metadata={}, temp_dir=tmp_path
    )
    chosen = written.codec.row_group_rows
    assert written.details()["codec_params"]["row_group_rows"] == chosen
    with duckdb.connect() as connection:
        metadata = dict(
            connection.execute(
                "SELECT key, value FROM parquet_kv_metadata(?)", [str(written.path)]
            ).fetchall()
        )
    assert f'"row_group_rows":{chosen}' in metadata[b"transit.codec"].decode()


def test_a_wide_window_chooses_the_same_layout_every_time(tmp_path):
    source = wide_csv(tmp_path / "wide.csv", 160)
    digests = set()
    for name in ("a", "b"):
        (tmp_path / name).mkdir()
        written = write_window(
            source,
            TEXT_SCHEMA,
            tmp_path / name / "w.parquet",
            metadata={},
            temp_dir=tmp_path / name,
        )
        digests.add((written.sha256, written.codec.row_group_rows))
    assert len(digests) == 1


def test_wide_window_rows_keep_csv_order_and_quoted_newlines(tmp_path, monkeypatch):
    monkeypatch.setattr(wide_rows, "WIDE_WINDOW_BYTES", 200)
    monkeypatch.setattr(wide_rows, "TARGET_GROUP_BYTES", 120)
    source = tmp_path / "rows.csv"
    values = [f"line\none {i}\n" + "x" * 30 for i in range(25)]
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i, value in enumerate(values):
            stream.write(f'{100 - i},"{value}"\n')
    written = write_window(
        source, TEXT_SCHEMA, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path
    )
    assert written.codec.row_group_rows < 25
    with duckdb.connect() as connection:
        stored = connection.read_parquet(str(written.path)).fetchall()
    assert stored == [(100 - i, value) for i, value in enumerate(values)]
    assert not list(tmp_path.glob(".transit-*"))


def test_mixed_type_window_bytes_are_unchanged(tmp_path):
    source = tmp_path / "mixed.csv"
    source.write_bytes(
        b"id,name,at,price,note\n"
        b'1,alpha,2026-01-02 03:04:05+00,1.50,\n2,"be,ta",2026-01-02 03:04:06+00,2.25,""\n'
        b'3,"multi\nline",2026-01-02 03:04:07+00,,x\n'
    )
    schema = TableSchema.from_columns(
        [
            ("id", "integer", True),
            ("name", "text", False),
            ("at", "timestamp with time zone", False),
            ("price", "numeric(6,2)", False),
            ("note", "text", False),
        ],
        ["id"],
    )
    written = write_window(source, schema, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path)
    assert written.codec == ParquetCodec()
    assert written.sha256 == MIXED_FIXTURE_SHA256


def test_a_large_file_of_ordinary_rows_goes_through_the_measure_and_keeps_its_bytes(
    tmp_path, monkeypatch
):
    # Lower the gate so a small file exercises the measuring path; the rows are narrow.
    monkeypatch.setattr(wide_rows, "WIDE_WINDOW_BYTES", 3 * 1024**2)
    source = tmp_path / "narrow.csv"
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(300_000):
            stream.write(f"{i},{(i * 2654435761) % 1000003}\n")
    assert source.stat().st_size > wide_rows.WIDE_WINDOW_BYTES
    schema = TableSchema.from_columns(
        [("id", "integer", True), ("payload", "integer", False)], ["id"]
    )
    written = write_window(source, schema, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path)
    assert written.codec == ParquetCodec()
    assert [row[0] for row in groups(written.path)] == [122_880, 122_880, 54_240]
    assert written.sha256 == NARROW_FIXTURE_SHA256


def test_measure_counts_records_not_lines(tmp_path):
    source = tmp_path / "m.csv"
    source.write_bytes(b'a,b\n1,"x\ny"\n22,"z"\n333,w')
    shape = wide_rows.measure(source, 2)
    assert shape.max_record_bytes == len(b'1,"x\ny"\n')
    assert shape.max_window_bytes == len(b'1,"x\ny"\n22,"z"\n')
    tail = wide_rows.measure(source, 3)
    assert tail.max_window_bytes == len(b'1,"x\ny"\n22,"z"\n333,w')


@pytest.mark.parametrize(
    ("window_bytes", "expected"),
    [(wide_rows.WIDE_WINDOW_BYTES, 122_880), (wide_rows.WIDE_WINDOW_BYTES + 1, 28)],
)
def test_rows_per_group_leaves_windows_at_the_threshold_alone(window_bytes, expected):
    shape = wide_rows.WindowShape(max_record_bytes=580_000, max_window_bytes=window_bytes)
    assert wide_rows.rows_per_group(shape, 122_880) == expected


def test_a_single_row_wider_than_the_target_gets_a_group_of_one():
    shape = wide_rows.WindowShape(max_record_bytes=40 * 1024**2, max_window_bytes=10**9)
    assert wide_rows.rows_per_group(shape, 122_880) == 1


def test_split_repeats_the_header_and_never_cuts_a_quoted_newline(tmp_path):
    source = tmp_path / "s.csv"
    source.write_bytes(b'a,b\n1,"x\ny"\n2,z\n3,"q""\n"\n4,w')
    directory = tmp_path / "parts"
    directory.mkdir()
    parts = wide_rows.split(source, directory, 2)
    assert [part.read_bytes() for part in parts] == [
        b'a,b\n1,"x\ny"\n2,z\n',
        b'a,b\n3,"q""\n"\n4,w',
    ]
