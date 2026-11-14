from datetime import timedelta
from uuid import uuid4

import pytest
from history_fixtures import delete_provider_rows, seed_stored_capture
from parallel_db import guarded_connect_kwargs
from sqlalchemy import text
from test_alert_recovery_captures import END, START, manifest
from test_alert_recovery_real_db import (
    ambient_storage_sentinel as ambient_storage_sentinel,
)
from test_alert_recovery_real_db import (
    complete_readers,
    rows,
)

from transit_ops.commands.alert_recovery import run_alert_archive_recovery
from transit_ops.history import store
from transit_ops.history.alert_recovery_captures import CaptureRecoveryReader
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.settings import Settings


@pytest.fixture
def source(real_db_engine, seed_provider, tmp_path):
    engine, provider = real_db_engine, "capture-" + uuid4().hex
    guarded_connect_kwargs(engine.url)
    try:
        with engine.begin() as c:
            seed_provider(c, provider, display_name="Capture fixture", timezone="UTC")
            for i, at in enumerate((START, START + timedelta(minutes=1), END)):
                identity = "alert-a" if at < END else "excluded"
                seed_stored_capture(
                    c,
                    tmp_path,
                    provider_id=provider,
                    endpoint_key="i3_alerts",
                    run_id=978310 + i,
                    capture_id=978310 + i,
                    started_at_utc=at,
                    captured_at_utc=at,
                    payload=('{"alerts":[{"id":"' + identity + '","header":"Travaux"}]}').encode(),
                )
            for table, column in (
                ("core.feed_endpoints", "source_format"),
                ("raw.ingestion_objects", "object_kind"),
            ):
                c.execute(
                    text(f"UPDATE {table} SET {column}='api_i3_json' WHERE provider_id=:p"),
                    {"p": provider},
                )
        yield engine, provider
    finally:
        with engine.begin() as c:
            c.execute(
                text("DELETE FROM gold.alert_archive_entry WHERE provider_id=:p"), {"p": provider}
            )
            delete_provider_rows(c, provider)


def unchanged(engine, provider):
    with engine.connect() as c:
        return [
            list(
                c.execute(
                    text(
                        f"SELECT to_jsonb(t) FROM {table} t WHERE provider_id=:p "
                        "ORDER BY to_jsonb(t)::text"
                    ),
                    {"p": provider},
                )
            )
            for table in ("silver.i3_alerts", "core.history_window", "core.history_event")
        ]


@pytest.mark.parametrize(
    "archived,fault",
    [
        (False, None),
        (True, None),
        (False, "absent"),
        (False, "mismatch"),
        (True, "footer"),
        (True, "manifest"),
    ],
)
def test_real_acquisition_dry_run_apply_rerun_and_incomplete_refusal(
    source, tmp_path, archived, fault
):
    engine, provider = source
    storage = LocalBronzeStorage(storage_backend="local", root=tmp_path)
    if archived:
        # Fixture-only sealing encodes synthetic bytes; recovery never invokes these verbs.
        with engine.connect() as c:
            copy = store.seal(
                c,
                lambda backend: storage,
                dataset_id="capture.i3_alerts",
                provider_id=provider,
                window_key=START.date().isoformat(),
                archive_backend="local",
                sealed_by="test",
            )
            assert store.verify(c, lambda backend: storage, copy).outcome == "verified"
    if fault:
        path = tmp_path / (
            copy.manifest_path
            if fault == "manifest"
            else copy.storage_path
            if archived
            else "capture/978310"
        )
        if fault in ("absent", "manifest"):
            path.unlink()
        else:
            data = path.read_bytes()
            path.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
    before = unchanged(engine, provider)
    reader = CaptureRecoveryReader(
        Settings(_env_file=None, BRONZE_S3_BUCKET=None, BRONZE_LOCAL_ROOT=str(tmp_path)),
        manifest(provider),
        capture_from=START,
        capture_to=END,
    )
    observed = []

    def capture(c, **kwargs):
        observed.append(c.exec_driver_sql("SHOW transaction_read_only").scalar_one())
        return reader(c, **kwargs)

    readers = complete_readers()
    readers["capture"] = capture

    def run(**kwargs):
        return run_alert_archive_recovery(
            engine,
            provider_id=provider,
            source_readers=readers,
            recovered_at_utc=END,
            expected_ids=["alert-a"],
            **kwargs,
        )

    preview = run()
    assert observed == ["on"] and preview.inserted == ()
    if fault:
        assert not preview.complete and preview.unrecovered_expected_ids is None
        assert run(dry_run=False).inserted == ()
        with engine.connect() as c:
            assert rows(c, provider) == []
    else:
        assert preview.complete and preview.would_insert == ("alert-a",)
        assert preview.source_reports[2].scanned == 2
        assert run(dry_run=False).inserted == ("alert-a",)
        assert run(dry_run=False).inserted == ()
        with engine.connect() as c:
            assert rows(c, provider)[0]["message"]["snapshot_id"] == "978311"
    assert unchanged(engine, provider) == before
