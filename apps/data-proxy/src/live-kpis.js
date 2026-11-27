import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { cacheMatch, serveQuestion } from "./questions.js";

const CADENCE_SECONDS = 30;
const VEHICLE_FRESHNESS_LIMIT_SECONDS = 60;
const RESPONSE_HEADERS = {
  ...CORS_HEADERS,
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function isFresh(feed, now, limits = Infinity) {
  const captured = Date.parse(feed?.captured_at);
  const source = Date.parse(feed?.source_at ?? feed?.captured_at);
  const freshness = Math.min(feed?.fresh_for_seconds, limits) * 1_000;
  return feed?.read_failed === false &&
    now - captured >= -5_000 && now - captured < freshness &&
    now - source >= -5_000 && now - source < freshness + feed.source_lag_seconds * 1_000;
}

function mean({ sum, count }) {
  return count ? Math.sign(sum) * Math.round(Math.abs(sum) / count) : null;
}

function summarize(capture, schedule, city) {
  if (capture?.version !== 2 || capture.city !== city || !Array.isArray(capture.vehicle_positions))
    return null;
  const vehicles = capture.vehicle_positions;
  const observed = { sum: 0, count: 0 };
  const byRoute = new Map();
  for (const { route_id: route, delay } of vehicles) {
    if (Number.isFinite(delay)) {
      observed.sum += delay;
      observed.count++;
    }
    if (typeof route !== "string" || !route) continue;
    if (!byRoute.has(route)) byRoute.set(route, { vehicles: 0, sum: 0, count: 0 });
    const entry = byRoute.get(route);
    entry.vehicles++;
    if (Number.isFinite(delay)) {
      entry.sum += delay;
      entry.count++;
    }
  }
  const routes = schedule?.schedule?.routes;
  const typedRoutes = Array.isArray(routes) ? routes.filter(({ type }) => Number.isInteger(type)) : [];
  const topRoutes = [...byRoute.entries()]
    .sort(([a, left], [b, right]) => right.vehicles - left.vehicles || a.localeCompare(b))
    .slice(0, 5)
    .map(([route, entry]) => ({ route, vehicles: entry.vehicles, avgDelayS: mean(entry) }));
  return {
    vehicleFeed: capture.feeds?.vehicle_positions,
    tripFeed: capture.feeds?.trip_updates,
    vehicles: vehicles.length,
    avgDelayS: mean(observed),
    coverage: vehicles.length ? observed.count / vehicles.length : null,
    routesLive: byRoute.size,
    routesTotal: typedRoutes.length
      ? typedRoutes.filter(({ type }) => type === 3).length
      : Array.isArray(routes) ? routes.length : null,
    topRoutes,
  };
}

function payload(reading, now) {
  const usable = isFresh(reading?.vehicleFeed, now, VEHICLE_FRESHNESS_LIMIT_SECONDS);
  const delaysUsable = usable && isFresh(reading.tripFeed, now);
  const stamp = usable ? Date.parse(reading.vehicleFeed.captured_at) : null;
  return {
    snapshotAt: stamp === null ? null : new Date(stamp).toISOString().replace(/\.\d{3}Z$/, "Z"),
    freshnessS: stamp === null ? null : Math.max(0, Math.floor((now - stamp) / 1_000)),
    vehicles: usable ? reading.vehicles : null,
    avgDelayS: delaysUsable ? reading.avgDelayS : null,
    coverage: delaysUsable ? reading.coverage : null,
    routesLive: usable ? reading.routesLive : null,
    routesTotal: reading?.routesTotal ?? null,
    topRoutes: usable
      ? reading.topRoutes.map((row) => ({ ...row, avgDelayS: delaysUsable ? row.avgDelayS : null }))
      : [],
  };
}

export async function serveLiveKpis(request, env, ctx, publicCities, defaultCity) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { ...RESPONSE_HEADERS, allow: "GET, HEAD, OPTIONS" } });

  const origin = new URL(request.url).origin;
  const cache = globalThis.caches?.default;
  const key = new Request(`${origin}/__transit_live_kpis/v2/${defaultCity}`);
  let reading = null;
  try {
    const cached = await cacheMatch(cache, key);
    if (cached) reading = await cached.json();
    if (!reading && publicCities?.has(defaultCity)) {
      const load = async (path) => {
        const response = await serveQuestion(new Request(`${origin}/v2/${defaultCity}/${path}`, {
          headers: request.headers,
          signal: request.signal,
        }), env, ctx, publicCities);
        if (response.ok && response.headers.get("x-transit-answer") !== "last-good")
          return response.json();
        await response.body?.cancel();
        return null;
      };
      const [capture, schedule] = await Promise.allSettled([load("live"), load("schedule-index")]);
      reading = summarize(capture.value, schedule.value, defaultCity);
      // This transient cache limits recomputation. Check data timestamps again on every serve.
      if (cache && reading) ctx.waitUntil(cache.put(key, Response.json(reading, {
        headers: { "cache-control": `public, max-age=${CADENCE_SECONDS}` },
      })).catch(() => {}));
    }
  } catch {
    // The brand site selects its labelled demo when a lane is unavailable.
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(payload(reading, Date.now())), {
    headers: RESPONSE_HEADERS,
  });
}
