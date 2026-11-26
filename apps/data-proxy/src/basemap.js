import { cleanObjectReader } from "./clean-download-store.js";

export function publicBasemapUrl(city, legacyUrl) {
  if (typeof legacyUrl !== "string") return null;
  const match = /^\/data\/v1\/([a-z0-9][a-z0-9_-]{0,63})\/static\/basemap\/([a-zA-Z0-9_-]+\.pmtiles)$/.exec(legacyUrl);
  return match?.[1] === city ? `https://data.yesid.dev/v2/${city}/basemap/${match[2]}` : null;
}

export function basemapKey(city, file) {
  return `basemaps/v1/${city}/${file}`;
}

const CONDITIONAL_HEADERS = [
  "if-match", "if-none-match", "if-modified-since", "if-unmodified-since",
];
const OBJECT_HEADERS = [
  "etag", "cache-control", "content-type", "content-disposition", "content-encoding",
  "content-language", "expires",
];

class CleanBasemapFailure extends Error {}

async function unusable(response, kind = `${Math.floor(response.status / 100)}xx`) {
  await response.body?.cancel().catch(() => {});
  throw new CleanBasemapFailure(kind);
}

// Confirm the first bytes arrived before committing to the clean response.
async function readyBody(body, length) {
  if (!body) throw new CleanBasemapFailure("invalid response");
  const reader = body.getReader();
  let first;
  try {
    do {
      first = await reader.read();
      if (first.done) throw new CleanBasemapFailure("invalid response");
    } while (first.value.byteLength === 0);
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });

  // Workers derives the wire Content-Length from the stream. Node tests use the standard stream.
  if (typeof FixedLengthStream === "undefined") return stream;
  const fixed = new FixedLengthStream(length);
  void stream.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

export async function serveCleanBasemap(request, env, city, file) {
  request.signal.throwIfAborted();
  const read = cleanObjectReader(env);
  if (!read) return null;
  try {
    const response = await readCleanBasemap(request, read, basemapKey(city, file));
    if (request.signal.aborted) {
      await response.body?.cancel().catch(() => {});
      request.signal.throwIfAborted();
    }
    return response;
  } catch (error) {
    request.signal.throwIfAborted();
    console.warn("Clean basemap fallback", error instanceof CleanBasemapFailure ? error.message : "read error");
    return null;
  }
}

async function readCleanBasemap(request, read, key) {
  const upstream = new Headers();
  for (const name of CONDITIONAL_HEADERS) {
    if (request.headers.has(name)) upstream.set(name, request.headers.get(name));
  }
  const range = request.method === "GET" ? request.headers.get("range") : null;
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/i.exec(range ?? "");
  if (match && (!match[2] || BigInt(match[2]) >= BigInt(match[1]))) {
    upstream.set("range", range);
  }

  const response = await read(request.method, key, upstream, request.signal);
  const headers = new Headers({ "accept-ranges": "bytes" });
  if (response.status === 416) {
    await response.body?.cancel();
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 416, headers });
  }

  let metadata = response.headers;
  if (response.status === 304 || response.status === 412) {
    await response.body?.cancel();
    // Conditional S3 responses can omit the HTTP metadata that the binding returns.
    const head = await read("HEAD", key, new Headers(), request.signal);
    if (head.status !== 200) return unusable(head);
    metadata = head.headers;
  } else if (response.status !== (upstream.has("range") ? 206 : 200)) {
    return unusable(response);
  }
  if (!metadata.get("etag") || !metadata.get("content-type")) {
    return unusable(response, "invalid response");
  }

  for (const name of OBJECT_HEADERS) {
    if (metadata.has(name)) headers.set(name, metadata.get(name));
  }
  if (response.status === 412) headers.set("cache-control", "no-store");
  if (response.status === 304 || response.status === 412 || request.method === "HEAD") {
    return new Response(null, { status: response.status, headers });
  }
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0) {
    return unusable(response, "invalid response");
  }
  if (range) {
    // The binding treats malformed and multiple ranges as a range over the whole object.
    const contentRange = upstream.has("range")
      ? response.headers.get("content-range") : `bytes 0-${length - 1}/${length}`;
    if (!/^bytes \d+-\d+\/\d+$/.test(contentRange ?? "")) {
      return unusable(response, "invalid response");
    }
    headers.set("content-length", String(length));
    headers.set("content-range", contentRange);
  }
  return new Response(await readyBody(response.body, length), { status: range ? 206 : 200, headers });
}
