import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.js";

const WINDOW = "from=2020-01-01&to=2020-01-02";
const HEALTH = `/v2/demo/data-health?${WINDOW}`;
const MEASURE = `/v2/demo/measure?measure=on_time&${WINDOW}`;
const RANKING = `/v2/demo/ranking?measure=on_time&kind=line&${WINDOW}`;
const ANSWER = {
  value: { on_time: 0 },
  state_text: { en: "Measured", fr: "Mesuré" },
  evidence: { cleaning_versions: [6], counts: { scheduled: 100 } },
};

function fixture(t, respond = () => Response.json(ANSWER)) {
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

  async function fetch(path, headers = {}, method = "GET") {
    const tasks = [];
    const response = await worker.fetch(new Request(`https://data.yesid.dev${path}`, {
      method,
      headers: { origin: "https://transit1.yesid.dev", ...headers },
    }), env, { waitUntil: (task) => tasks.push(task) });
    await Promise.all(tasks);
    return response;
  }
  return { fetch, env, answers, saved, requests, visitors };
}

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
    MEASURE + "&hour=24",
    MEASURE + "&day_type=weekend",
    MEASURE + "&format=xml",
    MEASURE + "&lang=es",
    RANKING + "&limit=0",
    RANKING + "&limit=501",
    RANKING + "&limit=1e2",
    RANKING + "&class=frequent",
    RANKING.replace("kind=line", "kind=stop") + "&class=all",
    RANKING.replace("kind=line", "kind=trip"),
    RANKING + "&format=csv",
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
  assert.equal(ranking.searchParams.get("class"), "3:frequent");
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
    assert.equal(await response.text(), exactJson.replace("{", '{"stale":true,'));
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
