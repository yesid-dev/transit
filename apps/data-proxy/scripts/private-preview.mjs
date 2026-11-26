// Private preview of one city that is not public yet, on this computer only.
//
// Runs the real proxy code (src/worker.js) on a loopback port with in-process bindings:
// the public city list plus the named city, a local engine, and the clean storage read
// key from this process's environment. It also writes a copy of the provider
// declarations with that one city switched to public, for a local engine and live
// publisher. Every path outside /v2/ is forwarded to a local web server, so pages,
// answers and map tiles share one origin. Nothing is deployed and nothing is written
// to storage.
//
//   bun apps/data-proxy/scripts/private-preview.mjs --city <id> [--port 4420]
//     [--engine http://127.0.0.1:8790] [--web http://127.0.0.1:4417]
//     [--live-dir <live publisher output>] [--declarations <output directory>]
//
// The environment must hold TRANSIT1_R2_ENDPOINT and the TRANSIT1_R2_READ_* key for
// downloads and tiles. Never print it.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import worker from "../src/worker.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const PUBLIC_DATA_ORIGIN = "https://data.yesid.dev";

export function assertLoopback(url) {
  const { hostname } = new URL(url);
  if (!LOOPBACK.has(hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error(`The private preview only talks to this computer, not ${hostname}`);
  }
  return url;
}

/** The same rule as scripts/build-public-cities.mjs, applied to parsed declarations. */
export function isPublicDeclaration(declaration) {
  return declaration.provider
    ? declaration.provider.is_active === true && declaration.public?.enabled === true
    : declaration.stage === "public";
}

export function previewCityList(declarations, city) {
  if (!Object.hasOwn(declarations, city)) throw new Error(`No declaration for ${city}`);
  const ids = Object.entries(declarations)
    .filter(([id, declaration]) => id === city || isPublicDeclaration(declaration))
    .map(([id]) => id);
  return new Set(ids);
}

/** Switch one declaration's text to public, leaving every other line as written. */
export function publishDeclaration(text) {
  let block = null;
  let changed = 0;
  const lines = text.split("\n").map((line) => {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) block = top[1];
    if (/^stage:\s*\S+\s*$/.test(line)) {
      changed++;
      return "stage: public";
    }
    if (block === "provider" && /^ {2}is_active:\s*\S+\s*$/.test(line)) {
      changed++;
      return "  is_active: true";
    }
    if (block === "public" && /^ {2}enabled:\s*\S+\s*$/.test(line)) {
      changed++;
      return "  enabled: true";
    }
    return line;
  });
  if (changed !== 1 && changed !== 2) throw new Error("Unexpected declaration shape");
  return lines.join("\n");
}

export function writePreviewDeclarations(source, target, city) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (!/\.(ya?ml|txt)$/.test(name)) continue;
    const from = join(source, name);
    if (name === `${city}.yaml`) {
      writeFileSync(join(target, name), publishDeclaration(readFileSync(from, "utf8")));
    } else {
      copyFileSync(from, join(target, name));
    }
  }
  return target;
}

export function engineBinding(origin, signalTimeoutMs = 60_000) {
  const base = new URL(assertLoopback(origin));
  return {
    fetch(request) {
      const incoming = new URL(request.url);
      const url = new URL(incoming.pathname + incoming.search, base);
      return fetch(url, {
        headers: request.headers,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(signalTimeoutMs)]),
        redirect: "manual",
      });
    },
  };
}

/** Serve a live object the local publisher wrote, with the range and ETag checks R2 gives. */
export function localLiveResponse(liveDir, city, key, method, headers) {
  const live = new RegExp(`^live/v2/${city}(?:\\.json|/trips\\.(?:json|bin))$`);
  if (!live.test(key)) return null;
  const path = join(liveDir, ...key.split("/"));
  let body;
  try {
    if (!statSync(path).isFile()) return new Response(null, { status: 404 });
    body = readFileSync(path);
  } catch {
    return new Response(null, { status: 404 });
  }
  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  const ifMatch = headers.get("if-match");
  if (ifMatch && ifMatch !== etag) return new Response(null, { status: 412 });
  const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
  if (range) {
    const [first, last] = [Number(range[1]), Math.min(Number(range[2]), body.length - 1)];
    if (first > last) return new Response(null, { status: 416 });
    const part = body.subarray(first, last + 1);
    return new Response(method === "HEAD" ? null : part, {
      status: 206,
      headers: {
        etag,
        "content-length": String(part.length),
        "content-range": `bytes ${first}-${last}/${body.length}`,
      },
    });
  }
  return new Response(method === "HEAD" ? null : body, {
    headers: { etag, "content-length": String(body.length) },
  });
}

/** Point the catalog's public tile addresses at this origin. */
export function sameOriginCatalog(body) {
  const catalog = JSON.parse(body);
  for (const provider of catalog.providers ?? []) {
    if (typeof provider.basemap_v2_url === "string" &&
        provider.basemap_v2_url.startsWith(`${PUBLIC_DATA_ORIGIN}/v2/`)) {
      provider.basemap_v2_url = provider.basemap_v2_url.slice(PUBLIC_DATA_ORIGIN.length);
    }
  }
  return JSON.stringify(catalog);
}

async function main() {
  const { values } = parseArgs({
    options: {
      city: { type: "string" },
      port: { type: "string", default: "4420" },
      engine: { type: "string", default: "http://127.0.0.1:8790" },
      web: { type: "string", default: "http://127.0.0.1:4417" },
      "live-dir": { type: "string" },
      declarations: { type: "string", default: join(tmpdir(), "transit-preview-declarations") },
    },
  });
  const city = values.city;
  if (!city || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city)) throw new Error("Give --city <id>");
  const web = new URL(assertLoopback(values.web));
  const source = new URL("../../db/config/providers/", import.meta.url);
  const declarations = Object.fromEntries(
    readdirSync(source).filter((name) => name.endsWith(".yaml")).map((name) => [
      name.slice(0, -".yaml".length),
      Bun.YAML.parse(readFileSync(new URL(name, source), "utf8")),
    ]),
  );
  const cities = previewCityList(declarations, city);
  const target = writePreviewDeclarations(source.pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    values.declarations, city);
  if (!isPublicDeclaration(Bun.YAML.parse(readFileSync(join(target, `${city}.yaml`), "utf8")))) {
    throw new Error("The preview declaration did not switch to public");
  }

  if (values["live-dir"]) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const key = url.hostname.endsWith(".r2.cloudflarestorage.com") &&
        decodeURIComponent(url.pathname).replace(/^\/transit-clean\//, "");
      const local = key && localLiveResponse(values["live-dir"], city, key, request.method,
        request.headers);
      return local ? Promise.resolve(local) : realFetch(input, init);
    };
  }

  const env = {
    ENGINE: engineBinding(values.engine),
    TRANSIT1_ENGINE_ACCESS_TOKEN: process.env.PREVIEW_ENGINE_TOKEN || "local-preview",
    TRANSIT1_R2_ENDPOINT: process.env.TRANSIT1_R2_ENDPOINT,
    TRANSIT1_R2_READ_ACCESS_KEY_ID: process.env.TRANSIT1_R2_READ_ACCESS_KEY_ID,
    TRANSIT1_R2_READ_SECRET_ACCESS_KEY: process.env.TRANSIT1_R2_READ_SECRET_ACCESS_KEY,
    QUESTION_LIMIT: { limit: async () => ({ success: true }) },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v2/")) {
        const response = await worker.fetch(request, env, ctx, cities);
        if (url.pathname !== "/v2/cities" || !response.ok) return response;
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(sameOriginCatalog(await response.text()), { headers });
      }
      const forwarded = new URL(url.pathname + url.search, web);
      const headers = new Headers(request.headers);
      headers.delete("host");
      return fetch(forwarded, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
    },
  });
  console.log(`Private preview of ${city}: http://127.0.0.1:${server.port}/?provider=${city}`);
  console.log(`Preview declarations: ${target}`);
}

if (globalThis.Bun && import.meta.main) await main();
