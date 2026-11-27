import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const configPath = process.env.WRANGLER_TOML ?? new URL("../wrangler.toml", import.meta.url);
const workflowPath =
  process.env.DEPLOY_WORKFLOW ??
  new URL("../../../.github/workflows/deploy-data-proxy.yml", import.meta.url);

function routePatterns(config) {
  const routes = /routes\s*=\s*\[([\s\S]*?)\]/.exec(config);
  assert.ok(routes, "wrangler.toml must define routes");
  return [...routes[1].matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
}

test("deployment routes keep v2 and capture only the retired namespaces", () => {
  const config = readFileSync(configPath, "utf8");
  assert.deepEqual(routePatterns(config), [
    "transit.yesid.dev/data/v1/*",
    "transit.yesid.dev/api/v1/*",
    "transit.yesid.dev/v1/*",
    "data.yesid.dev/v1/*",
    "data.yesid.dev/v2/*",
  ]);
  assert.doesNotMatch(config, /\bSNAPSHOTS\b/);
});

test("clean downloads use only the read credentials supplied by the proxy deploy", () => {
  const config = readFileSync(configPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");
  assert.doesNotMatch(config, /bucket_name\s*=\s*"transit-clean"/);
  for (const name of [
    "TRANSIT1_R2_ENDPOINT", "TRANSIT1_R2_READ_ACCESS_KEY_ID", "TRANSIT1_R2_READ_SECRET_ACCESS_KEY",
  ]) {
    assert.ok(workflow.includes(`${name}: \${{ secrets.${name} }}`));
  }
  assert.doesNotMatch(workflow, /TRANSIT1_R2_WRITE_/);
});

test("production deploys are push-only from main", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /deploy-data-proxy:[\s\S]*?environment: production/);
  assert.match(
    workflow,
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(workflow, /- name: Run production v2 smoke\n\s+run: bash smoke\.sh/);
});
