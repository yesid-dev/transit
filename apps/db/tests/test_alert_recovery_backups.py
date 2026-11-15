import io
from contextlib import nullcontext
from unittest.mock import Mock

import pytest
from test_alert_recovery import NOW
from test_alert_recovery_copy import COLUMNS, script

from transit_ops.history.alert_recovery_backups import BackupRecoveryReader
from transit_ops.settings import Settings


def test_missing_bucket_is_incomplete_without_io():
    client = Mock(side_effect=AssertionError("unexpected I/O"))
    items, report = BackupRecoveryReader(
        Settings(_env_file=None, BRONZE_S3_BUCKET=None), client_factory=client
    )(None, provider_id="fixture", recovered_at_utc=NOW)
    assert items == () and not report.complete and report.missing == ("backup_bucket",)
    client.assert_not_called()


class Client:
    def __init__(self, payloads, fault=""):
        self.payloads, self.fault = payloads, fault
        self.closed, self.bodies, self.gets = False, [], []

    def get_paginator(self, name):
        return self

    def paginate(self, **kwargs):
        if self.fault == "list":
            raise RuntimeError("secret")
        for key, value in self.payloads.items():
            meta = dict(Key=key, Size=len(value), LastModified=NOW)
            meta["ETag"] = None if self.fault == "missingetag" else '"version"'
            yield {"Contents": [meta]}

    def head_object(self, **kwargs):
        if self.fault == "deleted":
            raise RuntimeError("secret")
        return {
            "ContentLength": len(self.payloads[kwargs["Key"]]) + (self.fault == "headsize"),
            "LastModified": NOW.replace(year=2025) if self.fault == "headtime" else NOW,
            "ETag": '"version"',
        }

    def get_object(self, **kwargs):
        assert kwargs["IfMatch"] == '"version"' and kwargs["Bucket"] == "fixture"
        self.gets.append(kwargs["Key"])
        data = self.payloads[kwargs["Key"]]
        body = io.BytesIO(data + (b"x" if self.fault == "size" else b""))
        self.bodies.append(body)
        return {"Body": body, "ETag": '"changed"' if self.fault == "etag" else '"version"'}

    def close(self):
        self.closed = True


DIGEST = "b3cc0475bb78a5026098858e9889acf666d31062d513d303314eca31d36e72f2"
KEYS = [f"backups/postgres/transit-2026110{n}T000000Z.dump" for n in (2, 1)]


def reader(client, extract):
    return BackupRecoveryReader(
        Settings(_env_file=None, BRONZE_S3_BUCKET="fixture"),
        client_factory=lambda settings: client,
        extract=extract,
    )


def test_every_page_order_digest_empty_and_cleanup():
    reports = []
    paths = []

    def extract(dump, output):
        paths.extend((dump, output))
        assert dump.read_bytes() == b"synthetic"
        output.write_bytes(script("", COLUMNS))

    for keys in (KEYS, KEYS[::-1]):
        client = Client(dict.fromkeys(keys, b"synthetic"))
        items, report = reader(client, extract)(
            Mock(begin_nested=nullcontext, closed=False, invalidated=False),
            provider_id="fixture",
            recovered_at_utc=NOW,
        )
        assert items == () and report.complete and report.scanned == 2
        assert client.gets == KEYS and client.closed and all(b.closed for b in client.bodies)
        assert all(not p.exists() for p in paths)
        assert all(f"sha256={DIGEST}" in entry and "complete" in entry for entry in report.coverage)
        reports.append(report)
    assert reports[0] == reports[1]


@pytest.mark.parametrize(
    "fault",
    [
        "list",
        "deleted",
        "size",
        "etag",
        "headsize",
        "headtime",
        "missingetag",
        "archive",
        "table",
        "empty",
    ],
)
def test_unavailable_evidence_is_incomplete_and_clean(fault):
    client = Client({} if fault == "empty" else dict.fromkeys(KEYS, b"synthetic"), fault)
    paths = []

    def extract(dump, output):
        paths.extend((dump, output))
        if fault == "archive":
            raise ValueError("pg_restore_failed")
        output.write_bytes(b"" if fault == "table" else script("", COLUMNS))

    items, report = reader(client, extract)(
        Mock(begin_nested=nullcontext, closed=False, invalidated=False),
        provider_id="fixture",
        recovered_at_utc=NOW,
    )
    assert items == () and not report.complete and (report.errors or report.missing)
    assert client.closed and all(b.closed for b in client.bodies)
    assert all(not p.exists() for p in paths)
    assert "secret" not in str(report)
    assert report.scanned == (0 if fault in ("list", "empty") else 2)


def test_factory_binds_settings_without_source_io(tmp_path):
    from test_alert_recovery_captures import END, START, manifest

    from transit_ops.commands.alert_recovery import build_recovery_source_readers
    from transit_ops.snapshots.storage import LocalSnapshotStorage

    settings = Settings(_env_file=None, BRONZE_S3_BUCKET=None)
    readers = build_recovery_source_readers(
        LocalSnapshotStorage(str(tmp_path), "v1/fixture"),
        settings=settings,
        manifest=manifest(),
        capture_from=START,
        capture_to=END,
    )
    assert set(readers) == {"backup", "published", "capture"}
    assert isinstance(readers["backup"], BackupRecoveryReader)
    assert readers["backup"].settings is settings


def test_cancellation_closes_body_and_client(monkeypatch):
    client = Client(dict.fromkeys(KEYS, b"synthetic"))
    original = client.get_object

    def get(**kwargs):
        response = original(**kwargs)

        def cancel(size):
            raise KeyboardInterrupt

        monkeypatch.setattr(response["Body"], "read", cancel)
        return response

    monkeypatch.setattr(client, "get_object", get)
    with pytest.raises(KeyboardInterrupt):
        reader(client, lambda dump, output: None)(
            Mock(closed=False, invalidated=False), provider_id="fixture", recovered_at_utc=NOW
        )
    assert client.closed and all(body.closed for body in client.bodies)


def test_same_size_same_time_replacement_since_listing_is_incomplete():
    old, new = b"-- old\n" + script("", COLUMNS), b"-- new\n" + script("", COLUMNS)
    assert len(old) == len(new)
    client = Client({KEYS[0]: new})
    meta = dict(Key=KEYS[0], Size=len(old), LastModified=NOW, ETag='"listed-old-version"')
    client.paginate = lambda **kw: iter([dict(Contents=[meta])])
    client.head_object = Mock(
        return_value=dict(ContentLength=len(new), LastModified=NOW, ETag='"replacement-version"')
    )
    client.get_object = Mock(
        side_effect=lambda **kw: dict(Body=io.BytesIO(new), ETag='"replacement-version"')
    )
    items, report = reader(client, lambda dump, output: output.write_bytes(dump.read_bytes()))(
        Mock(begin_nested=nullcontext, closed=False, invalidated=False),
        provider_id="fixture",
        recovered_at_utc=NOW,
    )
    assert items == () and not report.complete and report.scanned == 1 and report.errors
    client.head_object.assert_called_once_with(
        Bucket="fixture", Key=KEYS[0], IfMatch='"listed-old-version"'
    )
    client.get_object.assert_not_called()
