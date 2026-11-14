from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from switch_store_contract import check_refusals, check_transitions

from transit_ops.control import switches
from transit_ops.control.objects import ObjectCollision, ObjectConflict, SnapshotConditionalObjects
from transit_ops.control.switches import R2Switches
from transit_ops.pipeline_switches import GuardRefused, GuardResult, PipelineSwitch
from transit_ops.settings import Settings
from transit_ops.snapshots.storage import LocalSnapshotStorage


def test_contract(local_store):
    calls = []
    store = local_store
    store.guards = {"test:": lambda k: (calls.append(k), GuardResult(True))[1]}
    check_transitions(store, "test:z", calls)
    check_refusals(store)
    store.set_switch("test:a", on=False, updated_by="a", reason="r")
    assert [r.switch_key for r in store.list_switches()] == ["test:a", "test:z"]


def test_race_rechecks_newer_value(local_store, monkeypatch):
    store, objects = local_store, local_store.objects
    store.guards = {"test:": lambda k: GuardResult(True)}
    replace = objects.replace

    def race(key, payload, *, expected):
        replace(key, {**payload, "updated_by": "winner"}, expected=expected)
        raise ObjectConflict("412")

    monkeypatch.setattr(objects, "replace", race)
    store.set_switch("test:x", on=True, updated_by="loser", reason="r")
    assert store.show_switch("test:x").updated_by == "winner"


@pytest.fixture
def local_store(tmp_path):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    return R2Switches(objects, clock=lambda: datetime(2026, 11, 14, tzinfo=UTC), guards={})


def test_copy_preserves_metadata_and_refuses_collision(local_store):
    row = PipelineSwitch("test:x", True, local_store.clock().replace(microsecond=123), "a", "r")
    source = SimpleNamespace(list_switches=lambda: [row])
    switches.copy_switches(source, local_store)
    token = local_store.objects.read("switches/test%3Ax.json").token
    switches.copy_switches(source, local_store)
    local_store.copy_in(row)
    assert local_store.show_switch("test:x") == row
    assert local_store.objects.read("switches/test%3Ax.json").token == token
    source.list_switches = lambda: [replace(row, reason="different")]
    with pytest.raises(ObjectCollision):
        switches.copy_switches(source, local_store)
    assert local_store.show_switch("test:x") == row


def test_second_conflict_raises_after_two_writes(local_store, monkeypatch):
    writes = []

    def conflict(*args, **kwargs):
        writes.append(kwargs["expected"])
        raise ObjectConflict("412")

    monkeypatch.setattr(local_store.objects, "replace", conflict)
    with pytest.raises(ObjectConflict):
        local_store.set_switch("test:x", on=False, updated_by="a", reason="r")
    assert writes == [None, None] and local_store.list_switches() == []


def test_race_reapplies_guard_and_keeps_winner(local_store, monkeypatch):
    decisions = []
    local_store.guards = {
        "test:": lambda k: (decisions.append(k), GuardResult(len(decisions) == 1))[1]
    }
    write = local_store.objects.replace

    def race(key, payload, *, expected):
        write(key, {**payload, "enabled": False, "updated_by": "winner"}, expected=expected)
        raise ObjectConflict("412")

    monkeypatch.setattr(local_store.objects, "replace", race)
    with pytest.raises(GuardRefused):
        local_store.set_switch("test:x", on=True, updated_by="a", reason="r")
    assert decisions == ["test:x", "test:x"]
    assert local_store.show_switch("test:x").updated_by == "winner"


def test_selector_defaults_and_refuses_unready_ledger(tmp_path):
    settings = Settings(
        _env_file=None,
        BRONZE_LOCAL_ROOT=str(tmp_path),
        LIGHTER_STORAGE={"control": {"switch_backend": "r2"}},
    )
    store = switches.switches_for(None, settings)
    with pytest.raises(GuardRefused, match="history ledger is not ready"):
        store.set_switch("history_daily", on=True, updated_by="a", reason="r")
    assert store.list_switches() == []
    settings.LIGHTER_STORAGE.control.switch_backend = "postgres"
    assert isinstance(switches.switches_for(object(), settings), switches.PostgresSwitches)
    with pytest.raises(ValueError):
        switches.switches_for(None, settings)
