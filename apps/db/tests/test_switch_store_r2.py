from datetime import UTC, datetime

from switch_store_contract import check_refusals, check_transitions

from transit_ops.control.objects import ObjectConflict, SnapshotConditionalObjects
from transit_ops.control.switches import R2Switches
from transit_ops.pipeline_switches import GuardResult
from transit_ops.snapshots.storage import LocalSnapshotStorage


def test_contract(tmp_path):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    calls = []
    store = R2Switches(
        objects,
        clock=lambda: datetime(2026, 11, 14, tzinfo=UTC),
        guards={"test:": lambda k: (calls.append(k), GuardResult(True))[1]},
    )
    check_transitions(store, "test:z", calls)
    check_refusals(store)
    store.set_switch("test:a", on=False, updated_by="a", reason="r")
    assert [r.switch_key for r in store.list_switches()] == ["test:a", "test:z"]


def test_race_rechecks_newer_value(tmp_path, monkeypatch):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    store = R2Switches(
        objects,
        clock=lambda: datetime(2026, 11, 14, tzinfo=UTC),
        guards={"test:": lambda k: GuardResult(True)},
    )
    replace = objects.replace

    def race(key, payload, *, expected):
        replace(key, {**payload, "updated_by": "winner"}, expected=expected)
        raise ObjectConflict("412")

    monkeypatch.setattr(objects, "replace", race)
    store.set_switch("test:x", on=True, updated_by="loser", reason="r")
    assert store.show_switch("test:x").updated_by == "winner"
