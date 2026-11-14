import json
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from google.transit import gtfs_realtime_pb2
from history_reader_fakes import FakeCaptureWindow, fake_capture, fake_feed_day, fake_poll

from transit_ops.core.models import ProviderConfig, ProviderManifest
from transit_ops.history.alert_recovery_captures import CaptureRecoveryReader
from transit_ops.settings import Settings

START = datetime(2026, 1, 2, tzinfo=UTC)
END = START + timedelta(minutes=5)


def manifest(provider="fixture"):
    return ProviderManifest.model_construct(
        provider=ProviderConfig(provider_id=provider, display_name="Fixture", timezone="UTC"),
        feeds={},
    )


def capture(payload=b'{"alerts": []}'):
    import hashlib

    return fake_capture(
        provider_id="fixture",
        endpoint_key="i3_alerts",
        index_family="alert_snapshot",
        captured_at_utc=START,
        payload=payload,
        byte_size=len(payload),
        checksum_sha256=hashlib.sha256(payload).hexdigest(),
        object_kind="api_i3_json",
    )


def setup(window=None, rows=None, **bounds):
    c = Mock(begin_nested=lambda: nullcontext())
    c.execute.return_value = (
        rows if rows is not None else [("i3_alerts", "i3_alerts", "api_i3_json")]
    )
    day = fake_feed_day(provider_id="fixture", endpoint_key="i3_alerts", capture_count=1)
    poll = fake_poll(provider_id="fixture", endpoint_key="i3_alerts", capture_row_id=1)
    w = window or FakeCaptureWindow([day], [poll], [capture()], [])
    scope = Mock()
    factory, acquire = Mock(return_value=scope), Mock(return_value=w)
    reader = CaptureRecoveryReader(
        Settings(_env_file=None),
        manifest(),
        capture_from=bounds.get("start", START),
        capture_to=bounds.get("end", END),
        storage_factory=factory,
        window_reader=acquire,
    )
    factory.assert_not_called()
    return reader, c, w, scope, acquire


@pytest.mark.parametrize("start,end", [(START.replace(tzinfo=None), END), (END, END), (END, START)])
def test_invalid_bounds_refuse_without_io(start, end):
    with pytest.raises(ValueError):
        CaptureRecoveryReader(
            Settings(_env_file=None), manifest(), capture_from=start, capture_to=end
        )


def test_inventory_bounds_empty_observations_and_resource_lifetime():
    reader, c, w, scope, acquire = setup(start=START.astimezone(timezone(timedelta(hours=2))))
    reader.manifest.feeds["service_alerts"] = SimpleNamespace(
        endpoint_key="service_alerts",
        feed_kind="service_alerts",
        source_format="gtfs_rt_service_alerts",
        is_enabled=False,
    )
    c.execute.return_value.append(("service_alerts", "service_alerts", "gtfs_rt_service_alerts"))
    w.days += (replace(w.days[0], endpoint_key="service_alerts"),)
    pb = gtfs_realtime_pb2.FeedMessage()
    pb.header.gtfs_realtime_version = "2.0"
    w._captures += (
        replace(
            capture(pb.SerializeToString()),
            endpoint_key="service_alerts",
            capture_row_id=2,
            object_kind="gtfs_rt_service_alerts",
        ),
    )
    original = w.captures
    exhausted = []

    def consume(**kwargs):
        yield from original(**kwargs)
        scope.close.assert_not_called()
        exhausted.append(True)

    w.captures = consume
    items, report = reader(c, provider_id="fixture", recovered_at_utc=END)
    assert items == () and report.complete and report.scanned == 2 and exhausted == [True]
    assert acquire.call_args.args == ("fixture", ("i3_alerts", "service_alerts"), START, END)
    assert acquire.call_args.kwargs["connection"] is c
    assert c.execute.call_args.args[1] == {"provider_id": "fixture"}
    scope.close.assert_called_once()
    scope.reset_mock()
    c.execute.return_value.reverse()
    assert reader(c, provider_id="fixture", recovered_at_utc=END)[1] == report


@pytest.mark.parametrize(
    "fault",
    [
        "still_open",
        "no_polls",
        "never_collected",
        "pruned_before_archive",
        "capture_missing",
        "unfinished",
        "failed",
        "unreadable",
        "omitted",
        "checksum",
        "size",
        "format",
        "provider",
        "container",
        "member",
        "footer",
        "end",
    ],
)
def test_incomplete_evidence_never_becomes_complete_empty(fault):
    reader, c, w, scope, _ = setup()
    if fault in ("still_open", "no_polls", "never_collected", "pruned_before_archive"):
        w.days = (
            fake_feed_day(
                provider_id="fixture", endpoint_key="i3_alerts", state="not_available", reason=fault
            ),
        )
    elif fault in ("capture_missing", "unfinished", "failed"):
        w._polls = (replace(w._polls[0], status=fault),)
    elif fault in ("unreadable", "omitted"):
        w._captures = ()
        w.unreadable = list(w._polls) if fault == "unreadable" else []
    elif fault == "footer":

        def broken(**kwargs):
            yield capture()
            raise ValueError("corrupt footer")

        w.captures = broken
    else:
        changes = {
            "checksum": {"checksum_sha256": "0" * 64},
            "size": {"byte_size": 0},
            "format": {"object_kind": "unknown"},
            "provider": {"provider_id": "other"},
            "end": {"captured_at_utc": END},
        }
        w._captures = (
            capture(b"{}" if fault == "container" else b'{"alerts":[1]}')
            if fault in ("container", "member")
            else replace(capture(), **changes[fault]),
        )
    items, report = reader(c, provider_id="fixture", recovered_at_utc=END)
    assert not report.complete and items == () and (report.errors or report.missing)
    assert report.scanned == 1
    scope.close.assert_called_once()


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [("unknown", "i3_alerts", "api_i3_json")],
        [("i3_alerts", "service_alerts", "gtfs_rt_service_alerts")],
    ],
)
def test_absent_or_contradictory_inventory_refuses(rows):
    reader, c, _, _, acquire = setup(rows=rows)
    assert not reader(c, provider_id="fixture", recovered_at_utc=END)[1].complete
    acquire.assert_not_called()


def test_no_observations_is_unknown():
    reader, c, w, _, _ = setup()
    w._captures, w._polls = (), ()
    assert not reader(c, provider_id="fixture", recovered_at_utc=END)[1].complete


@pytest.mark.parametrize("protobuf", [False, True])
def test_recorded_format_decodes_nonempty_alerts_and_preserves_alert_ordinal(protobuf):
    reader, c, w, _, _ = setup()
    pb = gtfs_realtime_pb2.FeedMessage()
    pb.header.gtfs_realtime_version = "2.0"
    pb.entity.add(id="not-alert")
    pb.entity.add(id="alert-a").alert.header_text.translation.add(language="fr", text="Travaux")
    payload = (
        pb.SerializeToString() if protobuf else b'{"alerts":[{"id":"alert-a","header":"Travaux"}]}'
    )
    w._captures = (
        replace(
            capture(payload), object_kind=("gtfs_rt_service_alerts" if protobuf else "api_i3_json")
        ),
    )
    rows = c.execute.return_value
    c.execute.side_effect = lambda sql, params: (
        Mock(scalar_one=lambda: json.loads(params["raw"])) if "raw" in params else rows
    )
    items, report = reader(c, provider_id="fixture", recovered_at_utc=END)
    assert report.complete and report.candidates == 1 and items[0].alert_id == "alert-a"
    assert items[0].record["header_text"] == "Travaux"
    assert items[0].record["message"]["alert_index"] == 0
