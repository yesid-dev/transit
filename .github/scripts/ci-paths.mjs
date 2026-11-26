import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DB_JOBS = [
  "offline-tests-work",
  "db-quality-work",
  "alembic-single-head-work",
  "real-db-tests-work",
];
const ALWAYS = new Set([
  ".bun-version",
  ".python-version",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".gitleaks.toml",
  ".npmrc",
  ".nvmrc",
  "bun.lock",
  "package.json",
  "turbo.json",
]);
const IGNORED = new Set([
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
]);
// DB artifact tests also read the web, data-proxy and engine trees.
const IGNORED_PREFIXES = ["docs/"];

// Unknown or unresolved paths run all checks. Only known unrelated paths skip them.
export function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  return paths.some(
    (path) =>
      typeof path !== "string" ||
      ALWAYS.has(path) ||
      (!IGNORED.has(path) &&
        !IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))),
  );
}

export function checkRequiredJobs(needs) {
  const runDb = needs?.classify?.outputs?.run_db;
  if (
    needs?.classify?.result !== "success" ||
    !["true", "false"].includes(runDb)
  ) {
    throw new Error("DB path classification did not succeed");
  }
  for (const job of DB_JOBS) {
    const result = needs[job]?.result;
    if (result !== "success" && !(runDb === "false" && result === "skipped")) {
      throw new Error(`${job}: unexpected result ${result}`);
    }
  }
}

function changedPaths(environment) {
  const eventName = environment.GITHUB_EVENT_NAME;
  if (!["pull_request", "merge_group", "push"].includes(eventName))
    return null;
  try {
    const event = JSON.parse(
      readFileSync(environment.GITHUB_EVENT_PATH, "utf8"),
    );
    const [base, head] = {
      pull_request: [event.pull_request?.base?.sha, event.pull_request?.head?.sha],
      merge_group: [event.merge_group?.base_sha, event.merge_group?.head_sha],
      push: [event.before, event.after],
    }[eventName];
    if (
      ![base, head].every(
        (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
      )
    )
      return null;
    // A push lists the differences between the previous and new branch tips.
    const revisions = eventName === "push" ? [base, head] : [`${base}...${head}`];
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", ...revisions, "--"],
      { encoding: "utf8" },
    );
    return paths.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "classify") {
    const runDb = classifyPaths(changedPaths(process.env));
    appendFileSync(process.env.GITHUB_OUTPUT, `run_db=${runDb}\n`);
    console.log(`Run DB checks: ${runDb}`);
  } else if (process.argv[2] === "required") {
    checkRequiredJobs(JSON.parse(process.env.NEEDS_JSON));
  } else {
    throw new Error("Expected classify or required");
  }
}
