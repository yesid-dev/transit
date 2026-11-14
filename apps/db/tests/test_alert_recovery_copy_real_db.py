import os
import shutil
import subprocess
from datetime import UTC, date, datetime
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from psycopg.conninfo import make_conninfo
from sqlalchemy import text
from test_alert_recovery_copy import COLUMNS, ROW, script
from test_alert_recovery_real_db import target  # noqa: F401

from transit_ops.gold.alert_archive import _write_params
from transit_ops.history.alert_recovery_copy import read_alert_archive_copy
from transit_ops.history.alert_recovery_pg_restore import extract_alert_archive_copy
from transit_ops.silver.i3 import alert_message_provenance


def seed_dump_row(c, provider, tmp_path):
    source = tmp_path / "literal.sql"
    source.write_bytes(script(ROW.replace("fixture", provider)))
    rows, missing = read_alert_archive_copy(c, source, provider_id=provider)
    expected = dict.fromkeys(COLUMNS.split(", ")) | {
        "provider_id": provider,
        "alert_id": "a",
        "archive_month": date(2026, 11, 1),
        "header_text_en": "",
        "description_text": "Travaux",
        "description_text_en": "Works",
        "route_ids": [],
        "stop_ids": [],
        "active_periods": [],
        "content_hash": "hash",
        "first_seen_utc": datetime(2026, 11, 1, tzinfo=UTC),
        "last_seen_utc": datetime(2026, 11, 2, tzinfo=UTC),
        "updated_at_utc": datetime(2026, 11, 2, tzinfo=UTC),
        "url_en": None,
        "message": None,
    }
    assert rows == (expected,) and missing == ("url_en", "message")
    expected.update(description_text="École\tA\nB", route_ids=["a,b", 'quote"', "back\\slash"])
    expected["message"] = alert_message_provenance({}, 101, 0, datetime(2026, 11, 1, tzinfo=UTC))
    assert expected["message"] == {
        "snapshot_id": "101",
        "alert_index": 0,
        "captured_utc": "2026-11-01T00:00:00Z",
        "header_language": None,
        "description_language": None,
        "url_language": None,
    }
    c.execute(
        text(
            f"INSERT INTO gold.alert_archive_entry ({COLUMNS}, message) VALUES ("
            + ", ".join(f":{k}" for k in (COLUMNS + ", message").split(", "))
            + ")"
        ),
        _write_params(expected),
    )
    return expected


def test_native_custom_dump_exact_typed_row(target, tmp_path):  # noqa: F811
    engine, provider = target
    for tool in ("pg_dump", "pg_restore"):
        assert shutil.which(tool), f"{tool}_unavailable: CI requires native PostgreSQL clients"
    with engine.begin() as c:
        expected = seed_dump_row(c, provider, tmp_path)
    url = engine.url
    conninfo = make_conninfo(host=url.host, port=url.port, user=url.username, dbname=url.database)
    with TemporaryDirectory() as scratch:
        dump, output = Path(scratch) / "native.dump", Path(scratch) / "selected.sql"
        subprocess.run(
            [
                "pg_dump",
                "--format=custom",
                "--table=gold.alert_archive_entry",
                "--file",
                str(dump),
                "--dbname",
                conninfo,
            ],
            check=True,
            timeout=120,
            env=os.environ | {"PGPASSWORD": url.password or ""},
            capture_output=True,
        )
        extract_alert_archive_copy(dump, output)
        with engine.connect() as c:
            actual, missing = read_alert_archive_copy(c, output, provider_id=provider)
        assert actual == (expected,) and missing == ()
        assert _write_params(actual[0])["message"] == _write_params(expected)["message"]
    assert not Path(scratch).exists()


@pytest.mark.parametrize(
    ("old", "new", "code"),
    [
        ("2026-11-01 00:00:00+00", "2026-11-01 00:00:00", "copy_instant"),
        ("2026-11-01 00:00:00+00", "infinity", "copy_instant"),
        ("2026-11-01 00:00:00+00", "2026-11-03 00:00:00+00", "copy_inverted"),
    ],
)
def test_invalid_evidence_is_refused(real_db_engine, tmp_path, old, new, code):
    path = tmp_path / "invalid.sql"
    path.write_bytes(script(ROW.replace(old, new)))
    with real_db_engine.connect() as c, pytest.raises(ValueError, match=code):
        read_alert_archive_copy(c, path, provider_id="fixture")


def test_cast_values_cannot_execute_sql_and_arrays_are_postgres_decoded(real_db_engine, tmp_path):
    path = tmp_path / "values.sql"
    path.write_bytes(
        script(
            ROW.replace("Travaux", "'); SELECT 1/0; --").replace(
                "{}\t{}", '{"a,b","quote\\\\\\"","back\\\\\\\\slash"}\t{}'
            )
        )
    )
    with real_db_engine.connect() as c:
        rows, _ = read_alert_archive_copy(c, path, provider_id="fixture")
        assert rows[0]["description_text"] == "'); SELECT 1/0; --"
        assert rows[0]["route_ids"] == ["a,b", 'quote"', "back\\slash"]
        assert read_alert_archive_copy(c, path, provider_id="other")[0] == ()


def test_invalid_postgres_cast_refuses_by_name(real_db_engine, tmp_path):
    path = tmp_path / "bad-date.sql"
    path.write_bytes(script(ROW.replace("2026-11-01\t", "not-a-date\t")))
    with real_db_engine.connect() as c, pytest.raises(ValueError, match="^copy_cast$"):
        read_alert_archive_copy(c, path, provider_id="fixture")
