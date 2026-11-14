from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from hashlib import sha256

import pytest
from snapshot_storage_fixtures import MemorySnapshotStore
from test_live_captures import POLICY, _capture, _message
from test_snapshots_publish import FakeConn, FakeSettings, NamedRowsResult

from transit_ops.providers import ProviderRegistry
from transit_ops.settings import Settings
from transit_ops.snapshots import publish
from transit_ops.snapshots.live_trip_updates import LiveTripUpdates
from transit_ops.sql_registry import query_name

AT = datetime(2026, 6, 20, 12, tzinfo=UTC)
KEYS = (
    "live/vehicles.json live/trips.json live/alerts.json live/network.json "
    "live/stop_departures.json status/data_health.json manifest.json"
).split()
DIGESTS = {
    "stm": dict(
        zip(
            KEYS,
            """
24a9bb0661e745bae7291d8635811fd9cdc8f02ec48adfa8a147f016d2d82fdf
c98fa1c9e5bab5fe3583c0d5b91c5e759966d2ebe9d685b1cf77417a212f8374
0ae1c24350b79db9f429239c331c6dd374b911a15b6c01a494f47f3e2c74ea81
e7af6830e9a23e971c8ef17f0d1d513c438a24f2a21dec70388fd08ff750c075
bfac2312b67c35afc4404fe09debd585d0a4e09b2bfcba67603f44d3bf04063b
ae71a9edea33f10e8f4282f93da0a894c4fa35faa6f94bff9f84a5c89c4f267e
725132488f5b625e1f7e522059bf327df367709e9863b3fd30164bee741cbb59
""".split(),
            strict=True,
        )
    ),
    "octranspo": dict(
        zip(
            KEYS,
            """
322c7f2f00170ac8a9da76e8f257739f59eb77a12f2638a5d642c5114a54c2c4
8dc02a621726edf46c692354d88484db646872505f2c50698d044b3973367792
2b7fe68b5ccaa9fafd139f65774ac8f70604f103e6210ad7ee44c3a0c50be2cc
78588cec338453f63d3b059fa8a16e10f7da0668e2161dc628a65ee4587cc197
0dcb0d66ef6eb82baebf53d9a72836f8f20db512cb5745a83dd19655f2f8d330
4451cacbcb972646ccbcd1e270a329817033eeaac63f3c1d7c49963a5c3a9601
fe0f6daf8c2d2c6b166a3f255629b72184799911c2f09f88585efb7064d63a7c
""".split(),
            strict=True,
        )
    ),
}


class Engine:
    @contextmanager
    def begin(self):
        class Conn(FakeConn):
            def execute(self, statement, params=None):
                if query_name(statement) == "live.trip_delay":
                    return NamedRowsResult(
                        [
                            dict(
                                trip_id="T1",
                                route_id="51",
                                avg_delay_seconds=60,
                                status_band="on_time",
                            )
                        ]
                    )
                return super().execute(statement, params)

        yield Conn()


@pytest.mark.parametrize("provider", ["stm", "octranspo"])
def test_live_publication_bytes_unchanged_with_trip_holder(monkeypatch, provider):
    monkeypatch.setattr(publish, "utc_now", lambda: AT)
    registry = ProviderRegistry.from_project_root(settings=Settings(_env_file=None))
    store = MemorySnapshotStore()
    publish.publish_snapshot(
        provider, settings=FakeSettings(), registry=registry, engine=Engine(), storage=store
    )
    assert store.get_json("live/trips.json")["trips"]["T1"]["route"] == "51"
    assert store.keys[-1] == "manifest.json"
    assert {k: sha256(v).hexdigest() for k, v in store.objects.items()} == DIGESTS[provider]
    baseline = dict(store.objects)
    for state in ("absent", "warm", "empty", "failing"):
        holder = LiveTripUpdates(
            provider, policy=POLICY, fallback=lambda: pytest.fail("unused holder resolved")
        )
        if state in ("warm", "empty"):
            message = _message()
            if state == "empty":
                del message.entity[:]
            payload = message.SerializeToString()
            from dataclasses import replace

            holder.accept(payload, replace(_capture(payload), provider_id=provider))
        candidate = MemorySnapshotStore()
        publish.publish_snapshot(
            provider,
            settings=FakeSettings(),
            registry=registry,
            engine=Engine(),
            storage=candidate,
            live_trip_updates=None if state == "absent" else holder,
        )
        assert candidate.objects == baseline
        assert candidate.keys == store.keys
        monkeypatch.setattr(publish, "utc_now", lambda: AT + timedelta(seconds=20))
        publish.publish_snapshot(
            provider,
            settings=FakeSettings(),
            registry=registry,
            engine=Engine(),
            storage=candidate,
            live_trip_updates=holder,
        )
        for key in baseline.keys() - {"status/data_health.json", "manifest.json"}:
            assert candidate.objects[key] == baseline[key]
        assert candidate.keys[-1] == "manifest.json"
        monkeypatch.setattr(publish, "utc_now", lambda: AT)


def test_publisher_does_not_resolve_an_unused_holder(monkeypatch):
    monkeypatch.setattr(publish, "utc_now", lambda: AT)
    holder = LiveTripUpdates(
        "stm", policy=POLICY, fallback=lambda: pytest.fail("unused fallback resolved")
    )
    publish.publish_snapshot(
        "stm",
        settings=FakeSettings(),
        engine=Engine(),
        storage=MemorySnapshotStore(),
        live_trip_updates=holder,
    )
