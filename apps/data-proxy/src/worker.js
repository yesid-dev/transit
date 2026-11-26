import { serveCleanBasemap } from "./basemap.js";
import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { isDownloadPath, serveDownload } from "./downloads.js";
import { serveLiveKpis } from "./live-kpis.js";
import { serveQuestion } from "./questions.js";
const DOWNLOADS = "https://transit.yesid.dev/download";

function errorResponse(status, extraHeaders = {}) {
  // Do not cache transient errors.
  return new Response(null, {
    status,
    headers: { ...CORS_HEADERS, "cache-control": "no-store", ...extraHeaders },
  });
}

export default {
  async fetch(request, env, ctx, publicCities, retiredBasemaps, defaultCity) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/v1/kpis") return serveLiveKpis(request, env, ctx, publicCities, defaultCity);
    if (isDownloadPath(pathname)) return serveDownload(request, env, ctx);
    const basemap = /^\/v2\/([a-z0-9][a-z0-9_-]{0,63})\/basemap\/([a-zA-Z0-9_-]+\.pmtiles)$/.exec(pathname);
    if (pathname.startsWith("/v2/") && !basemap) return serveQuestion(request, env, ctx, publicCities);

    const legacy = /^\/(?:data\/|api\/)?v1(?:\/|$)/;
    let legacyPath = pathname;
    try {
      legacyPath = decodeURIComponent(pathname);
    } catch {
      // A malformed suffix still belongs to its literal retirement namespace.
    }
    if (legacy.test(legacyPath)) {
      const bookmark = pathname.startsWith("/data/") ? pathname.slice("/data".length) : pathname;
      const tile = retiredBasemaps?.get(bookmark);
      if (tile && request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
      }
      if (tile && (request.method === "GET" || request.method === "HEAD")) {
        return errorResponse(308, { location: tile });
      }
      return new Response(request.method === "HEAD" ? null : `This data endpoint has retired. Downloads: ${DOWNLOADS}\n`, {
        status: 410,
        headers: { ...CORS_HEADERS, "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, { allow: "GET, HEAD, OPTIONS" });
    }
    if (basemap) {
      const [, city, file] = basemap;
      if (!publicCities?.has(city)) return errorResponse(404);
      let response;
      try {
        response = await serveCleanBasemap(request, env, city, file);
      } catch {
        request.signal.throwIfAborted();
        return errorResponse(503, {
          "retry-after": "30",
          "access-control-expose-headers": `${CORS_HEADERS["access-control-expose-headers"]}, Retry-After`,
        });
      }
      if (!response) return errorResponse(404);
      for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
      response.headers.set("x-transit-source", "clean");
      response.headers.set("access-control-expose-headers",
        `${CORS_HEADERS["access-control-expose-headers"]}, X-Transit-Source`);
      return response;
    }

    return errorResponse(404);
  },
};
