import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setupFailureDetails } from "./layout-setup-result.mjs";
import { liveProductionSha, WEB_ORIGIN } from "./deploy-scope.mjs";

export async function verifyDeployedSha(
  sha,
  fetcher = fetch,
  {
    deadlineMs = 90_000,
    intervalMs = 3_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    log = console.log,
  } = {},
) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) {
    throw new Error(
      "Production Worker does not report the deployed source SHA",
    );
  }
  const start = now();
  while (true) {
    const reported = await liveProductionSha(fetcher);
    const elapsed = now() - start;
    const seconds = elapsed / 1_000;
    if (reported === sha) {
      log(
        `Production Worker reports the deployed source SHA after ${seconds}s`,
      );
      return;
    }
    if (elapsed >= deadlineMs) {
      throw new Error(
        `Production Worker does not report the deployed source SHA: expected ${sha}, reported ${reported ?? "nothing"}, waited ${seconds}s`,
      );
    }
    log(
      `Waiting for deployed source SHA: waited ${seconds}s, reported ${reported ?? "nothing"}`,
    );
    await sleep(intervalMs);
  }
}

export async function verifySitePolicy(fetcher = fetch) {
  const request = (path, options = {}) => fetcher(`${WEB_ORIGIN}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    ...options,
  });
  const page = await request("/?provider=stm");
  if (!page.ok || !page.headers.get("content-type")?.includes("text/html"))
    throw new Error("Cannot read transit1 HTML");
  if (page.headers.get("x-robots-tag") !== "noindex, nofollow")
    throw new Error("transit1 HTML is missing noindex, nofollow");
  if (/static\.cloudflareinsights\.com\/beacon|\/cdn-cgi\/rum/i.test(await page.text()))
    throw new Error("Cloudflare Web Analytics beacon found on transit1");

  // An empty object cannot pass the relay's event schema or reach Plausible.
  const relay = await request("/relay/e", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (relay.status !== 404)
    throw new Error(`Expected disabled transit1 analytics relay to return 404, got ${relay.status}`);
}

export function report(
  env = process.env,
  execute = execFileSync,
  { throwOnFailure = true } = {},
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO ?? "") ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]{0,9}$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw new Error("Invalid deployment report identity");
  const validVersion =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      env.ROLLBACK_VERSION ?? "",
    );
  const rollback = validVersion
    ? `Rollback command (captured pre-deployment Worker version):\n\n\`\`\`sh\ngh workflow run rollback.yml -R ${env.GH_REPO} --ref main -f version=${env.ROLLBACK_VERSION}\n\`\`\``
    : "No pre-deployment Worker version was captured. For a failed first release, fix forward or detach the transit1.yesid.dev Custom Domain.";
  const slug = `${env.LAYOUT_SETUP_FAILURE ? "layout-setup" : "layout"}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const url = `https://github.com/${env.GH_REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
  const failed =
    env.DEPLOY_RESULT !== "success" || env.LAYOUT_RESULT !== "success";
  const setup = env.LAYOUT_SETUP_FAILURE || null;
  const body = setup
    ? `Verification could not run for SHA ${env.GITHUB_SHA}.\n${setup.startsWith("Shard/step evidence unavailable:") ? "Whether layout ran could not be confirmed." : "Layout was not checked on the affected shards."}\n${setup}\nHealth checks: ${env.HEALTH_RESULT === "success" ? "passed" : env.HEALTH_RESULT === "failure" ? "failed" : "not confirmed (" + (env.HEALTH_RESULT ?? "unknown") + ")"}.\nRun: ${url}, attempt ${env.GITHUB_RUN_ATTEMPT}.`
    : `Deployment verification for SHA ${env.GITHUB_SHA}: ${env.DEPLOY_RESULT ?? "unknown"}.\nFull layout grid: ${env.LAYOUT_RESULT}.\nRun: ${url}, attempt ${env.GITHUB_RUN_ATTEMPT}.\n\n${rollback}`;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  const helper = fileURLToPath(new URL("./alert-issue.sh", import.meta.url));
  const args = failed
    ? [
        helper,
        "fire",
        slug,
        setup
          ? `Layout verification could not run for ${env.GITHUB_SHA.slice(0, 12)}`
          : `Deployment verification failed for ${env.GITHUB_SHA.slice(0, 12)}`,
        body,
      ]
    : [helper, "resolve", slug, body];
  const output = execute("bash", args, { env, encoding: "utf8" });
  const existing = failed && output.match(/issue #(\d+) already open/);
  if (existing)
    execute(
      "gh",
      ["issue", "comment", existing[1], "--repo", env.GH_REPO, "--body", body],
      { env, encoding: "utf8" },
    );
  if (failed && throwOnFailure)
    throw new Error(
      setup
        ? "Layout verification could not run; setup alert published"
        : `Post-deploy verification failed; alert published${validVersion ? " and rollback command recorded" : ""}`,
    );
}

export function reportAttempt(env = process.env, execute = execFileSync) {
  const diagnosis = ["failure", "cancelled", "timed_out"].includes(
    env.LAYOUT_RESULT,
  )
    ? setupFailureDetails(env, execute)
    : { setup: null, layoutFailure: false };
  if (diagnosis.setup && diagnosis.layoutFailure)
    report({ ...env, LAYOUT_SETUP_FAILURE: diagnosis.setup }, execute, {
      throwOnFailure: false,
    });
  return report(
    {
      ...env,
      LAYOUT_SETUP_FAILURE: diagnosis.layoutFailure ? null : diagnosis.setup,
    },
    execute,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv[2] === "verify")
    await verifyDeployedSha(process.env.GITHUB_SHA);
  else if (process.argv[2] === "policy") await verifySitePolicy();
  else if (process.argv[2] === "report") reportAttempt();
  else throw new Error("Expected verify, policy, or report");
}
