from dataclasses import replace
from datetime import UTC, datetime

import pytest

from transit_ops.control.objects import ObjectConflict
from transit_ops.snapshots.historic_gc import HistoricGcMark
from transit_ops.snapshots.storage import StoredObjectVersion


def check_marks(store, other, provider, second):
    now = datetime(2026, 11, 14, 1, 2, 3, 456789, tzinfo=UTC)
    mark = HistoricGcMark(
        StoredObjectVersion("a", '"etag"', now, 123),
        now,
        now,
        "f44e6eb0-16df-4a93-a1af-8fc669cc35c6",
    )
    assert store.load(provider) == {}
    stale = store.version(provider)
    store.replace(provider, {"a": mark}, expected=stale)
    assert other.load(provider) == {"a": mark}
    with pytest.raises(ObjectConflict):
        other.replace(provider, {}, expected=stale)
    assert store.load(provider) == {"a": mark}
    previous = store.version(provider)
    store.replace(provider, {"a": mark}, expected=previous)
    with pytest.raises(ObjectConflict):
        other.replace(provider, {}, expected=previous)
    store.load(second)
    store.replace(second, {"a": mark}, expected=store.version(second))
    marks = store.load(provider)
    marks["keep"] = replace(mark, version=replace(mark.version, rel_key="keep"))
    store.replace(provider, marks, expected=store.version(provider))
    store.clear(provider, ["absent", "a"])
    assert store.load(provider) == {"keep": marks["keep"]}
    assert store.load(second) == {"a": mark}
    store.clear(provider, [])
    assert store.load(second) == {"a": mark}
