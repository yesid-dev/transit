import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, selectPromotion } from "./web-artifact-promotion.mjs";

const env = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REPOSITORY: "yesid-dev/transit",
};
const seal = "b".repeat(64);
const run = {
  id: 123,
  run_attempt: 2,
  event: "merge_group",
  status: "completed",
  conclusion: "success",
  head_sha: env.GITHUB_SHA,
  repository: { full_name: env.GITHUB_REPOSITORY },
  path: ".github/workflows/web.yml",
};
const artifact = {
  id: 456,
  expired: false,
  name: `transit-web-${env.GITHUB_SHA}-production-2-${seal}`,
};
const browserJobs = [1, 2, 3, 4].map((shard) => ({
  name: `e2e (${shard})`,
  run_id: run.id,
  run_attempt: run.run_attempt,
  status: "completed",
  conclusion: "success",
}));
const api =
  (runs = [run], artifacts = [artifact], jobs = browserJobs) =>
  async (path) => {
    if (path.startsWith("/actions/workflows/")) return { workflow_runs: runs };
    if (path === "/actions/runs/123/artifacts?per_page=100") return { artifacts };
    if (path === "/actions/runs/123/attempts/2/jobs?per_page=100")
      return { jobs, total_count: jobs.length };
    throw new Error(`Unexpected API request: ${path}`);
  };

test("fallback is the default without a successful same-SHA queue producer", async () => {
  assert.equal(await selectPromotion(env, api([])), null);
  for (const patch of [
    { event: "pull_request" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { head_sha: "c".repeat(40) },
    { repository: { full_name: "other/transit" } },
    { path: ".github/workflows/other.yml" },
  ]) {
    assert.equal(await selectPromotion(env, api([{ ...run, ...patch }])), null);
  }
  for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
    assert.equal(
      await selectPromotion({ ...env, GITHUB_EVENT_NAME: event }, () => {
        throw new Error("must not query");
      }),
      null,
    );
  }
});

test("promotion is bound to repository, exact SHA, successful workflow, attempt and manifest seal", async () => {
  assert.deepEqual(await selectPromotion(env, api()), {
    artifact_id: "456",
    run_id: "123",
    producer_attempt: "2",
    manifest_sha256: seal,
  });
  for (const patch of [
    { expired: true },
    { name: artifact.name.replace("-2-", "-1-") },
    { name: artifact.name.replace("-production-", "-verification-") },
    { name: artifact.name.slice(0, -1) },
    { id: 0 },
  ]) {
    assert.equal(
      await selectPromotion(env, api([run], [{ ...artifact, ...patch }])),
      null,
    );
  }
  assert.equal(
    await selectPromotion(
      env,
      api([run], [artifact, { ...artifact, id: 789 }]),
    ),
    null,
  );
});

test("a successful merge group without four successful shards on the artifact attempt uses a source build", async () => {
  const firstThree = browserJobs.slice(0, 3);
  const fourth = browserJobs[3];
  for (const jobs of [
    [],
    firstThree,
    [...firstThree, { ...fourth, conclusion: "skipped" }],
    [...firstThree, { ...fourth, conclusion: "failure" }],
    [...firstThree, { ...fourth, conclusion: "cancelled" }],
    [...firstThree, { ...fourth, run_attempt: 1 }],
    [...firstThree, { ...fourth, run_id: 789 }],
    [...browserJobs, fourth],
  ]) {
    assert.equal(await selectPromotion(env, api([run], [artifact], jobs)), null);
  }
});

test("API failure explicitly selects a source build, never an unverified artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "transit-promotion-"));
  try {
    const output = join(directory, "output");
    await main(
      { ...env, GITHUB_OUTPUT: output, GH_TOKEN: "test" },
      async () => ({ ok: false, status: 403 }),
    );
    assert.equal(readFileSync(output, "utf8"), "promoted=false\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
