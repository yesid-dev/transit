import { publicBasemapUrl } from "./basemap.js";
import { CleanObjectChanged, cleanDownloadStore } from "./clean-download-store.js";
import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { readLiveTrips } from "./live-trips.js";
import { parseQuestion } from "./question-params.js";

export const CLOSED_TTL = 7 * 24 * 60 * 60;
export const OPEN_TTL = 30;
const LIVE_TTL = 5;
// Timetables and vehicle IDs can change when the mirror updates without a code revision.
const INDEX_REFRESH_MS = 60 * 60 * 1000;
const FRESH_UNTIL = "x-transit-cache-fresh-until";
const INDEX_REVISION = "x-transit-cache-index-revision";
const INDEX_ROUTES = new Set(["schedule-index", "schedule-map", "search-index"]);
const refreshing = new Set();
const failedRefreshes = new Map();
const MAX_FAILED_REFRESHES = 256;

function refreshInBackground(ctx, key, generation, refresh) {
  const failure = failedRefreshes.get(key);
  const lastGood = failure?.generation === generation && failure.until > Date.now();
  if (refreshing.has(key)) return lastGood;
  refreshing.add(key);
  ctx.waitUntil(refresh().then((failed) => {
    if (failed === undefined) return; // Admission can stop a refresh before it reaches the engine.
    if (!failed) {
      failedRefreshes.delete(key);
      return;
    }
    // Remember failures for this saved copy without rewriting the cached body.
    failedRefreshes.delete(key);
    if (failedRefreshes.size >= MAX_FAILED_REFRESHES) {
      failedRefreshes.delete(failedRefreshes.keys().next().value);
    }
    failedRefreshes.set(key, { generation, until: Date.now() + OPEN_TTL * 1000 });
  }).catch(() => console.warn("Transit cache refresh failed"))
    .finally(() => refreshing.delete(key)));
  return lastGood;
}
const MAX_LIVE_BYTES = 8 * 1024 * 1024;
const LAST_GOOD_TTL = 30 * 24 * 60 * 60;
const CITY_CATALOG_KEY = "transit-city-catalog";
const VERSION_HEADER = "x-transit-cleaning-version";
const REVISION_HEADER = "x-transit-answer-revision";
const PENDING_DAYS_HEADER = "x-transit-days-pending";
const MAX_RECORD_BUDGET_MS = 45_000;
const PUBLIC_HEADERS = {
  ...CORS_HEADERS,
  "access-control-expose-headers":
    `${CORS_HEADERS["access-control-expose-headers"]}, Retry-After, X-Transit-Answer, X-Transit-Cache, Server-Timing`,
  "cache-control": "no-store",
};

function message(status, message, headers = {}) {
  return Response.json({ message }, { status, headers: { ...PUBLIC_HEADERS, ...headers } });
}

function busy(retryAfter, timing) {
  return message(503, "busy, try again", {
    "retry-after": retryAfter,
    ...(timing && { "server-timing": timing }),
  });
}

function engineTiming(response, started) {
  const allowed = /^(queue|engine);dur=[0-9]{1,8}(?:\.[0-9]{1,3})?$/;
  const durations = (response.headers.get("server-timing") ?? "")
    .split(",").map((metric) => metric.trim()).filter((metric) => allowed.test(metric));
  return [`upstream;dur=${(performance.now() - started).toFixed(2)}`, ...durations].join(", ");
}

function answerTiming(source, state, timing) {
  return [`src;desc=${source}`, `cache;desc=${state}`, timing].filter(Boolean).join(", ");
}

function publicAnswer(body, contentType, {
  stale = false, lastGood = false, cached = false, source, timing,
} = {}) {
  const headers = { ...PUBLIC_HEADERS, "content-type": contentType };
  // Cache age or an unverified revision calls for revalidation. Probe failures use X-Transit-Answer.
  if (stale) headers["x-transit-cache"] = "stale";
  if (lastGood) headers["x-transit-answer"] = "last-good";
  if (cached) headers["cache-status"] = "Transit; hit";
  if (source) {
    headers["server-timing"] = answerTiming(
      source, stale || lastGood ? "stale" : cached ? "hit" : "miss", timing,
    );
  }
  return new Response(body, { headers });
}

async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cleaningVersion(value) {
  const version = String(value ?? "");
  return /^[1-9][0-9]{0,15}$/.test(version) ? version : null;
}

function answerRevision(value) {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value) ? value : null;
}

export async function cacheMatch(cache, key) {
  try {
    return await cache?.match(key);
  } catch {
    return undefined;
  }
}

export function serviceToday(timezone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date());
  } catch {
    return null;
  }
}

export async function admit(env, visitorIp) {
  try {
    const { success } = await env.QUESTION_LIMIT.limit({ key: await hash(visitorIp || "unknown") });
    return success ? null : busy("60");
  } catch {
    return message(503, "question limiter unavailable", { "retry-after": "60" });
  }
}

async function fetchCities(env, cache, key, authorize, ctx) {
  const denied = await authorize();
  if (denied) return { error: denied };
  try {
    const started = performance.now();
    const response = await env.ENGINE.fetch(new Request("https://transit-engine.internal/cities", {
      headers: { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` },
    }));
    const timing = engineTiming(response, started);
    if (response.ok && response.headers.get("content-type")?.startsWith("application/json")) {
      const body = await response.text();
      const catalog = JSON.parse(body);
      if (Array.isArray(catalog?.providers) &&
          catalog.providers.every((provider) =>
            typeof provider?.id === "string" && typeof provider?.timezone === "string") &&
          catalog.providers.some((provider) => provider.id === catalog.default_provider)) {
        const freshUntil = Date.now() + OPEN_TTL * 1000;
        if (cache) ctx.waitUntil(remember(cache, key, LAST_GOOD_TTL, body, "application/json", {
          [FRESH_UNTIL]: String(freshUntil),
        }).catch(() => console.warn("Transit city cache write failed")));
        if (env.QUESTION_LAST_GOOD) ctx.waitUntil(env.QUESTION_LAST_GOOD.put(
          CITY_CATALOG_KEY, body, { expirationTtl: LAST_GOOD_TTL, metadata: { freshUntil } },
        ).catch(() => console.warn("Last-good city catalog write failed")));
        return { body, failed: false, source: "engine", timing };
      }
    }
  } catch {}
  return { error: message(503, "provider catalog unavailable"), failed: true };
}

export async function loadPublicCities(env, cache, origin, authorize, ctx, refresh = false) {
  const key = new Request(`${origin}/__transit_question_cache/v2/unversioned/cities`);
  const refill = () => fetchCities(env, cache, key, authorize, ctx);
  if (refresh) return refill();
  const background = (freshUntil) => refreshInBackground(
    ctx, key.url, freshUntil, async () => (await refill()).failed,
  );

  const cached = await cacheMatch(cache, key);
  if (cached) {
    const freshUntil = Number(cached.headers.get(FRESH_UNTIL));
    const stale = !(freshUntil > Date.now());
    const lastGood = stale && background(freshUntil);
    return { body: await cached.text(), stale, lastGood, cached: true, source: "edge" };
  }

  const saved = await savedAnswer(env, CITY_CATALOG_KEY);
  if (saved?.value != null) {
    const freshUntil = saved.metadata?.freshUntil ?? 0;
    const stale = freshUntil <= Date.now();
    const lastGood = stale && background(freshUntil);
    if (!stale) ctx.waitUntil(remember(cache, key, LAST_GOOD_TTL, saved.value, "application/json", {
      [FRESH_UNTIL]: String(freshUntil),
    }).catch(() => console.warn("Transit city cache write failed")));
    return { body: saved.value, stale, lastGood, cached: true, source: "kv" };
  }
  return refill();
}

async function savedAnswer(env, key) {
  try {
    return await env.QUESTION_LAST_GOOD?.getWithMetadata(key);
  } catch {
    console.warn("Last-good transit answer read failed");
  }
}

async function lastGood(env, key) {
  try {
    const saved = key && await savedAnswer(env, await hash(key));
    if (saved?.value != null && saved.metadata?.contentType) {
      const { value, metadata: { contentType } } = saved;
      // Add the marker without round-tripping the engine's JSON numbers or evidence.
      const body = contentType.toLowerCase().startsWith("application/json")
        ? value.replace(
          /^(\s*)\{(\s*)(\}?)/,
          (_, leading, space, close) => `${leading}{"stale":true${close ? "" : ","}${space}${close}`,
        )
        : value;
      return publicAnswer(body, contentType, { lastGood: true, source: "kv" });
    }
  } catch {
    console.warn("Last-good transit answer read failed");
  }
  return message(503, "engine unavailable", { "retry-after": "30" });
}

async function remember(cache, key, ttl, body, contentType, headers = {}) {
  if (!cache) return;
  const answer = new Response(body, {
    headers: { "cache-control": `public, max-age=${ttl}`, "content-type": contentType, ...headers },
  });
  await cache.put(key, answer);
}

export function serveQuestion(request, env, ctx, publicCities) {
  return answerQuestion(request, env, ctx, publicCities, request.headers.get("cf-connecting-ip"));
}

export function serveBoundQuestion(request, env, ctx, publicCities) {
  const deadline = Number(request.headers.get("x-transit-record-deadline"));
  return answerQuestion(request, env, ctx, publicCities, request.headers.get("x-transit-visitor-ip"),
    deadline > Date.now() ? Math.min(deadline, Date.now() + MAX_RECORD_BUDGET_MS) : undefined);
}

export async function probeEngine(env, signal) {
  let engine = "unconfigured";
  if (env.ENGINE && env.TRANSIT1_ENGINE_ACCESS_TOKEN) {
    engine = "unavailable";
    try {
      const response = await env.ENGINE.fetch(new Request("https://transit-engine.internal/healthz", {
        headers: { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` },
        signal,
        redirect: "manual",
      }));
      if (response.ok && typeof (await response.json())?.boot_id === "string") engine = "ok";
    } catch {}
  }
  return Response.json({ engine }, {
    status: engine === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

async function serveLive(env, ctx, origin, question, visitorIp) {
  if (env.TRANSIT1_LIVE_ENABLED === "0") return message(503, "live publication unavailable");
  const store = cleanDownloadStore(env);
  if (!store) return message(503, "live publication unavailable");
  const cache = globalThis.caches?.default;
  const key = new Request(`${origin}/__transit_question_cache/v2/live${question.key}`);
  const cached = await cacheMatch(cache, key);
  if (cached) return publicAnswer(cached.body, "application/json", { cached: true, source: "edge" });
  const denied = await admit(env, visitorIp);
  if (denied) return denied;

  try {
    let body;
    if (question.scope) {
      const trips = await readLiveTrips(store, question.city, question.scope);
      if (!trips) return message(404, "no live trip publication");
      body = JSON.stringify(trips);
    } else {
      const object = await store.get(`live/v2/${question.city}.json`);
      if (!object) return message(404, "no live publication");
      if (object.size > MAX_LIVE_BYTES) {
        await object.body?.cancel();
        return message(503, "live publication unavailable");
      }
      body = object.body;
    }
    const response = publicAnswer(body, "application/json", { source: "r2" });
    if (cache) {
      const copy = new Response(response.clone().body, {
        headers: { "cache-control": `public, max-age=${LIVE_TTL}`, "content-type": "application/json" },
      });
      ctx.waitUntil(cache.put(key, copy).catch(() => console.warn("Transit live cache write failed")));
    }
    return response;
  } catch (error) {
    if (error instanceof CleanObjectChanged) {
      return Response.json(
        { message: "live trips refreshing", state: "refreshing" },
        { status: 503, headers: { ...PUBLIC_HEADERS, "retry-after": "1" } },
      );
    }
    return message(503, "live publication unavailable");
  }
}

async function answerQuestion(request, env, ctx, publicCities, visitorIp, deadline) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-methods": "GET, OPTIONS" },
    });
  }
  if (request.method !== "GET") return message(405, "use GET", { allow: "GET, OPTIONS" });

  let question;
  try {
    question = parseQuestion(url);
  } catch (error) {
    return message(400, error instanceof URIError ? "invalid query encoding" : error.message);
  }
  if (!question) return message(404, "not found");
  if (question.route === "live" || question.route === "live-trips") {
    if (!publicCities?.has(question.city)) return message(404, "not found");
    return serveLive(env, ctx, url.origin, question, visitorIp);
  }
  const cache = globalThis.caches?.default;
  if (question.cacheOnly) {
    if (!publicCities?.has(question.city)) return message(404, "not found");
    return cachedVehicleIndex(env, cache, url.origin, question);
  }

  if (!env.ENGINE || !env.TRANSIT1_ENGINE_ACCESS_TOKEN) {
    return message(503, "engine not configured");
  }

  let admission;
  const authorize = () => admission ??= admit(env, visitorIp);

  const cities = await loadPublicCities(
    env, cache, url.origin, authorize, ctx,
    // The mirror's warm-up revalidates the public catalog immediately after copying.
    question.route === "cities" &&
      /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(request.headers.get("cache-control") ?? ""),
  );
  if (question.route === "cities") {
    if (cities.error) return cities.error;
    const catalog = JSON.parse(cities.body);
    catalog.providers = catalog.providers.map((provider) => ({
      ...provider,
      basemap_v2_url: publicBasemapUrl(provider.id, provider.basemap_url),
    }));
    return publicAnswer(JSON.stringify(catalog), "application/json", cities);
  }
  const catalog = cities.body && JSON.parse(cities.body);
  const index = INDEX_ROUTES.has(question.route);
  const city = catalog?.providers.find((entry) => entry.id === question.city);
  if ((question.end || index) && catalog && !city) return message(400, "unknown city");

  const version = cleaningVersion(catalog?.cleaning_version);
  const revision = answerRevision(catalog?.answer_revision);
  const key = version && revision ? `${version}/${revision}${question.key}` : null;
  const cacheKey = key && new Request(`${url.origin}/__transit_question_cache/v2/${key}`);
  const today = question.end && city && serviceToday(city.timezone);
  const closed = !!today && question.end < today;
  if (index && key) {
    return serveIndex(env, ctx, cache, url.origin, question, version, revision, city, authorize);
  }

  const cached = cacheKey && await cacheMatch(cache, cacheKey);
  if (cached) return publicAnswer(cached.body, cached.headers.get("content-type"), {
    cached: true, source: "edge",
  });

  const storageKey = key && env.QUESTION_LAST_GOOD && await hash(key);
  if (closed && storageKey) {
    const saved = await savedAnswer(env, storageKey);
    if (saved?.value != null && saved.metadata?.settled === true && saved.metadata.contentType) {
      const { value, metadata: { contentType } } = saved;
      ctx.waitUntil(remember(cache, cacheKey, CLOSED_TTL, value, contentType)
        .catch(() => console.warn("Transit question cache write failed")));
      return publicAnswer(value, contentType, { cached: true, source: "kv" });
    }
  }

  const denied = await authorize();
  if (denied) return denied;

  let body;
  let contentType;
  let matchesCatalog;
  let timing;
  let settled = false;
  const headers = { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` };
  if (deadline) headers["x-transit-record-deadline"] = String(deadline);
  const requirePublicCity = question.end && !catalog;
  if (requirePublicCity) headers["x-transit-require-public-city"] = "1";
  try {
    const signal = deadline
      ? AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))])
      : request.signal;
    const started = performance.now();
    const response = await env.ENGINE.fetch(
      new Request(question.upstream, { headers, signal, redirect: "manual" }),
    );
    timing = engineTiming(response, started);
    const reportedRevision = answerRevision(response.headers.get(REVISION_HEADER));
    // Older engines do not validate public city membership for dated questions.
    if (requirePublicCity && !reportedRevision) return cities.error;
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 503 && retryAfter) {
      await response.body?.cancel();
      return busy(retryAfter, answerTiming("engine", "miss", timing));
    }
    if (question.networkCorridors && response.status === 409) {
      const { reason, message } = await response.json();
      if (["segment_runs_version_required", "segment_runs_missing"].includes(reason)) {
        return Response.json({ reason, message }, { status: 409, headers: PUBLIC_HEADERS });
      }
    }
    if (response.status === 400) {
      const error = await response.json().catch(() => null);
      if (question.networkCorridors && error?.message === "unknown parameter") {
        return Response.json({ reason: "network_corridors_unsupported" }, {
          status: 409, headers: PUBLIC_HEADERS,
        });
      }
      if (question.map && !question.networkCorridors && error?.message === "unknown parameter")
        return lastGood(env, key);
      if (question.delayDistribution && error?.message === "unknown measure") {
        return Response.json({ reason: "delay_distribution_unsupported", message: "engine unavailable" }, {
          status: 409, headers: PUBLIC_HEADERS,
        });
      }
      return publicEngineError(error);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (question.csv && [404, 409, 422].includes(response.status))
        return message(response.status, "invalid export selection");
      return lastGood(env, key);
    }

    contentType = response.headers.get("content-type");
    const mime = contentType?.split(";")[0].trim().toLowerCase();
    if (mime !== (question.csv ? "text/csv" : "application/json")) {
      return lastGood(env, key);
    }
    body = await response.text();
    const json = question.csv ? null : JSON.parse(body);
    if (!question.csv && (!json || typeof json !== "object" ||
        Array.isArray(json) !== (question.route === "how-we-measure"))) {
      return lastGood(env, key);
    }
    if (question.map && !Array.isArray(json.state)) return lastGood(env, key);
    settled = response.headers.get(PENDING_DAYS_HEADER) === "0";
    matchesCatalog = response.headers.get(VERSION_HEADER) === version && reportedRevision === revision;
  } catch {
    return lastGood(env, key);
  }

  if (cacheKey && matchesCatalog) {
    const ttl = closed && settled ? CLOSED_TTL : OPEN_TTL;
    ctx.waitUntil(remember(cache, cacheKey, ttl, body, contentType)
      .catch(() => console.warn("Transit question cache write failed")));
    if (storageKey) {
      ctx.waitUntil(env.QUESTION_LAST_GOOD.put(storageKey, body, {
        expirationTtl: LAST_GOOD_TTL,
        metadata: { contentType, settled: closed && settled },
      }).catch(() => console.warn("Last-good transit answer write failed")));
    }
  }
  return publicAnswer(body, contentType, { source: "engine", timing });
}

const indexCacheKey = (origin, key) => new Request(`${origin}/__transit_question_cache/v2/index${key}`);
const indexStoreKey = (key) => hash(`index${key}`);

async function cachedVehicleIndex(env, cache, origin, question) {
  try {
    const cached = await cacheMatch(cache, indexCacheKey(origin, question.key));
    const saved = !cached && env.QUESTION_LAST_GOOD && await savedAnswer(env, await indexStoreKey(question.key));
    const freshUntil = cached ? Number(cached.headers.get(FRESH_UNTIL)) : saved?.metadata?.freshUntil;
    const body = cached ? await cached.json() : saved?.value && JSON.parse(saved.value);
    if (body && typeof body.vehicle_state === "string" &&
        (body.vehicles === null || Array.isArray(body.vehicles))) {
      return publicAnswer(JSON.stringify({ vehicles: body.vehicles, vehicle_state: body.vehicle_state }),
        "application/json", { cached: true, stale: !(freshUntil > Date.now()) });
    }
  } catch {
    // A missing or unreadable cache entry must never reach the engine on this path.
  }
  return message(504, "vehicle index not cached");
}

async function serveIndex(env, ctx, cache, origin, question, version, revision, city, authorize) {
  // The canonical cut identifies a single last copy. Its tag controls when it needs refreshing.
  const tag = `${version}/${revision}/${city.record_through ?? ""}`;
  const key = indexCacheKey(origin, question.key);
  const storeKey = env.QUESTION_LAST_GOOD && await indexStoreKey(question.key);
  const contentType = "application/json";
  const keepAtEdge = (body, freshUntil, storedTag) => ctx.waitUntil(
    remember(cache, key, LAST_GOOD_TTL, body, contentType, {
      [FRESH_UNTIL]: String(freshUntil),
      [INDEX_REVISION]: storedTag,
    }).catch(() => console.warn("Transit index cache write failed")),
  );
  const refill = async () => {
    const denied = await authorize();
    if (denied) return { response: denied };
    try {
      const started = performance.now();
      const response = await env.ENGINE.fetch(new Request(question.upstream, {
        headers: { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` },
        redirect: "manual",
      }));
      const timing = engineTiming(response, started);
      const retryAfter = response.headers.get("retry-after");
      if (response.status === 400) {
        return { response: publicEngineError(await response.json()), failed: true };
      }
      if (!response.ok || !response.headers.get("content-type")?.startsWith(contentType)) {
        await response.body?.cancel();
        return {
          response: retryAfter
            ? busy(retryAfter, answerTiming("engine", "miss", timing))
            : message(503, "index unavailable"),
          failed: true,
        };
      }
      const body = await response.text();
      const index = JSON.parse(body);
      if (!index || typeof index !== "object" || Array.isArray(index)) {
        return { response: message(503, "index unavailable"), failed: true };
      }
      const matchesCatalog = response.headers.get(VERSION_HEADER) === version &&
        answerRevision(response.headers.get(REVISION_HEADER)) === revision;
      if (matchesCatalog) {
        const freshUntil = Date.now() + INDEX_REFRESH_MS;
        keepAtEdge(body, freshUntil, tag);
        if (storeKey) ctx.waitUntil(env.QUESTION_LAST_GOOD.put(storeKey, body, {
          expirationTtl: LAST_GOOD_TTL, metadata: { freshUntil, tag },
        }).catch(() => console.warn("Last-good transit index write failed")));
      }
      return {
        response: publicAnswer(body, contentType, {
          stale: !matchesCatalog, source: "engine", timing,
        }),
        failed: false,
      };
    } catch {
      return { response: message(503, "index unavailable"), failed: true };
    }
  };
  const background = (storedTag, freshUntil) => refreshInBackground(
    ctx, key.url, `${tag}/${storedTag}/${freshUntil}`, async () => {
      const { response, failed } = await refill();
      await response.body?.cancel();
      return failed;
    },
  );

  const cached = await cacheMatch(cache, key);
  if (cached) {
    const storedTag = cached.headers.get(INDEX_REVISION);
    const freshUntil = Number(cached.headers.get(FRESH_UNTIL));
    const stale = storedTag !== tag || !(freshUntil > Date.now());
    const lastGood = stale && background(storedTag, freshUntil);
    return publicAnswer(cached.body, contentType, { cached: true, stale, lastGood, source: "edge" });
  }
  const saved = storeKey && await savedAnswer(env, storeKey);
  if (saved?.value != null && saved.metadata?.tag) {
    const { tag: storedTag, freshUntil } = saved.metadata;
    const stale = storedTag !== tag || !(freshUntil > Date.now());
    keepAtEdge(saved.value, freshUntil, storedTag);
    const lastGood = stale && background(storedTag, freshUntil);
    return publicAnswer(saved.value, contentType, { cached: true, stale, lastGood, source: "kv" });
  }
  return (await refill()).response;
}

function publicEngineError(payload) {
  return message(400, typeof payload?.message === "string" ? payload.message : "invalid question");
}
