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
  redirect: 302,
  network: new TypeError("fetch failed"),
  timeout: new DOMException("origin timed out", "TimeoutError"),
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

test("valid origin errors are returned to the proxy without a second query", async () => {
  const ENGINE = binding();
  for (const status of [400, 401, 500]) {
    const response = await fetchEngine(
      request,
      { ENGINE, ENGINE_ORIGIN: "https://origin.invalid" },
      async () => new Response("origin response", { status }),
    );
    assert.equal(response.status, status);
  }
  assert.equal(ENGINE.calls.length, 0);
});
