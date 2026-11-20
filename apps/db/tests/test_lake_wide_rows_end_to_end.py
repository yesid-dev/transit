"""Rows near 580 KB, over the 256 MiB codec budget in total, write and verify end to end.

Deliberately independent of the wide-row module so it can run against older code: the
real codec settings, then the real verifier, as every production copy does.
"""

import hashlib
import random

import duckdb

from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.parquet_verify import Expected, prove_window
from transit_ops.lake.table_schema import TableSchema

SCHEMA = TableSchema.from_columns([("id", "integer", True), ("payload", "text", False)], ["id"])


def test_a_window_of_580_kb_rows_over_the_memory_budget_writes_and_proves(tmp_path):
    # 600 rows of 576,000 bytes: 346 MB of CSV against a 256 MiB codec connection.
    source = tmp_path / "wide.csv"
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(600):
            stream.write(f"{i},{(hashlib.sha256(str(i).encode()).hexdigest() * 9000)[:576000]}\n")
    assert source.stat().st_size > 256 * 1024**2

    written = write_window(
        source, SCHEMA, tmp_path / "wide.parquet", metadata={}, temp_dir=tmp_path
    )
    proof = prove_window(
        source,
        written.path,
        SCHEMA,
        expect=Expected(written.content_sha256, written.rows, written.sha256),
        temp_dir=tmp_path,
    )

    assert proof.verified is True
    assert written.rows == 600
    with duckdb.connect() as connection:
        sizes = [
            row[0]
            for row in connection.execute(
                "SELECT max(row_group_num_rows) FROM parquet_metadata(?) "
                "GROUP BY row_group_id ORDER BY row_group_id",
                [str(written.path)],
            ).fetchall()
        ]
        ids = connection.execute(
            "SELECT id FROM read_parquet(?, file_row_number=true) ORDER BY file_row_number",
            [str(written.path)],
        ).fetchall()
    assert sum(sizes) == 600
    assert max(sizes) == written.codec.row_group_rows < 2048
    assert written.details()["codec_params"]["row_group_rows"] == max(sizes)
    assert ids == [(i,) for i in range(600)]
    assert not list(tmp_path.glob(".transit-*"))


def test_a_window_of_medium_rows_over_the_budget_writes_and_proves(tmp_path):
    # 7,500 rows of 14 KB of unrepeating text: 105 MB in 2,048-row chunks of 28 MB, so no
    # chunk is wide, but the whole group is over what the codec connection can write.
    source = tmp_path / "medium.csv"
    with source.open("w", encoding="utf8", newline="") as stream:
        stream.write("id,payload\n")
        for i in range(7_500):
            stream.write(f"{i},{random.Random(i).randbytes(7_000).hex()}\n")
    assert 95 * 1024**2 < source.stat().st_size < 120 * 1024**2

    written = write_window(
        source, SCHEMA, tmp_path / "medium.parquet", metadata={}, temp_dir=tmp_path
    )
    proof = prove_window(
        source,
        written.path,
        SCHEMA,
        expect=Expected(written.content_sha256, written.rows, written.sha256),
        temp_dir=tmp_path,
    )
    assert proof.verified is True
    assert written.rows == 7_500
