import assert from "node:assert/strict";
import { test } from "node:test";

import workerSource from "../src/worker.js";

const publicCities = new Set(["stm", "octranspo"]);
const worker = { fetch: (request, env, ctx) => workerSource.fetch(request, env, ctx, publicCities) };

const BASE = "https://transit.yesid.dev";

class FakeR2Object {
  constructor({
    body,
    etag,
    contentType,
    cacheControl,
    size,
    range,
    uploaded,
  }) {
    this.body = body;
    this.etag = etag;
    this.contentType = contentType;
    this.cacheControl = cacheControl;
    this.size = size ?? (typeof body === "string" ? body.length : undefined);
    this.range = range;
    this.uploaded = uploaded ?? new Date("2026-07-15T12:00:00Z");
  }

  get httpEtag() {
    return `"${this.etag}"`;
  }

  writeHttpMetadata(headers) {
    headers.set("content-type", this.contentType);
    headers.set("cache-control", this.cacheControl);
  }

  withoutBody() {
    return new FakeR2Object({
      body: undefined,
      etag: this.etag,
      contentType: this.contentType,
      cacheControl: this.cacheControl,
      size: this.size,
      uploaded: this.uploaded,
    });
  }
}

class FakeR2Bucket {
  constructor(objects) {
    this.objects = new Map(Object.entries(objects));
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? object.withoutBody() : null;
  }

  async get(key, options = {}) {
    const object = this.objects.get(key);
    if (!object) return null;
    const onlyIf = options.onlyIf;
    const ifMatch = onlyIf instanceof Headers ? onlyIf.get("if-match") : null;
    if (ifMatch !== null && ifMatch.replaceAll('"', "") !== object.etag) {
      return object.withoutBody();
    }
    const ifNoneMatch =
      onlyIf instanceof Headers
        ? onlyIf.get("if-none-match")
        : (onlyIf?.etagDoesNotMatch ?? null);
    if (
      ifNoneMatch !== null &&
      ifNoneMatch.replaceAll('"', "") === object.etag
    ) {
      return object.withoutBody();
    }
    const range = options.range;
    const rangeHeader = range instanceof Headers ? range.get("range") : null;
    if (rangeHeader && typeof object.body === "string") {
      const bounds = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      const suffix = /^bytes=-(\d+)$/.exec(rangeHeader);
      let offset = suffix ? Math.max(0, object.size - Number(suffix[1])) : Number(bounds?.[1] ?? 0);
      let end = Math.min(Number(bounds?.[2] || object.size - 1), object.size - 1);
      if (bounds?.[2] && Number(bounds[2]) < offset) {
        offset = 0;
        end = object.size - 1;
      }
      if (offset >= object.size) throw new Error("get: The requested range is not satisfiable. (10039)");
      return new FakeR2Object({
        body: object.body.slice(offset, end + 1),
        etag: object.etag,
        contentType: object.contentType,
        cacheControl: object.cacheControl,
        size: object.size,
        range: { offset, length: end - offset + 1 },
      });
    }
    return object;
  }
}

function makeEnv() {
  return {
    SNAPSHOTS: new FakeR2Bucket({
      "v1/stm/manifest.json": new FakeR2Object({
        body: '{"provider":"stm"}',
        etag: "manifest-rev-7",
        contentType: "application/json",
        cacheControl: "public, max-age=30",
      }),
      "v1/stm/static/routes_index.json": new FakeR2Object({
        body: '{"routes":[]}',
        etag: "routes-rev-7",
        contentType: "application/json",
        cacheControl: "public, max-age=604800",
      }),
      "v1/stm/static/basemap/montreal.pmtiles": new FakeR2Object({
        body: "P".repeat(196) + "TAIL",
        etag: "basemap-rev-1",
        contentType: "application/octet-stream",
        cacheControl: "public, max-age=2592000",
      }),
    }),
  };
}

function fetchWorker(path, init = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, init), makeEnv());
}

const BASEMAP_URL = "https://data.yesid.dev/v2/stm/basemap/montreal.pmtiles";
const CLEAN_STORAGE_ENV = {
  TRANSIT1_R2_ENDPOINT: "fixture.r2.cloudflarestorage.com",
  TRANSIT1_R2_READ_ACCESS_KEY_ID: "test-key",
  TRANSIT1_R2_READ_SECRET_ACCESS_KEY: "test-secret",
};

test("GET /data/v1 key returns 200 with passthrough content-type and cache-control", async () => {
  const response = await fetchWorker("/data/v1/stm/manifest.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  assert.equal(response.headers.get("etag"), '"manifest-rev-7"');
  assert.equal(await response.text(), '{"provider":"stm"}');
});

test("GET missing key returns 404", async () => {
  const response = await fetchWorker("/data/v1/stm/definitely-missing.json");
  assert.equal(response.status, 404);
});

test("the v2 basemap route rejects non-tile paths", async () => {
  const url = BASEMAP_URL.replace("montreal.pmtiles", "%2fmanifest.json");
  const invalid = await worker.fetch(new Request(url), makeEnv());
  assert.equal(invalid.status, 404);
});

test("a private city's basemap is hidden even when both storage locations contain it", async (t) => {
  const env = { ...makeEnv(), ...CLEAN_STORAGE_ENV };
  const publicTile = env.SNAPSHOTS.objects.get("v1/stm/static/basemap/montreal.pmtiles");
  env.SNAPSHOTS.objects.set("v1/private-city/static/basemap/map.pmtiles", publicTile);
  const legacy = t.mock.method(env.SNAPSHOTS, "get");
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
  assert.equal(legacy.mock.callCount(), 0);
});

test("Montréal reads ranges and validators only from clean storage", async (t) => {
  const env = { ...makeEnv(), ...CLEAN_STORAGE_ENV };
  const legacy = env.SNAPSHOTS;
  const object = legacy.objects.get("v1/stm/static/basemap/montreal.pmtiles");
  const legacyGet = t.mock.method(legacy, "get");
  const legacyHead = t.mock.method(legacy, "head");
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
    object.writeHttpMetadata(headers);
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
  assert.equal(legacyGet.mock.callCount() + legacyHead.mock.callCount(), 0);
});

const partialMetadata = {
  "content-type": "application/octet-stream",
  "content-length": "4",
  etag: '"clean-rev-1"',
};

test("Ottawa basemap ranges identify clean storage", async (t) => {
  const env = { ...makeEnv(), ...CLEAN_STORAGE_ENV };
  const legacy = t.mock.method(env.SNAPSHOTS, "get");
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
  assert.equal(legacy.mock.callCount(), 0);
});

test("a clean basemap miss returns the usual 404 even if the legacy file exists", async (t) => {
  const env = { ...makeEnv(), ...CLEAN_STORAGE_ENV };
  const legacyGet = t.mock.method(env.SNAPSHOTS, "get");
  const legacyHead = t.mock.method(env.SNAPSHOTS, "head");
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
  assert.equal(legacyGet.mock.callCount() + legacyHead.mock.callCount(), 0);
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
  test(`v2 basemap leaves the legacy bucket alone on clean storage ${failure}`, async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const fetch = t.mock.method(globalThis, "fetch", fetchClean);
    const env = { ...makeEnv(), ...CLEAN_STORAGE_ENV };
    const request = new Request(BASEMAP_URL, { headers: { range: "bytes=196-199" } });
    const legacyRead = t.mock.method(env.SNAPSHOTS, "get");

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
    assert.equal(legacyRead.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls.map(({ arguments: args }) => args), [["Clean basemap read failed", warning]]);
  });
}

test("v2 basemap propagates a client abort during the first clean body read", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const controller = new AbortController();
  const clientAbort = new DOMException("client disconnected", "AbortError");
  const env = { ...makeEnv(), ...CLEAN_STORAGE_ENV };
  const legacyRead = t.mock.method(env.SNAPSHOTS, "get");
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
  assert.equal(legacyRead.mock.callCount(), 0);
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
  const result = await worker.fetch(request, { ...makeEnv(), ...CLEAN_STORAGE_ENV });
  assert.equal(result.status, 206);
  assert.deepEqual(chunks, ["IL"]);
  assert.equal(await result.text(), "TAIL");
});

test("GET path outside /data/v1 returns 404", async () => {
  for (const path of [
    "/data/secrets.txt",
    "/data/",
    "/healthz",
    "/v1/stm/manifest.json",
  ]) {
    const response = await fetchWorker(path);
    assert.equal(response.status, 404, `expected 404 for ${path}`);
  }
});

test("retired STO compatibility paths return uncacheable 410", async () => {
  for (const url of [
    `${BASE}/data/v1/sto/static/routes_index.json`,
    `${BASE}/data/v1%2Fsto/static/routes_index.json`,
    `${BASE}/data/v1/sto%2Fstatic/routes_index.json`,
    `${BASE}/data/v1/%73to/static/routes_index.json`,
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request(url, { method }),
        makeEnv(),
      );
      assert.equal(response.status, 410, `${method} ${url}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(await response.text(), "");
    }
  }
});

test("POST returns 405 with Allow GET, HEAD, OPTIONS", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await fetchWorker("/data/v1/stm/manifest.json", {
      method,
    });
    assert.equal(response.status, 405, `expected 405 for ${method}`);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
});

test("HEAD returns 200 with headers and empty body", async () => {
  const response = await fetchWorker("/data/v1/stm/manifest.json", {
    method: "HEAD",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  assert.equal(response.headers.get("etag"), '"manifest-rev-7"');
  assert.equal(await response.text(), "");
});

for (const { name, headers, status } of [
  {
    name: "matching If-None-Match",
    headers: { "if-none-match": '"manifest-rev-7"' },
    status: 304,
  },
  {
    name: "mismatching If-Match",
    headers: { "if-match": '"different-revision"' },
    status: 412,
  },
  {
    name: "satisfied If-Match followed by matching If-None-Match",
    headers: {
      "if-match": '"manifest-rev-7"',
      "if-none-match": '"manifest-rev-7"',
    },
    status: 304,
  },
  {
    name: "satisfied If-Unmodified-Since followed by matching If-None-Match",
    headers: {
      "if-unmodified-since": "Wed, 15 Jul 2026 12:00:01 GMT",
      "if-none-match": '"manifest-rev-7"',
    },
    status: 304,
  },
  {
    name: "failed If-Match takes precedence over matching If-None-Match",
    headers: {
      "if-match": '"different-revision"',
      "if-none-match": '"manifest-rev-7"',
    },
    status: 412,
  },
]) {
  for (const method of ["GET", "HEAD"]) {
    test(`${method} ${name} returns ${status}`, async () => {
      const response = await fetchWorker("/data/v1/stm/manifest.json", {
        method,
        headers,
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("etag"), '"manifest-rev-7"');
      assert.equal(await response.text(), "");
    });
  }
}

test("GET response carries Access-Control-Allow-Origin star", async () => {
  const response = await fetchWorker("/data/v1/stm/static/routes_index.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const response = await fetchWorker("/data/v1/stm/manifest.json", {
    method: "OPTIONS",
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, HEAD, OPTIONS",
  );
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "If-None-Match, If-Modified-Since, Range",
  );
  assert.equal(
    response.headers.get("access-control-expose-headers"),
    "Content-Range, Content-Length, Accept-Ranges, ETag",
  );
  assert.equal(response.headers.get("access-control-max-age"), "86400");
  assert.equal(await response.text(), "");
});

test("GET with Range returns 206 with Content-Range + Accept-Ranges (pmtiles)", async () => {
  const response = await fetchWorker(
    "/data/v1/stm/static/basemap/montreal.pmtiles",
    {
      headers: { Range: "bytes=0-99" },
    },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-99/200");
  assert.equal(response.headers.get("content-length"), "100");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal((await response.text()).length, 100);
});

test("GET with an unsatisfiable Range returns a controlled 416", async () => {
  const response = await fetchWorker(
    "/data/v1/stm/static/basemap/montreal.pmtiles",
    {
      headers: { Range: "bytes=999-1000" },
    },
  );
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.text(), "");
});

test("GET without Range still returns 200 with full body + Accept-Ranges", async () => {
  const response = await fetchWorker(
    "/data/v1/stm/static/basemap/montreal.pmtiles",
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), null);
  assert.equal((await response.text()).length, 200);
});

test("HEAD advertises Accept-Ranges", async () => {
  const response = await fetchWorker(
    "/data/v1/stm/static/basemap/montreal.pmtiles",
    {
      method: "HEAD",
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(await response.text(), "");
});

test("malformed percent-encoding returns 404", async () => {
  const response = await fetchWorker("/data/v1/stm/%zz.json");
  assert.equal(response.status, 404);
});

test("percent-encoded path traversal returns 404", async () => {
  const response = await fetchWorker("/data/v1/%2e%2e/stm/manifest.json");
  assert.equal(response.status, 404);
});

test("error responses are not cacheable and still carry CORS", async () => {
  const missing = await fetchWorker("/data/v1/stm/definitely-missing.json");
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(missing.headers.get("access-control-allow-origin"), "*");

  const rejected = await fetchWorker("/data/v1/stm/manifest.json", {
    method: "POST",
  });
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.equal(rejected.headers.get("access-control-allow-origin"), "*");

  const ok = await fetchWorker("/data/v1/stm/manifest.json");
  assert.notEqual(ok.headers.get("cache-control"), "no-store");
});
