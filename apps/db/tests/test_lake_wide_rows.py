"""Wide-row layout rules: ordinary windows keep their bytes, wide ones go through parts."""

import duckdb
import pytest

from transit_ops.lake import parquet_codec, wide_rows
from transit_ops.lake.parquet_codec import ParquetCodec, write_window
from transit_ops.lake.parquet_verify import CopyDiffers, Expected, prove_window
from transit_ops.lake.table_schema import TableSchema

TEXT_SCHEMA = TableSchema.from_columns(
    [("id", "integer", True), ("payload", "text", False)], ["id"]
)

# Object digests written by the codec before wide-row handling existed (duckdb 2.0.0).
# Re-runs accept only identical bytes, so these must never move.
MIXED_FIXTURE_SHA256 = "c70ba298389c9d4d41ad47ac613c20ec05b0c4ec9cdc305803e1b0b748a43cc1"
NARROW_FIXTURE_SHA256 = "b3e4d046291046a8e147fe5ac27f5d4bb12d0fb00a93f9242f2880d83f1516ea"


@pytest.fixture
def tiny_budget(monkeypatch):
    """Scale the wide thresholds down so small fixtures take the part-file path."""
    monkeypatch.setattr(wide_rows, "WIDE_CHUNK_BYTES", 100)
    monkeypatch.setattr(wide_rows, "TARGET_GROUP_BYTES", 300)
    monkeypatch.setattr(wide_rows, "MAX_RECORD_BYTES", 2_000)
    monkeypatch.setattr(wide_rows, "CHUNK_ROWS", 4)


def group_sizes(path):
    with duckdb.connect() as connection:
        return [
            row[0]
            for row in connection.execute(
                "SELECT max(row_group_num_rows) FROM parquet_metadata(?) "
                "GROUP BY row_group_id ORDER BY row_group_id",
                [str(path)],
            ).fetchall()
        ]


def write_and_prove(source, tmp_path, schema=TEXT_SCHEMA, **kwargs):
    written = write_window(
        source, schema, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path, **kwargs
    )
    proof = prove_window(
        source,
        written.path,
        schema,
        expect=Expected(written.content_sha256, written.rows, written.sha256),
        temp_dir=tmp_path,
    )
    return written, proof


def text_csv(path, values, newline="\n", ids=None):
    with path.open("w", encoding="utf8", newline="") as stream:
        stream.write(f"id,payload{newline}")
        for position, value in enumerate(values):
            key = position if ids is None else ids[position]
            stream.write(f'{key},"{value}"{newline}')
    return path


# --- Ordinary windows are unchanged ---------------------------------------------------


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


def test_a_file_over_the_chunk_gate_of_ordinary_rows_keeps_its_bytes(tmp_path, monkeypatch):
    # Lower the file-size gate so a small file runs the measuring path; the rows are narrow.
    monkeypatch.setattr(wide_rows, "WIDE_CHUNK_BYTES", 3 * 1024**2)
    source = tmp_path / "narrow.csv"
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(300_000):
            stream.write(f"{i},{(i * 2654435761) % 1000003}\n")
    assert source.stat().st_size > wide_rows.WIDE_CHUNK_BYTES
    schema = TableSchema.from_columns(
        [("id", "integer", True), ("payload", "integer", False)], ["id"]
    )
    written, proof = write_and_prove(source, tmp_path, schema)
    assert proof.verified
    assert written.codec == ParquetCodec()
    assert group_sizes(written.path) == [122_880, 122_880, 54_240]
    assert written.sha256 == NARROW_FIXTURE_SHA256


def test_a_default_group_of_ordinary_rows_over_64_mib_stays_on_the_legacy_path(tmp_path):
    # 122,880 rows of 600 bytes: a 71 MiB group that writes on the legacy path today.
    source = tmp_path / "medium.csv"
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(122_880):
            stream.write(f"{i},{'x' * 590}\n")
    assert source.stat().st_size > 64 * 1024**2
    with wide_rows.window_layout(source, tmp_path, 122_880) as layout:
        assert layout is None


def test_rows_in_the_old_55_to_64_mib_cliff_take_the_part_path(tmp_path):
    # 110 rows of 576 KB is a 63 MB window: it passes on main only by about 3 MiB.
    source = tmp_path / "cliff.csv"
    value = "x" * 576_000
    source.write_text("id,payload\n" + "".join(f"{i},{value}\n" for i in range(110)), "utf8")
    with wide_rows.window_layout(source, tmp_path, 122_880) as layout:
        assert layout is not None
        assert sum(layout.rows) == 110
        assert max(layout.rows) * 576_000 <= wide_rows.TARGET_GROUP_BYTES + 576_000


# --- Wide windows through write and prove ---------------------------------------------


def test_wide_window_rows_keep_csv_order_and_quoted_newlines(tmp_path, tiny_budget):
    values = [f"line\none {i}\n" + "x" * 30 for i in range(25)]
    source = text_csv(tmp_path / "rows.csv", values, ids=[100 - i for i in range(25)][::-1])
    written, proof = write_and_prove(source, tmp_path)
    assert proof.verified
    assert max(group_sizes(written.path)) == written.codec.row_group_rows < 25
    with duckdb.connect() as connection:
        stored = connection.read_parquet(str(written.path)).fetchall()
    assert stored == [(76 + i, value) for i, value in enumerate(values)]
    assert not list(tmp_path.glob(".transit-*"))


def test_crlf_in_values_and_escaped_quotes_survive_the_wide_path(tmp_path, tiny_budget):
    source = tmp_path / "crlf.csv"
    # The exported header and record ends are LF; CRLF lives inside quoted values.
    rows = [f'{i},"say ""hi""\r\nthere {i} {"y" * 20}"\n' for i in range(12)]
    source.write_bytes(("id,payload\n" + "".join(rows)).encode())
    written, proof = write_and_prove(source, tmp_path)
    assert proof.verified
    assert written.codec.row_group_rows < 12
    with duckdb.connect() as connection:
        stored = connection.read_parquet(str(written.path)).fetchall()
    assert stored == [(i, f'say "hi"\r\nthere {i} {"y" * 20}') for i in range(12)]


def test_the_chosen_group_size_is_recorded_with_the_codec_facts(tmp_path, tiny_budget):
    source = text_csv(tmp_path / "rows.csv", ["z" * 60] * 10)
    written, _ = write_and_prove(source, tmp_path)
    chosen = written.codec.row_group_rows
    assert chosen == max(group_sizes(written.path))
    assert written.details()["codec_params"]["row_group_rows"] == chosen
    with duckdb.connect() as connection:
        metadata = dict(
            connection.execute(
                "SELECT key, value FROM parquet_kv_metadata(?)", [str(written.path)]
            ).fetchall()
        )
    assert f'"row_group_rows":{chosen}' in metadata[b"transit.codec"].decode()


def test_a_wide_window_chooses_the_same_layout_every_time(tmp_path, tiny_budget):
    source = text_csv(tmp_path / "rows.csv", ["z" * 60] * 10)
    results = set()
    for name in ("a", "b"):
        (tmp_path / name).mkdir()
        written = write_window(
            source,
            TEXT_SCHEMA,
            tmp_path / name / "w.parquet",
            metadata={},
            temp_dir=tmp_path / name,
        )
        results.add((written.sha256, written.codec.row_group_rows))
    assert len(results) == 1


def test_an_explicit_small_group_size_still_takes_the_part_path(tmp_path, tiny_budget):
    source = text_csv(tmp_path / "rows.csv", ["z" * 60] * 10)
    written, proof = write_and_prove(source, tmp_path, codec=ParquetCodec(row_group_rows=2))
    assert proof.verified
    assert max(group_sizes(written.path)) <= 2


def test_skewed_widths_pack_parts_by_bytes_not_by_the_widest_row(tmp_path, tiny_budget):
    # One 1,000-byte record among 40-byte ones must not shrink every part to one row.
    values = ["a" * 30] * 30 + ["b" * 1_000] + ["a" * 30] * 29
    source = text_csv(tmp_path / "skew.csv", values)
    with wide_rows.window_layout(source, tmp_path, 122_880) as layout:
        assert layout is not None
        assert len(layout.parts) < 20
        assert 1 in layout.rows
    written, proof = write_and_prove(source, tmp_path)
    assert proof.verified
    assert written.rows == 60


def test_a_record_over_the_ceiling_is_refused_by_name(tmp_path, tiny_budget):
    source = text_csv(tmp_path / "huge.csv", ["a" * 30, "b" * 2_500, "c" * 30])
    with pytest.raises(wide_rows.RecordTooWide) as refusal:
        write_window(source, TEXT_SCHEMA, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path)
    assert refusal.value.reason == "record_too_wide"
    assert refusal.value.record_bytes > wide_rows.MAX_RECORD_BYTES
    assert not (tmp_path / "o.parquet").exists()
    assert not list(tmp_path.glob(".transit-*"))


def test_part_files_are_removed_when_the_split_fails(tmp_path, tiny_budget, monkeypatch):
    source = text_csv(tmp_path / "rows.csv", ["z" * 60] * 10)
    real = wide_rows.split

    def failing(path, directory, max_rows):
        real(path, directory, max_rows)
        raise OSError("disk full")

    monkeypatch.setattr(wide_rows, "split", failing)
    with pytest.raises(OSError, match="disk full"):
        write_window(source, TEXT_SCHEMA, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path)
    assert not list(tmp_path.glob(".transit-*"))


def test_part_files_are_removed_when_the_write_fails(tmp_path, tiny_budget, monkeypatch):
    source = text_csv(tmp_path / "rows.csv", ["z" * 60] * 10)

    def failing(*args, **kwargs):
        raise RuntimeError("readback failed")

    monkeypatch.setattr(parquet_codec, "_readback", failing)
    with pytest.raises(RuntimeError, match="readback failed"):
        write_window(source, TEXT_SCHEMA, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path)
    assert not list(tmp_path.glob(".transit-*"))
    assert not (tmp_path / "o.parquet").exists()


FLOAT_SCHEMA = TableSchema.from_columns(
    [("id", "integer", True), ("v", "double precision", False), ("pad", "text", False)], ["id"]
)


def float_csv(path, ids=range(15), special=None):
    """Rows of about 56 bytes: with the tiny budget, four rows to a part."""
    special = special or {}
    with path.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,v,pad\n")
        for position, key in enumerate(ids):
            stream.write(f"{key},{special.get(position, key + 0.5)},{'p' * 40}\n")
    return path


def prove_tampered(tmp_path, source, query):
    """Rewrite the Parquet file with a changed query, keeping the transit.* metadata."""
    written = write_window(
        source, FLOAT_SCHEMA, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path
    )
    assert written.codec.row_group_rows < 15  # several slices
    target = tmp_path / "tampered.parquet"
    with duckdb.connect() as connection:
        metadata = {
            key.decode(): value.decode()
            for key, value in connection.execute(
                "SELECT key, value FROM parquet_kv_metadata(?)", [str(written.path)]
            ).fetchall()
        }
        connection.read_parquet(str(written.path)).create_view("original")
        connection.execute(
            f"COPY ({query}) TO ? (FORMAT parquet, KV_METADATA ?)", [str(target), metadata]
        )
    return prove_window(
        source,
        target,
        FLOAT_SCHEMA,
        expect=Expected(written.content_sha256, written.rows, None),
        temp_dir=tmp_path,
    )


def test_an_equal_wide_copy_over_several_slices_is_proven(tmp_path, tiny_budget):
    source = float_csv(tmp_path / "rows.csv")
    written, proof = write_and_prove(source, tmp_path, FLOAT_SCHEMA)
    assert proof.verified
    assert len(group_sizes(written.path)) > 1


@pytest.mark.parametrize(
    ("query", "reason"),
    [
        pytest.param(
            "SELECT id, CASE WHEN id = 12 THEN 99.5 ELSE v END AS v, pad FROM original",
            "missing_rows",
            id="value edit in a later slice",
        ),
        pytest.param(
            "SELECT id, CASE id WHEN 1 THEN 12.5 WHEN 12 THEN 1.5 ELSE v END AS v, pad "
            "FROM original",
            "missing_rows",
            id="values swapped across slices",
        ),
    ],
)
def test_a_tampered_wide_copy_is_refused_by_the_slice_difference(
    tmp_path, tiny_budget, query, reason
):
    source = float_csv(tmp_path / "rows.csv")
    with pytest.raises(CopyDiffers) as refusal:
        prove_tampered(tmp_path, source, query)
    assert refusal.value.reason == reason


def test_a_duplicate_key_across_a_slice_boundary_is_refused_for_key_order(tmp_path, tiny_budget):
    # The copy matches its CSV exactly; the key repeats where slice 1 begins (four rows a part).
    ids = [0, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    source = float_csv(tmp_path / "rows.csv", ids)
    written = write_window(
        source, FLOAT_SCHEMA, tmp_path / "o.parquet", metadata={}, temp_dir=tmp_path
    )
    with pytest.raises(CopyDiffers) as refusal:
        prove_window(
            source,
            written.path,
            FLOAT_SCHEMA,
            expect=Expected(written.content_sha256, written.rows, None),
            temp_dir=tmp_path,
        )
    assert refusal.value.reason == "key_order"


def test_a_flipped_negative_zero_in_a_later_slice_is_refused_for_canonical_text(
    tmp_path, tiny_budget
):
    source = float_csv(tmp_path / "rows.csv", special={12: "-0"})
    with pytest.raises(CopyDiffers) as refusal:
        prove_tampered(
            tmp_path,
            source,
            "SELECT id, CASE WHEN id = 12 THEN 0.0 ELSE v END AS v, pad FROM original",
        )
    assert refusal.value.reason == "canonical_text"


def test_a_column_name_with_a_quote_survives_the_wide_verifier(tmp_path, tiny_budget):
    schema = TableSchema.from_columns(
        [('a" "b', "integer", True), ("payload", "text", False)], ['a" "b']
    )
    source = tmp_path / "rows.csv"
    rows = "".join(f"{i},{'z' * 60}\n" for i in range(12))
    source.write_bytes(('a" "b,payload\n' + rows).encode())
    written, proof = write_and_prove(source, tmp_path, schema)
    assert proof.verified
    assert len(group_sizes(written.path)) > 1


# --- Measuring and splitting ----------------------------------------------------------


def test_measure_counts_records_not_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(wide_rows, "CHUNK_ROWS", 2)
    source = tmp_path / "m.csv"
    source.write_bytes(b'a,b\n1,"x\ny"\n22,"z"\n333,w')
    shape = wide_rows.measure(source, 3)
    assert shape.max_record_bytes == len(b'1,"x\ny"\n')
    assert shape.max_chunk_bytes == len(b'1,"x\ny"\n22,"z"\n')
    assert shape.max_window_bytes == len(b'1,"x\ny"\n22,"z"\n333,w')


def test_measure_ignores_a_header_without_a_final_newline(tmp_path):
    source = tmp_path / "h.csv"
    source.write_bytes(b"a,b")
    assert wide_rows.measure(source, 10) == wide_rows.WindowShape(0, 0, 0)


@pytest.mark.parametrize(
    ("chunk", "window", "wide"),
    [
        (wide_rows.WIDE_CHUNK_BYTES, wide_rows.WIDE_WINDOW_BYTES, False),
        (wide_rows.WIDE_CHUNK_BYTES + 1, 0, True),
        (0, wide_rows.WIDE_WINDOW_BYTES + 1, True),
    ],
)
def test_the_wide_gate_sits_at_the_documented_thresholds(chunk, window, wide):
    assert wide_rows.WindowShape(1, chunk, window).wide is wide


def test_split_repeats_the_header_and_never_cuts_a_quoted_newline(tmp_path):
    source = tmp_path / "s.csv"
    source.write_bytes(b'a,b\n1,"x\ny"\n2,z\n3,"q""\n"\n4,w')
    directory = tmp_path / "parts"
    directory.mkdir()
    layout = wide_rows.split(source, directory, 2)
    assert [part.read_bytes() for part in layout.parts] == [
        b'a,b\n1,"x\ny"\n2,z\n',
        b'a,b\n3,"q""\n"\n4,w',
    ]
    assert layout.rows == (2, 2)
    assert list(layout.spans())[1][1:] == (2, 4)


def test_split_keeps_crlf_record_ends_whole(tmp_path):
    source = tmp_path / "s.csv"
    source.write_bytes(b"a,b\r\n1,x\r\n2,y\r\n3,z\r\n")
    directory = tmp_path / "parts"
    directory.mkdir()
    layout = wide_rows.split(source, directory, 2)
    assert [part.read_bytes() for part in layout.parts] == [
        b"a,b\r\n1,x\r\n2,y\r\n",
        b"a,b\r\n3,z\r\n",
    ]


def test_split_caps_parts_at_one_reader_chunk(tmp_path):
    source = tmp_path / "s.csv"
    source.write_text("a\n" + "1\n" * 5_000, "utf8")
    directory = tmp_path / "parts"
    directory.mkdir()
    layout = wide_rows.split(source, directory, 122_880)
    assert layout.rows == (2048, 2048, 904)
