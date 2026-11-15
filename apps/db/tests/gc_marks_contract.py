from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from transit_ops.control.objects import ObjectConflict
from transit_ops.snapshots.historic_gc import HistoricGcMark
from transit_ops.snapshots.storage import StoredObjectVersion

KEY = "historic/network/generations/example.json"
KEEP = "historic/network/generations/keep.json"


def seed_mark():
    now = datetime(2026, 11, 14, 1, 2, 3, 456789, tzinfo=UTC)
    return HistoricGcMark(
        StoredObjectVersion(KEY, '"etag"', now, 123),
        now,
        now,
        "f44e6eb0-16df-4a93-a1af-8fc669cc35c6",
    )


def check_empty_mutations(store, other, provider):
    for finish in ("clear", "replace"):
        assert store.load(provider) == {}
        stale = store.version(provider)
        store.replace(provider, {}, expected=stale)
        with pytest.raises(ObjectConflict):
            other.replace(provider, {}, expected=stale)
        store.load(provider)
        stale = store.version(provider)
        store.replace(provider, {KEY: seed_mark()}, expected=stale)
        if finish == "clear":
            store.clear(provider, [KEY])
        else:
            store.load(provider)
            store.replace(provider, {}, expected=store.version(provider))
        assert store.load(provider) == {}
        with pytest.raises(ObjectConflict):
            other.replace(provider, {}, expected=stale)


def check_refusals(store, provider, fault):
    mark = seed_mark()
    store.load(provider)
    store.replace(provider, {KEY: mark}, expected=store.version(provider))
    assert store.load(provider) == {KEY: mark}
    token = store.version(provider)
    bad = {
        "backwards_time": replace(
            mark, last_confirmed_unreachable_utc=mark.first_unreachable_utc - timedelta(seconds=1)
        ),
        "bad_scan_id": replace(mark, last_scan_id="bad"),
        "negative_size": replace(mark, version=replace(mark.version, size=-1)),
        "boolean_size": replace(mark, version=replace(mark.version, size=True)),
        "bad_key": replace(mark, version=replace(mark.version, rel_key="invalid")),
    }[fault]
    with pytest.raises(ValueError):
        store.replace(provider, {KEY: mark, bad.version.rel_key: bad}, expected=token)
    assert store.load(provider) == {KEY: mark}
    assert store.version(provider) == token


def check_marks(store, other, provider, second):
    mark = seed_mark()
    assert store.load(provider) == {}
    stale = store.version(provider)
    store.replace(provider, {KEY: mark}, expected=stale)
    assert other.load(provider) == {KEY: mark}
    with pytest.raises(ObjectConflict):
        other.replace(provider, {}, expected=stale)
    assert store.load(provider) == {KEY: mark}
    previous = store.version(provider)
    store.replace(provider, {KEY: mark}, expected=previous)
    with pytest.raises(ObjectConflict):
        other.replace(provider, {}, expected=previous)
    store.load(second)
    store.replace(second, {KEY: mark}, expected=store.version(second))
    marks = store.load(provider)
    marks[KEEP] = replace(mark, version=replace(mark.version, rel_key=KEEP))
    store.replace(provider, marks, expected=store.version(provider))
    store.clear(provider, ["absent", KEY])
    assert store.load(provider) == {KEEP: marks[KEEP]}
    assert store.load(second) == {KEY: mark}
    store.clear(provider, [])
    assert store.load(second) == {KEY: mark}
