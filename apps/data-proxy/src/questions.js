import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { parseQuestion } from "./question-params.js";

const CLOSED_TTL = 7 * 24 * 60 * 60;
const OPEN_TTL = 30;
const LAST_GOOD_TTL = 30 * 24 * 60 * 60;
const CITY_CATALOG_KEY = "transit-city-catalog";
const VERSION_HEADER = "x-transit-cleaning-version";
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

function publicAnswer(body, contentType, stale = false) {
  const headers = { ...PUBLIC_HEADERS, "content-type": contentType };
  if (stale) headers[STALE_HEADER] = "last-good";
  return new Response(body, { headers });
}

async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cleaningVersion(value) {
  const version = String(value ?? "");
  return /^[1-9][0-9]{0,15}$/.test(version) ? version : null;
}

function cacheRequest(origin, question, version) {
  return new Request(`${origin}/__transit_question_cache/v2/${version}${question.key}`);
}

async function cacheMatch(cache, key) {
  try {
    return await cache?.match(key);
  } catch {
    return undefined;
  }
}

function serviceToday(timezone) {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date());
  } catch {
    return null;
  }
}

async function admit(env, visitorIp) {
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

async function lastGood(env, key) {
  try {
    const saved = await env.QUESTION_LAST_GOOD?.getWithMetadata(await key);
    if (saved?.value != null && saved.metadata?.contentType) {
      const { value, metadata: { contentType } } = saved;
      // Add the marker without round-tripping the engine's JSON numbers or evidence.
      const body = contentType.toLowerCase().startsWith("application/json")
        ? value.replace(
          /^(\s*)\{(\s*)(\}?)/,
          (_, leading, space, close) => `${leading}{"stale":true${close ? "" : ","}${space}${close}`,
        )
        : value;
      return publicAnswer(body, contentType, true);
    }
  } catch {
    console.warn("Last-good transit answer read failed");
  }
  return message(503, "engine unavailable", { "retry-after": "30" });
}

async function remember(cache, origin, question, version, versionKey, ttl, body, contentType) {
  if (!cache) return;
  const answer = new Response(body, {
    headers: { "cache-control": `public, max-age=${ttl}`, "content-type": contentType },
  });
  await cache.put(cacheRequest(origin, question, version ?? "unversioned"), answer);
  if (version) {
    // Publish the lookup version only after the corresponding answer is available.
    await cache.put(versionKey, new Response(version, {
      headers: { "cache-control": `public, max-age=${CLOSED_TTL}` },
    }));
  }
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

  if (!env.ENGINE || !env.TRANSIT1_ENGINE_ACCESS_TOKEN) {
    return message(503, "engine not configured");
  }

  const cache = globalThis.caches?.default;
  let admission;
  const authorize = () => admission ??= admit(env, visitorIp);

  let timezone;
  if (question.route === "cities" || question.end) {
    const cityKey = cacheRequest(url.origin, { key: "/cities" }, "unversioned");
    const cities = await loadCities(env, cache, cityKey, authorize, ctx, question.end !== null);
    if (cities.error) return cities.error;
    if (question.route === "cities") return publicAnswer(cities.body, "application/json");
    const city = JSON.parse(cities.body).providers.find((entry) => entry.id === question.city);
    if (!city) return message(400, "unknown city");
    timezone = city.timezone;
  }

  const versionKey = new Request(`${url.origin}/__transit_question_cache/v2/cleaning-version`);
  const versionHint = question.end && await cacheMatch(cache, versionKey);
  const version = versionHint ? cleaningVersion(await versionHint.text()) : null;
  const cached = await cacheMatch(cache, cacheRequest(url.origin, question, version ?? "unversioned"));
  if (cached) return publicAnswer(cached.body, cached.headers.get("content-type"));

  const denied = await authorize();
  if (denied) return denied;

  const storageKey = hash(question.key);
  let body;
  let contentType;
  let reportedVersion;
  let settled = false;
  try {
    const response = await env.ENGINE.fetch(new Request(question.upstream, {
      headers: { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` },
    }));
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 503 && retryAfter) return busy(retryAfter);
    if (response.status === 400) {
      return publicEngineError(await response.json());
    }
    if (!response.ok) return lastGood(env, storageKey);

    contentType = response.headers.get("content-type");
    const mime = contentType?.split(";")[0].trim().toLowerCase();
    if (mime !== (question.csv ? "text/csv" : "application/json")) {
      return lastGood(env, storageKey);
    }
    body = await response.text();
    const json = question.csv ? null : JSON.parse(body);
    if (!question.csv && (!json || typeof json !== "object" ||
        Array.isArray(json) !== (question.route === "how-we-measure"))) {
      return lastGood(env, storageKey);
    }
    if (question.end) {
      settled = response.headers.get(PENDING_DAYS_HEADER) === "0";
      const versions = json?.evidence?.cleaning_versions;
      reportedVersion = cleaningVersion(response.headers.get(VERSION_HEADER))
        ?? cleaningVersion(json?.cleaning_version)
        ?? cleaningVersion(versions?.length === 1 ? versions[0] : null);
    }
  } catch {
    return lastGood(env, storageKey);
  }

  const today = reportedVersion && settled && serviceToday(timezone);
  const ttl = today && question.end < today ? CLOSED_TTL : OPEN_TTL;
  ctx.waitUntil(remember(
    cache, url.origin, question, reportedVersion, versionKey, ttl, body, contentType,
  ).catch(() => console.warn("Transit question cache write failed")));
  if (env.QUESTION_LAST_GOOD) {
    ctx.waitUntil(storageKey.then((key) => env.QUESTION_LAST_GOOD.put(key, body, {
      expirationTtl: LAST_GOOD_TTL,
      metadata: { contentType },
    })).catch(() => console.warn("Last-good transit answer write failed")));
  }
  return publicAnswer(body, contentType);
}

function publicEngineError(payload) {
  return message(400, typeof payload?.message === "string" ? payload.message : "invalid question");
}
