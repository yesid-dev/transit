import re
from pathlib import Path

import yaml


def test_replay_workflow_has_only_manual_read_only_access():
    path = Path(__file__).resolve().parents[3] / ".github/workflows/batch-replay.yml"
    workflow = yaml.safe_load(path.read_text())
    assert set(workflow.get("on", workflow.get(True))) == {"workflow_dispatch"}
    replay = workflow["jobs"]["replay"]
    assert replay["environment"] == "batch-replay"
    assert replay["runs-on"] == "ubuntu-24.04"
    assert workflow["permissions"] == {"contents": "read"}
    text = path.read_text()
    assert set(re.findall(r"secrets\.([A-Z0-9_]+)", text)) == {
        "BATCH_REPLAY_R2_ACCESS_KEY",
        "BATCH_REPLAY_R2_SECRET_KEY",
    }
    assert not re.search(r"\b(?:DATABASE_URL|ADMIN_DATABASE_URL)\b", text)
    for job in workflow["jobs"].values():
        for step in job["steps"]:
            if "uses" in step and not step["uses"].startswith("./"):
                assert re.fullmatch(r"[^@]+@[a-f0-9]{40}", step["uses"])
    runs = "\n".join(s.get("run", "") for s in replay["steps"])
    assert "batch fetch-inputs" in runs and "batch replay-day" in runs
    assert not re.search(r"(?:aws\s+s3|rclone|wrangler|shadow-build|publish|upload)", runs)
    upload = next(s for s in replay["steps"] if "upload-artifact@" in s.get("uses", ""))
    assert upload["if"] == "${{ !cancelled() }}"
    assert "report-*.json" in upload["with"]["path"]
