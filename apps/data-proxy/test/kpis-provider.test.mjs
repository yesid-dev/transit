import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import worker from "../src/worker.js";
import { __resetKpisCachesForTests } from "../src/kpis.js";

const catalog = {
  default_provider: "stm",
  providers: [{ id: "stm" }, { id: "octranspo" }, { id: "fixture" }],
};
function bucket(defaultProvider = "stm") {
  const stamp = new Date().toISOString();
  const docs = new Map([
    ["v1/providers.json", { ...catalog, default_provider: defaultProvider }],
  ]);
  for (const [provider, route, count, delay, coverage] of [
    ["stm", "24", 2, 1, 80],
    ["octranspo", "88", 1, 3, 60],
    ["fixture", "Z9", 4, 7, 25],
  ]) {
    docs.set(`v1/${provider}/live/vehicles.json`, {
      generated_utc: stamp,
      vehicles: Array.from({ length: count }, (_, i) => ({
        id: String(i),
        route,
      })),
    });
    docs.set(`v1/${provider}/live/trips.json`, {
      generated_utc: stamp,
      trips: { t: { route, delay_min: delay } },
    });
    docs.set(`v1/${provider}/live/network.json`, {
      generated_utc: stamp,
      coverage_pct: coverage,
    });
    docs.set(`v1/${provider}/static/routes_index.json`, {
      routes: Array.from({ length: count }, () => ({ type: 3 })),
    });
  }
  const reads = [];
  return {
    docs,
    reads,
    async get(key) {
      reads.push(key);
      return docs.has(key) ? { json: async () => docs.get(key) } : null;
    },
  };
}
function fetchKpis(storage, query = "", method = "GET") {
  return worker.fetch(
    new Request(`https://transit.yesid.dev/api/v1/kpis${query}`, { method }),
    { SNAPSHOTS: storage },
    { waitUntil() {} },
  );
}
beforeEach(__resetKpisCachesForTests);
for (const defaultProvider of ["octranspo", undefined, "unknown"]) {
  test(`explicit provider overrides default ${defaultProvider}`, async () => {
    const storage = bucket(defaultProvider);
    storage.docs.set("v1/providers.json", {
      ...catalog,
      default_provider: defaultProvider,
    });
    for (const [provider, expected] of [
      ["stm", 2],
      ["octranspo", 1],
    ]) {
      assert.equal(
        (await (await fetchKpis(storage, `?provider=${provider}`)).json())
          .vehicles,
        expected,
      );
    }
    assert.equal((await fetchKpis(storage, "?provider=")).status, 404);
    assert.equal((await fetchKpis(storage, "?provider=unknown")).status, 404);
  });
}

const invalidCatalogs = [
  ["absent", null],
  ["missing providers", {}],
  ["bad providers", { ...catalog, providers: {} }],
  ["missing default", { providers: catalog.providers }],
  ...[null, "", 3, {}, "unknown", " stm "].map((value) => [
    `default ${JSON.stringify(value)}`,
    { ...catalog, default_provider: value },
  ]),
  [
    "duplicate default",
    { ...catalog, providers: [{ id: "stm" }, { id: "stm" }] },
  ],
  ["invalid JSON", "invalid-json"],
  ["rejected read", "rejected-read"],
];
for (const [name, invalid] of invalidCatalogs) {
  test(`missing, malformed or unknown default returns pipeline_cold: ${name}`, async (t) => {
    const storage = bucket();
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const cache = new Map();
    const previous = globalThis.caches;
    t.after(() => {
      if (previous === undefined) delete globalThis.caches;
      else globalThis.caches = previous;
    });
    let edgeReads = 0;
    globalThis.caches = {
      default: {
        match: async (key) => {
          edgeReads++;
          return cache.get(key)?.clone();
        },
        put: async (key, response) => cache.set(key, response),
      },
    };
    assert.equal((await fetchKpis(storage)).status, 200);
    assert.equal(cache.size, 1);
    if (name === "absent") storage.docs.delete("v1/providers.json");
    else storage.docs.set("v1/providers.json", invalid);
    const get = storage.get.bind(storage);
    storage.get = async (key) => {
      if (key === "v1/providers.json" && typeof invalid === "string") {
        storage.reads.push(key);
        if (invalid === "rejected-read")
          throw new Error("synthetic storage outage");
        return {
          json: async () => {
            throw new SyntaxError("synthetic invalid JSON");
          },
        };
      }
      return get(key);
    };
    now += 20_000;
    storage.reads.length = 0;
    const priorEdgeReads = edgeReads;
    for (const reset of [false, true]) {
      if (reset) __resetKpisCachesForTests();
      for (let i = 0; i < 2; i++) {
        const response = await fetchKpis(storage);
        assert.equal(response.status, 503);
        assert.equal(
          await response.text(),
          '{"error":"pipeline_cold","detail":"live snapshot missing or older than 60s"}',
        );
        assert.deepEqual(Object.fromEntries(response.headers), {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Retry-After",
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "retry-after": "20",
        });
      }
    }
    assert.deepEqual(storage.reads, ["v1/providers.json", "v1/providers.json"]);
    assert.equal(edgeReads, priorEdgeReads);
    now += 20_000;
    storage.docs.set("v1/providers.json", catalog);
    storage.get = get;
    assert.equal((await fetchKpis(storage)).status, 200);
  });
}

test("default selection refreshes at catalogue cadence without leaking provider caches", async (t) => {
  const storage = bucket();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  assert.equal((await (await fetchKpis(storage)).json()).vehicles, 2);
  storage.docs.set("v1/providers.json", {
    ...catalog,
    default_provider: "octranspo",
  });
  now += 19_999;
  assert.equal((await (await fetchKpis(storage)).json()).vehicles, 2);
  assert.equal(
    storage.reads.filter((key) => key === "v1/providers.json").length,
    1,
  );
  now++;
  assert.equal((await (await fetchKpis(storage)).json()).vehicles, 1);
  assert.equal(
    (await (await fetchKpis(storage, "?provider=stm")).json()).vehicles,
    2,
  );
  assert.equal(
    storage.reads.filter((key) => key === "v1/providers.json").length,
    2,
  );
});

test("a valid default with an observed empty vehicle array returns zero", async () => {
  const storage = bucket("fixture");
  storage.docs.set("v1/fixture/live/vehicles.json", {
    generated_utc: new Date().toISOString(),
    vehicles: [],
  });
  const response = await fetchKpis(storage);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).vehicles, 0);
});
for (const [provider, vehicles, delay, coverage] of [
  ["octranspo", 1, 180, 0.6],
  ["fixture", 4, 420, 0.25],
]) {
  test(`unqualified KPI request follows catalogue default ${provider}, not STM or array order`, async () => {
    const storage = bucket(provider);
    const response = await fetchKpis(storage);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.vehicles, vehicles);
    assert.equal(body.avgDelayS, delay);
    assert.equal(body.coverage, coverage);
    assert.ok(
      storage.reads.every(
        (key) =>
          key === "v1/providers.json" || key.startsWith(`v1/${provider}/`),
      ),
    );
  });
}
for (const provider of ["stm", "octranspo"]) {
  test(`${provider} selects its own snapshot and route total`, async () => {
    const storage = bucket();
    const response = await fetchKpis(storage, `?provider=${provider}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.vehicles, provider === "stm" ? 2 : 1);
    assert.equal(body.routesTotal, provider === "stm" ? 2 : 1);
    assert.equal(body.avgDelayS, provider === "stm" ? 60 : 180);
    assert.equal(body.coverage, provider === "stm" ? 0.8 : 0.6);
    assert.equal(body.topRoutes[0].route, provider === "stm" ? "24" : "88");
    assert.ok(
      storage.reads.every(
        (key) =>
          key === "v1/providers.json" || key.startsWith(`v1/${provider}/`),
      ),
    );
  });
}
test("catalogue default STM and concurrent providers never share in-flight or memo results", async () => {
  const storage = bucket();
  const responses = await Promise.all([
    fetchKpis(storage),
    fetchKpis(storage, "?provider=octranspo"),
  ]);
  assert.deepEqual(
    await Promise.all(responses.map(async (r) => (await r.json()).vehicles)),
    [2, 1],
  );
  assert.equal(
    (await (await fetchKpis(storage, "?provider=stm")).json()).vehicles,
    2,
  );
  assert.equal(
    (await (await fetchKpis(storage, "?provider=octranspo")).json()).vehicles,
    1,
  );
});
for (const provider of ["unknown", "", "../stm", "STM", "sto"]) {
  test(`unknown provider ${JSON.stringify(provider)} returns uncacheable 404`, async () => {
    const storage = bucket();
    const response = await fetchKpis(
      storage,
      `?provider=${encodeURIComponent(provider)}`,
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(await response.text(), "");
    assert.ok(storage.reads.every((key) => key === "v1/providers.json"));
  });
}
test("a cold provider cannot reuse another provider's warm core or failure cooldown", async () => {
  const storage = bucket();
  storage.docs.delete("v1/octranspo/live/vehicles.json");
  assert.equal((await fetchKpis(storage, "?provider=octranspo")).status, 503);
  assert.equal((await fetchKpis(storage)).status, 200);
  assert.equal((await fetchKpis(storage, "?provider=octranspo")).status, 503);
});
test("edge entries stay separate across isolate resets", async (t) => {
  const cache = new Map();
  const previous = globalThis.caches;
  t.after(() => {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  });
  globalThis.caches = {
    default: {
      match: async (key) => cache.get(key)?.clone(),
      put: async (key, value) => cache.set(key, value),
    },
  };
  const storage = bucket();
  await fetchKpis(storage);
  await fetchKpis(storage, "?provider=octranspo");
  assert.equal(cache.size, 2);
  __resetKpisCachesForTests();
  storage.docs.delete("v1/stm/live/vehicles.json");
  storage.docs.delete("v1/octranspo/live/vehicles.json");
  for (const [provider, expected] of [
    ["stm", 2],
    ["octranspo", 1],
  ]) {
    const response = await fetchKpis(storage, `?provider=${provider}`);
    assert.equal(response.headers.get("x-kpis-cache"), "hit");
    assert.equal((await response.json()).vehicles, expected);
  }
});

for (const missing of [true, false]) {
  test(`catalog ${missing ? "missing" : "malformed"} fails closed for explicit selection`, async () => {
    const storage = bucket();
    if (missing) storage.docs.delete("v1/providers.json");
    else storage.docs.set("v1/providers.json", {});
    assert.equal((await fetchKpis(storage, "?provider=octranspo")).status, 503);
    assert.ok(storage.reads.every((key) => key === "v1/providers.json"));
    assert.equal((await fetchKpis(storage)).status, 503);
  });
}
test("catalog membership is authoritative and refreshed at the live cadence", async (t) => {
  const storage = bucket();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  assert.equal((await fetchKpis(storage, "?provider=octranspo")).status, 200);
  const reads = storage.reads.length;
  await fetchKpis(storage, "?provider=octranspo");
  assert.equal(storage.reads.length, reads);
  storage.docs.set("v1/providers.json", { providers: [{ id: "stm" }] });
  now += 20_000;
  assert.equal((await fetchKpis(storage, "?provider=octranspo")).status, 404);
});
for (const provider of ["stm", "octranspo"]) {
  test(`${provider} accepts vehicles without trip, stop or occupancy and supports HEAD`, async () => {
    const storage = bucket();
    storage.docs.set(`v1/${provider}/live/vehicles.json`, {
      generated_utc: new Date().toISOString(),
      vehicles: [{ id: "unassigned" }],
    });
    const body = await (
      await fetchKpis(storage, `?provider=${provider}`)
    ).json();
    assert.equal(body.vehicles, 1);
    assert.equal(body.routesLive, 0);
    assert.deepEqual(body.topRoutes, []);
    const head = await fetchKpis(storage, `?provider=${provider}`, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });
}
