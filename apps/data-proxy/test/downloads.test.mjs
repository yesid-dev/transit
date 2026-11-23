import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.js";

const DATE = "2026-11-20";
const STM = "/v2/stm/download";
const OC = "/v2/octranspo/download";
const TABLES = [
  "stop_events", "trip_days", "scheduled_stop_times", "vehicle_positions",
  "alerts", "feed_polls", "prediction_samples",
];
const SHA = "1".repeat(64);

function fixture({ city = "stm", status, missing = false, admitted = true, alerts = true } = {}) {
  const manifest = {
    provider: city,
    service_date: DATE,
    cleaning_version: "11",
    ...(status ? { status } : {
      ...(alerts ? {} : { alerts: "not_tracked" }),
      files: Object.fromEntries(TABLES.filter((name) => alerts || name !== "alerts").map(
        (name) => [`${name}.parquet`, { sha256: SHA, byte_size: 5 }],
      )),
    }),
  };
  const keys = [];
  const admissions = [];
  const upstream = [];
  const env = {
    TRANSIT1_ENGINE_ACCESS_TOKEN: "test",
    QUESTION_LIMIT: {
      async limit({ key }) {
        admissions.push(key);
        return { success: admitted };
      },
    },
    ENGINE: {
      async fetch(request) {
        const url = new URL(request.url);
        upstream.push(url);
        if (url.pathname === "/cities") {
          return Response.json({
            default_provider: "stm",
            providers: [
              { id: "stm", timezone: "America/Toronto" },
              { id: "octranspo", timezone: "America/Toronto", inputs: { i3_alerts: false, service_alerts: false } },
            ],
          });
        }
        assert.equal(url.pathname, "/data-health");
        return Response.json({}, { headers: { "x-transit-cleaning-version": "11" } });
      },
    },
    CLEAN_DOWNLOADS: {
      async get(key, options) {
        keys.push(key);
        if (key.endsWith("/manifest.json")) {
          return !missing && key === `${city}/${DATE}/v11/manifest.json` ? Response.json(manifest) : null;
        }
        assert.equal(key, `${city}/${DATE}/v11/stop_events.parquet`);
        const range = options?.range;
        const body = range ? "PAR1!".slice(range.offset, range.offset + range.length) : "PAR1!";
        return { size: 5, body: new Response(body).body };
      },
      async head(key) {
        keys.push(key);
        assert.equal(key, `${city}/${DATE}/v11/stop_events.parquet`);
        return { size: 5 };
      },
    },
  };
  const fetch = (path, init) => worker.fetch(new Request("https://data.test" + path, init), env, {
    waitUntil(promise) { return promise; },
  });
  return { fetch, admissions, keys, upstream };
}

test("a dated listing uses the public city catalog, current version and manifest identities", async () => {
  const { fetch, keys, upstream, admissions } = fixture();
  const response = await fetch(STM + "?date=" + DATE);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const day = await response.json();
  assert.equal(day.cleaning_version, "11");
  assert.equal(day.status, "complete");
  assert.equal(day.files.length, 7);
  assert.deepEqual(day.files[0], {
    name: "stop_events.parquet", byte_size: 5, sha256: SHA,
    url: `${STM}/${DATE}/stop_events.parquet?version=11`,
  });
  assert.equal(upstream[1].searchParams.get("from"), DATE);
  assert.deepEqual(keys, [`stm/${DATE}/v11/manifest.json`]);
  assert.equal(admissions.length, 1);
  const readme = await fetch(day.readme_url);
  assert.match(readme.headers.get("content-type"), /^text\/plain/);
  assert.match(readme.headers.get("content-disposition"), /README\.txt/);
  const text = await readme.text();
  for (const lang of ["en", "fr"]) {
    assert.ok(text.includes(day.licence.attribution[lang]));
    assert.ok(text.includes(day.licence.changes[lang]));
    assert.ok(text.includes(day.licence.url[lang]));
  }
  assert.ok(text.includes(SHA));
});

test("paths, service dates, versions and nonpublic cities are refused before opening a file", async () => {
  const { fetch, keys } = fixture();
  for (const path of [
    `${STM}/${DATE}/%2e%2e%2fstop_events.parquet`,
    `${STM}/2026-02-30/stop_events.parquet`,
    `${STM}/${DATE}/other.parquet`,
    `/v2/sto/download/${DATE}/stop_events.parquet`,
    `${STM}/${DATE}/stop_events.parquet?version=10`,
  ]) {
    assert.equal((await fetch(path)).status, 404, path);
  }
  assert.equal((await fetch(`${STM}?date=${DATE}&date=${DATE}`)).status, 400);
  assert.equal((await fetch(STM, { method: "PUT" })).status, 405);
  assert.deepEqual(keys, []);
});

test("a missing day and a published unmeasured day have distinct states and no file links", async () => {
  for (const [settings, status, reason] of [
    [{ missing: true }, "missing", "no_manifest"],
    [{ status: "no_raw_captures" }, "not_measured", "no_raw_captures"],
    [{ status: "no_schedule_edition" }, "not_measured", "no_schedule_edition"],
    [{ status: "schedule_archive_unreadable" }, "not_measured", "schedule_archive_unreadable"],
  ]) {
    const { fetch, keys } = fixture(settings);
    const day = await (await fetch(STM + "?date=" + DATE)).json();
    assert.deepEqual([day.status, day.reason, day.files, day.readme_url], [status, reason, [], null]);
    assert.equal((await fetch(`${STM}/${DATE}/stop_events.parquet`)).status, 404);
    assert.equal((await fetch(`${STM}/${DATE}/README.txt`)).status, 404);
    assert.ok(keys.every((key) => key.endsWith("/manifest.json")));
  }
});

test("Ottawa without tracked alerts has its own licence and no alerts download", async () => {
  const { fetch } = fixture({ city: "octranspo", alerts: false });
  const day = await (await fetch(OC + "?date=" + DATE)).json();
  assert.equal(day.alerts_not_tracked, true);
  assert.equal(day.files.length, 6);
  assert.match(day.licence.attribution.en, /^Contains information licensed under/);
  assert.match(day.licence.url.en, /^https:\/\/ottawa\.ca\//);
  assert.equal((await fetch(`${OC}/${DATE}/alerts.parquet`)).status, 404);
});

test("download streams Parquet with attachment, SHA-256 ETag, HEAD and byte ranges", async () => {
  const { fetch } = fixture();
  const path = `${STM}/${DATE}/stop_events.parquet`;
  const response = await fetch(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.apache.parquet");
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="transit-stm-${DATE}-v11-stop_events.parquet"`);
  assert.equal(response.headers.get("content-length"), "5");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("etag"), `"${SHA}"`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.text(), "PAR1!");

  const head = await fetch(path, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "5");
  assert.equal(head.body, null);
  assert.equal((await fetch(path, { headers: { "if-none-match": `W/"${SHA}"` } })).status, 304);

  const partial = await fetch(path, { headers: { range: "bytes=1-2" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 1-2/5");
  assert.equal(await partial.text(), "AR");
  assert.equal((await fetch(path, { headers: { range: "bytes=5-" } })).headers.get("content-range"), "bytes */5");
  assert.equal((await fetch(path, { headers: { range: "bytes=1-2", "if-range": '"old"' } })).status, 200);
});

test("listing admission applies before catalog and bucket work", async () => {
  const { fetch, keys, upstream, admissions } = fixture({ admitted: false });
  const response = await fetch(STM + "?date=" + DATE, { headers: { "cf-connecting-ip": "192.0.2.1" } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(admissions.length, 1);
  assert.deepEqual([keys, upstream], [[], []]);
});

test("closed-day metadata uses the versioned cache while every listing is admitted", async (t) => {
  const entries = new Map();
  t.mock.method(globalThis, "fetch", () => assert.fail("unexpected network access"));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: {
      async match(key) { return entries.get(key.url)?.clone(); },
      async put(key, response) { entries.set(key.url, response); },
    } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "caches", previous);
    else delete globalThis.caches;
  });
  const { fetch, keys, upstream, admissions } = fixture();
  for (let index = 0; index < 2; index++) {
    assert.equal((await fetch(STM + "?date=" + DATE)).status, 200);
  }
  assert.equal(keys.length, 1);
  assert.equal(upstream.length, 2);
  assert.equal(admissions.length, 2);
  const version = "https://data.test/__transit_download_cache/v2/version";
  const day = `https://data.test/__transit_download_cache/v2/stm/${DATE}/v11`;
  assert.equal(entries.get(version).headers.get("cache-control"), "public, max-age=30");
  assert.equal(entries.get(day).headers.get("cache-control"), "public, max-age=604800");
  entries.set(version, new Response("12"));
  const nextDay = await (await fetch(STM + "?date=" + DATE)).json();
  assert.equal(nextDay.status, "missing");
  assert.deepEqual(keys, [`stm/${DATE}/v11/manifest.json`, `stm/${DATE}/v12/manifest.json`]);
});
