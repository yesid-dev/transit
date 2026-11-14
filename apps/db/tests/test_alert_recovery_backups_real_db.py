import pytest
from sqlalchemy import text
from test_alert_recovery import NOW, candidate
from test_alert_recovery_backups import KEYS, Client
from test_alert_recovery_copy_real_db import dump_archive, seed_dump_row
from test_alert_recovery_real_db import complete_readers, rows
from test_alert_recovery_real_db import target as target

from transit_ops.commands.alert_recovery import run_alert_archive_recovery
from transit_ops.history.alert_recovery_backups import BackupRecoveryReader
from transit_ops.history.alert_recovery_pg_restore import extract_alert_archive_copy
from transit_ops.settings import Settings


@pytest.mark.parametrize("fault", ["", "cast", "archive", "empty"])
def test_native_backup_reader_runner_roundtrip(target, tmp_path, fault):
    engine, provider = target
    payloads = {}
    for key, identity in zip(KEYS[::-1], ("old", "new"), strict=True):
        with engine.begin() as c:
            c.execute(
                text("DELETE FROM gold.alert_archive_entry WHERE provider_id=:p"), {"p": provider}
            )
            if fault != "empty":
                seed_dump_row(c, provider)
                c.execute(
                    text("UPDATE gold.alert_archive_entry SET alert_id=:id WHERE provider_id=:p"),
                    {"p": provider, "id": identity},
                )
        dump = tmp_path / (identity + ".dump")
        dump_archive(engine, dump)
        payloads[key] = dump.read_bytes()
    with engine.begin() as c:
        c.execute(
            text("DELETE FROM gold.alert_archive_entry WHERE provider_id=:p"), {"p": provider}
        )
    if fault == "archive":
        payloads[KEYS[0]] = b"invalid custom dump"

    def extract(dump, output):
        extract_alert_archive_copy(dump, output)
        if fault == "cast" and b"\tnew\t" in output.read_bytes():
            output.write_bytes(output.read_bytes().replace(b"\t2026-11-01\t", b"\tbad-date\t"))

    observed = []

    def backup(connection, **kwargs):
        observed.append(connection.exec_driver_sql("SHOW transaction_read_only").scalar_one())
        client = Client(payloads)
        result = BackupRecoveryReader(
            Settings(_env_file=None, BRONZE_S3_BUCKET="fixture"),
            client_factory=lambda settings: client,
            extract=extract,
        )(connection, **kwargs)
        assert client.closed and all(b.closed for b in client.bodies)
        return result

    readers = complete_readers([candidate(provider, "published", kind="published")])
    readers["backup"] = backup

    def run(dry_run=True):
        return run_alert_archive_recovery(
            engine,
            provider_id=provider,
            source_readers=readers,
            expected_ids=["lost"],
            dry_run=dry_run,
            recovered_at_utc=NOW,
        )

    preview = run()
    assert observed == ["on"] and preview.inserted == ()
    good = fault in ("", "empty")
    assert preview.complete is good and preview.source_reports[0].scanned == 2
    assert preview.would_insert == (
        ("new", "old", "published")
        if fault == ""
        else ("published",)
        if fault == "empty"
        else ("old", "published")
    )
    applied = run(False)
    assert applied.inserted == (preview.would_insert if good else ())
    assert applied.unrecovered_expected_ids == (("lost",) if good else None)
    if good:
        with engine.connect() as c:
            before = rows(c, provider)
        assert run(False).inserted == ()
        with engine.connect() as c:
            assert rows(c, provider) == before
            if fault == "":
                old = next(row for row in before if row["alert_id"] == "old")
                assert old["description_text"] == "École\tA\nB"
                assert old["route_ids"] == ["a,b", "back\\slash", 'quote"']
                assert old["message"] == {
                    "snapshot_id": "101",
                    "alert_index": 0,
                    "captured_utc": "2026-11-01T00:00:00Z",
                    "header_language": None,
                    "description_language": None,
                    "url_language": None,
                }
                assert old["url_en"] is None
