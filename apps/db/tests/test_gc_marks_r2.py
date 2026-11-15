import json
from dataclasses import replace

import pytest
from gc_marks_contract import KEEP, KEY, check_marks, check_refusals

from transit_ops.control.historic_gc_marks import PostgresGcMarks, R2GcMarks, gc_marks_for
from transit_ops.control.objects import ObjectConflict, SnapshotConditionalObjects
from transit_ops.settings import Settings
from transit_ops.snapshots.storage import LocalSnapshotStorage


def test_contract(tmp_path):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    check_marks(R2GcMarks(objects), R2GcMarks(objects), "p/a", "p/A")


@pytest.mark.parametrize("always", [False, True])
def test_clear_reapplies_once(tmp_path, monkeypatch, always):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    store = R2GcMarks(objects)
    check_marks(store, R2GcMarks(objects), "p", "q")
    write, attempts = objects.replace, []

    def race(key, payload, *, expected):
        attempts.append(expected)
        if len(attempts) == 1:
            rival = R2GcMarks(
                SnapshotConditionalObjects(
                    LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
                )
            )
            winner = rival.load("q")
            winner[KEEP] = winner[KEY]
            winner[KEEP] = replace(
                winner[KEEP], version=replace(winner[KEEP].version, rel_key=KEEP)
            )
            rival.replace("q", winner, expected=rival.version("q"))
        if always or len(attempts) == 1:
            raise ObjectConflict("race")
        return write(key, payload, expected=expected)

    monkeypatch.setattr(objects, "replace", race)
    if always:
        with pytest.raises(ObjectConflict):
            store.clear("q", [KEY])
    else:
        store.clear("q", [KEY])
    assert len(attempts) == 2
    assert set(store.load("q")) == ({KEY, KEEP} if always else {KEEP})


@pytest.mark.parametrize(
    "nested,field,value",
    [
        (True, "content_length", True),
        (True, "content_length", "1"),
        (True, "content_length", -1),
        (True, "etag", None),
        (True, "object_key", 12),
        (True, "last_scan_id", "bad"),
        (True, "object_key", "a"),
        (True, "last_confirmed_unreachable_utc", "2026-11-14T00:00:00.000000+00:00"),
        (True, "first_unreachable_utc", "2026-11-14T00:00:00"),
        (True, "object_last_modified_utc", 123),
        (True, "extra", "unexpected"),
        (False, "mutation_id", 123),
        (False, "mutation_id", "bad"),
        (False, "provider_id", 123),
        (False, "marks", {}),
        (False, "marks", [None]),
        (False, "extra", 1),
    ],
)
def test_corrupt_document_is_named(tmp_path, nested, field, value):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    store = R2GcMarks(objects)
    check_marks(store, R2GcMarks(objects), "p", "q")
    obj = objects.read("historic-gc/q/marks.json")
    body = json.loads(obj.body)
    (body["marks"][0] if nested else body)[field] = value
    objects.replace(obj.key, body, expected=obj.token)
    with pytest.raises(ValueError, match="^invalid GC marks document"):
        store.load("q")


def test_selector(tmp_path):
    settings = Settings(_env_file=None, BRONZE_LOCAL_ROOT=str(tmp_path))
    assert isinstance(gc_marks_for(object(), settings), PostgresGcMarks)
    with pytest.raises(ValueError):
        gc_marks_for(None, settings)
    settings.LIGHTER_STORAGE.control.gc_marks_backend = "r2"
    assert isinstance(gc_marks_for(None, settings), R2GcMarks)


@pytest.mark.parametrize(
    "fault", ["backwards_time", "bad_scan_id", "negative_size", "boolean_size", "bad_key"]
)
def test_invalid_replacement_is_refused_before_overwriting(tmp_path, fault):
    objects = SnapshotConditionalObjects(
        LocalSnapshotStorage(tmp_path, "control/v1"), min_interval_s=0
    )
    check_refusals(R2GcMarks(objects), "review-provider", fault)
