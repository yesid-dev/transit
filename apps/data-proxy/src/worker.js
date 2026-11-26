// Public snapshots retain object metadata; errors use no-store. The bucket is read-only.
import { serveCleanBasemap } from "./basemap.js";
import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { isDownloadPath, serveDownload } from "./downloads.js";
import { serveKpis } from "./kpis.js";
import { serveQuestion } from "./questions.js";
import { serveSnapshot } from "./snapshot-response.js";

const KEY_PREFIX = "/data/";
const SERVABLE_PREFIX = "/data/v1/";

const KPIS_PATH = "/api/v1/kpis";
const API_PREFIX = "/api/v1/";
const RETIRED_STO_PREFIX = "/data/v1/sto/";

function errorResponse(status, extraHeaders = {}) {
  // Do not cache transient errors.
  return new Response(null, {
    status,
    headers: { ...CORS_HEADERS, "cache-control": "no-store", ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx, publicCities) {
    const { pathname } = new URL(request.url);
    if (isDownloadPath(pathname)) return serveDownload(request, env, ctx);
    const basemap = /^\/v2\/([a-z0-9][a-z0-9_-]{0,63})\/basemap\/([a-zA-Z0-9_-]+\.pmtiles)$/.exec(pathname);
    if (pathname.startsWith("/v2/") && !basemap) return serveQuestion(request, env, ctx, publicCities);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, { allow: "GET, HEAD, OPTIONS" });
    }
    if (basemap) {
      const [, city, file] = basemap;
      if (!publicCities?.has(city)) return errorResponse(404);
      const response = await serveCleanBasemap(request, env, city, file);
      if (!response) return errorResponse(404);
      for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
      response.headers.set("x-transit-source", "clean");
      response.headers.set("access-control-expose-headers",
        `${CORS_HEADERS["access-control-expose-headers"]}, X-Transit-Source`);
      return response;
    }

    let decodedPathname;
    try {
      decodedPathname = decodeURIComponent(pathname);
    } catch {
      return errorResponse(404);
    }
    if (decodedPathname.startsWith(RETIRED_STO_PREFIX)) {
      return errorResponse(410);
    }
    if (decodedPathname === KPIS_PATH) {
      return serveKpis(request, env, ctx);
    }
    if (decodedPathname.startsWith(API_PREFIX)) {
      // Undefined API routes return an uncacheable 404.
      return errorResponse(404);
    }
    if (!decodedPathname.startsWith(SERVABLE_PREFIX)) {
      return errorResponse(404);
    }

    const key = decodedPathname.slice(KEY_PREFIX.length);
    if (key.includes("..")) {
      return errorResponse(404);
    }

    const response = await serveSnapshot(request, env.SNAPSHOTS, key);
    if (response === null) return errorResponse(404);
    for (const [name, value] of Object.entries(CORS_HEADERS))
      response.headers.set(name, value);
    return response;
  },
};
