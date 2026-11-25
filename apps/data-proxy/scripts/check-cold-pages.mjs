// Run against one local engine started with the intended memory, threads and queue settings.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { serveBoundQuestion } from "../src/questions.js";
import { fetchEngine } from "../../engine/upstream.js";

const { values } = parseArgs({ options: {
  url: { type: "string" },
  city: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  vehicle: { type: "string", multiple: true },
  line: { type: "string", multiple: true },
  out: { type: "string" },
  baseline: { type: "boolean" },
} });
const { url, city, from, to, out, baseline, vehicle = [], line = [] } = values;
if (!url || !city || !from || !to || !out || vehicle.length !== 2 || line.length !== 2) {
  throw new Error("Provide --url, --city, --from, --to, two --vehicle and two --line values, and --out");
}
const base = new URL(url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("The benchmark sends a concurrent burst and requires a loopback engine");
}

const answers = new Map();
globalThis.caches = { default: {
  match: async (key) => answers.get(key.url)?.clone(),
  put: async (key, response) => answers.set(key.url, response),
} };
const admissions = new Map();
const env = {
  TRANSIT1_ENGINE_ACCESS_TOKEN: "local-benchmark",
  QUESTION_LIMIT: { limit: async ({ key }) => {
    const used = (admissions.get(key) ?? 0) + 1;
    admissions.set(key, used);
    return { success: used <= (baseline ? 30 : 36) };
  } },
  ENGINE: { fetch: (request) => fetchEngine(request, { ENGINE_ORIGIN: "https://local-engine.invalid" },
    (upstream, options) => {
      const { pathname, search } = new URL(upstream.url);
      return fetch(new Request(new URL(pathname + search, base), upstream), options);
    }) },
};
const writes = [];
const ctx = { waitUntil: (operation) => writes.push(operation) };
const origin = "https://data.yesid.dev";

const vehicleQuestions = [
  ...(baseline
    ? [["summary", { measure: "vehicles" }], ["days", { measure: "vehicles", group: "day" }]]
    : [["summary and days", { measure: "vehicles", group: "day", include_overall: "1" }]]),
  ["lines", { measure: "vehicle_trips_run", group: "line" }],
  ["reporting", { measure: "vehicle_reporting_gaps_per_100_hours" }],
  ["completion", { measure: "vehicle_unfinished_trips" }],
  ["punctuality", { measure: "vehicle_on_time" }],
];
const lineQuestions = [
  ["punctuality", { measure: "punctuality" }],
  ["daily", { measure: "on_time", group: "day" }],
  ["hourly", { measure: "late", group: "weekday_hour" }],
  ["directions", { measure: "punctuality", group: "direction" }],
  ["stops", { measure: "punctuality", group: "stop" }],
  ["waiting", { measure: "waiting_and_gaps" }],
  ["offered", { measure: "scheduled_frequency", group: "hour" }],
  ["delivery", { measure: "trips_run", group: "departure" }],
  ["late", { measure: "late", kind: "departure", limit: "8" }],
  ["crowding", { measure: "crowding" }],
  ["alerts", { measure: "alert_counts", alert_details: "1" }],
  ["frequency", { measure: "scheduled_frequency" }],
  ["boundaries", { measure: "service_delivered", group: "day_type" }],
  ["network", { measure: "on_time" }],
  ["network daily", { measure: "on_time", group: "day" }],
];

// The layout obtains its catalog before its page loaders start. Leave dated answers cold.
await serveBoundQuestion(new Request(origin + "/v2/cities"), env, ctx);
await Promise.all(writes);
admissions.clear();

const started = performance.now();
async function run(visitor, page, [section, parameters]) {
  const query = new URLSearchParams({ from, to, ...parameters });
  const route = query.has("kind") ? "ranking" : "measure";
  const timeout = baseline ? 20_000 : 45_000;
  const headers = { "x-transit-visitor-ip": `192.0.2.${visitor + 1}` };
  if (!baseline) headers["x-transit-record-deadline"] = String(Date.now() + timeout - 250);
  try {
    const request = new Request(`${origin}/v2/${city}/${route}?${query}`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    const response = await serveBoundQuestion(request, env, ctx);
    const answer = await response.json();
    return { visitor: visitor + 1, page, section, status: response.status,
      elapsed_ms: Math.round(performance.now() - started),
      state: answer.state ?? (Array.isArray(answer.cells) ? "series" : answer.message) };
  } catch (error) {
    return { visitor: visitor + 1, page, section, error: error.name,
      elapsed_ms: Math.round(performance.now() - started) };
  }
}

const results = await Promise.all([0, 1].flatMap((visitor) => [
  ...vehicleQuestions.map(([section, parameters]) =>
    run(visitor, "Vehicle", [section, { ...parameters, vehicle: vehicle[visitor] }])),
  ...lineQuestions.map(([section, parameters]) =>
    run(visitor, "Line", [section, {
      ...parameters,
      ...(!section.startsWith("network") && { line: line[visitor] }),
    }])),
]));
await Promise.all(writes);
const report = { baseline: Boolean(baseline), city, from, to, admissions: [...admissions.values()], results };
await writeFile(out, JSON.stringify(report, null, 2) + "\n");
console.table(results);
if (!baseline && results.some((entry) => entry.status !== 200)) process.exitCode = 1;
