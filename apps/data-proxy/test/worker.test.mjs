import assert from "node:assert/strict";
import { test } from "node:test";

import workerSource from "../src/worker.js";

const publicCities = new Set(["stm", "octranspo"]);
const retiredBasemaps = new Map([
  ["/v1/stm/static/basemap/montreal.pmtiles", "https://data.yesid.dev/v2/stm/basemap/montreal.pmtiles"],
]);
const worker = { fetch: (request, env, ctx) => workerSource.fetch(request, env, ctx, publicCities, retiredBasemaps) };

const BASEMAP_URL = "https://data.yesid.dev/v2/stm/basemap/montreal.pmtiles";
const CLEAN_STORAGE_ENV = {
  TRANSIT1_R2_ENDPOINT: "fixture.r2.cloudflarestorage.com",
  TRANSIT1_R2_READ_ACCESS_KEY_ID: "test-key",
  TRANSIT1_R2_READ_SECRET_ACCESS_KEY: "test-secret",
};

test("the v2 basemap route rejects non-tile paths", async () => {
  const url = BASEMAP_URL.replace("montreal.pmtiles", "%2fmanifest.json");
  const invalid = await worker.fetch(new Request(url), {});
  assert.equal(invalid.status, 404);
});

test("a private city’s basemap is hidden without looking up clean storage", async (t) => {
  const env = CLEAN_STORAGE_ENV;
  const clean = t.mock.method(globalThis, "fetch", () => new Response("TILE", {
    status: 206,
    headers: { ...partialMetadata, "content-range": "bytes 0-3/200" },
  }));
  const requestFor = (city) => new Request(`https://data.yesid.dev/v2/${city}/basemap/map.pmtiles`, {
    headers: { range: "bytes=0-3" },
  });
  const unknown = await worker.fetch(requestFor("unknown"), env);
  const hidden = await worker.fetch(requestFor("private-city"), env);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.status, unknown.status);
  assert.deepEqual([...hidden.headers], [...unknown.headers]);
  assert.equal(await hidden.text(), await unknown.text());
  assert.equal(clean.mock.callCount(), 0);
});

test("Montréal reads ranges and validators only from clean storage", async (t) => {
  const env = CLEAN_STORAGE_ENV;
  const object = { body: "P".repeat(196) + "TAIL", size: 200, httpEtag: '"basemap-rev-1"' };
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.host, "fixture.r2.cloudflarestorage.com");
    assert.match(init.headers.get("authorization"), /Credential=test-key\//);
    assert.equal(init.cache, "no-store");
    assert.equal(url.pathname, "/transit-clean/basemaps/v1/stm/montreal.pmtiles");

    const range = init.headers.get("range");
    if (init.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304 });
    if (init.headers.has("if-match")) return new Response("precondition failed", { status: 412 });
    if (range === "bytes=200-") return new Response("invalid range", { status: 416 });
    const headers = new Headers({ etag: object.httpEtag, "content-length": String(object.size) });
    headers.set("content-type", "application/octet-stream");
    if (init.method === "HEAD") {
      assert.equal(range, null);
      return new Response(null, { headers });
    }
    if (!range) return new Response(object.body, { headers });
    const [start, end] = { "bytes=0-15": [0, 15], "bytes=196-199": [196, 199],
      "bytes=198-209": [198, 199], "bytes=-4": [196, 199], "bytes=196-": [196, 199] }[range];
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(object.body.slice(start, end + 1)));
        controller.close();
      },
    }), { status: 206, headers });
  });

  const cases = [
    [{}, 200, object.body],
    [{ method: "HEAD", headers: { range: "bytes=0-15" } }, 200, ""],
    [{ headers: { range: "bytes=0-15" } }, 206, "P".repeat(16), "bytes 0-15/200"],
    [{ headers: { range: "bytes=196-199" } }, 206, "TAIL", "bytes 196-199/200"],
    [{ headers: { range: "bytes=198-209" } }, 206, "IL", "bytes 198-199/200"],
    [{ headers: { range: "bytes=196-" } }, 206, "TAIL", "bytes 196-199/200"],
    [{ headers: { range: "bytes=-4" } }, 206, "TAIL", "bytes 196-199/200"],
    [{ headers: { range: "bytes=3-2" } }, 206, object.body, "bytes 0-199/200"],
    [{ headers: { range: "bytes=200-" } }, 416, ""],
    [{ headers: { "if-none-match": object.httpEtag } }, 304, ""],
    [{ method: "HEAD", headers: { "if-match": '"different"' } }, 412, ""],
  ];
  for (const [init, status, body, contentRange] of cases) {
    fetch.mock.resetCalls();
    const result = await worker.fetch(new Request(BASEMAP_URL, init), env);
    assert.equal(result.status, status);
    assert.equal(result.headers.get("x-transit-source"), "clean");
    assert.match(result.headers.get("access-control-expose-headers"), /\bX-Transit-Source\b/);
    assert.equal(result.headers.get("content-range"), contentRange ?? null);
    assert.equal(await result.text(), body);
    assert.equal(fetch.mock.callCount(), [304, 412].includes(status) ? 2 : 1);
  }
});

const partialMetadata = {
  "content-type": "application/octet-stream",
  "content-length": "4",
  etag: '"clean-rev-1"',
};

test("Ottawa basemap ranges identify clean storage", async (t) => {
  const env = CLEAN_STORAGE_ENV;
  t.mock.method(globalThis, "fetch", (url, init) => {
    assert.equal(url.pathname, "/transit-clean/basemaps/v1/octranspo/ottawa.pmtiles");
    assert.equal(init.headers.get("range"), "bytes=0-3");
    return new Response("TILE", {
      status: 206,
      headers: { ...partialMetadata, "content-range": "bytes 0-3/200" },
    });
  });
  const response = await worker.fetch(new Request("https://data.yesid.dev/v2/octranspo/basemap/ottawa.pmtiles", {
    headers: { range: "bytes=0-3" },
  }), env);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("x-transit-source"), "clean");
  assert.equal(await response.text(), "TILE");
});

test("a clean basemap miss returns an uncacheable 404", async (t) => {
  const env = CLEAN_STORAGE_ENV;
  const fetch = t.mock.method(globalThis, "fetch", (url) => {
    assert.equal(url.pathname, "/transit-clean/basemaps/v1/stm/montreal.pmtiles");
    return new Response("private upstream detail", { status: 404 });
  });
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request(BASEMAP_URL, { method }), env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("x-transit-source"), null);
    assert.equal(await response.text(), "");
  }
  assert.equal(fetch.mock.callCount(), 2);
});

for (const [failure, warning, fetchClean] of [
  ["thrown fetch", "read error", () => { throw new Error("private upstream detail"); }],
  ["forbidden", "4xx", () => new Response("private upstream detail", { status: 403 })],
  ["unavailable", "5xx", () => new Response("private upstream detail", { status: 503 })],
  ["missing content range", "invalid response", () =>
    new Response("TILE", { status: 206, headers: partialMetadata })],
  ["missing object metadata", "invalid response", () => new Response("TILE", {
    status: 206, headers: { "content-range": "bytes 196-199/200", "content-length": "4" },
  })],
  ["upstream body abort before byte one", "read error", () => {
    const body = new ReadableStream({
      pull() { throw new DOMException("private upstream detail", "AbortError"); },
    });
    return new Response(body, {
      status: 206, headers: { ...partialMetadata, "content-range": "bytes 196-199/200" },
    });
  }],
]) {
  test(`v2 basemap returns an uncacheable 503 on clean storage ${failure}`, async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const fetch = t.mock.method(globalThis, "fetch", fetchClean);
    const env = CLEAN_STORAGE_ENV;
    const request = new Request(BASEMAP_URL, { headers: { range: "bytes=196-199" } });

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("access-control-expose-headers"), /\bRetry-After\b/);
    assert.equal(await response.text(), "");
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls.map(({ arguments: args }) => args), [["Clean basemap read failed", warning]]);
  });
}

test("a clean basemap read that times out returns a retryable 503", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const env = CLEAN_STORAGE_ENV;
  const { promise: started, resolve: start } = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    start();
  }));
  const pending = worker.fetch(new Request(BASEMAP_URL), env);
  await started;
  t.mock.timers.tick(10_000);
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
});

test("v2 basemap propagates a client abort during the first clean body read", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const controller = new AbortController();
  const clientAbort = new DOMException("client disconnected", "AbortError");
  const env = CLEAN_STORAGE_ENV;
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Response(new ReadableStream({
    pull() {
      controller.abort(clientAbort);
      signal.throwIfAborted();
    },
  }, { highWaterMark: 0 }), {
    status: 206, headers: { ...partialMetadata, "content-range": "bytes 196-199/200" },
  }));
  const request = new Request(BASEMAP_URL, {
    headers: { range: "bytes=196-199" }, signal: controller.signal,
  });
  await assert.rejects(() => worker.fetch(request, env), (error) => error === clientAbort);
  assert.equal(warn.mock.callCount(), 0);
});

test("v2 basemap returns the clean stream as soon as the first bytes arrive", async (t) => {
  const chunks = ["TA", "IL"];
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(chunks.shift()));
      if (chunks.length === 0) controller.close();
    },
  }, { highWaterMark: 0 });
  t.mock.method(globalThis, "fetch", () => new Response(body, {
    status: 206, headers: { ...partialMetadata, "content-range": "bytes 196-199/200" },
  }));
  const request = new Request(BASEMAP_URL, { headers: { range: "bytes=196-199" } });
  const result = await worker.fetch(request, CLEAN_STORAGE_ENV);
  assert.equal(result.status, 206);
  assert.deepEqual(chunks, ["IL"]);
  assert.equal(await result.text(), "TAIL");
});

test("known tile bookmarks redirect to the equivalent v2 tile on both hosts", async () => {
  for (const prefix of ["https://transit.yesid.dev/data", "https://data.yesid.dev"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request(
        prefix + "/v1/stm/static/basemap/montreal.pmtiles",
        { method, headers: { range: "bytes=0-6" } },
      ), {});
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("location"), BASEMAP_URL);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(await response.text(), "");
    }
  }
});

test("old namespaces return 410 without redirecting unlisted tiles", async () => {
  for (const url of [
    "https://transit.yesid.dev/data/v1/stm/static/basemap/unknown.pmtiles",
    "https://transit.yesid.dev/data/v1/private-city/static/basemap/map.pmtiles",
    "https://data.yesid.dev/v1/stm/manifest.json",
    "https://data.yesid.dev/v1/stm/%zz.json",
    "https://transit.yesid.dev/data/v1%2Fstm/manifest.json",
    "https://transit.yesid.dev/v1/stm/manifest.json",
    "https://transit.yesid.dev/api/v1/anything",
  ]) {
    const response = await worker.fetch(new Request(url), {});
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type"), /^text\/plain/);
    assert.match(await response.text(), /https:\/\/transit\.yesid\.dev\/download/);
  }
  const head = await worker.fetch(new Request("https://data.yesid.dev/v1/file", { method: "HEAD" }), {});
  assert.equal(head.status, 410);
  assert.equal(await head.text(), "");
});

test("retirement does not cover unrelated data names or web API routes", async () => {
  for (const path of ["/data/v10/file", "/api/vitals"]) {
    const response = await worker.fetch(new Request("https://transit.yesid.dev" + path), {});
    assert.equal(response.status, 404);
  }
});
