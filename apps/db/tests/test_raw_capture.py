import json
import logging
from datetime import timedelta
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from threading import Thread
from urllib.parse import parse_qs, urlsplit
from zipfile import ZipFile

import duckdb
import pytest
from google.transit.gtfs_realtime_pb2 import FeedMessage
from test_readiness import CONFIG, NOW, write_samples

from transit_ops import clean_days
from transit_ops.clean_days import run_clean_days
from transit_ops.core.models import CaptureDownloadLimit
from transit_ops.ingestion.i3 import build_service_alerts_object_storage_path
from transit_ops.ingestion.realtime_gtfs import build_realtime_object_storage_path
from transit_ops.ingestion.static_gtfs import build_static_object_storage_path
from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.playback import LivePublisher
from transit_ops.providers.registry import load_provider_manifest
from transit_ops.raw_capture import CaptureError, CaptureRunner

CITY = "sto"
PUBLIC = "test-public-credential"
PRIVATE = "test-private-credential"


class Clock:
    elapsed = 0.0
    adjustment = timedelta()

    def __call__(self):
        return self.elapsed

    def wall(self):
        return NOW + timedelta(seconds=self.elapsed) + self.adjustment


@pytest.fixture
def feeds(tmp_path, monkeypatch):
    static, samples = write_samples(tmp_path, NOW)
    message = FeedMessage.FromString(samples["trip_updates"].read_bytes())
    trip = message.entity[0].trip_update
    trip.trip.start_date = NOW.strftime("%Y%m%d")
    matching = trip.stop_time_update[0]
    matching.departure.time = int(NOW.replace(hour=17).timestamp())
    matching.departure.uncertainty = 0
    unknown = trip.stop_time_update.add(stop_id="UNKNOWN", stop_sequence=2)
    unknown.arrival.time = int(NOW.replace(hour=17, minute=10).timestamp())
    unknown.arrival.uncertainty = 0
    samples["trip_updates"].write_bytes(message.SerializeToString())
    message = FeedMessage.FromString(samples["vehicle_positions"].read_bytes())
    message.entity[0].vehicle.position.latitude = 45.45
    message.entity[0].vehicle.position.longitude = -75.7
    position = message.entity.add(id="unassigned").vehicle
    position.vehicle.id = "unassigned"
    position.stop_id = "UNKNOWN"
    position.position.latitude = 45.46
    position.position.longitude = -75.7
    samples["vehicle_positions"].write_bytes(message.SerializeToString())
    paths = {
        "/GTFS.zip": static.read_bytes(),
        **{
            f"/{key}": samples[key].read_bytes()
            for key in ("trip_updates", "vehicle_positions", "service_alerts")
        },
    }
    calls = []
    failed = {}
    clock = Clock()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlsplit(self.path)
            calls.append((clock.elapsed, url.path, parse_qs(url.query)))
            status = failed.get(url.path, 200)
            body = paths[url.path] if status == 200 else self.path.encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        manifest = load_provider_manifest(CONFIG / f"{CITY}.yaml")
        for feed in manifest.feeds.values():
            path = (
                "/GTFS.zip" if feed.endpoint_key == "static_schedule" else f"/{feed.endpoint_key}"
            )
            monkeypatch.setenv(feed.source_url_env_var, base + path)
        monkeypatch.setenv("STO_PUBLIC_KEY", PUBLIC)
        monkeypatch.setenv("STO_PRIVATE_KEY", PRIVATE)
        try:
            yield manifest, clock, calls, failed, paths, base
        finally:
            server.shutdown()
            thread.join()


def _run_until(runner, clock, seconds):
    while clock.elapsed < seconds:
        clock.elapsed += runner.step()


def _signature(at):
    return sha256(f"{PRIVATE}{at:%Y%m%dT%H%MZ}".encode()).hexdigest().upper()


def test_dry_run_uses_legacy_layout_and_writes_nothing(feeds, tmp_path, capsys):
    manifest, clock, calls, _, paths, base = feeds
    before = set(tmp_path.rglob("*"))
    assert CaptureRunner(manifest, None, clock=clock, wall=clock.wall).run() == 0
    records = {row["feed"]: row for row in map(json.loads, capsys.readouterr().out.splitlines())}
    assert set(tmp_path.rglob("*")) == before
    assert len(calls) == len(records) == 4
    for endpoint, row in records.items():
        static = endpoint == "static_schedule"
        path = "/GTFS.zip" if static else f"/{endpoint}"
        body = paths[path]
        digest = sha256(body).hexdigest()
        if static:
            expected = build_static_object_storage_path(CITY, endpoint, NOW, base + path, digest)
        elif endpoint == "service_alerts":
            expected = build_service_alerts_object_storage_path(
                provider_id=CITY, captured_at_utc=NOW, checksum_sha256=digest
            )
        else:
            expected = build_realtime_object_storage_path(CITY, endpoint, NOW, digest)
        assert row == {
            "feed": endpoint,
            "bytes": len(body),
            "count": 7 if static else 2 if endpoint == "vehicle_positions" else 1,
            "key": expected,
        }
    assert calls[0][2] == {}
    assert all(query == {"key": [PUBLIC], "hash": [_signature(NOW)]} for _, _, query in calls[1:])


def test_capture_restart_partial_failure_and_private_consumers(
    feeds, tmp_path, caplog, capsys, monkeypatch
):
    manifest, clock, calls, failed, paths, base = feeds
    raw = tmp_path / "raw"
    raw.mkdir()
    storage = LocalBronzeStorage("local", raw)
    heartbeat = tmp_path / "heartbeat.json"
    kwargs = {"clock": clock, "wall": clock.wall, "heartbeat": heartbeat}
    runner = CaptureRunner(manifest, storage, **kwargs)
    caplog.set_level(logging.INFO)
    failed["/service_alerts"] = 401
    _run_until(runner, clock, 1)
    assert json.loads(heartbeat.read_text())["feeds"]["service_alerts"]["error"] == "HTTP 401"
    assert all(value not in caplog.text for value in (PUBLIC, PRIVATE, _signature(NOW), base))
    first = {
        p.relative_to(raw).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
        for p in raw.rglob("*")
        if p.is_file()
    }
    assert len(first) == 3
    del failed["/service_alerts"]
    clock.elapsed = 0
    restarted = CaptureRunner(manifest, storage, **kwargs)
    _run_until(restarted, clock, 1)
    keys = {p.relative_to(raw).as_posix(): p for p in raw.rglob("*") if p.is_file()}
    assert len(keys) == 4
    for key, (body, mtime) in first.items():
        assert keys[key].stat().st_mtime_ns == mtime and keys[key].read_bytes() == body
    for key, dest in keys.items():
        endpoint = key.split("/")[1]
        assert (
            dest.read_bytes()
            == paths["/GTFS.zip" if endpoint == "static_schedule" else f"/{endpoint}"]
        )

    private = LivePublisher(manifest, storage)
    live = private.poll(NOW + timedelta(seconds=1))
    assert len(live["vehicle_positions"]) == 2
    assert all(feed["captured_at"] for feed in live["feeds"].values())
    with pytest.raises(ValueError, match="active public city"):
        private.run(storage, "", once=True)

    clean = tmp_path / "clean"
    day = NOW.date().isoformat()
    # The synthetic day predates the declared first day; lift the cut-off for this check.
    undated = clean_days.declaration_for(CITY).model_copy(update={"clean_days_from": None})
    monkeypatch.setattr(clean_days, "declaration_for", lambda _: undated)
    run_clean_days(CITY, str(raw), str(clean), selection=(day, day))
    assert "Built 1" in capsys.readouterr().out
    events = next(clean.rglob("stop_events.parquet"))
    with duckdb.connect() as db:
        rows = db.execute(
            "SELECT stop_id FROM read_parquet(?) WHERE observed_at_utc IS NOT NULL", [str(events)]
        ).fetchall()
        assert not db.execute(
            "SELECT 1 FROM read_parquet(?) WHERE stop_id = 'UNKNOWN'", [str(events)]
        ).fetchall()
    assert rows == [("S",)]

    # Eligibility is based on elapsed time even if the wall clock moves back.
    clock.adjustment = timedelta(seconds=-90)
    _run_until(restarted, clock, 62)
    for elapsed, path, query in calls:
        if elapsed > 0 and path != "/GTFS.zip":
            assert query["hash"] == [_signature(NOW + timedelta(seconds=elapsed - 90))]
    assert any(elapsed >= 60 for elapsed, _, _ in calls)


def test_rolling_provider_budget_survives_process_restart(feeds, tmp_path):
    manifest, clock, calls, failed, _, _ = feeds
    failed["/trip_updates"] = 500
    manifest.capture_download_limit = CaptureDownloadLimit(requests=3, window_seconds=60)
    storage = LocalBronzeStorage("local", tmp_path)
    kwargs = {"clock": clock, "wall": clock.wall, "rate_state": tmp_path / "rate.json"}
    assert CaptureRunner(manifest, storage, **kwargs).step() == 0
    runner = CaptureRunner(manifest, storage, **kwargs)
    assert runner.step() == runner.step() == 0
    assert runner.step() == 60
    clock.elapsed = 60
    _run_until(runner, clock, 240)
    assert len(calls) > 3
    assert all(sum(at <= other < at + 60 for other, _, _ in calls) <= 3 for at, _, _ in calls)
    runner.stop.set()
    assert runner.run() == 0


def test_declared_cadence_and_aggregate_budget(feeds, tmp_path):
    manifest, clock, calls, _, _, _ = feeds
    storage = LocalBronzeStorage("local", tmp_path)
    runner = CaptureRunner(manifest, storage, clock=clock, wall=clock.wall)
    _run_until(runner, clock, 600)
    assert len(calls) == 43
    for feed in manifest.feeds.values():
        path = "/GTFS.zip" if feed.endpoint_key == "static_schedule" else f"/{feed.endpoint_key}"
        times = [elapsed for elapsed, captured, _ in calls if captured == path]
        assert times == list(range(0, 600, feed.refresh_interval_seconds))
    assert "capture_download_limit" not in manifest.model_dump()


def test_schedule_check_stores_each_edition_once_and_only_the_named_feed(feeds, tmp_path):
    # OC Transpo publishes editions with new trip ids overnight; a timer checks the
    # static feed alone before service and must keep one object per edition.
    manifest, clock, calls, failed, paths, _ = feeds
    raw = tmp_path / "raw"
    raw.mkdir()
    storage = LocalBronzeStorage("local", raw)
    static = frozenset({"static_schedule"})

    def check():
        runner = CaptureRunner(
            manifest, storage, clock=clock, wall=clock.wall, endpoints=static, once=True
        )
        status = runner.run()
        return status, sorted(p.name for p in raw.rglob("*.zip"))

    status, first = check()
    assert status == 0 and len(first) == 1
    assert {path for _, path, _ in calls} == {"/GTFS.zip"}

    clock.elapsed = 3600
    assert check() == (0, first)

    edition = BytesIO()
    with ZipFile(BytesIO(paths["/GTFS.zip"])) as previous, ZipFile(edition, "w") as following:
        for member in previous.infolist():
            following.writestr(member, previous.read(member))
        following.writestr("feed_info.txt", "feed_version\nnext\n")
    paths["/GTFS.zip"] = edition.getvalue()
    clock.elapsed = 7200
    status, second = check()
    assert status == 0 and len(second) == 2 and set(first) < set(second)

    failed["/GTFS.zip"] = 503
    clock.elapsed = 10800
    assert check() == (1, second)
    assert len(calls) == 4

    with pytest.raises(CaptureError, match="Unknown or disabled"):
        CaptureRunner(manifest, storage, endpoints=frozenset({"nope"}), once=True)
