from datetime import UTC, datetime

import pytest

from transit_ops.pipeline_switches import GuardRefused, ReservedSwitch


def check_transitions(store, key, calls):
    assert store.show_switch(key) is None
    assert key not in store.enabled()
    store.set_switch(key, on=False, updated_by="first", reason="initial")
    first = store.show_switch(key)
    assert first.enabled is False and not calls
    store.set_switch(key, on=False, updated_by="second", reason="repeat")
    assert store.show_switch(key) == first
    store.set_switch(key, on=True, updated_by="owner", reason="approved")
    row = store.show_switch(key)
    assert row.enabled and row.updated_by == "owner" and row.reason == "approved"
    assert row.updated_at_utc >= datetime(2026, 1, 1, tzinfo=UTC)
    assert calls == [key] and key in store.enabled()
    store.set_switch(key, on=True, updated_by="second", reason="repeat")
    assert store.show_switch(key) == row
    calls.clear()
    store.set_switch(key, on=False, updated_by="owner", reason="stop")
    assert not calls and key not in store.enabled()
    assert store.show_switch(key).reason == "stop"


def check_refusals(store):
    for key, actor, reason, error in (
        ("stop_time_diet:x", "a", "r", ReservedSwitch),
        ("x\n", "a", "r", ValueError),
        ("x", "a\x00", "r", ValueError),
        ("x", "a", " ", ValueError),
        ("unknown", "a", "r", GuardRefused),
    ):
        with pytest.raises(error):
            store.set_switch(key, on=True, updated_by=actor, reason=reason)
