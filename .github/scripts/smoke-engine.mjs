import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const { ENGINE_URL, TRANSIT1_ENGINE_ACCESS_TOKEN: token } = process.env;
const city = process.env.SMOKE_CITY || "stm";
const day = process.env.SMOKE_DATE || "2026-11-15";
assert.match(ENGINE_URL ?? "", /^https:\/\/transit-engine\.[a-z0-9-]+\.workers\.dev$/);
assert.ok(token, "Missing engine access token");
assert.match(city, /^[a-z0-9][a-z0-9_-]{0,63}$/);
assert.match(day, /^\d{4}-\d{2}-\d{2}$/);

const query = new URLSearchParams({ city, from: day, to: day });
const url = `${ENGINE_URL}/data-health?${query}`;
const options = { redirect: "error" };
for (const [target, headers] of [
  [url, {}],
  [`${ENGINE_URL}/healthz`, { Authorization: "Bearer invalid" }],
]) {
  const response = await fetch(target, { ...options, headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 401, "The Worker must refuse unauthorized requests");
  await response.body?.cancel();
}

// A first deployment may return 5xx while Cloudflare provisions the Container.
const deadline = performance.now() + 300_000;
const started = performance.now();
let response;
do {
  response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status < 500 || performance.now() >= deadline) break;
  await response.body?.cancel();
  await delay(10_000);
} while (true);

assert.equal(response.status, 200, "Authenticated data-health request failed");
const body = await response.json();
assert.equal(body.city, city);
assert.equal(body.days?.length, 1, "Expected exactly one day in data health");
assert.equal(body.days[0].service_date, day);
assert.equal(body.days[0].status, "present", `Clean day ${city} ${day} must be present`);
console.log(`Private access verified. ${city} ${day} present in ${((performance.now() - started) / 1000).toFixed(2)} s including any provisioning retries.`);
