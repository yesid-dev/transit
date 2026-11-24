import { cleanObjectReader } from "./clean-download-store.js";

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

export async function serveCleanBasemap(request, env, city, file) {
  const read = cleanObjectReader(env);
  if (!read) return null;

  const key = basemapKey(city, file);
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
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
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
    if (head.status === 404) return null;
    if (head.status !== 200) throw new Error("Could not read clean basemap metadata");
    metadata = head.headers;
  } else if (response.status !== (upstream.has("range") ? 206 : 200)) {
    await response.body?.cancel();
    throw new Error("Invalid response from clean basemap storage");
  }

  for (const name of OBJECT_HEADERS) {
    if (metadata.has(name)) headers.set(name, metadata.get(name));
  }
  if (response.status === 412) headers.set("cache-control", "no-store");
  if (response.status === 304 || response.status === 412 || request.method === "HEAD") {
    return new Response(null, { status: response.status, headers });
  }
  if (range) {
    const length = response.headers.get("content-length");
    // The binding treats malformed and multiple ranges as a range over the whole object.
    const contentRange = upstream.has("range")
      ? response.headers.get("content-range") : `bytes 0-${Number(length) - 1}/${length}`;
    if (!length || !contentRange) {
      await response.body?.cancel();
      throw new Error("Missing clean basemap range metadata");
    }
    headers.set("content-length", length);
    headers.set("content-range", contentRange);
    return new Response(response.body, { status: 206, headers });
  }
  return new Response(response.body, { headers });
}
