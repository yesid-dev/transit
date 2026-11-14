import json
from copy import deepcopy
from pathlib import Path

import pytest
from publication_target_cases import (
    GOLDEN,
    assert_inventory,
    catalog_case,
    inventory,
    storage_pair,
    summary,
)

from transit_ops.snapshots.storage import (
    ImmutableKeyCollisionError,
    StableActivationConflictError,
)


def test_catalog_and_optional_basemap_keep_their_existing_keys_and_bytes(tmp_path, monkeypatch):
    rows = catalog_case(tmp_path, monkeypatch)
    assert GOLDEN.exists(), "missing publication golden; capture through the real-DB test"
    assert (
        summary({"catalog": rows})["cases"]["catalog"]
        == json.loads(GOLDEN.read_bytes())["cases"]["catalog"]
    ), rows


@pytest.mark.parametrize("mutation", ["byte", "rename", "add", "remove", "type", "cache"])
def test_characterization_detects_changed_byte_key_content_type_and_cache_policy(
    mutation, tmp_path
):
    remote, _local, client = storage_pair(tmp_path)
    remote.put_bytes("live/network.json", b'{"value":null}', tier="live")
    original = client.objects
    remote.close()
    expected = inventory(original)
    changed = deepcopy(original)
    key = next(iter(changed))
    if mutation == "byte":
        changed[key]["Body"] = b'{"value":nulL}'
    elif mutation == "rename":
        changed[key + ".renamed"] = changed.pop(key)
    elif mutation == "add":
        changed[key + ".extra"] = deepcopy(changed[key])
    elif mutation == "remove":
        changed.pop(key)
    elif mutation == "type":
        changed[key]["ContentType"] = "text/plain"
    else:
        changed[key]["CacheControl"] = "public, max-age=21"
    assert_inventory(original, expected)
    with pytest.raises(AssertionError, match="publication inventory"):
        assert_inventory(changed, expected)


def test_local_and_s3_targets_store_identical_publication_bytes(tmp_path):
    remote, local, client = storage_pair(tmp_path)
    operations = [
        ("live/network.json", "live", "public, max-age=20"),
        (
            "static/routes_index.json",
            "static",
            "public, max-age=86400, stale-while-revalidate=86400",
        ),
        (
            "historic/network_trend.json",
            "historic",
            "public, max-age=3600, stale-while-revalidate=86400",
        ),
        ("_meta/publish_state_static.json", "internal", "private, no-store"),
        ("_meta/publish_state_historic.json", "internal", "private, no-store"),
    ]
    payload = {"name": "Métro 🚇", "missing": None, "values": [2, 1], "rate": 1.25}
    for store in (remote, local):
        for key, tier, _cache in operations:
            store.put_json(key, payload, tier=tier)
        store.put_immutable_json("historic/history/leaf.json", payload)
        root = "historic/history/index.json"
        version = store.capture_stable_version(root)
        store.activate_stable_json(root, payload, expected_version=version, tier="historic")
    operations += [
        ("historic/history/leaf.json", "historic_immutable", "public, max-age=31536000, immutable"),
        (root, "historic", "public, max-age=3600, stale-while-revalidate=86400"),
    ]
    assert set(client.objects) == {f"v1/test/{key}" for key, *_ in operations}
    for key, _tier, cache in operations:
        full = f"v1/test/{key}"
        request = client.objects[full]
        path = tmp_path / "v1" / "test" / Path(key)
        assert remote.full_key(key) == full
        assert local.full_key(key) == str(path.resolve())
        assert path.read_bytes() == request["Body"]
        assert request["ContentType"] == "application/json"
        assert request["CacheControl"] == cache
    remote.close()


@pytest.mark.parametrize("backend", ["local", "s3"])
def test_default_publication_keeps_failure_and_activation_contract(tmp_path, backend):
    remote, local, client = storage_pair(tmp_path)
    store = local if backend == "local" else remote
    root, leaf = "historic/history/index.json", "historic/history/leaf.json"
    store.put_immutable_json(leaf, {"value": "old"})
    absent = store.capture_stable_version(root)
    store.activate_stable_json(root, {"leaf": leaf}, expected_version=absent, tier="historic")
    old = (
        Path(local.full_key(root)).read_bytes()
        if backend == "local"
        else client.objects[remote.full_key(root)]["Body"]
    )
    with pytest.raises(ImmutableKeyCollisionError):
        store.put_immutable_json(leaf, {"value": "different"})
    with pytest.raises(StableActivationConflictError):
        store.activate_stable_json(
            root, {"leaf": "different"}, expected_version=absent, tier="historic"
        )
    current = (
        Path(local.full_key(root)).read_bytes()
        if backend == "local"
        else client.objects[remote.full_key(root)]["Body"]
    )
    assert current == old == b'{"leaf":"historic/history/leaf.json"}'
    assert store.get_json(leaf) == {"value": "old"}
    remote.close()
