import assert from "node:assert/strict";
import test from "node:test";
import { probeV2, probeWebHealth } from "../scripts/probe-v2.mjs";

const day = "2026-11-24";
const captured = "2026-11-26T17:00:00Z";
const feed = {
  family: "trip_updates",
  captured_at: captured,
  fresh_for_seconds: 90,
  source_lag_seconds: 0,
  read_failed: false,
};

function fixture(path, response) {
  return async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://data.example");
    assert.equal(options.redirect, "manual");
    const key = target.pathname + target.search;
    if (key === path) return response();
    switch (key) {
      case "/v2/cities":
        return Response.json({
          default_provider: "fixture",
          providers: [
            {
              id: "fixture",
              inputs: { trip_updates: true },
              basemap_v2_url: "/v2/fixture/basemap/city.pmtiles",
              record_through: day,
              download_licence: {},
            },
            { id: "schedule_only", inputs: { static_schedule: true } },
          ],
        });
      case "/v2/fixture/live":
        return Response.json({ version: 2, city: "fixture", feeds: { trip_updates: feed } });
      case "/v2/fixture/live-trips?stop=1":
        return Response.json({ version: 2, city: "fixture", feed, trip_updates: [] });
      case "/v2/fixture/basemap/city.pmtiles":
        assert.equal(options.headers.range, "bytes=0-6");
        return new Response("PMTiles", {
          status: 206,
          headers: { "content-range": "bytes 0-6/1234", "x-transit-source": "clean" },
        });
      case `/v2/fixture/download?date=${day}`:
        return Response.json({ city: "fixture", service_date: day, status: "complete", files: [{}] });
      case `/v2/fixture/data-health?from=${day}&to=${day}`:
        return Response.json({ city: "fixture", from: day, to: day, days: [{ service_date: day }] });
      default:
        assert.fail(`Unexpected public request ${key}`);
    }
  };
}

const run = (fetchFn, seconds = 30, requireFresh = false) => probeV2({
  fetchFn,
  dataOrigin: "https://data.example",
  requireFresh,
  now: () => Date.parse(captured) + seconds * 1_000,
});

test("discovers cities, respects capabilities, and checks the announced record date", async () => {
  assert.deepEqual(await run(fixture()), []);
});

test("stale, well-formed live answers pass deploy verification and fail scheduled monitoring", async () => {
  assert.deepEqual(await run(fixture(), 120), []);
  assert.deepEqual(await run(fixture(), 120, true), [
    "v2 fixture fresh live failed",
    "v2 fixture live trips failed",
  ]);
});

const markedStale = (headers = {}) => {
  const fetchFn = fixture();
  return async (url, init) => {
    const response = await fetchFn(url, init);
    if (!new URL(url).pathname.startsWith("/v2/fixture/live")) return response;
    return Response.json({ ...await response.json(), stale: true }, { headers });
  };
};

test("deploy verification permits explicit stale markers only for valid live answers", async () => {
  assert.deepEqual(await run(markedStale()), []);
  assert.deepEqual(await run(markedStale({ "x-transit-answer": "last-good" })), [
    "v2 fixture live answer failed",
    "v2 fixture live trips failed",
  ]);
});

test("scheduled monitoring rejects live answers explicitly marked stale", async () => {
  assert.deepEqual(await run(markedStale(), 30, true), [
    "v2 fixture fresh live failed",
    "v2 fixture live trips failed",
  ]);
});

test("unparseable feed timestamps fail deploy verification", async () => {
  const corrupted = { ...feed, captured_at: "unavailable" };
  const fetchFn = fixture("/v2/fixture/live-trips?stop=1", () =>
    Response.json({ version: 2, city: "fixture", feed: corrupted, trip_updates: [] }));
  assert.deepEqual(await run(fetchFn), ["v2 fixture live trips failed"]);
});

test("a legacy tile source, missing downloads and last-good Record answers fail independently", async () => {
  for (const [path, response, name] of [
    ["/v2/fixture/basemap/city.pmtiles", () => new Response("private detail", { status: 206 }), "clean PMTiles range"],
    [`/v2/fixture/download?date=${day}`, () => Response.json({ city: "fixture", service_date: day, status: "missing", files: [] }), "dated downloads"],
    [`/v2/fixture/data-health?from=${day}&to=${day}`, () => Response.json({ city: "fixture", from: day, to: day, days: [{ service_date: day }] }, { headers: { "x-transit-answer": "last-good" } }), "Record answer"],
  ]) {
    assert.deepEqual(await run(fixture(path, response)), [`v2 fixture ${name} failed`]);
  }
});

test("web health requires the new worker and the deployed SHA when supplied", async () => {
  const commit = "a".repeat(40);
  const health = { status: "ok", engine: "ok", proxy: "ok", branch: "main", service: "transit1-web", commit };
  assert.equal(await probeWebHealth({ fetchFn: async () => Response.json(health), commit }), null);
  for (const change of [{ service: "transit-web" }, { commit: "b".repeat(40) }]) {
    assert.equal(await probeWebHealth({ fetchFn: async () => Response.json({ ...health, ...change }), commit }), "transit1-web health failed");
  }
});
