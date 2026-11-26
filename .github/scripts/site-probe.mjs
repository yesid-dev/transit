import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ORIGIN, WEB_ORIGIN, probeV2, probeWebHealth } from "../../apps/data-proxy/scripts/probe-v2.mjs";

/** @typedef {{ name: string, url: string, kind: 'health' | 'data-v2' } | { name: string, url: string, kind: 'html', marker: string }} SiteCheck */

// Fixed public targets only. No credentials, visitor input, analytics or database access.
/** @type {SiteCheck[]} */
export const SITE_CHECKS = [
  { name: "transit-health", url: `${WEB_ORIGIN}/health`, kind: "health" },
  {
    name: "transit-home",
    url: "https://transit.yesid.dev/",
    kind: "html",
    marker: "Transit",
  },
  {
    name: "yesid-home",
    url: "https://yesid.dev/",
    kind: "html",
    marker: "Yesid",
  },
  { name: "transit-data", url: DATA_ORIGIN, kind: "data-v2" },
];

/** @param {SiteCheck} check @param {typeof fetch} fetchFn */
async function checkSite(check, fetchFn) {
  try {
    if (check.kind === "health") return probeWebHealth({ fetchFn, webOrigin: new URL(check.url).origin });
    if (check.kind === "data-v2") return (await probeV2({ fetchFn, dataOrigin: check.url, requireFresh: true })).join(", ") || null;
    const response = await fetchFn(check.url, {
      redirect: "manual",
      headers: {
        "cache-control": "no-cache",
        "user-agent": "Transit-site-probe",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return `HTTP ${response.status}`;
    if (!response.headers.get("content-type")?.includes("text/html"))
      return "not HTML";
    const body = await response.text();
    return check.kind === "html" && body.includes("<html") && body.includes(check.marker)
      ? null
      : "missing page content";
  } catch {
    // Never copy a response body or exception into a public issue.
    return "request failed, timed out, or returned invalid JSON";
  }
}

/**
 * @param {{ checks?: SiteCheck[], fetchFn?: typeof fetch, alert: (...args: string[]) => unknown, pause?: (ms: number) => Promise<unknown> }} options
 */
export async function probeSites({
  checks = SITE_CHECKS,
  fetchFn = fetch,
  alert,
  pause = sleep,
}) {
  const failures = (
    await Promise.all(
      checks.map(async (check) => {
        let failure = await checkSite(check, fetchFn);
        if (failure) {
          await pause(5_000);
          failure = await checkSite(check, fetchFn);
        }
        return failure ? `${check.name} (${check.url}): ${failure}` : null;
      }),
    )
  ).filter(Boolean);
  if (failures.length) {
    await alert(
      "fire",
      "site-availability",
      "[alert] Public site unavailable",
      `Failed twice, five seconds apart:\n\n${failures.join("\n")}\n\nRun: ${runUrl()}`,
    );
    return 1;
  }
  await alert(
    "resolve",
    "site-availability",
    `All public site checks recovered. Run: ${runUrl()}`,
  );
  return 0;
}

function runUrl() {
  return `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.GITHUB_REPOSITORY ?? "yesid-dev/transit"}/actions/runs/${process.env.GITHUB_RUN_ID ?? "local"}`;
}

/** @param {string[]} args */
function issueAlert(...args) {
  const result = spawnSync(
    "bash",
    [fileURLToPath(new URL("./alert-issue.sh", import.meta.url)), ...args],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw new Error("GitHub issue alert failed");
}

// The alert adapter intentionally runs on the Linux Actions host, like the data probes.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "--weekly") {
    const { weeklyAllowed, probeLinks } =
      await import("./site-probe-weekly.mjs");
    if (!weeklyAllowed(process.env, process.env.PROBE_SCHEDULE))
      throw new Error("Weekly probe is not authorized for this event or rerun");
    process.exitCode = await probeLinks({ alert: issueAlert });
  } else {
    process.exitCode = await probeSites({ alert: issueAlert });
  }
}
