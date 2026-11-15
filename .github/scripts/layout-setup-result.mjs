import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Read attempt-specific jobs so container/checkout failures need no artifact upload.
export function classifyLayoutJobs(jobs) {
  const shards = jobs.filter((job) =>
    /^post-deploy-layout \(\d+\)$/.test(job.name),
  );
  if (shards.length !== 12 || new Set(shards.map((j) => j.name)).size !== 12)
    throw new Error("Incomplete post-deploy shard evidence");
  const failures = [];
  let layoutFailure = false;
  for (const job of shards) {
    if (job.status !== "completed")
      throw new Error("Incomplete post-deploy job");
    if (job.conclusion === "success") continue;
    const layout = job.steps?.find((step) => step.name === "layout");
    const execution = job.steps?.find(
      (step) => step.name === "Confirm layout test execution",
    );
    // Once the layout command started, retain today's layout-failure behavior.
    if (
      layout &&
      layout.conclusion !== "skipped" &&
      layout.conclusion !== null &&
      execution?.conclusion !== "failure"
    ) {
      layoutFailure = true;
      continue;
    }
    const step = job.steps?.find((s) =>
      ["failure", "cancelled", "timed_out"].includes(s.conclusion),
    );
    failures.push(
      `${job.name}: ${step?.name ?? "container/job initialization (no step evidence)"} (${job.conclusion})`,
    );
  }
  return { setup: failures.length ? failures.join("\n") : null, layoutFailure };
}

export function assertLayoutRan(path) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      "Layout verification could not run: no readable Playwright execution report",
    );
  }
  const ran = (suites) =>
    Array.isArray(suites) &&
    suites.some(
      (suite) =>
        suite.specs?.some((spec) =>
          spec.tests?.some((test) =>
            test.results?.some((result) =>
              ["passed", "failed", "timedOut", "interrupted"].includes(
                result.status,
              ),
            ),
          ),
        ) || ran(suite.suites),
    );
  if (!ran(report.suites))
    throw new Error(
      "Layout verification could not run: no layout test executed",
    );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv[2] !== "assert-ran")
    throw new Error("Expected assert-ran REPORT");
  assertLayoutRan(process.argv[3]);
}

export function setupFailureDetails(env, execute) {
  try {
    const pages = JSON.parse(
      execute(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${env.GH_REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
        ],
        { env, encoding: "utf8" },
      ),
    );
    if (!Array.isArray(pages) || !pages.length)
      throw new Error("Missing job evidence");
    const jobs = pages.flatMap((p) => p.jobs ?? []);
    if (
      jobs.some(
        (j) =>
          String(j.run_id) !== env.GITHUB_RUN_ID ||
          String(j.run_attempt) !== env.GITHUB_RUN_ATTEMPT,
      )
    )
      throw new Error("Wrong attempt evidence");
    return classifyLayoutJobs(jobs);
  } catch {
    return {
      setup:
        "Shard/step evidence unavailable: could not authenticate complete attempt-specific job metadata; layout coverage is unconfirmed.",
      layoutFailure: false,
    };
  }
}
