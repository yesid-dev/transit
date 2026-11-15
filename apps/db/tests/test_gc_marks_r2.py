import json
from dataclasses import replace

import pytest
from gc_marks_contract import check_marks

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
            winner["keep"] = winner["a"]
            winner["keep"] = replace(
                winner["keep"], version=replace(winner["keep"].version, rel_key="keep")
            )
            rival.replace("q", winner, expected=rival.version("q"))
        if always or len(attempts) == 1:
            raise ObjectConflict("race")
        return write(key, payload, expected=expected)

    monkeypatch.setattr(objects, "replace", race)
    if always:
        with pytest.raises(ObjectConflict):
            store.clear("q", ["a"])
    else:
        store.clear("q", ["a"])
    assert len(attempts) == 2
    assert set(store.load("q")) == ({"a", "keep"} if always else {"keep"})


@pytest.mark.parametrize(
    "nested,field,value",
    [
        (True, "content_length", True),
        (True, "content_length", "1"),
        (True, "content_length", -1),
        (True, "etag", None),
        (True, "object_key", 12),
        (True, "last_scan_id", "bad"),
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
