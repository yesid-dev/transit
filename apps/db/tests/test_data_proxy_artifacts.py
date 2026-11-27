from __future__ import annotations

import json
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
PROXY_DIR = REPO_ROOT / "apps" / "data-proxy"
WRANGLER_TOML = PROXY_DIR / "wrangler.toml"
DEPLOY_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-data-proxy.yml"
PUBLISH_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "daily-warm-rollups.yml"
WEB_WRANGLER_TOML = REPO_ROOT / "apps" / "web" / "wrangler.toml"


def _wrangler_config() -> dict:
    return tomllib.loads(WRANGLER_TOML.read_text(encoding="utf-8"))


def _deploy_workflow() -> dict:
    return yaml.safe_load(DEPLOY_WORKFLOW.read_text(encoding="utf-8"))


def _workflow_triggers(workflow: dict) -> dict:
    return workflow.get("on", workflow.get(True))


def test_wrangler_config_pins_v2_and_narrow_retirement_routes() -> None:
    config = _wrangler_config()

    assert config["name"] == "transit-data-proxy"
    assert config["main"] == "src/entrypoint.js"
    assert config["routes"] == [
        {"pattern": "transit.yesid.dev/data/v1/*", "zone_name": "yesid.dev"},
        {"pattern": "transit.yesid.dev/api/v1/*", "zone_name": "yesid.dev"},
        {"pattern": "transit.yesid.dev/v1/*", "zone_name": "yesid.dev"},
        {"pattern": "data.yesid.dev/v1/*", "zone_name": "yesid.dev"},
        {"pattern": "data.yesid.dev/v2/*", "zone_name": "yesid.dev"},
    ]
    assert "r2_buckets" not in config


def test_wrangler_config_disables_workers_dev_and_pins_account() -> None:
    config = _wrangler_config()

    assert config["workers_dev"] is False
    assert config["account_id"] == "eccfb9bedd87d413eaf4cac6ae2285d3"
    assert (
        tomllib.loads(WEB_WRANGLER_TOML.read_text(encoding="utf-8"))["account_id"]
        == (config["account_id"])
    )


def test_deploy_workflow_runs_worker_tests_then_wrangler_action() -> None:
    workflow = _deploy_workflow()

    triggers = _workflow_triggers(workflow)
    assert "workflow_dispatch" not in triggers
    assert triggers["push"]["branches"] == ["main"]
    assert "apps/data-proxy/**" in triggers["push"]["paths"]
    assert ".github/workflows/deploy-data-proxy.yml" in triggers["push"]["paths"]
    assert workflow["permissions"] == {"contents": "read"}

    jobs = workflow["jobs"]
    test_job = jobs["test-data-proxy"]
    deploy_job = jobs["deploy-data-proxy"]

    test_runs = [step.get("run", "") for step in test_job["steps"]]
    assert any("node --test" in run for run in test_runs), (
        "test job must run the worker behavioral suite"
    )
    assert deploy_job["needs"] == "test-data-proxy", "tests must gate the deploy"

    assert deploy_job["if"] == ("github.event_name == 'push' && github.ref == 'refs/heads/main'")
    assert deploy_job["environment"] == "production"

    deploy_steps = deploy_job["steps"]
    wrangler_steps = [
        step
        for step in deploy_steps
        if "wrangler" in step.get("run", "") and "deploy" in step.get("run", "")
    ]
    assert wrangler_steps, "deploy job must publish via `wrangler deploy`"
    wrangler_step = wrangler_steps[0]
    assert wrangler_step["env"]["CLOUDFLARE_API_TOKEN"] == "${{ secrets.CLOUDFLARE_API_TOKEN }}"
    secret_names = (
        "TRANSIT1_ENGINE_ACCESS_TOKEN",
        "TRANSIT1_R2_ENDPOINT",
        "TRANSIT1_R2_READ_ACCESS_KEY_ID",
        "TRANSIT1_R2_READ_SECRET_ACCESS_KEY",
    )
    for name in secret_names:
        assert wrangler_step["env"][name] == "${{ secrets." + name + " }}"
        assert f"'{name}'" in wrangler_step["run"]

    deploy_runs = [step.get("run", "") for step in deploy_steps]
    wrangler_index = deploy_steps.index(wrangler_step)
    smoke_index = next(index for index, run in enumerate(deploy_runs) if run == "bash smoke.sh")
    assert smoke_index > wrangler_index, "live smoke must verify the deployed Worker"

    root_pkg = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    proxy_pkg = json.loads((PROXY_DIR / "package.json").read_text(encoding="utf-8"))
    assert root_pkg["devDependencies"]["wrangler"] == "4.154.0"
    assert "wrangler" not in proxy_pkg.get("devDependencies", {})
    assert any(step.get("uses") == "./.github/actions/setup" for step in deploy_steps)
    deploy_commands = wrangler_step["run"].splitlines()
    assert "umask 077" in deploy_commands
    assert "writeFileSync(process.argv[2], JSON.stringify(secrets));" in deploy_commands
    assert (
        '../../node_modules/.bin/wrangler deploy --secrets-file "$proxy_secrets"' in deploy_commands
    )


def test_legacy_publish_and_web_do_not_share_snapshot_configuration() -> None:
    publish_env = yaml.safe_load(PUBLISH_WORKFLOW.read_text(encoding="utf-8"))["jobs"]["publish"][
        "env"
    ]
    web_config = tomllib.loads(WEB_WRANGLER_TOML.read_text(encoding="utf-8"))

    assert publish_env["SNAPSHOT_PUBLIC_BASE_URL"] == ("${{ secrets.SNAPSHOT_PUBLIC_BASE_URL }}")
    assert "PUBLIC_V1_BASE" not in web_config.get("vars", {})
    assert all(bucket.get("binding") != "SNAPSHOTS" for bucket in web_config.get("r2_buckets", []))

@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_smoke_script_committed_with_executable_bit() -> None:
    result = subprocess.run(
        ["git", "ls-files", "--stage", "--", "apps/data-proxy/smoke.sh"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip(f"not a git checkout: {result.stderr.strip()}")

    assert result.stdout.strip(), "smoke.sh must be tracked by git"
    mode = result.stdout.split()[0]
    assert mode == "100755", (
        f"smoke.sh tracked as {mode}; fresh clones would get a non-executable file"
    )

@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_worker_behavioral_suite_passes_under_node() -> None:
    test_files = sorted(
        path.relative_to(PROXY_DIR).as_posix() for path in (PROXY_DIR / "test").glob("*.test.mjs")
    )
    assert test_files, "worker behavioral suite has no test files"

    result = subprocess.run(
        ["node", "--test", *test_files],
        cwd=PROXY_DIR,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
