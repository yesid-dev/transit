from pathlib import Path

from publication_target_cases import storage_pair


def test_default_target_and_revision_2_target_keep_storage_roots(tmp_path):
    from transit_ops.settings import Settings
    from transit_ops.snapshots.publication_target import REVISION_2_TARGET
    from transit_ops.snapshots.storage import build_snapshot_storage

    remote, _local, client = storage_pair(tmp_path)
    for backend in ("local", "s3"):
        settings = Settings(
            _env_file=None,
            SNAPSHOT_STORAGE_BACKEND=backend,
            SNAPSHOT_LOCAL_ROOT=str(tmp_path),
            SNAPSHOT_R2_BUCKET="test-bucket",
        )
        for provider, prefix in (("r2guard", "v1/r2guard"), (None, "v1")):
            default = build_snapshot_storage(settings, provider_id=provider, client=client)
            explicit = build_snapshot_storage(
                settings, provider_id=provider, client=client, target=REVISION_2_TARGET
            )
            expected = prefix + "/historic/example.json"
            if backend == "local":
                expected = str(tmp_path.joinpath(*expected.split("/")).resolve())
            assert default.full_key("historic/example.json") == expected
            assert explicit.full_key("historic/example.json") == expected
            if backend == "s3":
                default.close()
                explicit.close()
    remote.close()


def test_explicit_target_changes_only_the_isolated_test_root(tmp_path):
    from transit_ops.settings import Settings
    from transit_ops.snapshots.publication_target import REVISION_3_TARGET
    from transit_ops.snapshots.storage import build_snapshot_storage

    remote, _local, client = storage_pair(tmp_path)
    settings = Settings(
        _env_file=None, SNAPSHOT_STORAGE_BACKEND="s3", SNAPSHOT_R2_BUCKET="test-bucket"
    )
    isolated = build_snapshot_storage(
        settings, provider_id="r2guard", client=client, target=REVISION_3_TARGET
    )
    local = build_snapshot_storage(
        Settings(
            _env_file=None, SNAPSHOT_STORAGE_BACKEND="local", SNAPSHOT_LOCAL_ROOT=str(tmp_path)
        ),
        provider_id="r2guard",
        target=REVISION_3_TARGET,
    )
    for store in (isolated, local):
        store.put_bytes("historic/example.json", b'{"value":null}', tier="historic")
    assert list(client.objects) == ["v1/r2guard/r3/historic/example.json"]
    obj = client.objects["v1/r2guard/r3/historic/example.json"]
    assert obj["Body"] == b'{"value":null}'
    assert obj["ContentType"] == "application/json"
    assert obj["CacheControl"] == "public, max-age=3600, stale-while-revalidate=86400"
    assert Path(local.full_key("historic/example.json")).read_bytes() == obj["Body"]
    assert not (tmp_path / "v1/r2guard/historic").exists()
    remote.close()
    isolated.close()


def test_publication_target_policy_is_immutable_and_unknown_models_refuse():
    import pytest

    from transit_ops.snapshots.contract import NetworkTrend
    from transit_ops.snapshots.publication_target import REVISION_2_TARGET, REVISION_3_TARGET

    assert REVISION_2_TARGET.token_for_model(NetworkTrend) == "reliability-2"
    assert REVISION_2_TARGET.model_by_path("historic/network_trend.json") is NetworkTrend
    with pytest.raises(ValueError, match="publication_target_not_ready"):
        REVISION_3_TARGET.model_by_path("historic/network_trend.json")


def test_nondefault_catalog_and_unsafe_target_suffix_refuse_before_io(tmp_path):
    from dataclasses import replace

    import pytest

    from transit_ops.settings import Settings
    from transit_ops.snapshots.publication_target import REVISION_3_TARGET
    from transit_ops.snapshots.storage import build_snapshot_storage

    root = tmp_path / "absent"
    settings = Settings(
        _env_file=None, SNAPSHOT_STORAGE_BACKEND="local", SNAPSHOT_LOCAL_ROOT=str(root)
    )
    for suffix in ("r3", ""):
        with pytest.raises(ValueError, match="requires_provider"):
            build_snapshot_storage(
                settings, provider_id=None, target=replace(REVISION_3_TARGET, root_suffix=suffix)
            )
    for suffix in ("../r3", "/r3", "a/b", "a\\b", "%72%33", ".", "r3?", "r3#", "r3 "):
        with pytest.raises(ValueError):
            build_snapshot_storage(
                settings, provider_id="test", target=replace(REVISION_3_TARGET, root_suffix=suffix)
            )
    assert not root.exists()


def test_policy_copies_nested_inputs_and_refuses_unknowns():
    from dataclasses import FrozenInstanceError, replace

    import pytest
    from pydantic import BaseModel

    from transit_ops.snapshots.contract import HistoricCollectionIndex, NetworkTrend
    from transit_ops.snapshots.publication_target import REVISION_2_TARGET, REVISION_3_TARGET

    tokens = {NetworkTrend: "example"}
    metrics = {"network": ["delay"]}
    target = replace(REVISION_2_TARGET, token_by_model=tokens, history_metrics=metrics)
    tokens.clear()
    metrics["network"].append("other")
    assert target.token_for_model(NetworkTrend) == "example"
    assert target.history_metrics["network"] == ("delay",)
    with pytest.raises(TypeError):
        target.token_by_model[NetworkTrend] = "changed"
    with pytest.raises(FrozenInstanceError):
        target.root_suffix = "changed"
    with pytest.raises(ValueError, match="unknown_model"):
        target.token_for_model(BaseModel)
    with pytest.raises(ValueError, match="unknown_publication_path"):
        target.model_by_path("historic/unknown.json")
    with pytest.raises(ValueError, match="publication_target_not_ready"):
        REVISION_3_TARGET.token_for_model(NetworkTrend)
    assert REVISION_3_TARGET.history_metrics == {}
    assert REVISION_3_TARGET.token_by_model == {}
    assert target.model_by_path("historic/history/network/index.json") is HistoricCollectionIndex
    assert REVISION_2_TARGET.history_metrics["stops"] == ("delay", "delay_percentiles", "occupancy")
