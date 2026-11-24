import { cleanDownloadStore } from "./clean-download-store.js";
import { CORS_HEADERS, PREFLIGHT_HEADERS } from "./cors.js";
import { downloadLicence, downloadReadme } from "./download-licences.js";
import { serviceDate } from "./question-params.js";
import { admit, cacheMatch, cleaningVersion, CLOSED_TTL, loadPublicCities, OPEN_TTL, serviceToday } from "./questions.js";

const TABLES = [
  "stop_events", "trip_days", "scheduled_stop_times", "vehicle_positions",
  "alerts", "feed_polls", "prediction_samples", "segment_runs",
].map((table) => `${table}.parquet`);
const SEGMENT_RUNS = "segment_runs.parquet";
const UNMEASURED = new Set(["no_raw_captures", "no_schedule_edition", "schedule_archive_unreadable"]);
const HEADERS = {
  ...CORS_HEADERS,
  "access-control-expose-headers": `${CORS_HEADERS["access-control-expose-headers"]}, Content-Disposition, Retry-After`,
  "cache-control": "no-store",
};
const ALLOW = "GET, HEAD, OPTIONS";

export function isDownloadPath(path) {
  return /^\/v2\/[^/]+\/download(?:\/|$)/.test(path);
}

function message(status, message, headers) {
  return Response.json({ message }, { status, headers: { ...HEADERS, ...headers } });
}

function remember(cache, ctx, key, body, ttl) {
  if (!cache) return;
  ctx.waitUntil(cache.put(key, new Response(body, {
    headers: { "cache-control": `public, max-age=${ttl}` },
  })).catch(() => console.warn("Transit download cache write failed")));
}

async function activeVersion(env, cache, ctx, origin, city, date) {
  const key = new Request(`${origin}/__transit_download_cache/v2/version`);
  const cached = await cacheMatch(cache, key);
  if (cached) return cleaningVersion(await cached.text());
  // A single-day health request reports the live engine's version, including on missing days.
  const query = new URLSearchParams({ city, from: date, to: date });
  const response = await env.ENGINE.fetch(new Request(`https://transit-engine.internal/data-health?${query}`, {
    headers: { authorization: `Bearer ${env.TRANSIT1_ENGINE_ACCESS_TOKEN}` },
  }));
  if (!response.ok) return null;
  const version = cleaningVersion(response.headers.get("x-transit-cleaning-version"));
  await response.body?.cancel();
  if (version) remember(cache, ctx, key, version, OPEN_TTL);
  return version;
}

async function readDay(bucket, cache, ctx, origin, city, date, version, today) {
  const directory = `${city}/${date}/v${version}`;
  const key = new Request(`${origin}/__transit_download_cache/v2/${directory}`);
  const cached = await cacheMatch(cache, key);
  if (cached) return cached.json();

  const object = await bucket.get(`${directory}/manifest.json`);
  if (!object) return { status: "missing", reason: "no_manifest", files: [] };
  const manifest = await object.json();
  if (manifest?.provider !== city || manifest.service_date !== date || manifest.cleaning_version !== version) {
    throw new Error("Clean download manifest identity mismatch");
  }

  let day;
  if (UNMEASURED.has(manifest.status) && !("files" in manifest)) {
    day = { status: "not_measured", reason: manifest.status, files: [] };
  } else {
    const alertsNotTracked = manifest.alerts === "not_tracked";
    const expected = TABLES.filter((name) =>
      (!alertsNotTracked || name !== "alerts.parquet") &&
      (version === "12" || name !== SEGMENT_RUNS));
    if (manifest.status !== undefined || (manifest.alerts !== undefined && !alertsNotTracked) ||
        !manifest.files || Object.keys(manifest.files).length !== expected.length) {
      throw new Error("Invalid clean download manifest");
    }
    const files = expected.map((name) => {
      const entry = manifest.files[name];
      if (typeof entry?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          !Number.isSafeInteger(entry.byte_size) || entry.byte_size <= 0) {
        throw new Error("Invalid clean download file identity");
      }
      return { name, byte_size: entry.byte_size, sha256: entry.sha256 };
    });
    day = { status: "complete", alerts_not_tracked: alertsNotTracked, files };
  }
  remember(cache, ctx, key, JSON.stringify(day), date < today ? CLOSED_TTL : OPEN_TTL);
  return day;
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header ?? "");
  if (!match || (!match[1] && !match[2])) return undefined;
  const [, start, end] = match;
  const offset = start ? Number(start) : Math.max(0, size - Number(end));
  const last = start && end ? Math.min(Number(end), size - 1) : size - 1;
  if (offset >= size || last < offset) return null;
  return { offset, length: last - offset + 1 };
}

async function downloadFile(request, bucket, key, filename, file) {
  const etag = `"${file.sha256}"`;
  const headers = {
    ...HEADERS,
    "content-type": "application/vnd.apache.parquet",
    "content-disposition": `attachment; filename="${filename}"`,
    "accept-ranges": "bytes",
    etag,
  };
  const head = request.method === "HEAD";
  const fresh = request.headers.get("if-none-match")?.split(",").some((tag) =>
    ["*", etag].includes(tag.trim().replace(/^W\//, "")),
  );
  const ifRange = request.headers.get("if-range");
  const range = !head && !fresh && (!ifRange || ifRange === etag)
    ? byteRange(request.headers.get("range"), file.byte_size)
    : undefined;
  const object = head || fresh || range === null
    ? await bucket.head(key)
    : await bucket.get(key, range ? { range } : undefined);
  if (!object) return message(404, "file not found");
  if (object.size !== file.byte_size) {
    await object.body?.cancel();
    return message(503, "file differs from its manifest");
  }
  if (fresh) return new Response(null, { status: 304, headers });
  if (range === null) {
    return new Response(null, {
      status: 416, headers: { ...headers, "content-range": `bytes */${file.byte_size}` },
    });
  }
  if (range) headers["content-range"] =
    `bytes ${range.offset}-${range.offset + range.length - 1}/${file.byte_size}`;
  headers["content-length"] = String(range?.length ?? file.byte_size);
  return new Response(head ? null : object.body, { status: range ? 206 : 200, headers });
}

export async function serveDownload(request, env, ctx, visitorIp = request.headers.get("cf-connecting-ip")) {
  const url = new URL(request.url);
  const match = /^\/v2\/([a-z0-9][a-z0-9_-]{0,63})\/download(?:\/([\d-]+)\/([\w.]+))?$/.exec(url.pathname);
  if (!match) return message(404, "not found");
  const [, city, pathDate, name] = match;
  if (name && name !== "README.txt" && !TABLES.includes(name)) return message(404, "file not found");
  const parameter = name ? "version" : "date";
  const params = [...url.searchParams];
  const param = url.searchParams.get(parameter);
  if (params.length > 1 || (params.length === 1 && (params[0][0] !== parameter || !param)) ||
      (name && param && !cleaningVersion(param))) return message(400, "invalid download parameter");
  const requestedDate = pathDate ?? param;
  if (requestedDate !== null && !Number.isFinite(serviceDate(requestedDate))) return message(404, "invalid date");

  if (request.method === "OPTIONS") return new Response(null, {
    status: 204,
    headers: {
      ...PREFLIGHT_HEADERS,
      "access-control-allow-methods": name ? ALLOW : "GET, OPTIONS",
      "access-control-allow-headers": "If-None-Match, If-Range, Range",
    },
  });
  if (request.method !== "GET" && (request.method !== "HEAD" || !name)) {
    return message(405, "use GET", { allow: name ? ALLOW : "GET, OPTIONS" });
  }
  const bucket = cleanDownloadStore(env);
  if (!bucket || !env.ENGINE || !env.TRANSIT1_ENGINE_ACCESS_TOKEN) return message(503, "downloads not configured");

  const cache = globalThis.caches?.default;
  let admission;
  const authorize = () => admission ??= admit(env, visitorIp);
  if (!name) {
    const denied = await authorize();
    if (denied) return denied;
  }

  try {
    const cities = await loadPublicCities(env, cache, url.origin, authorize, ctx);
    if (cities.error) return cities.error;
    const provider = JSON.parse(cities.body).providers.find((entry) => entry.id === city);
    if (!provider) return message(404, "unknown city");

    const today = serviceToday(provider.timezone);
    if (!today) return message(503, "service timezone unavailable");
    const date = requestedDate ?? new Date(serviceDate(today) - 86_400_000).toISOString().slice(0, 10);
    const licence = downloadLicence(provider, date);
    if (!licence) return message(404, "download licence unavailable");
    const version = await activeVersion(env, cache, ctx, url.origin, city, date);
    if (!version) return message(503, "cleaning version unavailable", { "retry-after": "30" });
    if (name && param && param !== version) return message(404, "cleaning version unavailable");

    const day = await readDay(bucket, cache, ctx, url.origin, city, date, version, today);
    const link = (filename) => `/v2/${city}/download/${date}/${filename}?version=${version}`;
    if (!name) {
      return Response.json({
        city, service_date: date, cleaning_version: version, licence, ...day,
        alerts_not_tracked: day.alerts_not_tracked ??
          (provider.inputs?.i3_alerts === false && provider.inputs?.service_alerts === false),
        files: day.files.map((file) => ({ ...file, url: link(file.name) })),
        readme_url: day.status === "complete" ? link("README.txt") : null,
      }, { headers: HEADERS });
    }
    if (day.status !== "complete") return message(404, "day has no completed files");
    const filename = `transit-${city}-${date}-v${version}-${name}`;
    if (name === "README.txt") {
      return new Response(request.method === "HEAD" ? null : downloadReadme(licence, date, version, day.files), {
        headers: {
          ...HEADERS,
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
        },
      });
    }
    const file = day.files.find((entry) => entry.name === name);
    if (!file) return message(404, "file not found");
    return await downloadFile(request, bucket, `${city}/${date}/v${version}/${name}`, filename, file);
  } catch {
    return message(503, "downloads unavailable", { "retry-after": "30" });
  }
}
