import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const VERSION =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function workerMissing(token, fetcher = fetch) {
  if (!token) throw new Error("Missing Cloudflare token for transit1-web lookup");
  const response = await fetcher(
    "https://api.cloudflare.com/client/v4/accounts/eccfb9bedd87d413eaf4cac6ae2285d3/workers/scripts/transit1-web/script-settings",
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (response.ok && body?.success === true) return false;
  if (
    [400, 404].includes(response.status) &&
    body?.success === false &&
    Array.isArray(body.errors) &&
    body.errors.length === 1 &&
    body.errors[0]?.code === 10007
  ) {
    return true;
  }
  throw new Error(
    `Cannot confirm whether transit1-web exists (Cloudflare HTTP ${response.status})`,
  );
}

function runWrangler(args, execute) {
  return execute(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
      ),
      ...args,
      "--name",
      "transit1-web",
    ],
    {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      encoding: "utf8",
      env: process.env,
    },
  );
}

export function currentWorkerVersion(execute = execFileSync, { allowEmpty = false } = {}) {
  const deployments = JSON.parse(
    runWrangler(["deployments", "list", "--json"], execute),
  );
  if (
    !Array.isArray(deployments) ||
    deployments.some((item) => !Number.isFinite(Date.parse(item.created_on)))
  ) {
    throw new Error("Cannot identify active production deployment");
  }
  if (allowEmpty && deployments.length === 0) return undefined;
  const latest = deployments
    .sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on))
    .at(-1);
  if (
    latest?.versions?.length !== 1 ||
    latest.versions[0].percentage !== 100 ||
    !VERSION.test(latest.versions[0].version_id)
  ) {
    throw new Error("Cannot identify one active production Worker version");
  }
  return latest.versions[0].version_id;
}

export function rollback(version = "", execute = execFileSync) {
  if (version && !VERSION.test(version))
    throw new Error("Invalid Worker version ID");
  const output = runWrangler(
    ["rollback", ...(version ? [version] : []), "--yes"],
    execute,
  );
  const actual = output.match(/Current Version ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!VERSION.test(actual ?? "") || (version && actual !== version)) {
    throw new Error("Wrangler did not confirm the requested rollback");
  }
  return actual;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const capture = process.argv[2] === "capture";
  const actual = capture
    ? currentWorkerVersion(execFileSync, {
      allowEmpty: process.env.TRANSIT_ALLOW_EMPTY_DEPLOYMENTS === "true",
    })
    : rollback(process.env.ROLLBACK_VERSION);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    actual === undefined
      ? "No deployed transit1-web version to capture before recovery.\n"
      : `${capture ? "Captured rollback target" : "Production web rolled back to Worker version"} \`${actual}\`.\n`,
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `version_id=${actual ?? ""}\n`);
}
