import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPaths, checkRequiredJobs, DB_JOBS } from "./ci-paths.mjs";

test("classify CLI sees both sides of renames and runs all checks when a diff is unavailable", (t) => {
  const parent = resolve(tmpdir());
  const root = mkdtempSync(join(parent, "transit-ci-paths-"));
  t.after(() => {
    const within = relative(parent, resolve(root));
    assert.ok(
      within &&
        !isAbsolute(within) &&
        within !== ".." &&
        !within.startsWith(`..${sep}`),
    );
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=CI test",
        "-c",
        "user.email=ci@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  mkdirSync(join(root, "apps/db"), { recursive: true });
  mkdirSync(join(root, "apps/engine"), { recursive: true });
  mkdirSync(join(root, "apps/web"), { recursive: true });
  writeFileSync(join(root, "apps/db/old file.py"), "fixture\n");
  git("add", "apps/db/old file.py");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  renameSync(
    join(root, "apps/db/old file.py"),
    join(root, "apps/web/new file.ts"),
  );
  git("add", "apps/db/old file.py", "apps/web/new file.ts");
  git("commit", "--quiet", "-m", "rename");
  const head = git("rev-parse", "HEAD");
  const eventPath = join(root, "event.json");
  const output = join(root, "output");
  const classify = (baseSha, headSha, eventName = "pull_request") => {
    writeFileSync(
      eventPath,
      JSON.stringify(
        {
          merge_group: { merge_group: { base_sha: baseSha, head_sha: headSha } },
          pull_request: {
            pull_request: { base: { sha: baseSha }, head: { sha: headSha } },
          },
          push: { before: baseSha, after: headSha },
        }[eventName],
      ),
    );
    writeFileSync(output, "");
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./ci-paths.mjs", import.meta.url)), "classify"],
      {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: eventName,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: output,
        },
        stdio: "pipe",
      },
    );
    return readFileSync(output, "utf8").trim();
  };
  assert.equal(classify(base, head), "run_db=true");
  assert.equal(classify("f".repeat(40), head), "run_db=true");
  assert.equal(classify("--not-a-sha", head), "run_db=true");
  writeFileSync(join(root, "apps/web/new file.ts"), "web change\n");
  git("add", "apps/web/new file.ts");
  git("commit", "--quiet", "-m", "web only");
  assert.equal(classify(head, git("rev-parse", "HEAD")), "run_db=false");
  assert.equal(
    classify(head, git("rev-parse", "HEAD"), "merge_group"),
    "run_db=false",
  );
  assert.equal(
    classify(base, git("rev-parse", "HEAD"), "merge_group"),
    "run_db=true",
  );
  for (const invalid of [undefined, "--bad", "f".repeat(40)]) {
    assert.equal(classify(invalid, head, "merge_group"), "run_db=true");
    assert.equal(classify(base, invalid, "merge_group"), "run_db=true");
  }
  const engineBase = git("rev-parse", "HEAD");
  writeFileSync(join(root, "apps/engine/engine.py"), "engine change\n");
  git("add", "apps/engine/engine.py");
  git("commit", "--quiet", "-m", "engine only");
  const engineHead = git("rev-parse", "HEAD");
  for (const event of ["pull_request", "merge_group", "push"]) {
    assert.equal(classify(engineBase, engineHead, event), "run_db=false");
    assert.equal(classify(base, engineHead, event), "run_db=true");
  }
  assert.equal(classify("0".repeat(40), engineHead, "push"), "run_db=true");
});

test("web, proxy, engine and documentation changes skip DB work", () => {
  for (const paths of [
    ["apps/web/src/app.css"],
    ["apps/data-proxy/index.js"],
    ["apps/engine/src/transit_engine/timing.py", "apps/engine/uv.lock"],
    ["CONTRIBUTING.md"],
    ["docs/guide.md"],
  ]) {
    assert.equal(classifyPaths(paths), false);
  }
});

test("DB, CI, shared configuration and unknown paths run the DB checks", () => {
  for (const path of [
    "apps/db/src/model.py",
    "apps/db/uv.lock",
    ".github/scripts/ci-paths.mjs",
    ".github/workflows/web.yml",
    ".github/actions/setup-py/action.yml",
    ".github/dependabot.yml",
    ".python-version",
    ".bun-version",
    ".nvmrc",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    ".gitleaks.toml",
    ".npmrc",
    "bun.lock",
    "package.json",
    "turbo.json",
    "contracts/kpis-v1.js",
    "new-root-file",
  ]) {
    assert.equal(classifyPaths([path]), true);
    assert.equal(classifyPaths(["apps/engine/engine.py", path]), true);
  }
  for (const paths of [
    [],
    null,
    [""],
  ]) {
    assert.equal(classifyPaths(paths), true);
  }
  assert.equal(
    classifyPaths(["README.md", "apps/db/tests/test_model.py"]),
    true,
  );
});

const expectedDbJobs = [
  "offline-tests-work",
  "db-quality-work",
  "alembic-single-head-work",
  "real-db-tests-work",
];

function needs(relevant = true) {
  return {
    classify: { result: "success", outputs: { run_db: String(relevant) } },
    ...Object.fromEntries(
      expectedDbJobs.map((job) => [job, { result: relevant ? "success" : "skipped" }]),
    ),
  };
}

test("required checks accept successful work and deliberately skipped DB work", () => {
  assert.deepEqual(DB_JOBS, expectedDbJobs);
  assert.doesNotThrow(() => checkRequiredJobs(needs()));
  assert.doesNotThrow(() => checkRequiredJobs(needs(false)));
});

test("required checks fail closed on classifier failure, missing output or incomplete work", () => {
  for (const result of ["failure", "cancelled", "skipped"]) {
    const jobs = needs();
    jobs.classify.result = result;
    assert.throws(() => checkRequiredJobs(jobs));
  }
  for (const job of expectedDbJobs) {
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      const jobs = needs();
      jobs[job].result = result;
      assert.throws(() => checkRequiredJobs(jobs), new RegExp(job));
    }
  }
  for (const runDb of ["", "maybe", undefined]) {
    const jobs = needs(false);
    jobs.classify.outputs.run_db = runDb;
    assert.throws(() => checkRequiredJobs(jobs));
  }
  const failedSkip = needs(false);
  failedSkip[DB_JOBS[0]].result = "failure";
  assert.throws(() => checkRequiredJobs(failedSkip));
});
