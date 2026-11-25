import assert from "node:assert/strict";
import test from "node:test";
import { fetchEngine } from "../upstream.js";

const request = new Request("https://worker.invalid//measure?city=stm&format=csv", {
  headers: { Authorization: "Bearer test-engine-token" },
});

function binding() {
  const calls = [];
  return {
    calls,
    getByName(name) {
      assert.equal(name, "network");
      return {
        fetch(upstream) {
          calls.push(upstream);
          return new Response("Container response");
        },
      };
    },
  };
}

test("configured HTTPS origin gets the path, query and bearer and returns its response", async () => {
  const ENGINE = binding();
  const originResponse = new Response("city,wait\nstm,10\n", {
    headers: { "content-type": "text/csv", "x-transit-cleaning-version": "10" },
  });
  const response = await fetchEngine(
    request,
    { ENGINE, ENGINE_ORIGIN: "https://origin.invalid" },
    async (upstream, options) => {
      assert.equal(upstream.url, "https://origin.invalid//measure?city=stm&format=csv");
      assert.equal(upstream.headers.get("Authorization"), "Bearer test-engine-token");
      assert.equal(options.redirect, "manual");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      return originResponse;
    },
  );
  assert.equal(response, originResponse);
  assert.equal(ENGINE.calls.length, 0);
});

const fallbacks = {
  unset: undefined,
  insecure: "http://origin.invalid",
  malformed: "https://user@origin.invalid",
  gateway: 502,
  unavailable: 503,
  "gateway timeout": 504,
  "disconnected tunnel": 530,
  network: new TypeError("fetch failed"),
};

for (const [name, failure] of Object.entries(fallbacks)) {
  test(`Container fallback strips the bearer after ${name}`, async () => {
    const ENGINE = binding();
    const skipOrigin = typeof failure === "string" || failure === undefined;
    let originCalls = 0;
    const response = await fetchEngine(
      request,
      { ENGINE, ENGINE_ORIGIN: skipOrigin ? failure : "https://origin.invalid" },
      async () => {
        originCalls++;
        if (failure instanceof Error) throw failure;
        return new Response("upstream failure", { status: failure });
      },
    );
    assert.equal(originCalls, skipOrigin ? 0 : 1);
    assert.equal(await response.text(), "Container response");
    assert.equal(ENGINE.calls.length, 1);
    assert.equal(ENGINE.calls[0].url, request.url);
    assert.equal(ENGINE.calls[0].headers.has("Authorization"), false);
  });
}

test("origin timeout returns 504 without querying the Container", async (t) => {
  const ENGINE = binding();
  const timeout = new DOMException("origin timed out", "TimeoutError");
  t.mock.method(AbortSignal, "timeout", (delay) => {
    assert.equal(delay, 25_000);
    return AbortSignal.abort(timeout);
  });

  const response = await fetchEngine(
    request,
    { ENGINE, ENGINE_ORIGIN: "https://origin.invalid" },
    async (_upstream, { signal }) => { signal.throwIfAborted(); },
  );
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(ENGINE.calls.length, 0);
});

test("the proxy's record budget extends the origin timeout and stays internal", async (t) => {
  const ENGINE = binding();
  t.mock.method(Date, "now", () => 1_000);
  t.mock.method(AbortSignal, "timeout", (delay) => {
    assert.equal(delay, 40_000);
    return new AbortController().signal;
  });
  const bounded = new Request(request);
  bounded.headers.set("x-transit-record-deadline", "41000");
  const response = await fetchEngine(bounded, { ENGINE, ENGINE_ORIGIN: "https://origin.invalid" },
    async (upstream) => {
      assert.equal(upstream.headers.has("x-transit-record-deadline"), false);
      return new Response("answer");
    });
  assert.equal(await response.text(), "answer");
});

test("origin busy response retains Retry-After without querying the Container", async () => {
  const ENGINE = binding();
  const busy = Response.json({ message: "busy, try again" }, {
    status: 503,
    headers: { "Retry-After": "1" },
  });
  const response = await fetchEngine(
    request,
    { ENGINE, ENGINE_ORIGIN: "https://origin.invalid" },
    async () => busy,
  );
  assert.equal(response, busy);
  assert.equal(ENGINE.calls.length, 0);
});

test("other origin statuses are returned to the proxy without a second query", async () => {
  const ENGINE = binding();
  for (const status of [302, 400, 401, 500]) {
    const response = await fetchEngine(
      request,
      { ENGINE, ENGINE_ORIGIN: "https://origin.invalid" },
      async () => new Response("origin response", { status }),
    );
    assert.equal(response.status, status);
  }
  assert.equal(ENGINE.calls.length, 0);
});
