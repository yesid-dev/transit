import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { QUESTION_PARAMS } from "../src/question-params.js";
import { serveBoundQuestion } from "../src/questions.js";
import worker from "../src/worker.js";

const WINDOW = "from=2020-01-01&to=2020-01-02";
const HEALTH = `/v2/demo/data-health?${WINDOW}`;
const MEASURE = `/v2/demo/measure?measure=on_time&${WINDOW}`;
const RANKING = `/v2/demo/ranking?measure=on_time&kind=line&${WINDOW}`;
const ANSWER = {
  value: { on_time: 0 },
  state_text: { en: "Measured", fr: "Mesuré" },
  evidence: { cleaning_versions: [6], days_pending: [], counts: { scheduled: 100 } },
};

function fixture(t, respond = () => Response.json(ANSWER, {
  headers: { "x-transit-days-pending": "0" },
})) {
  const answers = new Map();
  const saved = new Map();
  const requests = [];
  const visitors = [];
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
    SNAPSHOTS: {
      async get(key) {
        const catalog = { providers: [{ id: "demo" }, { id: "other-city" }] };
        if (key === "v1/providers.json") return { json: async () => catalog };
        if (key === "v1/demo/manifest.json") return { json: async () => ({ tz: "America/Toronto" }) };
        return null;
      },
    },
    ENGINE: {
      async fetch(request) {
        requests.push(request);
        return respond(request);
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
    }), env, { waitUntil: (task) => tasks.push(task) });
    await Promise.all(tasks);
    return response;
  }
  return { fetch, env, answers, saved, requests, visitors };
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

test("rejects invalid questions before spending an engine slot or visitor budget", async (t) => {
  const f = fixture(t);
  for (const path of [
    MEASURE.replace("/demo/", "/unknown/"),
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
  assert.deepEqual(await first.json(), ANSWER);
  const second = await f.fetch(
    "/v2/demo/measure?line=A%2fB&to=2020-01-02&hour=7&measure=on_time&from=2020-01-01",
  );
  assert.deepEqual(await second.json(), ANSWER);
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
  assert.match(key, /\/6\/demo\/measure\?from=2020-01-01&hour=7&line=A%2FB&measure=on_time&to=2020-01-02$/);
  assert.equal(entry.ttl, 604800);
});

test("a newly observed cleaning version moves dated cache lookups to that version", async (t) => {
  let version = 6;
  const f = fixture(t, () => Response.json({ ...ANSWER, evidence: { cleaning_versions: [version] } }));
  await f.fetch(MEASURE);
  version = 7;
  await f.fetch(MEASURE + "&line=2");
  assert.deepEqual((await (await f.fetch(MEASURE)).json()).evidence.cleaning_versions, [7]);
  assert.equal(f.requests.length, 3);
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
  assert.equal([...f.saved.values()][0].expirationTtl, 2592000);
  f.answers.clear();
  for (const failure of ["throw", "http"]) {
    result = failure;
    const response = await f.fetch(MEASURE);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-transit-answer"), "last-good");
    assert.match(response.headers.get("access-control-expose-headers"), /X-Transit-Answer/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), `{"stale":true,${exactJson.slice(1)}`);
    assert.equal(f.answers.size, 0);
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

test("rate limiting keys on hashed client IP and only runs for cache misses", async (t) => {
  const f = fixture(t);
  const counts = new Map();
  f.env.QUESTION_LIMIT.limit = async ({ key }) => {
    assert.match(key, /^[a-f0-9]{64}$/);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { success: counts.get(key) <= 30 };
  };
  const ip = { "cf-connecting-ip": "192.0.2.1" };
  for (let question = 1; question <= 30; question += 1) {
    assert.equal((await f.fetch(MEASURE + "&line=" + question, ip)).status, 200);
  }
  assert.equal((await f.fetch(MEASURE + "&line=1", ip)).status, 200);
  const rejected = await f.fetch(MEASURE + "&line=31", ip);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "60");
  assert.deepEqual(await rejected.json(), { message: "busy, try again" });
  assert.equal(f.requests.length, 30);
  assert.equal((await f.fetch(MEASURE + "&line=31", { "cf-connecting-ip": "192.0.2.2" })).status, 200);
  assert.equal(counts.size, 2);
});

test("missing binding and unknown registry measures get honest responses", async (t) => {
  const f = fixture(t, () => Response.json({ message: "unknown measure" }, { status: 400 }));
  assert.equal((await f.fetch(MEASURE)).status, 400);
  assert.equal(f.saved.size, 0);
  delete f.env.ENGINE;
  const unavailable = await f.fetch(MEASURE);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { message: "engine not configured" });
  assert.equal((await f.fetch(MEASURE, {}, "HEAD")).status, 405);
  const preflight = await f.fetch(MEASURE, {}, "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});
