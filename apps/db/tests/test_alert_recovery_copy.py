import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from transit_ops.gold.alert_archive import _write_params
from transit_ops.history.alert_recovery_copy import (
    canonical_archive_message,
    parse_alert_archive_copy,
)
from transit_ops.history.alert_recovery_pg_restore import extract_alert_archive_copy

COLUMNS = (
    "provider_id, alert_id, archive_month, header_text, header_text_en, description_text, "
    "description_text_en, severity, cause, effect, route_ids, stop_ids, start_utc, end_utc, "
    "active_periods, url, first_seen_utc, last_seen_utc, content_hash, updated_at_utc"
)
ROW = (
    "fixture\ta\t2026-11-01\t\\N\t\tTravaux\tWorks\t\\N\t\\N\t\\N\t{}\t{}\t"
    "\\N\t\\N\t[]\t\\N\t2026-11-01 00:00:00+00\t2026-11-02 00:00:00+00\thash\t"
    "2026-11-02 00:00:00+00\n"
)


def script(row=ROW, columns=COLUMNS):
    return f"COPY gold.alert_archive_entry ({columns}) FROM stdin;\n{row}\\.\n".encode()


@pytest.mark.parametrize(
    ("literal", "expected"),
    [
        (
            '{"alert_index": 0, "snapshot_id": "101", "captured_utc": '
            '"2026-11-01T00:00:00Z", "url_language": null, "header_language": null, '
            '"description_language": null}',
            '{"snapshot_id": "101", "alert_index": 0, "captured_utc": "2026-11-01T00:00:00Z", '
            '"header_language": null, "description_language": null, "url_language": null}',
        ),
        (
            '{"captured_utc":"2026-11-01T00:00:00Z","alert_index":0,"snapshot_id":"101"}',
            '{"snapshot_id": "101", "alert_index": 0, "captured_utc": "2026-11-01T00:00:00Z"}',
        ),
        ("null", None),
        ('{"z":1,"alert_index":0,"a":2}', '{"alert_index": 0, "z": 1, "a": 2}'),
    ],
)
def test_scrambled_literal_message_has_normal_sync_serialized_order(literal, expected):
    rows, _ = parse_alert_archive_copy(
        script(ROW.rstrip("\n") + "\t" + literal + "\n", COLUMNS + ", message")
    )
    message = canonical_archive_message(json.loads(rows[0]["message"]))
    assert _write_params({"message": message, "active_periods": []})["message"] == expected


def test_copy_null_and_standalone_literals():
    raw_values = [r"\N", r"\\N", r'"\N"', r'"\\N"', ""]
    for raw, expected in zip(raw_values, [None, "\\N", '"N"', '"\\N"', ""], strict=True):
        rows, _ = parse_alert_archive_copy(script(ROW.replace("Travaux", raw)))
        assert rows[0]["description_text"] == expected


@pytest.fixture
def restore_tool(tmp_path, monkeypatch):
    tool = tmp_path / ("pg_restore.exe" if os.name == "nt" else "pg_restore")
    tool.touch()
    tool.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("PATHEXT", ".bad;.eXe")
    return tool


def test_literal_copy_preserves_null_empty_and_single_byte_decoding():
    data = script(ROW.replace("Travaux", r"caf\303\251\t\n\\N\x21"))
    rows, missing = parse_alert_archive_copy(data)
    assert rows[0]["description_text"] == "café\t\n\\N!"
    assert rows[0]["header_text"] is None and rows[0]["header_text_en"] == ""
    assert missing == ("url_en", "message")
    assert parse_alert_archive_copy(script("")) == ((), missing)
    permuted = script(
        ROW.replace("fixture\ta", "a\tfixture"),
        COLUMNS.replace("provider_id, alert_id", "alert_id, provider_id"),
    )
    assert parse_alert_archive_copy(permuted) == parse_alert_archive_copy(script())


@pytest.mark.parametrize(
    ("data", "code"),
    [
        (b"-- empty\n", "copy_missing"),
        (script()[:-3], "copy_truncated"),
        (script() + script(), "copy_multiple"),
        (script(columns=COLUMNS + ", alert_id"), "copy_columns"),
        (script(columns=COLUMNS.replace("cause", "unknown")), "copy_columns"),
        (script(columns=COLUMNS.replace("first_seen_utc, ", "")), "copy_columns"),
        (script("short\n"), "copy_width"),
        (script() + b"DROP SCHEMA gold CASCADE;\n", "copy_framing"),
        (script().replace(b"COPY gold.", b"COPY evil."), "copy_framing"),
        (script() + b"SET client_encoding = 'LATIN1';\n", "copy_framing"),
        (script().replace(b"Travaux", b"\xff"), "copy_encoding"),
        (script().replace(b"Travaux", rb"\000"), "copy_escape"),
        (b"\\restrict token\n" + script(), "copy_truncated"),
        (b"INSERT INTO gold.alert_archive_entry VALUES (1);\n", "copy_framing"),
    ],
)
def test_refuses_entire_malformed_dump(data, code):
    with pytest.raises(ValueError, match=code):
        parse_alert_archive_copy(data)


def test_native_framing_is_inert():
    pre = b"-- dump\n\\restrict token\nSET client_encoding = 'UTF8';\n"
    assert parse_alert_archive_copy(pre + script() + b"\\unrestrict token\n") == (
        parse_alert_archive_copy(script())
    )


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (FileNotFoundError("private"), "pg_restore_unavailable"),
        (subprocess.TimeoutExpired("private", 120), "pg_restore_timeout"),
        (subprocess.CalledProcessError(1, "private"), "pg_restore_failed"),
        (PermissionError("private"), "pg_restore_process_error"),
        (None, "pg_restore_output_unreadable"),
        ("cwd", "pg_restore_unavailable"),
        ("relative", "pg_restore_unavailable"),
    ],
)
def test_process_refusals_are_named_and_do_not_disclose_details(
    tmp_path, monkeypatch, restore_tool, failure, code
):
    if failure in ("cwd", "relative"):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("PATH", "" if failure == "cwd" else ".")

    def run(*args, **kwargs):
        if failure in ("cwd", "relative"):
            raise AssertionError("impostor must never run")
        if failure:
            raise failure

    monkeypatch.setattr(subprocess, "run", run)
    with TemporaryDirectory(dir=tmp_path) as scratch:
        with pytest.raises(ValueError, match=f"^{code}$"):
            extract_alert_archive_copy(Path(scratch) / "in.dump", Path(scratch) / "out.sql")
    assert not Path(scratch).exists()


def test_process_only_writes_local_text_and_closes_handles(tmp_path, monkeypatch, restore_tool):
    def run(argv, **kwargs):
        flags = "--format=custom --data-only --schema=gold --table=alert_archive_entry"
        expected = [str(restore_tool), *flags.split(), "--strict-names", "--file"]
        assert argv == [*expected, str(tmp_path / "out.sql"), str(tmp_path / "in.dump")]
        assert kwargs["shell"] is False and kwargs["timeout"] > 0
        Path(argv[-2]).write_bytes(script())

    monkeypatch.setattr(subprocess, "run", run)
    output = tmp_path / "out.sql"
    extract_alert_archive_copy(tmp_path / "in.dump", output)
    with pytest.raises(ValueError, match="pg_restore_output_exists"):
        extract_alert_archive_copy(tmp_path / "in.dump", output)
    output.unlink()
    assert not output.exists()
