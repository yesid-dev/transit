import { pathToFileURL } from "node:url";

export const DATA_ORIGIN = "https://data.yesid.dev";
export const WEB_ORIGIN = "https://transit.yesid.dev";

async function request(fetchFn, url, headers = {}) {
  return fetchFn(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { "user-agent": "Transit-site-probe", ...headers },
  });
}

async function json(fetchFn, url, { headers, allowStale = false } = {}) {
  const response = await request(fetchFn, url, headers);
  if (response.status !== 200 || response.headers.get("x-transit-answer") === "last-good") {
    await response.body?.cancel();
    return null;
  }
  const body = await response.json();
  return !allowStale && body?.stale === true ? null : body;
}

async function check(label, test) {
  try {
    if (await test()) return null;
  } catch {
    // Do not expose response content, redirect targets, or exceptions.
  }
  return `${label} failed`;
}

function usableFeed(feed, family, requireFresh, now) {
  if (feed?.family !== family) return false;
  const captured = Date.parse(feed.captured_at);
  const source = Date.parse(feed.source_at ?? feed.captured_at);
  if (!Number.isFinite(captured) || !Number.isFinite(source)) return false;
  if (!requireFresh) return true;

  const capturedAge = now - captured;
  const sourceAge = now - source;
  const limit = feed?.fresh_for_seconds * 1_000;
  // The live edge cache retains answers for five seconds.
  const deliveryGrace = 5_000;
  return feed?.read_failed === false &&
    capturedAge >= -deliveryGrace && capturedAge < limit + deliveryGrace &&
    sourceAge >= -deliveryGrace &&
    sourceAge < limit + feed.source_lag_seconds * 1_000 + Math.max(0, Math.min(deliveryGrace, capturedAge));
}

export async function probeWebHealth({ fetchFn = fetch, webOrigin = WEB_ORIGIN, commit } = {}) {
  return check("transit1-web health", async () => {
    const health = await json(fetchFn, `${webOrigin}/health`, { headers: { "cache-control": "no-cache" } });
    return health?.status === "ok" && health.engine === "ok" && health.proxy === "ok" &&
      health.service === "transit1-web" && /^[a-f0-9]{40}$/.test(health.commit) &&
      typeof health.branch === "string" && health.branch.length > 0 &&
      (commit === undefined || health.commit === commit);
  });
}

export async function probeV2({ fetchFn = fetch, dataOrigin = DATA_ORIGIN, requireFresh = false, now = Date.now } = {}) {
  const root = `${dataOrigin}/v2`;
  let catalog;
  const catalogFailure = await check("v2 public cities", async () => {
    catalog = await json(fetchFn, `${root}/cities`);
    const cities = catalog?.providers;
    return Array.isArray(cities) && cities.length > 0 &&
      cities.every((city) => /^[a-z\d][a-z\d_-]{0,63}$/.test(city?.id ?? "") && city.inputs) &&
      new Set(cities.map(({ id }) => id)).size === cities.length &&
      cities.some(({ id }) => id === catalog.default_provider);
  });
  if (catalogFailure) return [catalogFailure];

  const checks = [];
  for (const { id, inputs, basemap_v2_url, record_through, download_licence } of catalog.providers) {
    const city = `${root}/${id}`;
    const feeds = ["vehicle_positions", "trip_updates"].filter((feed) => inputs[feed] === true);
    if (feeds.length) checks.push(check(`v2 ${id} ${requireFresh ? "fresh live" : "live answer"}`, async () => {
      const live = await json(fetchFn, `${city}/live`, { allowStale: !requireFresh });
      const time = now();
      return live?.version === 2 && live.city === id &&
        feeds.every((feed) => usableFeed(live.feeds?.[feed], feed, requireFresh, time));
    }));
    if (inputs.trip_updates === true) checks.push(check(`v2 ${id} live trips`, async () => {
      // Stop scopes allow an empty array when no passing trip is being tracked.
      const trips = await json(fetchFn, `${city}/live-trips?stop=1`, { allowStale: !requireFresh });
      return trips?.version === 2 && trips.city === id &&
        Array.isArray(trips.trip_updates) && usableFeed(trips.feed, "trip_updates", requireFresh, now());
    }));
    if (basemap_v2_url != null) checks.push(check(`v2 ${id} clean PMTiles range`, async () => {
      const tile = new URL(basemap_v2_url, dataOrigin);
      const [, version, cityId, directory, name, ...rest] = tile.pathname.split("/");
      if (tile.origin !== new URL(dataOrigin).origin || tile.username || tile.password ||
          tile.search || tile.hash || version !== "v2" || cityId !== id || directory !== "basemap" ||
          !/^[\w-]+\.pmtiles$/.test(name ?? "") || rest.length) return false;
      const response = await request(fetchFn, tile.href, { range: "bytes=0-6" });
      if (response.status !== 206 || response.headers.get("x-transit-source") !== "clean" ||
          !/^bytes 0-6\/\d+$/.test(response.headers.get("content-range") ?? "")) {
        await response.body?.cancel();
        return false;
      }
      return await response.text() === "PMTiles";
    }));

    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(record_through ?? "");
    if (download_licence) checks.push(check(`v2 ${id} dated downloads`, async () => {
      if (!validDate) return false;
      const day = await json(fetchFn, `${city}/download?date=${record_through}`);
      return day?.city === id && day.service_date === record_through &&
        day.status === "complete" && Array.isArray(day.files) && day.files.length > 0;
    }));
    if (record_through != null || download_licence) checks.push(check(`v2 ${id} Record answer`, async () => {
      if (!validDate) return false;
      const answer = await json(fetchFn, `${city}/data-health?from=${record_through}&to=${record_through}`);
      return answer?.city === id && answer.from === record_through && answer.to === record_through &&
        Array.isArray(answer.days) && answer.days.some((day) => day.service_date === record_through);
    }));
  }
  return (await Promise.all(checks)).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await Promise.all([
    probeV2({ dataOrigin: process.env.CANONICAL_BASE }),
    probeWebHealth({ webOrigin: process.env.V2_WEB_ORIGIN, commit: process.argv[2] }),
  ]);
  const failures = result.flat().filter(Boolean);
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log("SMOKE OK: public catalog, live, trips, clean tiles, Downloads, Record and transit1-web");
  }
}
