import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { QUESTION_PARAMS } from "../src/question-params.js";
import { probeEngine, serveBoundQuestion } from "../src/questions.js";
import worker from "../src/worker.js";
import { fetchEngine } from "../../engine/upstream.js";

const WINDOW = "from=2020-01-01&to=2020-01-02";
const HEALTH = `/v2/demo/data-health?${WINDOW}`;
const MEASURE = `/v2/demo/measure?measure=on_time&${WINDOW}`;
const RANKING = `/v2/demo/ranking?measure=on_time&kind=line&${WINDOW}`;
const REVISION = "0123456789abcdef";
const NEXT_REVISION = "fedcba9876543210";
const ANSWER = {
  value: { on_time: 0 },
  state_text: { en: "Measured", fr: "Mesuré" },
  evidence: { cleaning_versions: [6], days_pending: [], counts: { scheduled: 100 } },
};

test("passes schedule map line sets upstream and caches each cut independently", async (t) => {
  const base = "/v2/demo/schedule-map";
  const requestFor = (lines) => base + "?" + new URLSearchParams({ lines: JSON.stringify(lines) });
  const f = fixture(t, (request) => {
    const lines = new URL(request.url).searchParams.get("lines");
    return Response.json({ lines: lines ? JSON.parse(lines) : null });
  });
  assert.deepEqual(await (await f.fetch(base)).json(), { lines: null });
  assert.deepEqual(await (await f.fetch(requestFor(["B", "A/B,é"]))).json(), { lines: ["A/B,é", "B"] });
  assert.deepEqual(await (await f.fetch(requestFor(["A/B,é", "B", "B"]))).json(), { lines: ["A/B,é", "B"] });
  assert.deepEqual(await (await f.fetch(requestFor(["B"]))).json(), { lines: ["B"] });
  assert.equal(f.requests.length, 3);
  for (const invalid of [[], [4], [" A"], ["A\n"], ["A".repeat(257)], Array(257).fill("A")]) {
    assert.equal((await f.fetch(requestFor(invalid))).status, 400);
  }
  assert.equal(f.requests.length, 3);
});

function stubLiveStorage(t, env, respond) {
  Object.assign(env, {
    TRANSIT1_R2_ENDPOINT: "fixture.r2.cloudflarestorage.com",
    TRANSIT1_R2_READ_ACCESS_KEY_ID: "fixture-key",
    TRANSIT1_R2_READ_SECRET_ACCESS_KEY: "fixture-secret",
  });
  return t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).host, "fixture.r2.cloudflarestorage.com");
    assert.match(request.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=fixture-key\//);
    return respond(request);
  });
}

test("serves the per-city live object with a short edge cache through public and bound routes", async (t) => {
  const f = fixture(t);
  const snapshot = { city: "demo", version: 2, vehicle_positions: null };
  const body = JSON.stringify(snapshot);
  const get = stubLiveStorage(t, f.env, (request) => {
    assert.equal(new URL(request.url).pathname, "/transit-clean/live/v2/demo.json");
    return new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
  });
  const path = "/v2/demo/live";
  const first = await f.fetch(path);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), snapshot);
  const second = await f.fetch(path, {}, "GET", true);
  assert.deepEqual(await second.json(), snapshot);
  assert.equal([...f.answers.values()][0].ttl, 5);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.saved.size, 0);
  f.env.TRANSIT1_LIVE_ENABLED = "0";
  assert.equal((await f.fetch(path)).status, 503);
  assert.equal(get.mock.callCount(), 1);
});

test("keeps the live edge cache independent of engine revision and availability", async (t) => {
  const f = fixture(t);
  delete f.env.ENGINE;
  delete f.env.TRANSIT1_ENGINE_ACCESS_TOKEN;
  const snapshot = JSON.stringify({ city: "demo", version: 2, vehicle_positions: [] });
  const get = stubLiveStorage(t, f.env, () => new Response(snapshot, {
    headers: { "content-length": String(Buffer.byteLength(snapshot)) },
  }));
  const path = "/v2/demo/live";
  assert.equal(await (await f.fetch(path)).text(), snapshot);
  assert.equal(await (await f.fetch(path, {}, "GET", true)).text(), snapshot);
  assert.equal(get.mock.callCount(), 1);
  assert.deepEqual([...f.answers.keys()], [
    "https://data.yesid.dev/__transit_question_cache/v2/live/demo/live",
  ]);
  assert.equal(f.cityRequests.length, 0);
  assert.equal(f.saved.size, 0);
});

test("private live objects and cached answers are as inaccessible as unknown cities", async (t) => {
  const f = fixture(t);
  const stored = '{"city":"private-city"}';
  const get = stubLiveStorage(t, f.env, () => new Response(stored, {
    headers: { "content-length": String(Buffer.byteLength(stored)) },
  }));
  for (const path of ["/live", "/live-trips?trip=t1"]) {
    for (const bound of [false, true]) {
      const requestFor = (city) => new Request(`https://data.yesid.dev/v2/${city}${path}`);
      const handler = bound ? serveBoundQuestion : worker.fetch;
      const fetch = (city) => handler(requestFor(city), f.env, { waitUntil() {} }, new Set(["demo", "other-city"]));
      const key = requestFor("private-city").url.replace("/v2/", "/__transit_question_cache/v2/live/");
      f.answers.set(key, { response: Response.json({ city: "private-city" }), expiresAt: Infinity });
      const unknown = await fetch("unknown");
      const hidden = await fetch("private-city");
      assert.equal(hidden.status, 404);
      assert.equal(hidden.status, unknown.status);
      assert.deepEqual([...hidden.headers], [...unknown.headers]);
      assert.equal(await hidden.text(), await unknown.text());
    }
  }
  assert.equal(get.mock.callCount(), 0);
});

test("reads only the ranges for a live scope and rejects mixed publications", async (t) => {
  const f = fixture(t);
  const first = [{
    trip_id: "t1", route_id: "a/b", trip_headsign: "Terminus Est",
    stops: [{ stop_id: "s", scheduled_arrival: null, scheduled_departure: 120 }, { stop_id: "other" }],
  }];
  const second = { trip_id: "t2", route_id: null, stops: [{ stop_id: "s" }] };
  const stopCalls = [
    ["t1", "a/b", null, null, null, 0, null, 1, null, 123, null, 0, 0, null, 120, "Terminus Est"],
    ["t2", null, null, null, null, 0, null, 1, null, 124, null, null, 0],
  ];
  const chunks = [first, second, stopCalls].map((value) => Buffer.from(JSON.stringify(value)));
  const bundle = Buffer.concat(chunks);
  const etag = '"live-trip-42"';
  const feed = { family: "trip_updates", captured_at: "2026-11-23T19:10:00Z" };
  const index = JSON.stringify({
    version: 2, city: "demo", etag, feed,
    ranges: {
      "line:a/b": [0, chunks[0].length],
      "trip:t2": [chunks[0].length, chunks[1].length],
      "stop:s": [chunks[0].length + chunks[1].length, chunks[2].length],
    },
  });
  let changed = false;
  const ranges = [];
  stubLiveStorage(t, f.env, (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/transit-clean/live/v2/demo/trips.json") {
      return new Response(index, { headers: { "content-length": String(Buffer.byteLength(index)) } });
    }
    assert.equal(path, "/transit-clean/live/v2/demo/trips.bin");
    assert.equal(request.headers.get("if-match"), etag);
    assert.match(request.headers.get("authorization"), /SignedHeaders=host;if-match;range;x-amz-/);
    const [, start, last] = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range"));
    ranges.push(Number(start));
    if (changed) return new Response(null, { status: 412 });
    const body = bundle.subarray(Number(start), Number(last) + 1);
    return new Response(body, { status: 206, headers: {
      "content-length": String(body.length),
      "content-range": `bytes ${start}-${last}/${bundle.length}`,
      etag,
    } });
  });
  const base = "/v2/demo/live-trips";
  assert.equal((await f.fetch(base)).status, 400);
  assert.equal((await f.fetch(base + "?line=a&trip=t1")).status, 400);
  const line = await (await f.fetch(base + "?line=a%2Fb", {}, "GET", true)).json();
  assert.deepEqual(line, { version: 2, city: "demo", feed, trip_updates: first });
  assert.deepEqual(ranges, [0]);
  const stop = await (await f.fetch(base + "?stop=s")).json();
  assert.deepEqual(stop.trip_updates.map(({ trip_id, stops }) => [trip_id, stops[0].stop_id, stops[0].departure]),
    [["t1", "s", 123], ["t2", "s", 124]]);
  assert.equal(stop.trip_updates[0].trip_headsign, "Terminus Est");
  assert.deepEqual(stop.trip_updates[0].stops[0], {
    stop_id: "s", sequence: 1, arrival: null, departure: 123,
    arrival_delay: null, departure_delay: 0, relationship: 0,
    scheduled_arrival: null, scheduled_departure: 120,
  });
  assert.deepEqual(stop.trip_updates[1], {
    trip_id: "t2", route_id: null, direction_id: null, start_date: null, start_time: null,
    relationship: 0, delay: null,
    stops: [{
      stop_id: "s", sequence: 1, arrival: null, departure: 124,
      arrival_delay: null, departure_delay: null, relationship: 0,
    }],
  });
  assert.deepEqual(ranges, [0, chunks[0].length + chunks[1].length]);
  const trip = await (await f.fetch(base + "?trip=t2")).json();
  assert.deepEqual(trip.trip_updates, [second]);
  assert.deepEqual(ranges, [0, chunks[0].length + chunks[1].length, chunks[0].length]);
  changed = true;
  f.answers.clear();
  const refreshing = await f.fetch(base + "?trip=t2");
  assert.equal(refreshing.status, 503);
  assert.equal(refreshing.headers.get("retry-after"), "1");
  assert.equal(refreshing.headers.get("cache-control"), "no-store");
  assert.equal((await refreshing.json()).state, "refreshing");
  assert.equal(f.answers.size, 0);
  assert.equal(f.saved.size, 0);
});

test("rejects live writes and malformed city paths or parameters, and leaves misses uncached", async (t) => {
  const f = fixture(t);
  const path = "/v2/demo/live";
  assert.equal((await f.fetch(path)).status, 503);
  const get = stubLiveStorage(t, f.env, () => new Response(null, { status: 404 }));
  assert.equal((await f.fetch(path, {}, "POST")).status, 405);
  assert.equal((await f.fetch("/v2/%2fprivate/live")).status, 400);
  assert.equal((await f.fetch(path + "?limit=1")).status, 400);
  assert.equal(get.mock.callCount(), 0);
  assert.equal((await f.fetch(path)).status, 404);
  assert.equal((await f.fetch(path)).headers.get("cache-control"), "no-store");
  assert.equal(get.mock.callCount(), 2);
  assert.equal(f.answers.size, 0);
});

test("forwards the opt-in agency message detail and rejects invalid values", async (t) => {
  const harness = fixture(t);
  const base = `/v2/demo/measure?measure=alert_counts&${WINDOW}`;
  assert.equal((await harness.fetch(`${base}&alert_details=1`)).status, 200);
  assert.equal(new URL(harness.requests[0].url).searchParams.get("alert_details"), "1");
  assert.equal((await harness.fetch(`${base}&alert_details=true`)).status, 400);
  assert.equal((await harness.fetch(`${base}&alert_details=1&group=day`)).status, 400);
  assert.equal(harness.requests.length, 1);
});

test("caps agency message detail at seven inclusive service dates", async (t) => {
  const harness = fixture(t);
  const base = "/v2/demo/measure?measure=alert_counts&from=2020-01-28";
  const accepted = await harness.fetch(`${base}&to=2020-02-03&alert_details=1`);
  assert.equal(accepted.status, 200);
  const denied = await harness.fetch(`${base}&to=2020-02-04&alert_details=1`);
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).message, "alert_details supports at most 7 service dates");
  assert.equal(harness.requests.length, 1);
  assert.equal((await harness.fetch(`${base}&to=2020-02-04`)).status, 200);
});

test("forwards alert effect and cause groups with the published-value cuts", async (t) => {
  const harness = fixture(t);
  const base = `/v2/demo/measure?measure=alert_counts&${WINDOW}`;
  const cuts = { effect: "DETOUR", cause: "CONSTRUCTION" };
  for (const [index, [group, value]] of Object.entries(cuts).entries()) {
    assert.equal((await harness.fetch(`${base}&group=${group}&${group}=${value}`)).status, 200);
    const { searchParams } = new URL(harness.requests[index].url);
    assert.equal(searchParams.get("group"), group);
    assert.equal(searchParams.get(group), value);
  }
});

function fixture(t, respond = () => Response.json(ANSWER, {
  headers: { "x-transit-days-pending": "0" },
})) {
  const answers = new Map();
  const saved = new Map();
  const requests = [];
  const cityRequests = [];
  const cities = {
    answer_revision: REVISION,
    cleaning_version: 6,
    default_provider: "demo",
    providers: [
      { id: "demo", timezone: "America/Toronto" },
      { id: "other-city", timezone: "Europe/Paris" },
    ],
  };
  const visitors = [];
  const engine = { revision: REVISION, version: 6 };
  const cache = {
    async match(key) {
      const entry = answers.get(key.url);
      return entry && entry.expiresAt > Date.now() ? entry.response.clone() : undefined;
    },
    async put(key, response) {
      const ttl = Number(response.headers.get("cache-control").split("=")[1]);
      answers.set(key.url, { ttl, expiresAt: Date.now() + ttl * 1000, response: response.clone() });
    },
  };
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: cache } });
  t.after(() => { delete globalThis.caches; });
  const env = {
    ENGINE: {
      async fetch(request) {
        if (new URL(request.url).pathname === "/cities") {
          cityRequests.push(request);
          return Response.json(cities);
        }
        requests.push(request);
        const response = await respond(request);
        if (engine.revision) response.headers.set("x-transit-answer-revision", engine.revision);
        if (!response.headers.has("x-transit-cleaning-version")) {
          response.headers.set("x-transit-cleaning-version", String(engine.version));
        }
        return response;
      },
    },
    TRANSIT1_ENGINE_ACCESS_TOKEN: "fixture-token",
    QUESTION_LIMIT: {
      async limit({ key }) {
        visitors.push(key);
        return { success: true };
      },
    },
    QUESTION_LAST_GOOD: {
      async put(key, value, options) {
        saved.set(key, { value, ...options });
      },
      async getWithMetadata(key) {
        return saved.get(key) ?? { value: null, metadata: null };
      },
    },
  };

  async function fetch(path, headers = {}, method = "GET", bound = false) {
    const tasks = [];
    const handler = bound ? serveBoundQuestion : worker.fetch;
    const response = await handler(new Request(`https://data.yesid.dev${path}`, {
      method,
      headers: { origin: "https://transit1.yesid.dev", ...headers },
    }), env, { waitUntil: (task) => tasks.push(task) }, new Set(["demo", "other-city"]));
    await Promise.all(tasks);
    return response;
  }
  return { fetch, env, answers, saved, requests, cityRequests, cities, visitors, engine };
}

test("dated public routes accept the same query names as the engine HTTP parser", () => {
  const source = readFileSync(
    new URL("../../engine/src/transit_engine/server.py", import.meta.url), "utf8",
  );
  const match = /def _question\([\s\S]*?required = (\{[^}]*\})\s+optional = (\{[^}]*\})\s+if ranking:\s+required\.add\("([^"]+)"\)\s+optional\.update\(\s*(\{[^}]*\})\s*\)\s+else:\s+required\.add\("([^"]+)"\)\s+optional\.update\(\s*(\{[^}]*\})\s*\)/.exec(source);
  const health = /def _health\([^\n]*\n\s+required = (\{[^}]*\})/.exec(source);
  assert.ok(match && health, "Review the proxy parameter contract when the engine parser changes");
  const names = (literal) => [...literal.matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]);
  const [, required, optional, rankRequired, rankOptional, measureRequired, measureOptional] = match;
  const common = [...names(required), ...names(optional)];
  for (const [route, accepted] of Object.entries({
    measure: [...common, measureRequired, ...names(measureOptional)],
    ranking: [...common, rankRequired, ...names(rankOptional)],
    "data-health": names(health[1]),
  })) {
    const proxy = QUESTION_PARAMS[route];
    assert.deepEqual(new Set(["city", ...proxy.required, ...proxy.optional]), new Set(accepted), route);
  }
});

test("only the bound entrypoint uses the forwarded visitor IP", async (t) => {
  const f = fixture(t);
  const edge = "192.0.2.1";
  const visitor = "192.0.2.2";
  const headers = { "cf-connecting-ip": edge, "x-transit-visitor-ip": visitor };
  await f.fetch(MEASURE, headers);
  await f.fetch(MEASURE + "&line=24", headers, "GET", true);
  await f.fetch(MEASURE + "&line=31", { "cf-connecting-ip": visitor });
  await f.fetch(MEASURE + "&line=32", { "cf-connecting-ip": edge });
  assert.equal(f.visitors.length, 4);
  assert.notEqual(f.visitors[0], f.visitors[1]);
  assert.equal(f.visitors[0], f.visitors[3]);
  assert.equal(f.visitors[1], f.visitors[2]);
  assert.equal(f.requests[1].headers.get("x-transit-visitor-ip"), null);
});

test("forwards Line and Stop Record groups and departure ranking cuts", async (t) => {
  const f = fixture(t);
  for (const question of [
    MEASURE + "&line=24&group=stop",
    MEASURE.replace("measure=on_time", "measure=trips_run") + "&line=24&group=departure",
    MEASURE + "&stop=S1&group=line",
  ]) {
    assert.equal((await f.fetch(question)).status, 200);
  }
  assert.equal(
    (await f.fetch(`/v2/demo/ranking?measure=late&kind=departure&line=24&direction=1&${WINDOW}`)).status,
    200,
  );
  const params = f.requests.map((request) => new URL(request.url).searchParams);
  assert.deepEqual(params.slice(0, 3).map((entry) => entry.get("group")), ["stop", "departure", "line"]);
  assert.equal(params[2].get("stop"), "S1");
  assert.equal(params[3].get("kind"), "departure");
  assert.equal(params[3].get("line"), "24");
  assert.equal(params[3].get("direction"), "1");
});

test("forwards the fleet and per-vehicle line breakdown through the public route", async (t) => {
  const f = fixture(t, (request) =>
    new URL(request.url).searchParams.get("format") === "csv"
      ? new Response("Ligne,Valeur\n", { headers: { "content-type": "text/csv" } })
      : Response.json(ANSWER));
  assert.equal((await f.fetch(`/v2/demo/measure?measure=vehicle_days_in_service&group=vehicle&${WINDOW}`)).status, 200);
  assert.equal((await f.fetch(`/v2/demo/measure?measure=vehicle_trips_run&vehicle=40061&group=line&format=csv&lang=fr&${WINDOW}`)).status, 200);
  const [fleet, detail] = f.requests.map((request) => new URL(request.url).searchParams);
  assert.equal(fleet.get("group"), "vehicle");
  assert.equal(detail.get("group"), "line");
  assert.equal(detail.get("vehicle"), "40061");
  assert.equal(detail.get("format"), "csv");
  assert.equal(detail.get("lang"), "fr");
});

test("forwards the finders' network groups without ranking limits", async (t) => {
  const f = fixture(t);
  for (const question of [
    MEASURE + "&group=line",
    MEASURE.replace("measure=on_time", "measure=trips_run") + "&group=line",
    MEASURE + "&group=stop_id",
  ]) {
    assert.equal((await f.fetch(question)).status, 200);
  }
  const params = f.requests.map((request) => new URL(request.url).searchParams);
  assert.deepEqual(params.map((entry) => [entry.get("measure"), entry.get("group")]), [
    ["on_time", "line"],
    ["trips_run", "line"],
    ["on_time", "stop_id"],
  ]);
  assert.ok(params.every((entry) => !["limit", "line", "stop", "vehicle"].some((key) => entry.has(key))));
});

test("validates and forwards map questions while an older engine degrades to unavailable", async (t) => {
  const f = fixture(t, () => Response.json({ message: "unknown parameter" }, { status: 400 }));
  const base = "/v2/demo/measure?from=2026-10-17&to=2026-10-23";
  const stop = await f.fetch(`${base}&view=map&measure=late&group=stop_id`);
  assert.equal(stop.status, 503);
  assert.ok(stop.headers.has("retry-after"));
  const corridor = `${base}&view=map&measure=mean_time_lost&group=segment`;
  const network = await f.fetch(corridor);
  assert.equal(network.status, 409);
  assert.deepEqual(await network.json(), { reason: "network_corridors_unsupported" });
  assert.equal((await f.fetch(`${corridor}&direction=0`)).status, 400);
  assert.equal((await f.fetch(`${corridor}&line=51&direction=0`)).status, 503);
  assert.deepEqual(f.requests.map(({ url }) => new URL(url).searchParams.get("line")), [null, null, "51"]);
  assert.ok(f.requests.every(({ url }) => new URL(url).searchParams.get("view") === "map"));
});

test("preserves a network corridor refusal from an engine without complete clean facts", async (t) => {
  const payload = { reason: "segment_runs_missing", message: "Clean segment runs are unavailable" };
  const f = fixture(t, () => Response.json(payload, { status: 409 }));
  const result = await f.fetch(
    "/v2/demo/measure?from=2026-10-17&to=2026-10-23&view=map&measure=mean_time_lost&group=segment",
  );
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), payload);
});

test("rejects invalid questions before spending an engine slot or visitor budget", async (t) => {
  const f = fixture(t);
  for (const path of [
    MEASURE.replace("2020-01-01", "2020-02-30"),
    MEASURE.replace("2020-01-01", "20200101"),
    MEASURE.replace("2020-01-01", "0000-01-01"),
    MEASURE.replace("2020-01-02", "2019-12-31"),
    MEASURE.replace("2020-01-02", "2021-02-04"),
    MEASURE.replace("measure=on_time&", ""),
    MEASURE + "&measure=late",
    MEASURE + "&debug=1",
    MEASURE + "&city=demo",
    MEASURE + "&direction=2",
    MEASURE + "&departure=25:30:00",
    MEASURE + "&line=1&direction=0&departure=25:61:00",
    MEASURE + "&line=%20X",
    MEASURE + "&stop=",
    MEASURE + "&stop=%C3",
    MEASURE + "&stop=%FF",
    MEASURE + "&from_stop=%20A&to_stop=B",
    MEASURE + "&hour=24",
    MEASURE + "&day_type=weekend",
    MEASURE + "&group=week",
    MEASURE + "&vehicle=43%00",
    MEASURE + "&effect=%20DETOUR",
    MEASURE + "&format=xml",
    MEASURE + "&lang=es",
    RANKING + "&limit=0",
    RANKING + "&limit=501",
    RANKING + "&limit=1e2",
    RANKING + "&class=frequent",
    RANKING.replace("kind=line", "kind=stop") + "&class=all",
    RANKING.replace("kind=line", "kind=trip"),
    RANKING + "&group=day",
    RANKING + "&direction=2",
    HEALTH + "&line=1",
    "/v2/how-we-measure?format=csv",
  ]) {
    assert.equal((await f.fetch(path)).status, 400, path);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.visitors.length, 0);
  assert.equal((await f.fetch(HEALTH.replace("2020-01-02", "2021-02-03"))).status, 200);
});

test("canonical questions reuse the versioned edge answer and bypass the engine and limiter", async (t) => {
  const f = fixture(t);
  const first = await f.fetch(MEASURE + "&hour=07&format=json&lang=fr&line=A%2FB");
  assert.equal(first.headers.get("access-control-allow-origin"), "*");
  assert.equal(first.headers.get("cache-status"), null);
  assert.deepEqual(await first.json(), ANSWER);
  const second = await f.fetch(
    "/v2/demo/measure?line=A%2fB&to=2020-01-02&hour=7&measure=on_time&from=2020-01-01",
  );
  assert.deepEqual(await second.json(), ANSWER);
  assert.equal(second.headers.get("cache-status"), "Transit; hit");
  assert.equal(f.requests.length, 1);
  assert.equal(f.visitors.length, 1);
  const forwarded = f.requests[0];
  assert.equal(forwarded.headers.get("authorization"), "Bearer fixture-token");
  assert.equal(forwarded.headers.get("origin"), null);
  const upstream = new URL(forwarded.url);
  assert.equal(upstream.pathname, "/measure");
  assert.deepEqual(Object.fromEntries(upstream.searchParams), {
    city: "demo", from: "2020-01-01", hour: "7", line: "A/B", measure: "on_time", to: "2020-01-02",
  });
  const [key, entry] = [...f.answers].find(([key]) => key.includes("/measure?"));
  assert.match(key, /\/6\/0123456789abcdef\/demo\/measure\?from=2020-01-01&hour=7&line=A%2FB&measure=on_time&to=2020-01-02$/);
  assert.equal(entry.ttl, 604800);
});

test("a refreshed catalog separates answers by cleaning version and engine revision", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let value = 1;
  const f = fixture(t, () => Response.json({ value }, {
    headers: { "x-transit-days-pending": "0" },
  }));
  await f.fetch(MEASURE);
  f.cities.answer_revision = f.engine.revision = NEXT_REVISION;
  t.mock.timers.tick(31_000);
  value = 2;
  assert.deepEqual(await (await f.fetch(MEASURE)).json(), { value: 2 });
  f.cities.cleaning_version = f.engine.version = 7;
  t.mock.timers.tick(31_000);
  value = 3;
  assert.deepEqual(await (await f.fetch(MEASURE)).json(), { value: 3 });
  assert.equal(f.requests.length, 3);
});

test("answers with a mismatched or missing engine revision are never stored", async (t) => {
  const f = fixture(t);
  for (const revision of [NEXT_REVISION, null]) {
    f.engine.revision = revision;
    assert.deepEqual(await (await f.fetch(MEASURE)).json(), ANSWER);
    assert.ok(![...f.answers.keys()].some((key) => key.includes("/measure?")));
    assert.ok(![...f.saved.values()].some(({ metadata }) => metadata?.contentType));
  }
  assert.equal(f.requests.length, 2);
});

test("an unknown catalog revision allows answers without storing them", async (t) => {
  const f = fixture(t);
  delete f.cities.answer_revision;
  assert.deepEqual(await (await f.fetch(MEASURE)).json(), ANSWER);
  assert.ok(![...f.answers.keys()].some((key) => key.includes("/measure?")));
  assert.ok(![...f.saved.values()].some(({ metadata }) => metadata?.contentType));
  let supportsPublicCityCheck = true;
  f.env.ENGINE.fetch = (request) => {
    if (new URL(request.url).pathname === "/cities") throw new Error("catalog offline");
    assert.equal(request.headers.get("x-transit-require-public-city"), "1");
    return Response.json(ANSWER, {
      headers: supportsPublicCityCheck ? { "x-transit-answer-revision": REVISION } : {},
    });
  };
  f.answers.clear();
  f.saved.clear();
  assert.deepEqual(await (await f.fetch(MEASURE)).json(), ANSWER);
  assert.equal(f.answers.size, 0);
  assert.equal(f.saved.size, 0);
  supportsPublicCityCheck = false;
  assert.equal((await f.fetch(MEASURE)).status, 503);
});

test("last-good answers are scoped to the catalog cleaning version and answer revision", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let offline = false;
  const f = fixture(t, () => offline ? new Response(null, { status: 500 }) : Response.json(ANSWER));
  await f.fetch(MEASURE);
  offline = true;
  f.answers.clear();
  assert.equal((await f.fetch(MEASURE)).headers.get("x-transit-answer"), "last-good");
  f.cities.answer_revision = NEXT_REVISION;
  t.mock.timers.tick(31_000);
  assert.equal((await f.fetch(MEASURE)).headers.get("x-transit-answer"), "last-good");
  assert.equal((await f.fetch(MEASURE)).status, 503);
  f.cities.answer_revision = REVISION;
  f.cities.cleaning_version = 7;
  t.mock.timers.tick(31_000);
  // A foreground catalogue refresh is visible immediately after a mirror copy.
  await f.fetch("/v2/cities", { "cache-control": "no-cache" });
  assert.equal((await f.fetch(MEASURE)).status, 503);
});

test("ranking and health pass the approved parameters to their engine routes", async (t) => {
  const rank = { rows: [], state_text: ANSWER.state_text, evidence: ANSWER.evidence };
  const health = { cleaning_version: "6", days: [] };
  const f = fixture(t, (request) => Response.json(request.url.includes("/ranking?") ? rank : health));
  assert.deepEqual(await (await f.fetch(RANKING + "&class=003:frequent&limit=050")).json(), rank);
  assert.deepEqual(await (await f.fetch(HEALTH)).json(), health);
  const [ranking, dataHealth] = f.requests.map((request) => new URL(request.url));
  assert.equal(ranking.pathname, "/ranking");
  assert.equal(ranking.searchParams.get("class"), "003:frequent");
  assert.equal(ranking.searchParams.get("limit"), "50");
  assert.equal(dataHealth.pathname, "/data-health");
  assert.equal(dataHealth.searchParams.get("city"), "demo");
  assert.match([...f.answers.keys()].find((key) => key.includes("/data-health?")), /\/6\//);
});

test("today in the provider timezone gets a short TTL even after UTC midnight", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2020-01-03T01:30:00Z") });
  const f = fixture(t);
  await f.fetch(MEASURE);
  assert.equal([...f.answers].find(([key]) => key.includes("/measure?"))[1].ttl, 30);
  t.mock.timers.tick(31_000);
  await f.fetch(MEASURE);
  assert.equal(f.requests.length, 2);
});

test("forwards series, vehicle, alert and corridor cuts and localized ranking CSV", async (t) => {
  const f = fixture(t, (request) => {
    return new URL(request.url).searchParams.get("format") === "csv"
      ? new Response("classe,valeur\n", { headers: { "content-type": "text/csv" } })
      : Response.json(ANSWER);
  });
  await f.fetch(MEASURE + "&group=weekday_hour");
  await f.fetch(MEASURE.replace("on_time", "vehicles") + "&vehicle=45%2F68");
  await f.fetch(MEASURE.replace("on_time", "alert_counts") + "&effect=DETOUR&cause=CONSTRUCTION");
  const csv = await f.fetch(
    `/v2/demo/ranking?measure=mean_time_lost&kind=line&${WINDOW}` +
      "&line=123&direction=1&hour=07&day_type=weekday&format=csv&lang=fr",
  );
  assert.equal(await csv.text(), "classe,valeur\n");
  const corridor = `/v2/demo/ranking?measure=median_time_lost&kind=segment&${WINDOW}`;
  assert.equal((await f.fetch(corridor + "&from_stop=A%2F1&to_stop=B")).status, 200);
  assert.equal(f.requests.length, 5);
  const [series, vehicle, alerts, ranking, segment] = f.requests.map(
    (req) => new URL(req.url).searchParams,
  );
  assert.equal(series.get("group"), "weekday_hour");
  assert.equal(vehicle.get("vehicle"), "45/68");
  assert.deepEqual([alerts.get("effect"), alerts.get("cause")], ["DETOUR", "CONSTRUCTION"]);
  assert.deepEqual(
    ["line", "direction", "hour", "day_type", "format", "lang"].map((name) => ranking.get(name)),
    ["123", "1", "7", "weekday", "csv", "fr"],
  );
  assert.deepEqual(
    ["kind", "from_stop", "to_stop"].map((name) => segment.get(name)),
    ["segment", "A/1", "B"],
  );
});

for (const path of [MEASURE, RANKING + "&format=csv", HEALTH]) {
  test(`a closed window gets the long TTL only after the engine confirms settlement (${path})`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2020-01-03T14:00:00Z") });
    const csv = path.includes("format=csv");
    let pending;
    const f = fixture(t, () => {
      const headers = {
        "content-type": csv ? "text/csv" : "application/json",
        "x-transit-cleaning-version": "6",
      };
      if (pending !== undefined) headers["x-transit-days-pending"] = pending;
      return new Response(csv ? "measure,value\n" : JSON.stringify(ANSWER), { headers });
    });
    for (const [readiness, ttl] of [[undefined, 30], ["1", 30], ["0", 604800]]) {
      pending = readiness;
      assert.equal((await f.fetch(path)).status, 200);
      assert.equal([...f.answers].find(([key]) => key.includes("/demo/"))[1].ttl, ttl);
      t.mock.timers.tick(31_000);
    }
    await f.fetch(path);
    assert.equal(f.requests.length, 3);
  });
}

test("cache eviction and upstream failures return the same question's saved answer", async (t) => {
  let result = "good";
  const exactJson = '{"value":9007199254740993,"state_text":{"en":"Measured","fr":"Mesuré"},"evidence":{}}';
  const f = fixture(t, () => {
    if (result === "throw") throw new Error("service unavailable");
    if (result === "http") return new Response(null, { status: 500 });
    return new Response(exactJson, { headers: { "content-type": "application/json" } });
  });
  assert.equal(await (await f.fetch(MEASURE)).text(), exactJson);
  assert.equal([...f.saved.values()].find(({ value }) => value === exactJson).expirationTtl, 2592000);
  f.answers.clear();
  const fetchEngine = f.env.ENGINE.fetch;
  f.env.ENGINE.fetch = async (request) => {
    if (new URL(request.url).pathname === "/cities") throw new Error("catalog offline");
    return fetchEngine(request);
  };
  for (const failure of ["throw", "http"]) {
    result = failure;
    const response = await f.fetch(MEASURE);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-transit-answer"), "last-good");
    assert.match(response.headers.get("access-control-expose-headers"), /X-Transit-Answer/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), `{"stale":true,${exactJson.slice(1)}`);
    assert.ok(![...f.answers.keys()].some((key) => key.includes("/measure?")));
  }
  assert.equal((await f.fetch(MEASURE + "&line=1")).status, 503);
});

test("the engine owns the CSV and bilingual registry representations", async (t) => {
  const csv = "Mesure,Valeur\r\nPonctualité,0\r\n";
  let offline = false;
  const methods = [{ id: "on_time", text: { en: { unit: "Share" }, fr: { unit: "Part" } } }];
  const f = fixture(t, (request) => {
    if (offline) throw new Error("unavailable");
    const { pathname, search, searchParams } = new URL(request.url);
    if (pathname === "/how-we-measure") {
      assert.equal(search, "");
      return Response.json(methods);
    }
    assert.equal(searchParams.get("format"), "csv");
    assert.equal(searchParams.get("lang"), "fr");
    return new Response(csv, { headers: {
      "content-type": "text/csv; charset=utf-8", "x-transit-cleaning-version": "6",
    } });
  });
  const exportPath = MEASURE + "&format=csv&lang=fr";
  const catalogPath = "/v2/how-we-measure?lang=fr";
  assert.equal(await (await f.fetch(exportPath)).text(), csv);
  assert.match([...f.answers.keys()].find((key) => key.includes("/measure?")), /\/6\//);
  assert.deepEqual(await (await f.fetch(catalogPath)).json(), methods);
  offline = true;
  f.answers.clear();
  const stale = await f.fetch(exportPath);
  assert.equal(stale.headers.get("x-transit-answer"), "last-good");
  assert.equal(await stale.text(), csv);
  const staleCatalog = await f.fetch(catalogPath);
  assert.equal(staleCatalog.headers.get("x-transit-answer"), "last-good");
  assert.deepEqual(await staleCatalog.json(), methods);
});

test("engine busy keeps Retry-After even with a last good answer", async (t) => {
  let overloaded = false;
  const f = fixture(t, () => overloaded
    ? Response.json({ message: "busy, try again" }, { status: 503, headers: { "retry-after": "3" } })
    : Response.json(ANSWER));
  await f.fetch(MEASURE);
  f.answers.clear();
  overloaded = true;
  const response = await f.fetch(MEASURE);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("x-transit-answer"), null);
  assert.deepEqual(await response.json(), { message: "busy, try again" });
});

test("a bound record read retries engine contention under its original admission", async (t) => {
  let attempts = 0;
  const f = fixture(t, (request) => fetchEngine(
    request,
    { ENGINE_ORIGIN: "https://local-engine.invalid" },
    async () => ++attempts === 1
      ? new Response(null, { status: 503, headers: { "retry-after": "0" } })
      : Response.json(ANSWER),
  ));
  let admissions = 0;
  f.env.QUESTION_LIMIT.limit = async () => ({ success: ++admissions === 1 });
  const response = await f.fetch(MEASURE, {
    "x-transit-record-deadline": String(Date.now() + 10_000),
  }, "GET", true);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ANSWER);
  assert.equal(f.requests.length, 1);
  assert.equal(attempts, 2);
  assert.equal(admissions, 1);
  const cached = await f.fetch(MEASURE, {
    "x-transit-record-deadline": String(Date.now() + 10_000),
  }, "GET", true);
  assert.equal(cached.headers.get("cache-status"), "Transit; hit");
  assert.equal(attempts, 2);
  assert.equal(admissions, 1);
});

test("public callers cannot opt in to retries and short record budgets are respected", async (t) => {
  const f = fixture(t, () =>
    new Response(null, { status: 503, headers: { "retry-after": "2" } }));
  const headers = { "x-transit-record-deadline": String(Date.now() + 10_000) };
  assert.equal((await f.fetch(MEASURE, headers)).status, 503);
  assert.equal(f.requests.length, 1);
  const short = { "x-transit-record-deadline": String(Date.now() + 1_000) };
  assert.equal((await f.fetch(MEASURE, short, "GET", true)).status, 503);
  assert.equal(f.requests.length, 2);
});

test("rate limiting keys on hashed client IP and only runs for cache misses", async (t) => {
  const f = fixture(t);
  const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const limit = Number(config.match(/simple = \{ limit = (\d+), period = 60 \}/)?.[1]);
  assert.ok(limit >= 2 * (15 + 3));
  const counts = new Map();
  f.env.QUESTION_LIMIT.limit = async ({ key }) => {
    assert.match(key, /^[a-f0-9]{64}$/);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { success: counts.get(key) <= limit };
  };
  const ip = { "cf-connecting-ip": "192.0.2.1" };
  for (let question = 1; question <= limit; question += 1) {
    assert.equal((await f.fetch(MEASURE + "&line=" + question, ip)).status, 200);
  }
  assert.equal((await f.fetch(MEASURE + "&line=1", ip)).status, 200);
  const next = MEASURE + "&line=" + (limit + 1);
  const rejected = await f.fetch(next, ip);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "60");
  assert.deepEqual(await rejected.json(), { message: "busy, try again" });
  assert.equal(f.requests.length, limit);
  assert.equal((await f.fetch(next, { "cf-connecting-ip": "192.0.2.2" })).status, 200);
  assert.equal(counts.size, 2);
});

test("missing binding and unknown registry measures get honest responses", async (t) => {
  const f = fixture(t, () => Response.json({ message: "unknown measure" }, { status: 400 }));
  assert.equal((await f.fetch(MEASURE)).status, 400);
  assert.ok(![...f.saved.values()].some(({ metadata }) => metadata?.contentType));
  delete f.env.ENGINE;
  const unavailable = await f.fetch(MEASURE);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { message: "engine not configured" });
  assert.equal((await f.fetch(MEASURE, {}, "HEAD")).status, 405);
  const preflight = await f.fetch(MEASURE, {}, "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("delay distribution validates its cuts and handles an older engine", async (t) => {
  const distribution = `/v2/demo/measure?measure=delay_distribution&${WINDOW}`;
  const answer = { measure: "delay_distribution", group: "delay_minute", cells: [] };
  const f = fixture(t, (request) => {
    const params = new URL(request.url).searchParams;
    if (params.get("measure") !== "delay_distribution") return Response.json(ANSWER);
    if (!params.has("line")) return Response.json({ message: "unknown measure" }, { status: 400 });
    assert.equal(params.get("line"), "24");
    assert.equal(params.get("direction"), "1");
    assert.equal(params.get("stop"), "S1");
    assert.equal(params.get("hour"), "7");
    assert.equal(params.get("day_type"), "weekday");
    return Response.json(answer);
  });
  for (const path of [
    distribution + "&group=day",
    distribution + "&direction=2",
    distribution + "&vehicle=1",
    distribution + "&effect=DETOUR",
    distribution + "&departure=07:00:00",
    distribution.replace("/measure?", "/ranking?kind=line&"),
  ]) assert.equal((await f.fetch(path)).status, 400);
  assert.equal(f.requests.length, 0);
  const unavailable = await f.fetch(distribution);
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.headers.get("retry-after"), null);
  assert.deepEqual(await unavailable.json(), {
    reason: "delay_distribution_unsupported", message: "engine unavailable",
  });
  assert.equal((await f.fetch(MEASURE)).status, 200);
  const response = await f.fetch(distribution + "&line=24&direction=1&stop=S1&hour=07&day_type=weekday");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), answer);
});


test("serves and caches the search index with the normal limit and no v1 catalog", async (t) => {
  const body = { schedule: null, vehicles: null, vehicle_state: "not_tracked" };
  const harness = fixture(t, (request) => {
    assert.equal(new URL(request.url).pathname, "/search-index");
    assert.equal(new URL(request.url).search, "?city=demo");
    return Response.json(body);
  });
  harness.env.SNAPSHOTS = undefined;
  for (const path of [
    "/v2/demo/search-index?q=private-term",
    "/v2/%2e%2e%2fdemo/search-index",
  ]) assert.equal((await harness.fetch(path)).status, 400);
  assert.equal((await harness.fetch("/v2/demo/search-index", {}, "POST")).status, 405);
  for (let i = 0; i < 2; i += 1) {
    const response = await harness.fetch("/v2/demo/search-index");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), body);
  }
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.visitors.length, 1);
});

test("the city endpoint and dated questions share the declaration catalog", async (t) => {
  const f = fixture(t);
  f.cities.providers[0].name_separators = {
    ends: "<>",
    languages: "~",
    language_order: ["en", "fr"],
  };
  assert.equal((await f.fetch("/v2/cities?city=demo")).status, 400);
  assert.equal(f.cityRequests.length, 0);
  assert.deepEqual(await (await f.fetch("/v2/cities")).json(), {
    ...f.cities,
    providers: f.cities.providers.map((provider) => ({ ...provider, basemap_v2_url: null })),
  });
  assert.equal((await f.fetch(MEASURE.replace("/demo/", "/private/"))).status, 400);
  assert.equal(f.requests.length, 0);
  assert.equal(f.cityRequests.length, 1);
  assert.equal(f.cityRequests[0].headers.get("authorization"), "Bearer fixture-token");
  assert.equal((await f.fetch(MEASURE)).status, 200);
});

test("the city catalog adds canonical v2 basemap URLs to fresh and cached catalogs", async (t) => {
  const f = fixture(t);
  f.cities.default_provider = "stm";
  f.cities.providers = [
    { id: "stm", timezone: "America/Toronto", basemap_url: "/data/v1/stm/static/basemap/montreal.pmtiles" },
    { id: "octranspo", timezone: "America/Toronto", basemap_url: "/data/v1/octranspo/static/basemap/ottawa.pmtiles" },
    { id: "other-city", timezone: "Europe/Paris", basemap_url: "/data/v1/stm/static/basemap/montreal.pmtiles" },
  ];
  const expected = JSON.parse(readFileSync(new URL("./fixtures/cities-basemaps.golden.json", import.meta.url), "utf8"));
  for (let request = 0; request < 2; request++) {
    assert.deepEqual(await (await f.fetch("/v2/cities")).json(), expected);
  }
  assert.equal(f.cityRequests.length, 1);
});

test("settled answer lifetime uses each declared city's local date", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2020-01-03T01:30:00Z") });
  const f = fixture(t);
  await f.fetch(MEASURE);
  await f.fetch(MEASURE.replace("/demo/", "/other-city/"));
  const ttl = (city) => [...f.answers].find(([key]) => key.includes(`/${city}/measure?`))[1].ttl;
  assert.equal(ttl("demo"), 30);
  assert.equal(ttl("other-city"), 604800);
});

test("service-binding health probes the engine directly and keeps the public endpoint closed", async () => {
  const requests = [];
  const env = {
    TRANSIT1_ENGINE_ACCESS_TOKEN: "test-token",
    ENGINE: {
      fetch(request) {
        requests.push(request);
        return Response.json({ boot_id: "test-boot" });
      },
    },
  };
  const response = await probeEngine(env, new AbortController().signal);
  assert.deepEqual(await response.json(), { engine: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(requests[0].url, "https://transit-engine.internal/healthz");
  assert.equal(requests[0].headers.get("authorization"), "Bearer test-token");

  const publicProbe = await worker.fetch(new Request("https://data.yesid.dev/v2/health"), env, {});
  assert.equal(publicProbe.status, 404);
  assert.equal(requests.length, 1);
});

test("engine health distinguishes missing configuration from an unavailable engine", async () => {
  const signal = new AbortController().signal;
  const unconfigured = await probeEngine({}, signal);
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { engine: "unconfigured" });

  const unreachable = await probeEngine({
    TRANSIT1_ENGINE_ACCESS_TOKEN: "test-token",
    ENGINE: { fetch: () => Response.json({ message: "internal error" }, { status: 503 }) },
  }, signal);
  assert.equal(unreachable.status, 503);
  assert.deepEqual(await unreachable.json(), { engine: "unavailable" });
});

test("the catalog refresh after a mirror copy keeps each provider's record date", async (t) => {
  const f = fixture(t);
  f.cities.providers[0].record_through = "2026-11-23";
  f.cities.providers[1].record_through = null;
  const catalog = async (headers) => (await f.fetch("/v2/cities", headers)).json();
  assert.deepEqual((await catalog()).providers.map((city) => city.record_through), [
    "2026-11-23", null,
  ]);
  f.cities.providers[0].record_through = "2026-11-24";
  assert.equal((await catalog()).providers[0].record_through, "2026-11-23");
  assert.equal((await catalog({ "cache-control": "no-cache" })).providers[0].record_through, "2026-11-24");
  assert.equal((await catalog()).providers[0].record_through, "2026-11-24");
  assert.equal(f.cityRequests.length, 2);
  assert.equal(JSON.parse(f.saved.get("transit-city-catalog").value).providers[0].record_through,
    "2026-11-24");
});

test("a settled period reuses a shared answer after edge eviction without spending admission", async (t) => {
  const f = fixture(t);
  await f.fetch(MEASURE);
  f.answers.clear();
  const shared = await f.fetch(MEASURE);
  assert.deepEqual(await shared.json(), ANSWER);
  assert.equal(shared.headers.get("x-transit-answer"), null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.visitors.length, 1);
  assert.equal((await f.fetch(MEASURE)).headers.get("cache-status"), "Transit; hit");
});

test("indexes retain the last response while an updated revision refreshes", async (t) => {
  let response = 1;
  const f = fixture(t, () => Response.json({ schedule: { revision: response } }));
  const url = "/v2/demo/schedule-index";
  assert.equal((await (await f.fetch(url)).json()).schedule.revision, 1);
  f.answers.clear();
  assert.equal((await (await f.fetch(url)).json()).schedule.revision, 1);
  assert.equal(f.requests.length, 1);
  f.cities.answer_revision = f.engine.revision = NEXT_REVISION;
  await f.fetch("/v2/cities", { "cache-control": "no-cache" });
  response = 2;
  const stale = await f.fetch(url);
  assert.equal(stale.headers.get("x-transit-answer"), "last-good");
  assert.equal((await stale.json()).schedule.revision, 1);
  const current = await f.fetch(url);
  assert.equal(current.headers.get("x-transit-answer"), null);
  assert.equal((await current.json()).schedule.revision, 2);
  assert.equal(f.requests.length, 2);
});
