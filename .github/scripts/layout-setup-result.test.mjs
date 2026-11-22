import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLayoutRan,
  classifyLayoutJobs,
  setupFailureDetails,
} from "./layout-setup-result.mjs";
import { reportAttempt } from "./post-deploy-layout.mjs";

test("startup without results is setup failure; executed failed assertions remain layout failure", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-execution-"));
  try {
    const path = join(root, "report.json");
    assert.throws(
      () => assertLayoutRan(path),
      /no readable Playwright execution report/,
    );
    writeFileSync(
      path,
      JSON.stringify({ suites: [], errors: [{ message: "webServer failed" }] }),
    );
    assert.throws(() => assertLayoutRan(path), /no layout test executed/);
    writeFileSync(
      path,
      JSON.stringify({
        suites: [{ specs: [{ tests: [{ results: [{ status: "failed" }] }] }] }],
      }),
    );
    assert.doesNotThrow(() => assertLayoutRan(path));
    const all = setupJobs();
    all[3].steps = [
      { name: "layout", conclusion: "failure" },
      { name: "Confirm layout test execution", conclusion: "failure" },
    ];
    assert.equal(classifyLayoutJobs(all).layoutFailure, false);
    assert.match(classifyLayoutJobs(all).setup, /\(4\)/);
    all[3].steps[1].conclusion = "success";
    assert.equal(classifyLayoutJobs(all).layoutFailure, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("both container grids guard timing records when tests never start and reporting can read attempt jobs", () => {
  const workflow = readFileSync(
    new URL("../workflows/web.yml", import.meta.url),
    "utf8",
  );
  for (const name of [
    "Record layout timing provenance",
    "Upload complete layout timings",
  ]) {
    const step = workflow
      .split(`      - name: ${name}\n`)[1]
      .split(/\n      - name:/)[0];
    assert.match(step, /steps.layout_execution.outcome == 'success'/);
  }
  assert.match(workflow, /name: layout\n\s+id: layout/);
  const replay = workflow
    .split("\n  post-deploy-layout:\n")[1]
    .split("\n  post-deploy-result:\n")[0];
  assert.match(replay, /steps: \*layout-steps/);
  const result = workflow.split("\n  post-deploy-result:\n")[1];
  assert.match(result, /actions: read/);
  assert.ok(
    result.includes(
      "HEALTH_RESULT: ${{ needs.deploy-production.outputs.health_checks }}",
    ),
  );
});

function jobs() {
  return Array.from({ length: 12 }, (_, i) => ({
    name: `post-deploy-layout (${i + 1})`,
    run_id: 123,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    steps: [{ name: "layout", conclusion: "success" }],
  }));
}
function setupJobs() {
  const all = jobs();
  all[3] = {
    ...all[3],
    conclusion: "failure",
    steps: [
      { name: "Set up JS workspace", conclusion: "failure" },
      { name: "layout", conclusion: "skipped" },
    ],
  };
  return all;
}
test("setup failures identify the shard and failed step; actual layout failures retain the existing path", () => {
  assert.match(
    classifyLayoutJobs(setupJobs()).setup,
    /post-deploy-layout \(4\): Set up JS workspace/,
  );
  const all = setupJobs();
  all[3].steps = [
    { name: "Plan layout shards", conclusion: "failure" },
    { name: "layout", conclusion: "skipped" },
  ];
  assert.match(classifyLayoutJobs(all).setup, /Plan layout shards/);
  all[3].steps = [
    { name: "Build layout test app", conclusion: "failure" },
    { name: "layout", conclusion: "skipped" },
  ];
  assert.match(classifyLayoutJobs(all).setup, /Build layout test app/);
  all[3].steps = [{ name: "layout", conclusion: "failure" }];
  assert.equal(classifyLayoutJobs(all).setup, null);
  all[3].steps = [];
  assert.match(classifyLayoutJobs(all).setup, /initialization/);
  assert.throws(() => classifyLayoutJobs(all.slice(1)), /Incomplete/);
  assert.deepEqual(classifyLayoutJobs(jobs()), {
    setup: null,
    layoutFailure: false,
  });
});
test("attempt-specific metadata failure cannot masquerade as a layout regression", () => {
  const env = {
    GH_REPO: "yesid-dev/transit",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const execute = (_, args) => {
    assert.ok(
      args.includes(
        "repos/yesid-dev/transit/actions/runs/123/attempts/1/jobs?per_page=100",
      ),
    );
    return JSON.stringify([{ jobs: setupJobs() }]);
  };
  assert.match(setupFailureDetails(env, execute).setup, /\(4\)/);
  assert.match(
    setupFailureDetails(env, () => {
      throw Error("403");
    }).setup,
    /unavailable/,
  );
  assert.match(
    setupFailureDetails({ ...env, GITHUB_RUN_ATTEMPT: "2" }, () =>
      JSON.stringify([{ jobs: setupJobs() }]),
    ).setup,
    /unavailable/,
  );
});
test("setup alerts are red, distinct, identify missing layout coverage and health, without rollback advice", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-setup-alert-"));
  try {
    for (const health of ["success", "failure"]) {
      const calls = [];
      const env = {
        GH_REPO: "yesid-dev/transit",
        GITHUB_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        LAYOUT_RESULT: "failure",
        DEPLOY_RESULT: health,
        HEALTH_RESULT: health,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
      };
      const execute = (cmd, args) => {
        if (cmd === "gh" && args[0] === "api")
          return JSON.stringify([{ jobs: setupJobs() }]);
        calls.push(args);
        return "";
      };
      assert.throws(
        () => reportAttempt(env, execute),
        /could not run; setup alert published/,
      );
      assert.match(calls[0][3], /verification could not run/);
      assert.equal(calls[0][2], "layout-setup-123-1");
      assert.match(calls[0][4], /Layout was not checked/);
      assert.match(
        calls[0][4],
        /post-deploy-layout \(4\): Set up JS workspace/,
      );
      assert.ok(
        calls[0][4].includes(
          `Health checks: ${health === "success" ? "passed" : "failed"}`,
        ),
      );
      assert.doesNotMatch(
        calls[0][4],
        /rollback|layout failure|Deployment verification failed/i,
      );
    }
    assert.match(
      readFileSync(join(root, "summary"), "utf8"),
      /Layout was not checked/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("real test failure still publishes today's alert and rollback command", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-layout-alert-"));
  try {
    const all = jobs();
    all[3].conclusion = "failure";
    all[3].steps[0].conclusion = "failure";
    let alert;
    const execute = (cmd, args) => {
      if (cmd === "gh") return JSON.stringify([{ jobs: all }]);
      alert = args;
      return "";
    };
    assert.throws(
      () =>
        reportAttempt(
          {
            GH_REPO: "yesid-dev/transit",
            GITHUB_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            LAYOUT_RESULT: "failure",
            DEPLOY_RESULT: "success",
            ROLLBACK_VERSION: "12345678-1234-1234-1234-123456789abc",
            GITHUB_STEP_SUMMARY: join(root, "summary"),
          },
          execute,
        ),
      /rollback command recorded/,
    );
    assert.match(alert[3], /Deployment verification failed/);
    assert.match(alert[4], /gh workflow run rollback/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed setup and layout failures publish both distinct alerts", () => {
  const root = mkdtempSync(join(tmpdir(), "transit-mixed-alert-"));
  try {
    const all = setupJobs();
    all[4].conclusion = "failure";
    all[4].steps[0].conclusion = "failure";
    const diagnosis = classifyLayoutJobs(all);
    assert.match(diagnosis.setup, /\(4\)/);
    assert.equal(diagnosis.layoutFailure, true);
    const alerts = [];
    const execute = (cmd, args) => {
      if (cmd === "gh") return JSON.stringify([{ jobs: all }]);
      alerts.push(args);
      return "";
    };
    assert.throws(
      () =>
        reportAttempt(
          {
            GH_REPO: "yesid-dev/transit",
            GITHUB_SHA: "a".repeat(40),
            GITHUB_RUN_ID: "123",
            GITHUB_RUN_ATTEMPT: "1",
            LAYOUT_RESULT: "failure",
            DEPLOY_RESULT: "success",
            HEALTH_RESULT: "success",
            ROLLBACK_VERSION: "12345678-1234-1234-1234-123456789abc",
            GITHUB_STEP_SUMMARY: join(root, "summary"),
          },
          execute,
        ),
      /rollback command recorded/,
    );
    assert.equal(alerts.length, 2);
    assert.match(alerts[0][3], /could not run/);
    assert.doesNotMatch(alerts[0][4], /rollback/i);
    assert.match(alerts[1][3], /Deployment verification failed/);
    assert.match(alerts[1][4], /rollback/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
