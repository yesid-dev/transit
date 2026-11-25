import { CleanObjectChanged, cleanDownloadStore } from "./clean-download-store.js";
import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { readLiveTrips } from "./live-trips.js";
import { parseQuestion } from "./question-params.js";

export const CLOSED_TTL = 7 * 24 * 60 * 60;
export const OPEN_TTL = 30;
const LIVE_TTL = 5;
const MAX_LIVE_BYTES = 8 * 1024 * 1024;
const LAST_GOOD_TTL = 30 * 24 * 60 * 60;
const CITY_CATALOG_KEY = "transit-city-catalog";
const VERSION_HEADER = "x-transit-cleaning-version";
const REVISION_HEADER = "x-transit-answer-revision";
const PENDING_DAYS_HEADER = "x-transit-days-pending";
const STALE_HEADER = "x-transit-answer";
const PUBLIC_HEADERS = {
  ...CORS_HEADERS,
  "access-control-expose-headers":
    `${CORS_HEADERS["access-control-expose-headers"]}, Retry-After, X-Transit-Answer`,
  "cache-control": "no-store",
};

function message(status, message, headers = {}) {
  return Response.json({ message }, { status, headers: { ...PUBLIC_HEADERS, ...headers } });
}

function busy(retryAfter) {
  return message(503, "busy, try again", { "retry-after": retryAfter });
}

function publicAnswer(body, contentType, { stale = false, cached = false } = {}) {
  const headers = { ...PUBLIC_HEADERS, "content-type": contentType };
  if (stale) headers[STALE_HEADER] = "last-good";
  if (cached) headers["cache-status"] = "Transit; hit";
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

async function loadCities(env, cache, key, authorize, ctx, allowLastGood) {
  const cached = await cacheMatch(cache, key);
  if (cached) return { body: await cached.text() };
  const denied = await authorize();
  if (denied) return { error: denied };
  try {
    const response = await env.ENGINE.fetch(new Request("https://transit-engine.internal/cities", {
      headers: { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` },
    }));
    if (response.ok && response.headers.get("content-type")?.startsWith("application/json")) {
      const body = await response.text();
      const catalog = JSON.parse(body);
      if (Array.isArray(catalog?.providers) &&
          catalog.providers.every((provider) =>
            typeof provider?.id === "string" && typeof provider?.timezone === "string") &&
          catalog.providers.some((provider) => provider.id === catalog.default_provider)) {
        if (cache) ctx.waitUntil(cache.put(key, new Response(body, {
          headers: { "cache-control": `public, max-age=${OPEN_TTL}` },
        })).catch(() => console.warn("Transit city cache write failed")));
        if (env.QUESTION_LAST_GOOD) ctx.waitUntil(env.QUESTION_LAST_GOOD.put(
          CITY_CATALOG_KEY, body, { expirationTtl: LAST_GOOD_TTL },
        ).catch(() => console.warn("Last-good city catalog write failed")));
        return { body };
      }
    }
  } catch {}
  if (allowLastGood) {
    // Once admitted, dated questions can still reach their saved answers when the engine is down.
    try {
      const saved = await env.QUESTION_LAST_GOOD?.getWithMetadata(CITY_CATALOG_KEY);
      if (saved?.value != null) return { body: saved.value };
    } catch {
      console.warn("Last-good city catalog read failed");
    }
  }
  return { error: message(503, "provider catalog unavailable") };
}

export function loadPublicCities(env, cache, origin, authorize, ctx, allowLastGood = false) {
  const key = new Request(`${origin}/__transit_question_cache/v2/unversioned/cities`);
  return loadCities(env, cache, key, authorize, ctx, allowLastGood);
}

async function lastGood(env, key) {
  try {
    const saved = key && await env.QUESTION_LAST_GOOD?.getWithMetadata(await hash(key));
    if (saved?.value != null && saved.metadata?.contentType) {
      const { value, metadata: { contentType } } = saved;
      // Add the marker without round-tripping the engine's JSON numbers or evidence.
      const body = contentType.toLowerCase().startsWith("application/json")
        ? value.replace(
          /^(\s*)\{(\s*)(\}?)/,
          (_, leading, space, close) => `${leading}{"stale":true${close ? "" : ","}${space}${close}`,
        )
        : value;
      return publicAnswer(body, contentType, { stale: true });
    }
  } catch {
    console.warn("Last-good transit answer read failed");
  }
  return message(503, "engine unavailable", { "retry-after": "30" });
}

async function remember(cache, key, ttl, body, contentType) {
  if (!cache) return;
  const answer = new Response(body, {
    headers: { "cache-control": `public, max-age=${ttl}`, "content-type": contentType },
  });
  await cache.put(key, answer);
}

export function serveQuestion(request, env, ctx) {
  return answerQuestion(request, env, ctx, request.headers.get("cf-connecting-ip"));
}

export function serveBoundQuestion(request, env, ctx) {
  return answerQuestion(request, env, ctx, request.headers.get("x-transit-visitor-ip"));
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
  if (cached) return publicAnswer(cached.body, "application/json", { cached: true });
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
    const response = publicAnswer(body, "application/json");
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

async function answerQuestion(request, env, ctx, visitorIp) {
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
    return serveLive(env, ctx, url.origin, question, visitorIp);
  }

  if (!env.ENGINE || !env.TRANSIT1_ENGINE_ACCESS_TOKEN) {
    return message(503, "engine not configured");
  }

  const cache = globalThis.caches?.default;
  let admission;
  const authorize = () => admission ??= admit(env, visitorIp);

  const cities = await loadPublicCities(
    env, cache, url.origin, authorize, ctx, question.route !== "cities",
  );
  if (question.route === "cities") {
    if (cities.error) return cities.error;
    return publicAnswer(cities.body, "application/json");
  }
  const catalog = cities.body && JSON.parse(cities.body);
  let timezone;
  if (question.end && catalog) {
    const city = catalog.providers.find((entry) => entry.id === question.city);
    if (!city) return message(400, "unknown city");
    timezone = city.timezone;
  }

  const version = cleaningVersion(catalog?.cleaning_version);
  const revision = answerRevision(catalog?.answer_revision);
  const key = version && revision ? `${version}/${revision}${question.key}` : null;
  const cacheKey = key && new Request(`${url.origin}/__transit_question_cache/v2/${key}`);
  const cached = cacheKey && await cacheMatch(cache, cacheKey);
  if (cached) return publicAnswer(cached.body, cached.headers.get("content-type"), { cached: true });

  const denied = await authorize();
  if (denied) return denied;

  let body;
  let contentType;
  let matchesCatalog;
  let settled = false;
  const headers = { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` };
  const requirePublicCity = question.end && !catalog;
  if (requirePublicCity) headers["x-transit-require-public-city"] = "1";
  try {
    const response = await env.ENGINE.fetch(new Request(question.upstream, { headers }));
    const reportedRevision = answerRevision(response.headers.get(REVISION_HEADER));
    // Older engines do not validate public city membership for dated questions.
    if (requirePublicCity && !reportedRevision) return cities.error;
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 503 && retryAfter) return busy(retryAfter);
    if (question.networkCorridors && response.status === 409) {
      const { reason, message } = await response.json();
      if (["segment_runs_version_required", "segment_runs_missing"].includes(reason)) {
        return Response.json({ reason, message }, { status: 409, headers: PUBLIC_HEADERS });
      }
    }
    if (response.status === 400) {
      if (question.networkCorridors) {
        return Response.json({ reason: "network_corridors_unsupported" }, {
          status: 409, headers: PUBLIC_HEADERS,
        });
      }
      if (question.map) return lastGood(env, key);
      const error = await response.json();
      if (question.delayDistribution && error?.message === "unknown measure") {
        return Response.json({ reason: "delay_distribution_unsupported", message: "engine unavailable" }, {
          status: 409, headers: PUBLIC_HEADERS,
        });
      }
      return publicEngineError(error);
    }
    if (!response.ok) return lastGood(env, key);

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
    const today = question.end && settled && serviceToday(timezone);
    const ttl = today && question.end < today ? CLOSED_TTL : OPEN_TTL;
    ctx.waitUntil(remember(cache, cacheKey, ttl, body, contentType)
      .catch(() => console.warn("Transit question cache write failed")));
    if (env.QUESTION_LAST_GOOD) {
      ctx.waitUntil(hash(key).then((storageKey) => env.QUESTION_LAST_GOOD.put(storageKey, body, {
        expirationTtl: LAST_GOOD_TTL,
        metadata: { contentType },
      })).catch(() => console.warn("Last-good transit answer write failed")));
    }
  }
  return publicAnswer(body, contentType);
}

function publicEngineError(payload) {
  return message(400, typeof payload?.message === "string" ? payload.message : "invalid question");
}
